import { sql } from "../src/db";
import { translate } from "../src/provider";
import { validateOutput } from "../src/domain";
import { config } from "../src/config";
const [job]=await sql`select * from jobs where id=${process.argv[2]} and stage='SUCCEEDED' and approved=true`;
if(!job||process.env.PROVIDER_MODE!=="openai")throw new Error("LIVE_BENCHMARK_JOB_REQUIRED");
const blocks=Array.from({length:24},(_,n)=>({id:`cache-${n}`,text:`The battery supplies 12 kW. Service the motor every 100 km. Record the battery temperature before charging. Inspection step ${n+1} protects the motor and the charging system. Verify the connectors before reconnecting the battery and keep the maintenance record with the manual.`}));
const rows=[];
for(let n=0;n<4;n++){
  const id=crypto.randomUUID(),worker="prefix-measurement",sequence=200+n;
  const [unit]=await sql`insert into units(id,job_id,kind,sequence,state,lease_owner,lease_expires_at) values(${id},${job.id},'BENCHMARK',${sequence},'RUNNING',${worker},now()+interval '2 minutes') returning *`;
  const began=Date.now(),out=await translate({job:{...job,glossary:{entries:[]},options:{disable_result_cache:true}},unit,worker,generation:0},blocks,[]);
  validateOutput(blocks,out,"german");
  await sql`update units set state='DONE',lease_owner=null,lease_expires_at=null where id=${id}`;
  const [call]=await sql`select cost,usage from calls where unit_id=${id}`;
  rows.push({ordinal:n,elapsed_ms:Date.now()-began,cost_usd:Number(call.cost),usage:call.usage});
}
console.log(JSON.stringify({model:config.model,reasoning_effort:config.reasoning,prompt:"translation-v2",job_id:job.id,local_result_cache:"disabled",method:"Four identical fixed structured translation requests, sequential; distinct accounted call identities. First vs subsequent prefix-cache usage.",before:rows[0],after:rows.slice(1),rows}));
await sql.end();
