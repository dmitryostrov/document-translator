import {test,expect} from "bun:test";
process.env.PROVIDER_MODE="fake";
process.env.MODEL="gpt-4.1-mini";
const {candidateTerms,segmentKey,glossaryUsed}=await import("../../src/provider");
const block=(id:string,text:string)=>({id,text});

test("candidate terms: repeated words, capitalised non-initial words and hyphenated compounds",()=>{
  const blocks=[
    block("b1","Motor torque matters. The motor runs on Battery power."),
    block("b2","Each motor is checked. The drive-train and the drive-train seal. Battery care."),
    block("b3","Service the motor. Torque limits apply; Battery Service intervals."),
  ];
  const terms=candidateTerms(blocks);
  const byTerm=Object.fromEntries(terms.map(t=>[t.term,t]));
  expect(byTerm.motor).toEqual({term:"motor",count:4,first_block_id:"b1"});
  // count 2 and never capitalised away from a sentence start: excluded
  expect(byTerm.torque).toBeUndefined();
  expect(byTerm.battery).toEqual({term:"battery",count:3,first_block_id:"b1"});
  expect(byTerm["drive-train"]).toEqual({term:"drive-train",count:2,first_block_id:"b2"});
  // one non-initial capital occurrence is below the capitalised threshold
  expect(byTerm.service).toBeUndefined();
  // stopwords and short words never qualify
  expect(byTerm.the).toBeUndefined();
  expect(byTerm.with).toBeUndefined();
  expect(byTerm.drive).toBeUndefined();
  // ordered by count desc then term asc
  const counts=terms.map(t=>t.count);
  expect([...counts].sort((a,b)=>b-a)).toEqual(counts);
});

test("candidate terms: capitalised words at sentence start do not count as capitalised; limit applies",()=>{
  const sentenceStarts=candidateTerms([block("a","Ravens fly. Ravens sing. Ravens rest.")]);
  expect(sentenceStarts.find(t=>t.term==="ravens")?.count).toBe(3);
  const many=candidateTerms([block("a",Array.from({length:40},(_,i)=>`word${String.fromCharCode(97+(i%26))}xyz`).join(" ").repeat(3))],5);
  expect(many.length).toBe(5);
});

test("segment key is stable and depends only on the block, target, model and glossary terms it contains",()=>{
  const job={target:"german",glossary:{entries:[
    {term:"Motor",translation:"Motor",evidence_ids:["b1"]},
    {term:"battery",translation:"Batterie",evidence_ids:["b2"]},
  ]}};
  const b=block("b1","The MOTOR needs service.");
  expect(segmentKey(job,b)).toMatch(/^[0-9a-f]{64}$/);
  expect(segmentKey(job,b)).toBe(segmentKey({...job,glossary:{entries:[...job.glossary.entries].reverse()}},b));
  expect(segmentKey(job,b)).toBe(segmentKey({...job,glossary:{entries:[...job.glossary.entries,{term:"battery",translation:"Batterie",evidence_ids:["b9"]}]}},b));
  // a glossary term absent from this block does not change its key
  const c=block("b2","Service only.");
  expect(segmentKey(job,c)).toBe(segmentKey({target:"german",glossary:{entries:[]}},c));
  // a glossary term present in this block does
  expect(segmentKey(job,b)).not.toBe(segmentKey({target:"german",glossary:{entries:[]}},b));
  expect(segmentKey(job,b)).not.toBe(segmentKey({...job,target:"french"},b));
  expect(segmentKey(job,b)).not.toBe(segmentKey(job,block("b1","The MOTOR needs care.")));
});

test("glossary used per block: case-insensitive substring, sorted, only term and translation",()=>{
  const job={glossary:{entries:[
    {term:"Service",translation:"Wartung",evidence_ids:["x"]},
    {term:"motor",translation:"Motor",evidence_ids:["y"]},
    {term:"battery",translation:"Batterie",evidence_ids:["z"]},
    {term:"",translation:"",evidence_ids:[]},
  ]}};
  expect(glossaryUsed(job,block("b","Motor service and SERVICE."))).toEqual([
    {term:"Service",translation:"Wartung"},
    {term:"motor",translation:"Motor"},
  ]);
  expect(glossaryUsed(job,block("b","nothing here"))).toEqual([]);
  expect(glossaryUsed({},block("b","x"))).toEqual([]);
});
