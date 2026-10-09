import {test,expect} from "bun:test";
process.env.PROVIDER_MODE="fake";
process.env.MODEL="gpt-4.1-mini";
const {validateOutput,assembleTranslations}=await import("../../src/domain");
const check=(source:string,output:string)=>validateOutput([{id:"b",text:source}],[{id:"b",text:output}],"german");

test("German decimal and thousands separators match their English numeric literals",()=>{
  expect(check("Voltage is 4.2 V.","Spannung ist 4,2 V.").rate).toBe(1);
  expect(check("Mass 1,234.5 kg.","Masse 1.234,5 kg.").rate).toBe(1);
  expect(check("Range 10-20 kg.","Bereich 10–20 kg.").rate).toBe(1);
  expect(check("Range 10–20 kg.","Bereich 10-20 kg.").rate).toBe(1);
});
test("numeric changes hidden by separators are rejected",()=>{
  expect(()=>check("Voltage is 4.2 V.","Spannung ist 42 V.")).toThrow("INVALID_MODEL_OUTPUT");
  expect(()=>check("Voltage is 42 V.","Spannung ist 4,2 V.")).toThrow("INVALID_MODEL_OUTPUT");
  expect(()=>check("Keep 12 kW.","Behalten Sie 13 kW.")).toThrow("INVALID_MODEL_OUTPUT");
  expect(()=>check("Range 10-20 kg.","Bereich 10-21 kg.")).toThrow("INVALID_MODEL_OUTPUT");
});
test("URLs, emails and codes still must match exactly",()=>{
  expect(()=>check("See https://example.com/manual.","Siehe https://example.com/manual.")).not.toThrow();
  expect(()=>check("See https://example.com/manual.","Siehe https://example.com/handbuch.")).toThrow("INVALID_MODEL_OUTPUT");
  expect(()=>check("Mail ops@example.com now.","Mail an info@example.com jetzt.")).toThrow("INVALID_MODEL_OUTPUT");
  expect(()=>check("Part ABC-12 fits.","Teil ABC-13 passt.")).toThrow("INVALID_MODEL_OUTPUT");
});
test("assembleTranslations keeps block order and joins ordered split pieces",()=>{
  const blocks=[{id:"b0",text:"x"},{id:"b1",text:"y"},{id:"b2",text:"z"}];
  expect(assembleTranslations(blocks,[{id:"b2",text:"Z"},{id:"b1.s1",text:"c"},{id:"b0",text:"X"},{id:"b1.s0",text:"a"}]))
    .toEqual([{id:"b0",text:"X"},{id:"b1",text:"ac"},{id:"b2",text:"Z"}]);
});
test("assembleTranslations rejects duplicate, mixed, missing, gapped and misnamed pieces",()=>{
  const blocks=[{id:"b0",text:"x"}];
  const bad=[
    [{id:"b0",text:"a"},{id:"b0",text:"b"}],
    [{id:"b0",text:"a"},{id:"b0.s0",text:"b"}],
    [],
    [{id:"b0.s1",text:"b"}],
    [{id:"b0.s0",text:"a"},{id:"b0.s2",text:"c"}],
    [{id:"b0.s0",text:"a"},{id:"b0.s0",text:"a"}],
    [{id:"b0.sx",text:"a"}],
  ];
  for(const t of bad)expect(()=>assembleTranslations(blocks,t)).toThrow("ARTIFACT_INCOMPLETE");
});
test("assembleTranslations handles 16000 blocks quickly and correctly",()=>{
  const n=16000;
  const blocks=Array.from({length:n},(_,i)=>({id:`b${i}`,text:`t${i}`}));
  const translations:{id:string;text:string}[]=[];
  for(let i=n-1;i>=0;i--){
    if(i%10===0){translations.push({id:`b${i}.s1`,text:"2"},{id:`b${i}.s0`,text:"1"});}
    else translations.push({id:`b${i}`,text:`T${i}`});
  }
  const start=performance.now();
  const out=assembleTranslations(blocks,translations);
  const elapsed=performance.now()-start;
  expect(elapsed).toBeLessThan(300);
  expect(out.length).toBe(n);
  expect(out[0]).toEqual({id:"b0",text:"12"});
  expect(out[1]).toEqual({id:"b1",text:"T1"});
  expect(out[n-1]).toEqual({id:`b${n-1}`,text:`T${n-1}`});
});
