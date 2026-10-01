import {strict as assert} from "node:assert";
import {writeFile} from "node:fs/promises";
import {setup,Session,db,poll} from "./test-support";
import {source} from "./fixtures";
await setup(process.env.SKIP_BUILD!=="1");
const a=new Session(),b=new Session(),form=new FormData();
for(let n=0;n<3;n++)form.append("file",new Blob([source+` folder ${n}`]),`doc-${n}.md`);
form.append("target_language","german");
const p=await a.request("/api/translation-groups",form,crypto.randomUUID()),id=p.data.group_id;
const group=await poll(async()=>(await a.request(`/api/translation-groups/${id}`)).data,g=>g.children.every((c:any)=>c.stage==="AWAITING_APPROVAL"));
const small=await b.prepare(source+" another owner"),quote=await b.quote(small.data.job_id);
db("insert into test_gates(name,enabled,hits) values('provider-accepted',true,0) on conflict(name) do update set enabled=true,hits=0");
try{
  const cap=group.children.reduce((n:number,c:any)=>n+c.quote.maximum_reserved_usd,0);
  assert.equal((await a.request(`/api/translation-groups/${id}/start`,JSON.stringify({quote_version:group.quote_version,max_total_cost_usd:cap}),crypto.randomUUID())).code,200);
  await poll(async()=>Number(db(`select count(*) from units u join jobs j on j.id=u.job_id where j.group_id='${id}' and u.state='RUNNING' and u.kind in ('TERMS','TRANSLATE')`)),n=>n===2);
  const started=Date.now();await b.start(quote);
  await poll(async()=>Number(db(`select count(*) from fake_events where job_id='${quote.job_id}'`)),n=>n>0,6000);
  const admission=Date.now()-started;assert.ok(admission<=5000,`${admission}`);
  db("update test_gates set enabled=false where name='provider-accepted'");
  assert.equal((await b.done(quote.job_id)).stage,"SUCCEEDED");
  for(const c of group.children)assert.equal((await a.done(c.job_id)).stage,"SUCCEEDED");
  await writeFile("evidence/folder-fairness.json",JSON.stringify({folder_children:3,held_folder_slots:2,other_owner_admission_ms:admission,completed:4,global_slots:4,folder_slots:2},null,2));
  console.log(JSON.stringify({passed:true,evidence:"evidence/folder-fairness.json",admission_ms:admission}));
}finally{db("update test_gates set enabled=false where name='provider-accepted'");}
