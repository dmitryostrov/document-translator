import {test,expect} from "bun:test";
import {mkdtemp,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
process.env.PROVIDER_MODE="fake";
process.env.MODEL="gpt-4.1-mini";
const {validateOutput,screenText,quote}=await import("../../src/domain");
const {markdownIR}=await import("../../src/formats");
const {config}=await import("../../src/config");
const check=(source:string,output:string)=>validateOutput([{id:"b",text:source}],[{id:"b",text:output}],"english");
test("novel bare destinations and refusal are blocked; legitimate quoted refusal remains",()=>{
  for(const url of ["www.attacker.example/login","WWW.attacker.example/login","w\u00ADww.attacker.example/login","https://attacker.example/login"])
    expect(()=>check("The battery operates normally.","The battery operates at "+url+".")).toThrow("INVALID_MODEL_OUTPUT");
  for(const text of ["I'm sorry, but I won't translate this.","I’m sorry, but I will not translate this.","I won’t translate this.","I\tcannot translate this.","I\u00A0will not translate this.","I can\u00ADnot translate this."])
    expect(()=>check("The battery supplies power.",text)).toThrow("INVALID_MODEL_OUTPUT");
  expect(check("The message says: I'm sorry, but I won't translate this.","The message says: I'm sorry, but I won't translate this.").rate).toBeNull();
  expect(check("Read www.example.com/manual.","Read www.example.com/manual.").rate).toBeNull();
});
test("ordinary metadata prose and translated hyphenated words are not URI or model-code attacks",()=>{
  expect(check("Data about the battery.","Metadata: about the battery.").rate).toBeNull();
  expect(check("A battery-powered motor.","An electric-powered motor.").rate).toBeNull();
  expect(()=>check("The battery supplies power.","Use data:text/html,attack instead.")).toThrow("INVALID_MODEL_OUTPUT");
});
test("legitimate variation selectors and soft hyphens pass; concealment controls remain denied",()=>{
  for(const text of ["Warning ⚠️","bat\u00ADtery","字\u{E0100}"])expect(()=>screenText(text)).not.toThrow();
  for(const text of ["NATO RESTRICTED","NA\u00ADTO RESTRICTED","IT\u00ADAR","NAT\uFE0FO RESTRICTED","IT\u200DAR"])expect(()=>screenText(text)).toThrow("SENSITIVE_MARKING_DETECTED");
  for(const text of ["safe\u202Etext","safe\u200Btext","safe\u{E0020}text"])expect(()=>screenText(text)).toThrow("UNICODE_CONCEALMENT_UNSUPPORTED");
});
test("relative Markdown destinations are preserved without allowing active URI schemes",()=>{
  for(const path of ["manual.md","docs/manual.md","../manual.md","#battery","https://example.com/manual"]){
    const ir=markdownIR("Read [the manual]("+path+").");
    expect(ir.tree.children[0].children[1].url).toBe(path);
  }
  for(const path of ["javascript:alert(1)","data:text/html,test","vbscript:run","//evil.example/manual"])expect(()=>markdownIR("Read [the manual]("+path+").")).toThrow("MARKDOWN_URI_UNSUPPORTED");
});
test("a coherent wrong-language sample cannot evade validation through short individual blocks",()=>{
  const texts=["The battery supplies power.","Disconnect it before service.","Inspect all motor connections.","Keep the equipment dry.","Follow the maintenance instructions."];
  const blocks=texts.map((text,i)=>({id:"b"+i,text})),before=config.mode;config.mode="openai";
  try{expect(()=>validateOutput(blocks,blocks,"spanish")).toThrow("INVALID_MODEL_OUTPUT");}finally{config.mode=before;}
});
test("size-based estimates scale with source tokens and remain separate from reservations",()=>{
  const small=quote(markdownIR("The battery supplies power."),"spanish");
  const large=quote(markdownIR("The battery supplies power. ".repeat(300)),"spanish");
  expect(large.size_projection.source_tokens).toBeGreaterThan(small.size_projection.source_tokens);
  expect(large.size_projection.min).toBeGreaterThan(small.size_projection.min);
  expect(large.size_projection.max).toBeLessThanOrEqual(large.maximum_reserved_usd);
  expect(large.estimate_basis).toContain("Unmeasured");
  expect(large.eta_seconds).toBeNull();
});
test("missing, unreadable and empty key inputs produce only a named configuration error",async()=>{
  const scratch=await mkdtemp(join(tmpdir(),"stark-empty-key-")),empty=join(scratch,"empty.txt");await writeFile(empty,"");
  for(const file of ["",join(scratch,"missing.txt"),empty]){
    const script='import {key} from "./src/config";try{key();process.exit(2)}catch(e){console.log(e.code);process.exit(e.code==="OPENAI_KEY_UNAVAILABLE"?0:1)}';
    const p=Bun.spawn(["bun","-e",script],{stdout:"pipe",stderr:"pipe",env:{PATH:process.env.PATH!,PROVIDER_MODE:"openai",OPENAI_API_KEY:"",OPENAI_API_KEY_FILE:file}});
    const text=await new Response(p.stdout).text();expect(await p.exited).toBe(0);expect(text.trim()).toBe("OPENAI_KEY_UNAVAILABLE");
  }
});
