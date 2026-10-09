import { strict as assert } from "node:assert";
import { mkdir, writeFile } from "node:fs/promises";
import { setup, Session, db, compose, poll, project } from "./test-support";
import { source, fixturePDF } from "./fixtures";
if(!project.startsWith("translator-test-"))throw new Error("REFUSE_NON_TEST_PROJECT");
await setup(process.env.SKIP_BUILD!=="1");
const evidence:any[]=[];
function enable(name:string){db(`insert into test_gates(name,enabled,hits) values('${name}',true,0) on conflict(name) do update set enabled=true,hits=0`);}
function release(name:string){db(`update test_gates set enabled=false where name='${name}'`);}
async function hit(name:string){await poll(async()=>Number(db(`select hits from test_gates where name='${name}'`)),n=>n>0,30_000);}
for(const boundary of ["before-provider-submission","provider-accepted","provider-returned","call-checkpointed","terms-output-ready","unit-checkpointed","artifact-renamed"].filter(b=>!process.env.CHAOS_BOUNDARY||b===process.env.CHAOS_BOUNDARY)){
  const session=new Session(),prepared=await session.prepare(source+"\n"+boundary,"chaos.md"),q=await session.quote(prepared.data.job_id);
  assert.equal(q.stage,"AWAITING_APPROVAL");
  enable(boundary);await session.start(q);await hit(boundary);
  const beforeCalls=db(`select coalesce(json_agg(json_build_object('id',id,'state',state,'hash',md5(response::text))), '[]') from calls where job_id='${q.job_id}'`);
  compose(["kill","-s","SIGKILL","worker"]);
  release(boundary);
  const start=Date.now();compose(["up","-d","worker"]);
  const result=await session.done(q.job_id),recovery=Date.now()-start;
  const expected=["provider-accepted","provider-returned"].includes(boundary)?"NEEDS_ATTENTION":"SUCCEEDED";
  assert.equal(result.stage,expected,`${boundary}: ${JSON.stringify(result)}`);
  assert.ok(recovery<=60_000,`${boundary}: ${recovery}ms`);
  assert.equal(db(`select count(*) from (select call_id,count(*) n from fake_events where job_id='${q.job_id}' group by call_id having count(*)>1) t`),"0","duplicate provider invocation");
  if(expected==="NEEDS_ATTENTION"){assert.equal(result.error,"OUTCOME_UNKNOWN");assert.ok(result.cost.unresolved_exposure_usd>0);assert.equal(result.artifact,null);}
  const completedBefore=JSON.parse(beforeCalls).filter((x:any)=>x.state==="COMPLETED");
  for(const c of completedBefore)assert.equal(db(`select md5(response::text) from calls where id='${c.id}'`),c.hash,"completed checkpoint altered");
  evidence.push({boundary,job_id:q.job_id,expected,result:result.stage,recovery_ms:recovery,cost:result.cost,completed_preserved:completedBefore.length});
  console.log(JSON.stringify(evidence.at(-1)));
}
// API dies after PostgreSQL accepts work, before enqueue/202; a retry resolves one job.
const apiSession=new Session();await apiSession.request("/api/session");const requestKey=crypto.randomUUID();
enable("api-committed");
const pending=apiSession.prepare(source,"api-chaos.md",requestKey).catch(()=>null);
await hit("api-committed");compose(["kill","-s","SIGKILL","api"]);release("api-committed");await pending;
compose(["up","-d","--wait","api"]);
const retry=await apiSession.prepare(source,"api-chaos.md",requestKey);assert.equal(retry.code,202);
assert.equal(db(`select count(*) from jobs where request_key='${requestKey}'`),"1");
const apiQuote=await apiSession.quote(retry.data.job_id);assert.equal(apiQuote.stage,"AWAITING_APPROVAL");
evidence.push({boundary:"api-commit-before-notify",job_id:apiQuote.job_id,durable:true});
// Infrastructure kills during accepted work. Completed job/artifact survives PostgreSQL and Redis SIGKILL.
const infrastructure=new Session(),p=await infrastructure.prepare(),q=await infrastructure.quote(p.data.job_id);
await infrastructure.start(q);const completed=await infrastructure.done(q.job_id);assert.equal(completed.stage,"SUCCEEDED");
const checksum=completed.artifact.checksum, count=db(`select count(*) from fake_events where job_id='${q.job_id}'`);
for(const service of ["redis","postgres"]){
  compose(["kill","-s","SIGKILL",service]);compose(["up","-d","--wait",service]);
  await poll(()=>infrastructure.status(q.job_id),j=>j.stage==="SUCCEEDED");
  assert.equal((await infrastructure.status(q.job_id)).artifact.checksum,checksum);
  assert.equal(db(`select count(*) from fake_events where job_id='${q.job_id}'`),count);
  evidence.push({boundary:`${service}-SIGKILL`,checksum_preserved:true,calls_preserved:true});
}
// No entire namespace reset or user-volume removal is used.
const evidencePath=process.env.CHAOS_BOUNDARY?"evidence/chaos-focused.json":"evidence/chaos.json";
await mkdir("evidence",{recursive:true});await writeFile(evidencePath,JSON.stringify(evidence,null,2));
console.log(JSON.stringify({passed:evidence.length,evidence:evidencePath,project}));
