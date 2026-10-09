import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.PROVIDER_MODE="fake";
process.env.MODEL="gpt-4.1-mini";
const {validateOutput}=await import("../../src/domain");
const {markdownIR,render}=await import("../../src/formats");
const source="Keep **bold** and [the manual](https://example.com/manual) with `MODEL-X` here.\n";

async function renderTo(ir:any,translations:{id:string;text:string}[]){
  const dir=await mkdtemp(join(tmpdir(),"md-inline-"));
  try{
    const path=join(dir,"out.md");
    await render(ir,translations,path);
    return await readFile(path,"utf8");
  }finally{await rm(dir,{recursive:true,force:true});}
}
const check=(src:string,out:string)=>validateOutput([{id:"b0",text:src}],[{id:"b0",text:out}],"german");

describe("markdown inline runs",()=>{
  test("a paragraph with emphasis, link and inline code is one block without URL or code text",()=>{
    const ir=markdownIR(source);
    expect(ir.blocks.length).toBe(1);
    expect(ir.blocks[0].text).toBe("Keep <a>bold</a> and <b>the manual</b> with <c/> here.");
    expect(ir.blocks[0].text).not.toContain("https://example.com/manual");
    expect(ir.blocks[0].text).not.toContain("MODEL-X");
  });

  test("identity translation round-trips link target, code and emphasis",async()=>{
    const ir=markdownIR(source);
    const out=await renderTo(ir,ir.blocks.map(b=>({id:b.id,text:b.text})));
    expect(out).toContain("**bold**");
    expect(out).toContain("[the manual](https://example.com/manual)");
    expect(out).toContain("`MODEL-X`");
  });

  test("reordered words inside placeholders render with the original nodes",async()=>{
    const ir=markdownIR(source);
    const out=await renderTo(ir,[{id:"b0",text:"Hier <b>das Handbuch</b> mit <c/> behalten, <a>fett</a>."}]);
    expect(out).toContain("[das Handbuch](https://example.com/manual)");
    expect(out).toContain("`MODEL-X`");
    expect(out).toContain("**fett**");
    expect(out).not.toContain("<a>");
  });

  test("headings and table-like cells use the same block rule; code-only paragraphs produce no block",()=>{
    const ir=markdownIR("# Battery *pack*\n\n`MODEL-X`\n\n![logo](https://example.com/a.png)\n");
    expect(ir.blocks.map(b=>b.text)).toEqual(["Battery <a>pack</a>"]);
  });

  test("placeholder-like literal text in the source is refused",()=>{
    expect(()=>markdownIR("Write \\<a> here.")).toThrow("MARKDOWN_HTML_UNSUPPORTED");
  });

  test("render rejects translations with missing, extra or mis-nested placeholders",async()=>{
    const ir=markdownIR(source);
    for(const bad of ["Hier das Handbuch mit <c/> und <a>fett</a>.","Hier <a>fett<b>x</a></b> mit <c/>.","Hier <a>fett</a> mit <c/> und <c/>.","Hier <a>fett</a> mit <c/> <d/>."])
      await expect(renderTo(ir,[{id:"b0",text:bad}])).rejects.toThrow("ARTIFACT_INCOMPLETE");
  });
});

describe("placeholder validation",()=>{
  const src="Keep <a>bold</a> and <b>manual</b> with <c/> here.";
  test("accepts the same placeholders in any order that nests properly",()=>{
    expect(check(src,"Hier <b>Handbuch</b> mit <c/> behalten, <a>fett</a>.").rate).toBeNull();
  });
  test("rejects missing, extra, renamed and mis-nested placeholders",()=>{
    expect(()=>check(src,"Hier <b>Handbuch</b> mit <c/> behalten, fett.")).toThrow("INVALID_MODEL_OUTPUT");
    expect(()=>check(src,"Hier <b>Handbuch</b> mit <c/> behalten, <a>fett</a> <c/>.")).toThrow("INVALID_MODEL_OUTPUT");
    expect(()=>check(src,"Hier <a>fett<b>Handbuch</a></b> mit <c/>.")).toThrow("INVALID_MODEL_OUTPUT");
    expect(()=>check(src,"Hier <b>Handbuch</b> mit <c/> behalten, <a>fett</b>.")).toThrow("INVALID_MODEL_OUTPUT");
  });
  test("split pieces skip the per-piece placeholder check",()=>{
    expect(()=>validateOutput([{id:"b0.s0",text:src}],[{id:"b0.s0",text:"Hier <a>fett</a> mit"}],"german")).not.toThrow();
  });
});
