import { mkdir,writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { hash } from "../src/domain";
import { fixturePDF } from "./fixtures";
const base=process.env.LIVE_API_URL??"http://127.0.0.1:3100";
const mode=await fetch(base+"/health").then(r=>r.json());
if(mode.provider_mode!=="openai")throw new Error("LIVE_MEASUREMENT_REQUIRES_OPENAI");
const rows:any[]=[],failures:any[]=[];
await mkdir("evidence/live-artifacts",{recursive:true});
const db=(query:string)=>{
  const r=spawnSync("docker",["compose","exec","-T","postgres","psql","-U","stark","-d","stark","-Atc",query],{encoding:"utf8"});
  if(r.status!==0)throw new Error("MEASUREMENT_DATABASE_UNAVAILABLE");return r.stdout.trim();
};
async function run(index:number,concurrency:number,target="german",existingCookie=""){
  let cookie=existingCookie;
  const format=index%2?"pdf":"md",medium=index>=5;
  const text=`# Drive system ${index}\n\nThe drive means the motor assembly in this manual.\n\n`+
    Array.from({length:medium?16:2},(_,n)=>`The battery supplies 12 kW. Service the motor every 100 km. Record the battery temperature before charging. Inspection step ${n+1} protects the motor and the charging system.`).join("\n\n");
  const bytes=format==="pdf"?await fixturePDF(medium?4:1):new TextEncoder().encode(text);
  const request=async(path:string,body?:BodyInit,key?:string)=>{
    const r=await fetch(base+path,{method:body?"POST":"GET",body,headers:{...(cookie?{Cookie:cookie}:{}),...(key?{"Idempotency-Key":key}:{}),...(typeof body==="string"?{"Content-Type":"application/json"}:{})}});
    if(r.headers.has("set-cookie"))cookie=r.headers.get("set-cookie")!.split(";")[0];
    const data=await r.json();if(!r.ok)throw new Error(`HTTP_${r.status}_${data.error?.code}`);return data;
  };
  const begin=Date.now(),form=new FormData();form.append("file",new Blob([bytes]),`corpus-${index}.${format}`);form.append("target_language",target);
  const prepared=await request("/api/translations",form,crypto.randomUUID());
  const status=()=>request(`/api/translations/${prepared.job_id}`);
  let q=await status();
  while(q.stage==="PREFLIGHT"){await Bun.sleep(200);q=await status();}
  if(q.stage!=="AWAITING_APPROVAL")throw new Error(`PREFLIGHT_${q.error}`);
  await request(`/api/translations/${q.job_id}/start`,JSON.stringify({quote_version:q.quote.version,max_cost_usd:Math.max(.2,q.quote.maximum_reserved_usd)}),crypto.randomUUID());
  let done=await status();const deadline=Date.now()+10*60_000;
  while(!["SUCCEEDED","FAILED","NEEDS_ATTENTION"].includes(done.stage)){
    if(Date.now()>deadline)throw new Error("MEASUREMENT_DEADLINE");await Bun.sleep(250);done=await status();
  }
  const receipt=await request(`/api/translations/${q.job_id}/receipt`);
  if(done.stage!=="SUCCEEDED"){
    const failure={index,concurrency,format,target,job_id:q.job_id,stage:done.stage,error:done.error,cost:done.cost};
    failures.push(failure);console.log(JSON.stringify(failure));return null;
  }
  const output=await fetch(base+done.artifact.url,{headers:{Cookie:cookie}}).then(r=>r.arrayBuffer());
  const path=`evidence/live-artifacts/${q.job_id}.${format}`;await writeFile(path,new Uint8Array(output));
  const calls=JSON.parse(db(`select coalesce(json_agg(json_build_object('kind',kind,'state',state,'usage',usage,'cost',cost)), '[]') from calls where job_id='${q.job_id}'`));
  const row={index,concurrency,format,target,size:medium?"medium":"small",source_sha256:hash(bytes),job_id:q.job_id,elapsed_ms:Date.now()-begin,quote:q.quote,cost:done.cost,numeric:done.quality.numbers,tools:receipt.glossary.tool_calls,calls,artifact:path,cookie};
  rows.push(row);const {cookie:_,...publicRow}=row;console.log(JSON.stringify({index,concurrency,format,target,elapsed_ms:row.elapsed_ms,cost:row.cost.known_cost_usd,calls:calls.length,tools:row.tools}));
  return row;
}
for(let i=0;i<10;i++)await run(i,1);
let cursor=0;await Promise.all(Array.from({length:4},async()=>{while(cursor<10){const n=cursor++;await run(n,4);}}));
// Result-memory reuse is owner scoped and measured separately from cold inference.
const md=rows.find(r=>r.index===0&&r.concurrency===1);
const warm=md?await run(0,0,"german",md.cookie):null;
await run(0,1,"french");
function summary(list:any[]){
  const values=list.map(x=>x.elapsed_ms).sort((a,b)=>a-b);
  return {n:list.length,p50_ms:values[Math.max(0,Math.ceil(values.length*.5)-1)]??null,p95_ms:values[Math.max(0,Math.ceil(values.length*.95)-1)]??null,
    mean_cost_usd:list.length?list.reduce((n,r)=>n+r.cost.known_cost_usd,0)/list.length:null,
    input_tokens:list.reduce((n,r)=>n+r.cost.tokens.input,0),output_tokens:list.reduce((n,r)=>n+r.cost.tokens.output,0),cached_tokens:list.reduce((n,r)=>n+r.cost.tokens.cached,0),cache_write_tokens:list.reduce((n,r)=>n+r.cost.tokens.cache_write,0)};
}
const result={measured_at:new Date().toISOString(),model:"gpt-4.1-mini",rates_usd_per_million:{input:.4,cached:.1,write:.4,output:1.6},method:"Fixed synthetic corpus; cold means distinct owner, no local result-memory reuse. Wall time includes preflight, approval/start request, queue, all agent turns, validation and rendering. Provider prefix caching remains enabled. Warm memory and French samples excluded from cold p95.",cold:summary(rows.filter(r=>[1,4].includes(r.concurrency)&&r.target==="german")),concurrency_1:summary(rows.filter(r=>r.concurrency===1&&r.target==="german")),concurrency_4:summary(rows.filter(r=>r.concurrency===4)),warm_memory:warm?summary([warm]):null,failures,rows:rows.map(({cookie,...r})=>r),quality_reference_status:"Candidate references require independent human approval; numeric preservation measured automatically."};
await writeFile("evidence/live-measurements.json",JSON.stringify(result,null,2));
console.log(JSON.stringify({evidence:"evidence/live-measurements.json",cold:result.cold,failures:failures.length}));
