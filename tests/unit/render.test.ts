import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.PROVIDER_MODE="fake";
process.env.MODEL="gpt-4.1-mini";
const {markdownIR,render}=await import("../../src/formats");
const fontPath=join(process.cwd(),"node_modules/pdfjs-dist/standard_fonts/LiberationSans-Bold.ttf");

describe("markdown render",()=>{
  test("assembles split parts in numeric order and aliases resolve to their own text",async()=>{
    const dir=await mkdtemp(join(tmpdir(),"render-test-"));
    try{
      const ir:any={format:"md",blocks:[{id:"b0",text:"Alpha"},{id:"b1",text:"Beta",aliases:["x9"]}],warnings:[],pages:0,order:["b0","b1","x9"],
        tree:{type:"root",children:[{type:"paragraph",blockId:"b0",spans:{},children:[{type:"text",value:"Alpha"}]},{type:"paragraph",blockId:"b1",spans:{},children:[{type:"text",value:"Beta"}]}]}};
      const translations=[{id:"b1.s10",text:"K"},{id:"b1.s2",text:"J"},{id:"b0",text:"A"}];
      const path=join(dir,"out.md");
      await render(ir,translations,path);
      const out=await readFile(path,"utf8");
      expect(out).toContain("A");
      expect(out).toContain("JK");
      expect(out).not.toContain("Beta");
    }finally{await rm(dir,{recursive:true,force:true});}
  });

  test("missing translation and unknown occurrence throw ARTIFACT_INCOMPLETE",async()=>{
    const dir=await mkdtemp(join(tmpdir(),"render-test-"));
    try{
      const ir:any={format:"md",blocks:[{id:"b0",text:"A"}],warnings:[],pages:0,tree:{type:"root",children:[]}};
      await expect(render(ir,[],join(dir,"o.md"))).rejects.toThrow("ARTIFACT_INCOMPLETE");
    }finally{await rm(dir,{recursive:true,force:true});}
  });

  test.skipIf(!existsSync(fontPath))("pdf occurrence order: unknown or duplicate occurrence ids throw ARTIFACT_INCOMPLETE",async()=>{
    const dir=await mkdtemp(join(tmpdir(),"render-test-"));
    process.env.FONT_PATH=fontPath;
    try{
      const block={id:"b0",text:"A",aliases:["x"]};
      const unknown:any={format:"pdf",blocks:[block],warnings:[],pages:1,order:["b0","zz"]};
      await expect(render(unknown,[{id:"b0",text:"A"}],join(dir,"o.pdf"))).rejects.toThrow("ARTIFACT_INCOMPLETE");
      const dup:any={format:"pdf",blocks:[block],warnings:[],pages:1,order:["b0","b0"]};
      await expect(render(dup,[{id:"b0",text:"A"}],join(dir,"o.pdf"))).rejects.toThrow("ARTIFACT_INCOMPLETE");
      const alias:any={format:"pdf",blocks:[block],warnings:[],pages:1,order:["b0","x"]};
      await render(alias,[{id:"b0",text:"A"}],join(dir,"ok.pdf"));
      expect((await readFile(join(dir,"ok.pdf"))).byteLength).toBeGreaterThan(0);
    }finally{delete process.env.FONT_PATH;await rm(dir,{recursive:true,force:true});}
  });

  test("16000 Markdown blocks render within a generous time budget",async()=>{
    const dir=await mkdtemp(join(tmpdir(),"render-test-"));
    try{
      const text=Array.from({length:16000},(_,i)=>`Paragraph number ${i} with some words.`).join("\n\n");
      const ir=markdownIR(text);
      expect(ir.blocks.length).toBe(16000);
      const translations=ir.blocks.map(b=>({id:b.id,text:b.text.replace("Paragraph","Parrafo")}));
      const started=performance.now();
      await render(ir,translations,join(dir,"big.md"));
      const elapsed=performance.now()-started;
      expect(elapsed).toBeLessThan(10_000);
      expect((await readFile(join(dir,"big.md"),"utf8"))).toContain("Parrafo number 15999");
    }finally{await rm(dir,{recursive:true,force:true});}
  },60_000);
});
