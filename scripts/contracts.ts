import { strict as assert } from "node:assert";
import { writeFile } from "node:fs/promises";
import { PDFDocument,PDFName } from "pdf-lib";
import { setup,Session,db,compose,docker,poll,base,environment,project } from "./test-support";
import { fixturePDF,source } from "./fixtures";
await setup(process.env.SKIP_BUILD!=="1");const a=new Session(),evidence:any[]=[];
let p=await a.prepare(),q=await a.quote(p.data.job_id),key=crypto.randomUUID();
const body=JSON.stringify({quote_version:q.quote.version,max_cost_usd:q.quote.maximum_reserved_usd});
assert.equal((await a.request(`/api/translations/${q.job_id}/start`,JSON.stringify({quote_version:"stale",max_cost_usd:1}),key)).code,409);
assert.equal((await a.request(`/api/translations/${q.job_id}/start`,JSON.stringify({quote_version:q.quote.version,max_cost_usd:.000001}),key)).code,409);
assert.equal(db(`select count(*) from calls where job_id='${q.job_id}'`),"0");
const races=await Promise.all([a.request(`/api/translations/${q.job_id}/start`,body,key),a.request(`/api/translations/${q.job_id}/start`,body,key)]);
assert.ok(races.every(r=>r.code===200));assert.equal(db(`select count(*) from starts where job_id='${q.job_id}'`),"1");
assert.equal((await a.request(`/api/translations/${q.job_id}/start`,JSON.stringify({quote_version:q.quote.version,max_cost_usd:2}),key)).code,409);
assert.equal((await a.done(q.job_id)).stage,"SUCCEEDED");evidence.push({case:"quote-cap-and-concurrent-start",duplicate_starts:0});
p=await a.prepare(source+" expired");q=await a.quote(p.data.job_id);
db(`update jobs set quote=jsonb_set(quote,'{expires_at}',to_jsonb((now()-interval '1 second')::text)) where id='${q.job_id}'`);
assert.equal((await a.start(q)).code,409);assert.equal(db(`select count(*) from calls where job_id='${q.job_id}'`),"0");evidence.push({case:"expired-approval",paid_calls:0});
assert.equal((await a.request("/api/translations/not-a-uuid/start",body,key)).code,400);
// A settings change after approval must stop before transport, even on restart.
p=await a.prepare(source+" model configuration control");q=await a.quote(p.data.job_id);
db("insert into test_gates(name,enabled,hits) values('unit-claimed',true,0) on conflict(name) do update set enabled=true,hits=0");
try{
  assert.equal((await a.start(q)).code,200);
  await poll(async()=>Number(db("select hits from test_gates where name='unit-claimed'")),n=>n>0);
  db(`update jobs set quote=jsonb_set(quote,'{rates_version}',to_jsonb('unconfigured-test-rates'::text)) where id='${q.job_id}'`);
  db("update test_gates set enabled=false where name='unit-claimed'");
  const stopped=await a.done(q.job_id);assert.equal(stopped.stage,"FAILED");assert.equal(stopped.error,"MODEL_CONFIGURATION_CHANGED");
  assert.equal(db(`select count(*) from calls where job_id='${q.job_id}'`),"0");
  evidence.push({case:"approved-model-settings-change",error:stopped.error,paid_calls:0});
}finally{db("update test_gates set enabled=false where name='unit-claimed'");}
// Ordered canonical header/footer aliases are expanded without losing repeated numeric occurrences.
p=await a.prepare(await fixturePDF(3,"running"),"running.pdf");q=await a.quote(p.data.job_id);
assert.equal(q.stage,"AWAITING_APPROVAL");
const ir=JSON.parse(db(`select ir from jobs where id='${q.job_id}'`));
assert.ok(ir.blocks.some((b:any)=>b.aliases?.length===2));assert.equal(new Set(ir.order).size,ir.order.length);
await a.start(q);const result=await a.done(q.job_id);assert.equal(result.stage,"SUCCEEDED");assert.equal(result.quality.numbers.rate,1);
const path=db(`select artifact->>'path' from jobs where id='${q.job_id}'`);
const text=compose(["exec","-T","worker","pdftotext",path,"-"]);
assert.equal((text.match(/Drive manual 12/g)??[]).length,3);assert.equal((text.match(/Service every 100 km/g)??[]).length,6);
evidence.push({case:"running-text-alias-order",header_occurrences:3,footer_and_body_occurrences:6,numeric_rate:1});
// The renderer creates a clean catalog rather than copying source active objects.
p=await a.prepare(await fixturePDF(1,"active"),"active.pdf");q=await a.quote(p.data.job_id);await a.start(q);
assert.equal((await a.done(q.job_id)).stage,"SUCCEEDED");
const bytes=await fetch(base+`/api/translations/${q.job_id}/artifact`,{headers:{Cookie:a.cookie}}).then(r=>r.arrayBuffer());
const pdf=await PDFDocument.load(bytes);assert.equal(pdf.catalog.get(PDFName.of("OpenAction")),undefined);
assert.equal(pdf.catalog.get(PDFName.of("Names")),undefined);evidence.push({case:"fresh-pdf-catalog",active_objects_copied:0});
// Two processes reconcile/claim the same ready corpus without duplicating logical calls.
const extra=`${project}-competing-${crypto.randomUUID().slice(0,8)}`;
compose(["run","-d","--no-deps","--name",extra,"worker"]);
try{
  const jobs=await Promise.all(Array.from({length:4},(_,n)=>a.prepare(source+` competing ${n}`)));
  for(const doc of jobs){const quote=await a.quote(doc.data.job_id);await a.start(quote);}
  for(const doc of jobs){
    assert.equal((await a.done(doc.data.job_id)).stage,"SUCCEEDED");
    assert.equal(db(`select count(*) from (select call_id,count(*) n from fake_events where job_id='${doc.data.job_id}' group by call_id having count(*)>1) t`),"0");
  }
  evidence.push({case:"competing-reconcilers-and-workers",jobs:4,duplicate_paid_calls:0});
}finally{docker(["kill","--signal","SIGKILL",extra]);docker(["rm",extra]);}
await writeFile("evidence/contracts.json",JSON.stringify(evidence,null,2));console.log(JSON.stringify({passed:evidence.length,evidence:"evidence/contracts.json"}));
