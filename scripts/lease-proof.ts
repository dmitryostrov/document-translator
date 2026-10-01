import { strict as assert } from "node:assert";
import { writeFile } from "node:fs/promises";
import { setup,Session,db,compose,poll } from "./test-support";
import { fixturePDF,source } from "./fixtures";
await setup(process.env.SKIP_BUILD!=="1");const a=new Session();
db("insert into test_gates(name,enabled,hits) values('slow-pdf-subprocess',true,0) on conflict(name) do update set enabled=true,hits=0");
try{
  const p=await a.prepare(await fixturePDF(200),"slow.pdf");
  await poll(async()=>Number(db("select hits from test_gates where name='slow-pdf-subprocess'")),n=>n>0,30000);
  const [unit]=JSON.parse(db(`select json_agg(json_build_object('id',id,'generation',generation,'owner',lease_owner)) from units where job_id='${p.data.job_id}' and state='RUNNING'`));
  await Bun.sleep(23000);
  const lease=Number(db(`select extract(epoch from lease_expires_at-now()) from units where id='${unit.id}'`));
  const ttl=Number(compose(["exec","-T","redis","redis-cli","pttl",`bull:stark-units:wu-${unit.id}-g${unit.generation}:lock`]));
  assert.ok(lease>20,`${lease}`);assert.ok(ttl>45000,`${ttl}`);
  assert.equal(db(`select lease_owner from units where id='${unit.id}'`),unit.owner);
  db("update test_gates set enabled=false where name='slow-pdf-subprocess'");
  assert.equal((await a.quote(p.data.job_id)).stage,"AWAITING_APPROVAL");
  compose(["stop","worker"]);const s=await a.prepare(source+" repeated actual stalls");
  const stalled=JSON.parse(compose(["exec","-T","api","bun","scripts/stall-proof.ts",s.data.job_id]));
  const began=Date.now();compose(["up","-d","worker"]);assert.equal((await a.quote(s.data.job_id)).stage,"AWAITING_APPROVAL");
  const generation=Number(db(`select generation from units where job_id='${s.data.job_id}'`));assert.ok(generation>0);
  await writeFile("evidence/lease-proof.json",JSON.stringify({slow_pdf_pages:200,subprocess_hold_ms:23000,db_lease_remaining_seconds:lease,broker_lock_remaining_ms:ttl,owner_preserved:true,stalled,generation,recovery_ms:Date.now()-began},null,2));
  console.log(JSON.stringify({passed:true,evidence:"evidence/lease-proof.json"}));
}finally{db("update test_gates set enabled=false where name='slow-pdf-subprocess'");compose(["up","-d","worker"]);}
