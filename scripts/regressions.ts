import { strict as assert } from "node:assert";
import { mkdir,writeFile } from "node:fs/promises";
import { setup,Session,db,compose,poll } from "./test-support";
import { fixturePDF,source } from "./fixtures";
await setup(process.env.SKIP_BUILD!=="1");
const evidence:any[]=[];
const enable=(name:string,on=true)=>db(`insert into test_gates(name,enabled,hits) values('${name}',${on},0) on conflict(name) do update set enabled=${on},hits=0`);
const session=new Session();
// Rejections happen during local preparation, before reservations or provider calls.
for(const [bytes,name,error] of [
  ["%PDF-corrupt","corrupt.pdf","CORRUPT_OR_ENCRYPTED_PDF"],
  [await fixturePDF(1,"scan"),"scan.pdf","SCANNED_PDF_UNSUPPORTED"],
  [await fixturePDF(1,"lowcontrast"),"contrast.pdf","PDF_VISIBILITY_UNSUPPORTED"],
  [await fixturePDF(1,"mixed"),"mixed.pdf","PDF_TEXT_ONLY_CONFIRMATION_REQUIRED"],
  ["VS-NfD document","marked.md","SENSITIVE_MARKING_DETECTED"],
  ["The battery \u200b instruction","conceal.md","UNICODE_CONCEALMENT_UNSUPPORTED"],
  [new Uint8Array([0xff,0x80]),"invalid.md","MARKDOWN_UTF8_INVALID"],
] as const){
  const p=await session.prepare(bytes,name),r=await session.quote(p.data.job_id);assert.equal(r.error,error);
  assert.equal(db(`select count(*) from calls where job_id='${r.job_id}'`),"0");evidence.push({case:name,error,provider_calls:0});
}
assert.equal((await session.prepare("text","unsupported.docx")).code,415);
for(const variant of ["tr3","offpage"]){
  const p=await session.prepare(await fixturePDF(1,variant),variant+".pdf"),q=await session.quote(p.data.job_id);
  assert.equal(q.stage,"AWAITING_APPROVAL");assert.ok(q.warnings.some((w:any)=>w.code==="HIDDEN_TEXT_EXCLUDED"));
  assert.equal(db(`select count(*) from calls where job_id='${q.job_id}'`),"0");evidence.push({case:variant,hidden_excluded:true});
}
const mixed=await session.prepare(await fixturePDF(1,"mixed"),"ack.pdf",crypto.randomUUID(),true);
const mixedQuote=await session.quote(mixed.data.job_id);assert.equal(mixedQuote.stage,"AWAITING_APPROVAL");
assert.ok(mixedQuote.warnings.some((w:any)=>w.code==="TEXT_ONLY_PDF_IMAGES_EXCLUDED"));
for(const failure of ["fake-500","fake-timeout","fake-invalid-output","fake-429"]){
  const p=await session.prepare(source+failure,"failure.md"),q=await session.quote(p.data.job_id);
  enable(failure);
  try{
    await session.start(q);const r=await session.done(q.job_id);
    if(["fake-500","fake-timeout"].includes(failure)){
      assert.equal(r.stage,"NEEDS_ATTENTION");assert.equal(r.error,"OUTCOME_UNKNOWN");
      assert.equal(db(`select count(*) from fake_events where job_id='${q.job_id}'`),"1");assert.ok(r.cost.unresolved_exposure_usd>0);
    }else if(failure==="fake-invalid-output"){
      assert.equal(r.stage,"FAILED");assert.equal(r.error,"INVALID_MODEL_OUTPUT");assert.ok(r.cost.known_cost_usd>0);assert.equal(r.cost.unresolved_exposure_usd,0);
    }else{
      assert.equal(r.stage,"FAILED");assert.equal(db(`select count(*) from fake_events where job_id='${q.job_id}'`),"3");assert.equal(r.cost.active_reserved_usd,0);
    }
    assert.equal(r.artifact,null);evidence.push({case:failure,stage:r.stage,error:r.error,cost:r.cost});
  }finally{enable(failure,false);}
}
// Cancellation before transport fences the unit and releases confirmed unsubmitted money.
const p=await session.prepare(source+" canceled"),q=await session.quote(p.data.job_id);enable("before-provider-submission");
await session.start(q);await poll(async()=>Number(db("select hits from test_gates where name='before-provider-submission'")),n=>n>0);
await session.request(`/api/translations/${q.job_id}/cancel`,"{}");enable("before-provider-submission",false);
await Bun.sleep(600);const canceled=await session.status(q.job_id);assert.equal(canceled.stage,"CANCELED");assert.equal(canceled.cost.active_reserved_usd,0);
assert.equal(db(`select count(*) from fake_events where job_id='${q.job_id}'`),"0");evidence.push({case:"cancel-before-transport",reservation_released:true});
// Canceling a submitted call and killing its process cannot leave an active reservation forever.
const cp=await session.prepare(source+" canceled after submission"),cq=await session.quote(cp.data.job_id);enable("provider-accepted");
await session.start(cq);await poll(async()=>Number(db("select hits from test_gates where name='provider-accepted'")),n=>n>0);
await session.request(`/api/translations/${cq.job_id}/cancel`,"{}");compose(["kill","-s","SIGKILL","worker"]);enable("provider-accepted",false);compose(["up","-d","worker"]);
const canceledSubmitted=await session.status(cq.job_id);assert.equal(canceledSubmitted.stage,"CANCELED");assert.equal(canceledSubmitted.cost.active_reserved_usd,0);assert.ok(canceledSubmitted.cost.unresolved_exposure_usd>0);
evidence.push({case:"cancel-submitted-and-kill",uncertain_charge_preserved:true,active_reservation:0});
// Retained terminal notifications, active/no DB claim and missing deliveries cannot strand work.
for(const state of ["completed","failed","active","missing"]){
  compose(["stop","worker"]);
  const prepared=await session.prepare(source+state,"queue.md");
  const injected=JSON.parse(compose(["exec","-T","api","bun","scripts/queue-fault.ts",prepared.data.job_id,state]));
  const began=Date.now();compose(["up","-d","worker"]);
  const ready=await session.quote(prepared.data.job_id);assert.equal(ready.stage,"AWAITING_APPROVAL");assert.ok(Date.now()-began<60_000);
  const gen=Number(db(`select generation from units where id='${injected.unit_id}'`));
  if(state!=="missing")assert.ok(gen>injected.generation);
  evidence.push({case:`queue-${state}`,generation:gen,recovery_ms:Date.now()-began});
}
// PostgreSQL retry time remains authoritative even with an absent broker delivery.
compose(["stop","worker"]);const delayed=await session.prepare(source+" delayed");
db(`update units set not_before=now()+interval '8 seconds' where job_id='${delayed.data.job_id}'`);
compose(["exec","-T","api","bun","scripts/queue-fault.ts",delayed.data.job_id,"clear"]);compose(["up","-d","worker"]);
await Bun.sleep(1500);assert.equal((await session.status(delayed.data.job_id)).stage,"PREFLIGHT");
assert.equal((await session.quote(delayed.data.job_id)).stage,"AWAITING_APPROVAL");evidence.push({case:"persisted-not-before",early_claims:0});
// A live lease tolerates duplicate generation deliveries without repeating provider transport.
const dup=await session.prepare(source+" live duplicate"),dq=await session.quote(dup.data.job_id);
enable("provider-accepted");await session.start(dq);await poll(async()=>Number(db("select hits from test_gates where name='provider-accepted'")),n=>n>0);
const [unit]=JSON.parse(db(`select json_agg(json_build_object('id',id,'generation',generation)) from units where job_id='${dq.job_id}' and state='RUNNING'`));
compose(["exec","-T","api","bun","-e",`const {queue,connection}=await import('./src/queue.ts');await queue.add('unit',{id:'${unit.id}',generation:${unit.generation}},{jobId:'duplicate-${crypto.randomUUID()}',removeOnComplete:true});await queue.close();await connection.quit();`]);
await Bun.sleep(500);enable("provider-accepted",false);assert.equal((await session.done(dq.job_id)).stage,"SUCCEEDED");
assert.equal(db(`select count(*) from (select call_id,count(*) n from fake_events where job_id='${dq.job_id}' group by call_id having count(*)>1) t`),"0");
evidence.push({case:"live-lease-duplicate",duplicate_paid_calls:0});
await mkdir("evidence",{recursive:true});await writeFile("evidence/regressions.json",JSON.stringify(evidence,null,2));
console.log(JSON.stringify({passed:evidence.length,evidence:"evidence/regressions.json"}));
