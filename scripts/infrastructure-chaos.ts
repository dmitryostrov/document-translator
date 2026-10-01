import { strict as assert } from "node:assert";
import { writeFile } from "node:fs/promises";
import { setup,Session,db,compose,poll } from "./test-support";
import { source } from "./fixtures";
await setup(process.env.SKIP_BUILD!=="1");const evidence=[];
for(const service of ["redis","postgres"]){
  const session=new Session(),p=await session.prepare(source+` in-flight ${service}`),q=await session.quote(p.data.job_id);
  db("insert into test_gates(name,enabled,hits) values('provider-accepted',true,0) on conflict(name) do update set enabled=true,hits=0");
  await session.start(q);await poll(async()=>Number(db("select hits from test_gates where name='provider-accepted'")),n=>n>0);
  compose(["kill","-s","SIGKILL",service]);
  if(service==="redis")db("update test_gates set enabled=false where name='provider-accepted'");
  compose(["up","-d","--wait",service]);const healthy=Date.now();
  if(service==="postgres")db("update test_gates set enabled=false where name='provider-accepted'");
  const result=await session.done(q.job_id);assert.ok(["SUCCEEDED","NEEDS_ATTENTION"].includes(result.stage),JSON.stringify(result));
  assert.ok(Date.now()-healthy<=60000);
  assert.equal(result.cost.active_reserved_usd,0);
  assert.equal(db(`select count(*) from (select call_id,count(*) n from fake_events where job_id='${q.job_id}' group by call_id having count(*)>1) t`),"0");
  if(result.stage==="NEEDS_ATTENTION"){assert.equal(result.error,"OUTCOME_UNKNOWN");assert.ok(result.cost.unresolved_exposure_usd>0);assert.equal(result.artifact,null);}
  evidence.push({service,phase:"submitted provider call",stage:result.stage,error:result.error,recovery_after_healthy_ms:Date.now()-healthy,cost:result.cost,duplicate_paid_calls:0});
}
await writeFile("evidence/infrastructure-chaos.json",JSON.stringify(evidence,null,2));console.log(JSON.stringify({passed:evidence.length,evidence:"evidence/infrastructure-chaos.json"}));
