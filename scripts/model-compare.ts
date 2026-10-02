import {strict as assert} from "node:assert";
import {mkdir,readFile,writeFile} from "node:fs/promises";
import {join,resolve} from "node:path";
import {spawnSync} from "node:child_process";
import {PDFDocument,StandardFonts} from "pdf-lib";
import {assembleTranslations,cost,hash,literals} from "../src/domain";
import {modelProfile} from "../src/models";

if(process.env.ALLOW_LIVE_COMPARISON!=="1")throw new Error("LIVE_COMPARISON_REQUIRES_EXPLICIT_OPT_IN");
const root=resolve(import.meta.dir,".."),out=resolve(root,process.env.COMPARE_OUTPUT_DIR??"evidence/model-comparison-2026-10-02");
assert.ok(out.startsWith(resolve(root,"evidence")+"\\")||out.startsWith(resolve(root,"evidence")+"/"));
const base="http://127.0.0.1:3100",budget=5,rows:any[]=[],controls:any[]=[];
const topics=[
  {id:"battery",title:"Battery service",paragraphs:[
    "The battery supplies 12 kW to the drive system. Inspect the battery before every service visit.",
    "The motor must remain stopped while the battery cable is disconnected. Never energize the motor during inspection.",
    "Measure the voltage before closing the cover. The voltage must remain below 72 V during this check.",
    "The current is electric current through the cable. Record the current at 15 A before the test ends.",
    "Service the drive system every 100 km. The drive means the motor assembly in this manual.",
    "Record the battery temperature before charging. Keep MODEL-X and https://example.com/manual unchanged."
  ]},
  {id:"seal",title:"Inspection label",paragraphs:[
    "The seal must be replaced after every inspection. Photograph the seal before removing it.",
    "Record inspection step 3 and the date before starting work. The motor must remain disconnected.",
    "Attach the new seal across the cover joint. Confirm that the seal breaks if the cover is opened.",
    "This inspection is performed every 100 km. Keep MODEL-X in the service record.",
    "The seal is a tamper-evident adhesive security label. It is not a rubber gasket and has no fluid-sealing function.",
    "A missing seal indicates that the cover may have been opened. Replace the seal after completing service."
  ]},
  {id:"ground",title:"Isolated electrical return",paragraphs:[
    "Connect the measurement lead to ground before measuring the voltage. Disconnect the lead after the test.",
    "Measure 12 V relative to ground. Ground is the common return reference for this isolated battery circuit.",
    "The ground connection is attached to the chassis. It is not a protective earth connection to the soil.",
    "Inspect the lead for damage before the motor starts. The lead is an insulated electrical cable, not the metal lead.",
    "Keep the current below 15 A. Record the voltage and inspect the battery after the test.",
    "Do not confuse ground with earth. The circuit remains electrically isolated during service."
  ]},
  {id:"cell",title:"Battery cell connections",paragraphs:[
    "The cell is one electrochemical unit inside the battery pack. Measure the cell voltage before charging.",
    "The terminal is the cell's electrical connector. Inspect the terminal before connecting the lead.",
    "The lead is the insulated cable attached to the terminal. This lead contains no exposed conductor.",
    "The charge is electric charge stored in the cell, not a fee. Record the charge transferred during the 10 second test.",
    "Keep the voltage below 4.2 V and the current below 15 A. Stop charging if the battery temperature rises.",
    "Service the motor every 100 km. Keep MODEL-X and https://example.com/manual in the inspection record."
  ]}
];
const references=[
  {source:"battery",accepted:["Batterie","Batterien","Akku","Akkus"]},
  {source:"motor",accepted:["Motor","Motoren"]},{source:"drive",accepted:["Antrieb","Antriebs","Antriebe"]},
  {source:"service",accepted:["Wartung","Warten","warten","gewartet"]},
  {source:"voltage",accepted:["Spannung","Spannungen"]},{source:"current",accepted:["Strom","Stromstärke"]},
  {source:"seal",accepted:["Siegel","Manipulationssiegel","Sicherungsetikett","Sicherheitsetikett","Versiegelung"]},
  {source:"ground",accepted:["Masse","Masseanschluss","Masseverbindung"]},
  {source:"lead",accepted:["Leitung","Kabel","Anschlussleitung"]},
  {source:"cell",accepted:["Zelle","Zellen","Batteriezelle","Batteriezellen","Akkuzelle"]},
  {source:"terminal",accepted:["Anschluss","Anschlüsse","Anschlussklemme","Anschlussklemmen","Klemme","Klemmen","Pol","Pole"]},
  {source:"charge",accepted:["Ladung","Ladezustand"]}
];
const escaped=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
function score(blocks:any[],translations:any[]){
  let expected=0,matched=0;const details:any[]=[];
  for(const b of blocks){const text=translations.find(t=>t.id===b.id)?.text??"";
    for(const ref of references){
      const n=(b.text.match(new RegExp("\\b"+escaped(ref.source)+"\\b","gi"))??[]).length;if(!n)continue;
      const pattern="(?<![\\p{L}\\p{N}])(?:"+ref.accepted.map(escaped).join("|")+")(?![\\p{L}\\p{N}])";
      const hits=(text.match(new RegExp(pattern,"giu"))??[]).length;
      expected+=n;matched+=Math.min(n,hits);details.push({block_id:b.id,term:ref.source,expected:n,matched:Math.min(n,hits),source:b.text,translation:text});
    }
  }
  return {expected,matched,rate:expected?matched/expected:null,details};
}
const environment=(model:string)=>({...process.env,MODEL:model,PROVIDER_MODE:"openai",APP_PORT:"3100"});
function compose(args:string[],model:string){
  const p=spawnSync("docker",["compose",...args],{cwd:root,env:environment(model),encoding:"utf8",maxBuffer:4*1024*1024});
  if(p.status!==0)throw new Error("COMPARISON_DOCKER_FAILED:"+p.stderr.slice(-1000));return p.stdout.trim();
}
function db(query:string){return compose(["exec","-T","postgres","psql","-U","stark","-d","stark","-Atc",query],"gpt-6-astra");}
async function switchModel(model:string){
  assert.equal(db("select count(*) from jobs where stage in ('PREFLIGHT','TERMINOLOGY','TRANSLATING','RENDERING')"),"0","refuse to change model during active work");
  compose(["up","-d","--wait","--wait-timeout","120","api","worker"],model);
  const h=await fetch(base+"/health").then(r=>r.json());assert.equal(h.provider_mode,"openai");assert.equal(h.model,model);
  console.log(JSON.stringify({phase:model,reasoning:h.reasoning_effort}));
}
class Owner{
  cookie="";
  async request(path:string,body?:BodyInit){
    const r=await fetch(base+path,{method:body?"POST":"GET",body,headers:{...(this.cookie?{Cookie:this.cookie}:{}),...(body?{"Idempotency-Key":crypto.randomUUID()}:{}),...(typeof body==="string"?{"Content-Type":"application/json"}:{})}});
    if(r.headers.has("set-cookie"))this.cookie=r.headers.get("set-cookie")!.split(";")[0];
    return {status:r.status,data:await r.json()};
  }
  async prepare(input:any){
    const f=new FormData();f.append("file",new Blob([new Uint8Array(input.bytes)]),input.id+"."+input.format);f.append("target_language","german");
    const submitted=await this.request("/api/translations",f);assert.equal(submitted.status,202);
    const begin=Date.now();let job:any;
    do{job=(await this.request("/api/translations/"+submitted.data.job_id)).data;if(["AWAITING_APPROVAL","FAILED"].includes(job.stage))return job;await Bun.sleep(200);}while(Date.now()-begin<90_000);
    throw new Error("COMPARISON_PREFLIGHT_DEADLINE");
  }
}
async function pdf(topic:typeof topics[number]){
  const doc=await PDFDocument.create(),font=await doc.embedFont(StandardFonts.Helvetica);let page=doc.addPage([595,842]),y=770;
  for(const para of [topic.title,...topic.paragraphs]){let line="";
    for(const word of para.split(" ")){const next=line?line+" "+word:word;
      if(font.widthOfTextAtSize(next,11)>505&&line){page.drawText(line,{x:45,y,size:11,font});y-=17;line=word;}else line=next;
      if(y<60){page=doc.addPage([595,842]);y=770;}
    }
    if(line){page.drawText(line,{x:45,y,size:11,font});y-=25;}
  }
  return new Uint8Array(await doc.save());
}
const consumed=()=>rows.reduce((n,r)=>n+r.cost.known_cost_usd+r.cost.unresolved_exposure_usd+r.cost.active_reserved_usd,0);
const summary=(model:string)=>{
  const r=rows.filter(r=>r.model===model),success=r.filter(r=>r.stage==="SUCCEEDED"),times=success.map(r=>r.elapsed_ms).sort((a,b)=>a-b);
  const expected=success.reduce((n,r)=>n+(r.terminology?.expected??0),0),matched=success.reduce((n,r)=>n+(r.terminology?.matched??0),0);
  return {attempted:r.length,succeeded:success.length,artifacts_verified:success.filter(r=>r.artifact_verified).length,failed:r.filter(r=>r.stage!=="SUCCEEDED").length,
    p50_success_ms:times[Math.max(0,Math.ceil(times.length*.5)-1)]??null,p95_success_ms:times[Math.max(0,Math.ceil(times.length*.95)-1)]??null,
    known_cost_usd:r.reduce((n,r)=>n+r.cost.known_cost_usd,0),unresolved_exposure_usd:r.reduce((n,r)=>n+r.cost.unresolved_exposure_usd,0),
    mean_known_cost_per_attempt_usd:r.length?r.reduce((n,r)=>n+r.cost.known_cost_usd,0)/r.length:null,
    terminology:{reference_status:"AI-authored diagnostic references, not human approved; AC1 remains unmet",expected,matched,rate:expected?matched/expected:null},
    tokens:r.reduce((a,r)=>{for(const key of Object.keys(a))a[key]+=r.cost.tokens[key]??0;return a;},{input:0,output:0,cached:0,cache_write:0,reasoning:0}),
    rates:modelProfile(model).rates,reasoning_effort:modelProfile(model).reasoning??null};
};
async function save(error?:string){
  await writeFile(join(out,"comparison.json"),JSON.stringify({measured_at:new Date().toISOString(),budget_usd:budget,consumed_usd:consumed(),error:error??null,
    method:"Eight paired PDF/Markdown inputs from four fresh synthetic topics; sequential, separate owners, no local result reuse. Same prompts, policy and pipeline. Mini first then Astra low; order/cache/provider variability can affect timing. p95 over eight successful samples is descriptive, not a population estimate. Actual completed-call usage includes agent turns, reasoning output and cache writes; unknown charges remain separate. Diagnostic lexemes were fixed before outputs, but are AI-authored and do not close AC1.",
    policy:"visible-v3",prompt:"translation-v2",summaries:{mini:summary("gpt-4.1-mini"),astra:summary("gpt-6-astra")},controls,rows},null,2));
}
await mkdir(out,{recursive:false});await mkdir(join(out,"inputs"));await mkdir(join(out,"outputs"));
const inputs:any[]=[];
for(const topic of topics)for(const format of ["md","pdf"]){
  const bytes=format==="pdf"?await pdf(topic):new TextEncoder().encode("# "+topic.title+"\n\n"+topic.paragraphs.join("\n\n")+"\n\nRead [the manual](docs/manual.md); keep \`MODEL-X\`.\n");
  const input={id:topic.id,format,bytes,source_sha256:hash(bytes)};inputs.push(input);await writeFile(join(out,"inputs",topic.id+"."+format),bytes);
}
await writeFile(join(out,"references.json"),JSON.stringify({reference_status:"AI-authored before model outputs; not human approved",references},null,2));
await writeFile(join(out,"manifest.json"),JSON.stringify(inputs.map(({bytes,...r})=>r),null,2));
await writeFile(join(out,"source-manifest.json"),JSON.stringify(await Promise.all([
  "src/models.ts","src/config.ts","src/provider.ts","src/domain.ts","src/core.ts","src/worker.ts","scripts/model-compare.ts"
].map(async path=>({path,sha256:hash(new Uint8Array(await readFile(join(root,path))))}))),null,2));
let stale:{owner:Owner;job:any}|undefined;
let active:{owner:Owner;job:any;input:any;model:string;began:number}|undefined;
try{
  for(const model of ["gpt-4.1-mini","gpt-6-astra"]){
    await switchModel(model);
    if(model==="gpt-6-astra"&&stale){
      const rejected=await stale.owner.request("/api/translations/"+stale.job.job_id+"/start",JSON.stringify({quote_version:stale.job.quote.version,max_cost_usd:stale.job.quote.maximum_reserved_usd}));
      assert.equal(rejected.status,409);assert.equal(rejected.data.error.code,"QUOTE_STALE");assert.equal(db("select count(*) from calls where job_id='"+stale.job.job_id+"'"),"0");
      controls.push({case:"old-mini-quote-after-switch",error:"QUOTE_STALE",paid_calls:0});await stale.owner.request("/api/translations/"+stale.job.job_id+"/cancel","{}");
    }
    for(const input of inputs){
      const owner=new Owner(),began=Date.now(),q=await owner.prepare(input);assert.equal(q.stage,"AWAITING_APPROVAL");assert.equal(q.quote.model,model);
      const cap=q.quote.maximum_reserved_usd;
      if(consumed()+cap>budget){await owner.request("/api/translations/"+q.job_id+"/cancel","{}");throw new Error("COMPARISON_BUDGET_BOUND");}
      active={owner,job:q,input,model,began};
      console.log(JSON.stringify({starting:model,case:input.id,format:input.format,job_id:q.job_id,reservation:cap}));
      const started=await owner.request("/api/translations/"+q.job_id+"/start",JSON.stringify({quote_version:q.quote.version,max_cost_usd:cap}));assert.equal(started.status,200);
      let done:any;const deadline=Date.now()+360_000;
      do{done=(await owner.request("/api/translations/"+q.job_id)).data;if(["SUCCEEDED","FAILED","NEEDS_ATTENTION","CANCELED"].includes(done.stage))break;assert.ok(Date.now()<deadline,"COMPARISON_JOB_DEADLINE");await Bun.sleep(250);}while(true);
      const calls=JSON.parse(db("select coalesce(json_agg(json_build_object('id',id,'kind',kind,'state',state,'usage',usage,'cost',cost,'reserved',reserved)), '[]') from calls where job_id='"+q.job_id+"'"));
      const row:any={model,id:input.id,format:input.format,source_sha256:input.source_sha256,job_id:q.job_id,elapsed_ms:Date.now()-began,stage:done.stage,error:done.error,cost:done.cost,quote:q.quote,numeric:done.quality?.numbers??null,calls,artifact_verified:false};
      rows.push(row);active=undefined;await save();
      const receipt=(await owner.request("/api/translations/"+q.job_id+"/receipt")).data;
      assert.equal(receipt.model,model);assert.equal(receipt.reasoning_effort,modelProfile(model).reasoning??null);
      assert.equal(receipt.rates_version,q.quote.rates_version);assert.deepEqual(receipt.cost,done.cost);
      for(const call of calls)if(call.state==="COMPLETED")assert.ok(Math.abs(Number(call.cost)-cost(call.usage,modelProfile(model).rates))<1e-9);
      row.receipt_verified=true;row.accounting_verified=true;
      if(done.stage==="SUCCEEDED"){
        const r=await fetch(base+done.artifact.url,{headers:{Cookie:owner.cookie}}),bytes=new Uint8Array(await r.arrayBuffer());assert.ok(r.ok);assert.equal(hash(bytes),done.artifact.checksum);
        row.artifact="outputs/"+model+"-"+input.id+"."+input.format;await writeFile(join(out,row.artifact),bytes);row.artifact_verified=true;
        const data=JSON.parse(db("select json_build_object('blocks',ir->'blocks','parts',(select json_agg(result->'blocks' order by sequence) from units where job_id=j.id and kind='TRANSLATE')) from jobs j where id='"+q.job_id+"'"));
        const translations=assembleTranslations(data.blocks,data.parts.flat());assert.equal(translations.length,data.blocks.length);
        row.terminology=score(data.blocks,translations);row.coverage={expected:data.blocks.length,translated:translations.length};
        for(const b of data.blocks)assert.deepEqual(literals(b.text).sort(),literals(translations.find(t=>t.id===b.id)!.text).sort());
        await writeFile(join(out,"outputs",model+"-"+input.id+"-"+input.format+"-blocks.json"),JSON.stringify({format:input.format,source_sha256:input.source_sha256,blocks:data.blocks,translations},null,2));
      }
      await save();console.log(JSON.stringify({finished:model,case:input.id,format:input.format,stage:row.stage,elapsed_ms:row.elapsed_ms,known_cost:row.cost.known_cost_usd,error:row.error}));
    }
    if(model==="gpt-4.1-mini"){const owner=new Owner();stale={owner,job:await owner.prepare(inputs[0])};}
  }
  await save();console.log(JSON.stringify({output:out,known_cost_usd:consumed(),mini:summary("gpt-4.1-mini"),astra:summary("gpt-6-astra")}));
}catch(error:any){
  if(active){
    const {owner,job:q,input,model,began}=active;
    let done=(await owner.request("/api/translations/"+q.job_id)).data;
    if(!["SUCCEEDED","FAILED","NEEDS_ATTENTION","CANCELED"].includes(done.stage)){
      await owner.request("/api/translations/"+q.job_id+"/cancel","{}");
      const deadline=Date.now()+120_000;
      do{done=(await owner.request("/api/translations/"+q.job_id)).data;if(["SUCCEEDED","FAILED","NEEDS_ATTENTION","CANCELED"].includes(done.stage))break;await Bun.sleep(250);}while(Date.now()<deadline);
    }
    const calls=JSON.parse(db("select coalesce(json_agg(json_build_object('id',id,'kind',kind,'state',state,'usage',usage,'cost',cost,'reserved',reserved)), '[]') from calls where job_id='"+q.job_id+"'"));
    rows.push({model,id:input.id,format:input.format,source_sha256:input.source_sha256,job_id:q.job_id,elapsed_ms:Date.now()-began,stage:done.stage,error:done.error,cost:done.cost,quote:q.quote,numeric:done.quality?.numbers??null,calls,artifact_verified:false,harness_error:error.message});
  }
  await save(error.message);throw error;
}
finally{await switchModel("gpt-6-astra");}
