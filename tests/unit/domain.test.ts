import { describe, expect, test } from "bun:test";
process.env.PROVIDER_MODE="fake";
process.env.MODEL="gpt-4.1-mini";
const {splitBlocks,validateOutput,screenText,quote,cost,assembleTranslations,normalizeTarget}=await import("../../src/domain");
const {config}=await import("../../src/config");
const {markdownIR}=await import("../../src/formats");
describe("document invariants",()=>{
  test("Spanish is accepted and validates Spanish output without claiming calibrated quality",()=>{
    expect(normalizeTarget("SPANISH")).toBe("spanish");
    expect(()=>normalizeTarget("portuguese")).toThrow("LANGUAGE_UNSUPPORTED");
    const source=[{id:"b0",text:"The battery supplies 12 kW. Before servicing the motor, disconnect the battery and carefully inspect the electrical connections. Keep all components clean and follow the maintenance instructions."}];
    const spanish=[{id:"b0",text:"La batería suministra 12 kW. Antes de realizar el mantenimiento del motor, desconecte la batería e inspeccione cuidadosamente las conexiones eléctricas. Mantenga limpios todos los componentes y siga las instrucciones de mantenimiento."}];
    const before=config.mode;config.mode="openai";
    try{
      expect(validateOutput(source,spanish,"spanish").rate).toBe(1);
      expect(()=>validateOutput(source,source,"spanish")).toThrow("INVALID_MODEL_OUTPUT");
    }finally{config.mode=before;}
    expect(quote(markdownIR(source[0].text),"spanish").eta_seconds).toBeNull();
  });
  test("whole-block checks protect a destination spanning split pieces and reject missing pieces",()=>{
    const source=[{id:"b0",text:"See https://example.com/manual. Keep 12 kW."}];
    const pieces=[{id:"b0.s0",text:"See https://example.com/"},{id:"b0.s1",text:"manual. Keep 12 kW."}];
    expect(assembleTranslations(source,pieces)[0].text).toBe(source[0].text);
    const changed=[pieces[0],{...pieces[1],text:"different. Keep 12 kW."}];
    expect(()=>validateOutput(source,assembleTranslations(source,changed),"german")).toThrow("INVALID_MODEL_OUTPUT");
    expect(()=>assembleTranslations(source,[{id:"b0.s1",text:"manual."}])).toThrow("ARTIFACT_INCOMPLETE");
    expect(()=>assembleTranslations(source,[{id:"b0",text:source[0].text},...pieces])).toThrow("ARTIFACT_INCOMPLETE");
  });
  test("source instructions/links cannot manufacture output destinations",()=>{
    expect(()=>validateOutput([{id:"b0",text:"Battery 12 kg"}],[{id:"b0",text:"Batterie 12 kg https://evil.invalid"}],"german")).toThrow("INVALID_MODEL_OUTPUT");
    expect(()=>validateOutput([{id:"b0",text:"Battery 12 kg"}],[{id:"b0",text:"Batterie 13 kg"}],"german")).toThrow();
    expect(()=>validateOutput([{id:"b0",text:"Battery 12 kg 12 kg"}],[{id:"b0",text:"Batterie 12 kg"}],"german")).toThrow();
  });
  test("exact IDs/order and literal multiplicity are required",()=>{
    expect(()=>validateOutput([{id:"a",text:"1"},{id:"b",text:"2"}],[{id:"b",text:"2"},{id:"a",text:"1"}],"german")).toThrow();
    expect(validateOutput([{id:"a",text:"12 kg and 2 kW"}],[{id:"a",text:"12 kg und 2 kW"}],"german").rate).toBe(1);
  });
  test("sensitivity/Unicode checks run locally with no provider",()=>{
    for(const text of ["VS-NfD","NATO RESTRICTED","ITAR","a\u202Eb","a\u{E0001}b"])expect(()=>screenText(text)).toThrow();
    expect(()=>screenText("Joiners: a\u200Db")).not.toThrow();
  });
  test("Markdown adapter protects code/targets and rejects active content",()=>{
    const ir=markdownIR("# Battery\n\nKeep [manual](https://example.com) and `code 12`.\n\n```ts\nconst n = 12;\n```\n");
    expect(ir.blocks.map(b=>b.text).join(" ")).not.toContain("const n");
    expect(ir.blocks.map(b=>b.text).join(" ")).not.toContain("https://example.com");
    expect(()=>markdownIR("<img src=x>")).toThrow();
    expect(()=>markdownIR("[click](javascript:alert(1))")).toThrow();
  });
  test("seeded generated documents split/reassemble exactly in order",()=>{
    let seed=9371;const random=()=>((seed=(seed*1664525+1013904223)>>>0)/2**32);
    for(let fixture=0;fixture<100;fixture++){
      const blocks=Array.from({length:1+Math.floor(random()*15)},(_,i)=>({id:`b${i}`,text:Array.from({length:1+Math.floor(random()*500)},()=>["word","ü","中","💡","12 kg"][Math.floor(random()*5)]).join(" ")}));
      const chunks=splitBlocks(blocks,180);
      const pieces=chunks.flat();
      expect(new Set(pieces.map(b=>b.id)).size).toBe(pieces.length);
      for(const original of blocks)expect(pieces.filter(b=>b.id===original.id||b.id.startsWith(original.id+".s")).map(b=>b.text).join("")).toBe(original.text);
    }
  });
  test("quotes include all bounded agent turns, output and direct work",()=>{
    const q=quote(markdownIR("The motor is 12 kW."));expect(q.maximum_reserved_usd).toBeGreaterThan(cost({input:24000*4,output:2000*4}));
    expect(q.eta_seconds).toBeNull();
    expect(cost({input:1000,output:100,cached:500})).toBeCloseTo(0.00041,8);
  });
});
