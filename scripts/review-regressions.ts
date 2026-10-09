import {strict as assert} from "node:assert";
import {spawnSync} from "node:child_process";
import {mkdtemp,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {setup,Session,db,compose,docker,environment,project,poll} from "./test-support";
import {visibilityPDF,fixturePDF} from "./fixtures";
await setup(process.env.SKIP_BUILD!=="1");
const a=new Session(),evidence:any[]=[];
for(const variant of ["covered","squeezed","image-covered"]){
  const accepted=await a.prepare(await visibilityPDF(variant),variant+".pdf",crypto.randomUUID(),true),q=await a.quote(accepted.data.job_id);
  assert.equal(q.error,"PDF_VISIBILITY_UNSUPPORTED",variant);
  assert.equal(q.cost.completed_calls,0);assert.equal(q.cost.known_cost_usd,0);
  assert.equal(db(`select count(*) from calls where job_id='${q.job_id}'`),"0");
  evidence.push({case:variant,error:q.error,paid_calls:0});
}
for(const variant of ["plain","white-on-black","nested-form"]){
  const accepted=await a.prepare(await visibilityPDF(variant),variant+".pdf",crypto.randomUUID(),true),q=await a.quote(accepted.data.job_id);
  assert.equal(q.stage,"AWAITING_APPROVAL",variant+" "+q.error);
  const ir=JSON.parse(db(`select ir from jobs where id='${q.job_id}'`));
  assert.ok(ir.blocks.some((b:any)=>b.text==="Visible battery 12 kW"));
  assert.ok(ir.blocks.every((b:any)=>!b.text.includes("Hidden adversarial")));
  if(variant==="nested-form"){
    assert.ok(ir.blocks.some((b:any)=>b.text==="Visible form control"));
    assert.ok(q.warnings.some((w:any)=>w.code==="HIDDEN_TEXT_EXCLUDED"));
  }
  assert.equal(q.cost.completed_calls,0);evidence.push({case:variant,visible_blocks:ir.blocks.length,hidden_payload_absent:true,paid_calls:0});
  assert.equal((await a.request("/api/translations/"+q.job_id+"/cancel","{}")).code,200);
}
// Synthetic canary proves the worker filesystem is not the parser's filesystem.
compose(["exec","-T","worker","bun","-e","await Bun.write('/tmp/translator-parser-key-canary','synthetic-canary');"]);
const isolation=JSON.parse(compose(["exec","-T","parser","bun","-e",`import{stat}from'node:fs/promises';console.log(JSON.stringify({canary_visible:await stat('/tmp/translator-parser-key-canary').then(()=>true,()=>false),key_mount_visible:await stat('/run/secrets/openai_key').then(()=>true,()=>false),credential_environment:Object.keys(process.env).filter(k=>/OPENAI|DATABASE_URL|REDIS_URL|MCP_TOKEN/.test(k))}));`]));
assert.equal(isolation.canary_visible,false);assert.equal(isolation.key_mount_visible,false);assert.deepEqual(isolation.credential_environment,[]);
const id=compose(["ps","-q","parser"]),isolate=JSON.parse(docker(["inspect",id]))[0];
assert.equal(isolate.HostConfig.NetworkMode,"none");assert.equal(isolate.HostConfig.ReadonlyRootfs,true);
assert.ok(isolate.HostConfig.CapDrop.includes("ALL"));assert.ok(isolate.HostConfig.SecurityOpt.includes("no-new-privileges:true"));
evidence.push({case:"parser-key-isolation",...isolation,network:"none",root_read_only:true,caps_dropped:true});
// No key in a genuine normal-mode worker: failure is named and no call is submitted.
const noKey=project+"-no-key-"+crypto.randomUUID().slice(0,8);
compose(["stop","worker"]);
try{
  compose(["run","-d","--no-deps","--name",noKey,"-e","PROVIDER_MODE=openai","-e","OPENAI_API_KEY_FILE=/missing/key","-e","OPENAI_API_KEY=","worker"]);
  const accepted=await a.prepare("The battery supplies 12 kW.","no-key.md"),q=await a.quote(accepted.data.job_id);
  assert.equal(q.error,"OPENAI_KEY_UNAVAILABLE");assert.equal(q.stage,"FAILED");
  assert.equal(db(`select count(*) from calls where job_id='${q.job_id}'`),"0");
  evidence.push({case:"missing-key-preflight",error:q.error,paid_calls:0});
}finally{docker(["kill","--signal","SIGKILL",noKey]);docker(["rm",noKey]);compose(["up","-d","worker"]);}
// Missing fresh-clone setup is rejected by Compose before startup.
const empty=await mkdtemp(join(tmpdir(),"translator-no-key-config-"));
const config=spawnSync("docker",["compose","--project-directory",empty,"-f",resolve("compose.yaml"),"config","--quiet"],
  {env:{...environment,OPENAI_KEY_PATH:"",PROVIDER_MODE:"openai"},encoding:"utf8"});
assert.notEqual(config.status,0);assert.ok(config.stderr.includes("OPENAI_KEY_UNAVAILABLE"));
evidence.push({case:"fresh-config-missing-key",error:"OPENAI_KEY_UNAVAILABLE",containers_started:0});
// Kill the new isolated parser while the real adapter is held mid-preflight.
db("insert into test_gates(name,enabled,hits) values('slow-pdf-subprocess',true,0) on conflict(name) do update set enabled=true,hits=0");
try{
  const accepted=await a.prepare(await fixturePDF(),"parser-kill.pdf");
  await poll(async()=>Number(db("select hits from test_gates where name='slow-pdf-subprocess'")),n=>n>0);
  compose(["kill","--signal","SIGKILL","parser"]);
  db("update test_gates set enabled=false where name='slow-pdf-subprocess'");
  compose(["up","-d","--wait","--wait-timeout","60","parser"]);
  const began=Date.now(),q=await a.quote(accepted.data.job_id);
  assert.equal(q.stage,"AWAITING_APPROVAL",q.error);
  assert.equal(q.cost.completed_calls,0);
  evidence.push({case:"parser-SIGKILL-preflight",stage:q.stage,recovery_after_healthy_ms:Date.now()-began,paid_calls:0});
}finally{db("update test_gates set enabled=false where name='slow-pdf-subprocess'");compose(["up","-d","parser"]);}
await writeFile(process.env.REVIEW_EVIDENCE_PATH??"evidence/review-regressions.json",JSON.stringify(evidence,null,2));
console.log(JSON.stringify({passed:evidence.length,paid_calls:0}));
