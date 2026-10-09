import {strict as assert} from "node:assert";
import {spawnSync} from "node:child_process";
import {join,resolve} from "node:path";
import {assembleTranslations,hash,literals,validateOutput} from "../../src/domain";

// Read-only checkpoint analysis. No provider imports or paid transport.
const out=import.meta.dir,root=resolve(out,"../.."),run=await Bun.file(join(out,"comparison.json")).json();
const records:any[]=[],observed:any[]=[];
function db(query:string){
  const r=spawnSync("docker",["compose","exec","-T","postgres","psql","-U","translator","-d","translator","-Atc",query],{cwd:root,encoding:"utf8"});
  assert.equal(r.status,0);return JSON.parse(r.stdout.trim());
}
for(const row of run.rows){
  assert.ok(/^[0-9a-f-]{36}$/.test(row.job_id));
  const data=db(`select json_build_object('source_hash',source_hash,'artifact_hash',artifact->>'hash','blocks',ir->'blocks','responses',(select json_agg(c.response->>'raw' order by u.sequence) from calls c join units u on u.id=c.unit_id where c.job_id=j.id and c.kind='TRANSLATE' and c.state='COMPLETED'),'observed',(select json_agg(json_build_object('model',c.response->'providerData'->>'model','reasoning_effort',c.response->'providerData'->'reasoning'->>'effort','cache_options',c.response->'providerData'->'prompt_cache_options','cache_retention',c.response->'providerData'->>'prompt_cache_retention')) from calls c where c.job_id=j.id and c.kind='AGENT' and c.state='COMPLETED')) from jobs j where id='${row.job_id}'`);
  assert.equal(data.source_hash,row.source_sha256);
  assert.equal(hash(new Uint8Array(await Bun.file(join(out,"inputs",row.id+"."+row.format)).arrayBuffer())),row.source_sha256);
  const translations=assembleTranslations(data.blocks,(data.responses??[]).flatMap((r:string)=>JSON.parse(r).blocks));
  const violations=data.blocks.flatMap((b:any)=>{
    const t=translations.find(t=>t.id===b.id)!;
    return JSON.stringify(literals(b.text).sort())===JSON.stringify(literals(t.text).sort())?[]:[{block_id:b.id,source:b.text,translation:t.text,expected:literals(b.text).sort(),actual:literals(t.text).sort()}];
  });
  let validation="passed";try{validateOutput(data.blocks,translations,"german");}catch(e:any){validation=e.code??e.message;}
  assert.equal(validation,row.stage==="SUCCEEDED"?"passed":"INVALID_MODEL_OUTPUT");
  const path="outputs/"+row.model+"-"+row.id+"-"+row.format+"-blocks.json";
  const blockEvidence=JSON.stringify({job_id:row.job_id,format:row.format,source_sha256:row.source_sha256,stage:row.stage,checkpoint_analysis:true,blocks:data.blocks,translations,validation,literal_violations:violations},null,2);
  if(await Bun.file(join(out,path)).exists())assert.equal(await Bun.file(join(out,path)).text(),blockEvidence,"existing separate evidence must match exactly");
  else await Bun.write(join(out,path),blockEvidence);
  if(row.stage==="SUCCEEDED"){
    const bytes=new Uint8Array(await Bun.file(join(out,row.artifact)).arrayBuffer());assert.equal(hash(bytes),data.artifact_hash);
    if(row.format==="md"){const text=new TextDecoder().decode(bytes);assert.ok(text.includes("`MODEL-X`"));assert.ok(text.includes("docs/manual.md"));}
    else assert.equal(new TextDecoder().decode(bytes.slice(0,5)),"%PDF-");
  }
  records.push({model:row.model,id:row.id,format:row.format,stage:row.stage,path,validation,artifact_checksum:data.artifact_hash,literal_violations:violations});
  observed.push({model:row.model,id:row.id,format:row.format,responses:data.observed});
}
const shared=run.rows.filter((r:any)=>r.model==="gpt-4.1-mini"&&r.stage==="SUCCEEDED"&&run.rows.some((a:any)=>a.model==="gpt-6-astra"&&a.id===r.id&&a.format===r.format&&a.stage==="SUCCEEDED"));
const common:any={};
for(const model of ["gpt-4.1-mini","gpt-6-astra"]){
  const r=run.rows.filter((r:any)=>r.model===model&&shared.some((s:any)=>s.id===r.id&&s.format===r.format));
  const expected=r.reduce((n:number,r:any)=>n+r.terminology.expected,0),matched=r.reduce((n:number,r:any)=>n+r.terminology.matched,0);
  common[model]={documents:r.length,expected,matched,rate:matched/expected,mean_elapsed_ms:r.reduce((n:number,r:any)=>n+r.elapsed_ms,0)/r.length};
}
const failures=records.filter(r=>r.stage!=="SUCCEEDED");
const analysis={method:"Read-only extraction of existing completed call checkpoints. Format-specific filenames recover Markdown evidence overwritten by the original runner's PDF block filename; original ambiguous files remain and are superseded by this explicit manifest. No extra provider calls or changed references. The executed runner snapshot is runner-source.ts; the current runner fixes the filename.",
  comparison_source_sha256:hash(new Uint8Array(await Bun.file(join(out,"comparison.json")).arrayBuffer())),records,observed,common_successful_pairs:common,failures,
  known_cost_ratio:run.summaries.astra.known_cost_usd/run.summaries.mini.known_cost_usd,
  known_cost_usd:run.summaries.astra.known_cost_usd+run.summaries.mini.known_cost_usd};
const manifest=await Bun.file(join(out,"source-manifest.json")).json();
for(const f of manifest){const path=f.path==="scripts/model-compare.ts"?join(out,"runner-source.ts"):join(root,f.path);assert.equal(hash(new Uint8Array(await Bun.file(path).arrayBuffer())),f.sha256);}
await Bun.write(join(out,"analysis.json"),JSON.stringify(analysis,null,2));
console.log(JSON.stringify({documents:records.length,common,failures,known_cost_ratio:analysis.known_cost_ratio,known_cost_usd:analysis.known_cost_usd}));
