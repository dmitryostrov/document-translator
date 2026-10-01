import { readFile,writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
const measurements=JSON.parse(await readFile("evidence/live-measurements.json","utf8"));
const refs=[{term:"drive",pattern:"Antrieb"},{term:"battery",pattern:"Batterie|Akku"},{term:"motor",pattern:"Motor"},{term:"Service",pattern:"Wart|warten|gewartet|gewartet"}];
const review:any[]=[];let expected=0,correct=0,numbers=0,preserved=0;
for(const sample of measurements.rows.filter((r:any)=>r.concurrency===1&&r.target==="german")){
  const query=`select json_build_object('ir',ir,'parts',(select json_agg(result->'blocks' order by sequence) from units where job_id=j.id and kind='TRANSLATE')) from jobs j where id='${sample.job_id}'`;
  const p=spawnSync("docker",["compose","exec","-T","postgres","psql","-U","stark","-d","stark","-Atc",query],{encoding:"utf8"});
  if(p.status!==0)throw new Error("QUALITY_EVIDENCE_UNAVAILABLE");
  const data=JSON.parse(p.stdout),parts=data.parts.flat();
  for(const b of data.ir.blocks){
    const out=parts.find((t:any)=>t.id===b.id)?.text??parts.filter((t:any)=>t.id.startsWith(b.id+".s")).map((t:any)=>t.text).join("");
    for(const ref of refs){
      const count=(b.text.match(new RegExp(`\\b${ref.term}\\b`,"gi"))??[]).length;
      if(!count)continue;const accepted=(out.match(new RegExp(ref.pattern,"gi"))??[]).length;
      expected+=count;correct+=Math.min(count,accepted);
      for(let n=0;n<count&&review.length<40;n++)review.push({index:review.length+1,job_id:sample.job_id,block_id:b.id,term:ref.term,reference:ref.pattern,source:b.text,translation:out,provisional_pass:accepted>=count});
    }
  }
  numbers+=sample.numeric.expected;preserved+=sample.numeric.correct;
}
const score={reference_status:"AI-curated candidate reference. Independent human approval pending; this is not final acceptance.",occurrences:expected,matched:correct,rate:expected?correct/expected:null,numeric:{occurrences:numbers,preserved,rate:numbers?preserved/numbers:null},review};
await writeFile("evidence/quality.json",JSON.stringify(score,null,2));
const md="# Translation quality review\n\nThese 40 occurrences come from the fixed English-to-German corpus. Candidate references were curated by Codex, not approved by a human. Review the expected terminology and sentence meaning; approval is a separate acceptance gate. The complete numeric/terminology measurement is in [quality.json](quality.json).\n\n"+review.map(r=>`## ${r.index}. ${r.term} → ${r.reference}\n\nSource: ${r.source}\n\nOutput: ${r.translation}\n\nCandidate match: ${r.provisional_pass}. Job: \`${r.job_id}\`, block: \`${r.block_id}\`.\n`).join("\n");
await writeFile("evidence/quality-review.md",md);
console.log(JSON.stringify({occurrences:expected,matched:correct,rate:score.rate,numeric:score.numeric,review_occurrences:review.length}));
