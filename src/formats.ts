import { readFile } from "node:fs/promises";
import { fromMarkdown } from "mdast-util-from-markdown";
import { toMarkdown } from "mdast-util-to-markdown";
import { visit } from "unist-util-visit";
import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { AppError } from "./config";
import { screenText, splitBlocks, type IR, type Block, type Translated } from "./domain";
import { atomic } from "./files";

export function markdownIR(text: string): IR {
  screenText(text);
  const tree = fromMarkdown(text); const blocks: Block[] = [];
  visit(tree, (node: any) => {
    if (node.type === "html") throw new AppError("MARKDOWN_HTML_UNSUPPORTED");
    if (node.url && !/^(?:https?:|mailto:|\/|\.|#)/i.test(node.url)) throw new AppError("MARKDOWN_URI_UNSUPPORTED");
    if (node.type === "text" && node.value.trim()) {
      node.blockId = `b${blocks.length}`; blocks.push({ id: node.blockId, text: node.value });
    }
  });
  return { format: "md", blocks, tree, warnings: [], pages: 0 };
}
async function native(args: string[]) {
  const p = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => p.kill("SIGKILL"), 30_000);
  try {
    const [out, , code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    if (code !== 0) throw new AppError("CORRUPT_OR_ENCRYPTED_PDF");
    return out;
  } finally { clearTimeout(timer); }
}
function paint(args: any[]) {
  if (typeof args[0] === "string") return args[0].toLowerCase();
  const c = args.map(n => Math.round(Number(n) * (Number(n) <= 1 ? 255 : 1)));
  return "#" + c.map(n=>n.toString(16).padStart(2,"0")).join("");
}
export async function pdfIR(path: string, acknowledge: boolean): Promise<IR> {
  const bytes = new Uint8Array(await readFile(path));
  if (new TextDecoder().decode(bytes.slice(0,5)) !== "%PDF-") throw new AppError("CORRUPT_PDF");
  const info = await native(["pdfinfo", path]);
  const pages = Number(info.match(/Pages:\s+(\d+)/)?.[1] ?? 0);
  if (!pages || pages > 250) throw new AppError("PDF_PAGE_LIMIT");
  if (/Encrypted:\s+yes/.test(info)) throw new AppError("ENCRYPTED_PDF_UNSUPPORTED");
  const poppler = await native(["pdftotext", "-layout", path, "-"]);
  screenText(poppler);
  // PDF.js's Node canvas fallback is native JS tooling, not Python.
  const canvas = await import("@napi-rs/canvas");
  Object.assign(globalThis, { DOMMatrix: canvas.DOMMatrix, ImageData: canvas.ImageData, Path2D: canvas.Path2D });
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loading = pdfjs.getDocument({ data: bytes, stopAtErrors: true, disableFontFace: true });
  const pdf = await loading.promise;
  const optional = await pdf.getOptionalContentConfig({ intent: "display" });
  const blocks: Block[] = [], warnings: any[] = [],order:string[]=[]; let anyImage = false,occurrence=0;
  try {
    for (let pageNum = 1; pageNum <= pages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      if ((await page.getAnnotations()).length) throw new AppError("PDF_ANNOTATIONS_UNSUPPORTED");
      const content = await page.getTextContent();
      const operators = await page.getOperatorList({ annotationMode: pdfjs.AnnotationMode.DISABLE, intent: "display" });
      let mode = 0, color = "#000000", alpha = 1, markedHidden = false,fontSize=12,matrix=[1,0,0,1,0,0],ctm=[1,0,0,1,0,0];
      const multiply=(a:number[],b:number[])=>[a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]];
      const states: any[] = [], marked: boolean[] = [], runs: { text:string; hidden:boolean; suspect:boolean; off:boolean }[] = [];
      let pageImage = false;
      for (let n = 0; n < operators.fnArray.length; n++) {
        const op = operators.fnArray[n], args = operators.argsArray[n] ?? [];
        if (op === pdfjs.OPS.save) states.push({mode,color,alpha,ctm,fontSize});
        if (op === pdfjs.OPS.restore) { const s=states.pop(); if(s) ({mode,color,alpha,ctm,fontSize}=s); }
        if (op === pdfjs.OPS.setFont)fontSize=Math.abs(args[1]);
        if (op === pdfjs.OPS.setTextMatrix)matrix=Array.from(args[0]);
        if (op === pdfjs.OPS.transform)ctm=multiply(ctm,Array.isArray(args[0])||ArrayBuffer.isView(args[0])?Array.from(args[0] as ArrayLike<number>):args);
        if (op === pdfjs.OPS.setTextRenderingMode) mode = args[0];
        if (op === pdfjs.OPS.setFillRGBColor) color = paint(args);
        if (op === pdfjs.OPS.setFillGray) color = paint([args[0],args[0],args[0]]);
        if (op === pdfjs.OPS.setGState) for (const [k,v] of args[0]) if (k === "ca") alpha=Number(v);
        if (op === pdfjs.OPS.clip || op === pdfjs.OPS.eoClip || op === pdfjs.OPS.shadingFill) throw new AppError("PDF_VISIBILITY_UNSUPPORTED");
        // Arbitrary painted backgrounds/overlapping paths are outside the simple profile.
        if ([pdfjs.OPS.fill,pdfjs.OPS.eoFill,pdfjs.OPS.fillStroke,pdfjs.OPS.eoFillStroke].includes(op)) throw new AppError("PDF_VISIBILITY_UNSUPPORTED");
        if (op === pdfjs.OPS.beginMarkedContentProps) { marked.push(markedHidden); if(args[0]==="OC") markedHidden ||= !optional.isVisible(args[1]); }
        if (op === pdfjs.OPS.endMarkedContent) markedHidden=marked.pop() ?? false;
        if ([pdfjs.OPS.paintImageXObject,pdfjs.OPS.paintInlineImageXObject,pdfjs.OPS.paintImageMaskXObject].includes(op)) pageImage=true;
        if (op === pdfjs.OPS.showText) {
          const text = args[0].filter((g:any)=>typeof g!=="number").map((g:any)=>g.unicode ?? "").join("");
          const channels = color.match(/[a-f0-9]{2}/gi)?.map(s=>parseInt(s,16)) ?? [0,0,0];
          if (![0,3].includes(mode)) throw new AppError("PDF_VISIBILITY_UNSUPPORTED");
          const position=multiply(ctm,matrix),[left,bottom,right,top]=page.view;
          const width=args[0].filter((g:any)=>typeof g!=="number").reduce((n:number,g:any)=>n+(g.width??0),0)/1000*fontSize*Math.abs(position[0]);
          const off=position[4]>right || position[4]+width<left || position[5]>top || position[5]+fontSize*Math.abs(position[3])<bottom;
          if(off)warnings.push({code:"HIDDEN_TEXT_EXCLUDED",page:pageNum,count:1});
          runs.push({ text, off,hidden: mode===3 || alpha===0 || color==="#ffffff" || markedHidden, suspect: alpha>0 && alpha<0.95 || channels.every(c=>c>210)&&color!=="#ffffff" });
        }
      }
      anyImage ||= pageImage;
      const normalized = (s:string)=>s.replace(/\s/g,"");
      const extracted = content.items.filter((i:any)=>"str" in i).map((i:any)=>i.str).join("");
      const mappedRuns=runs.filter(r=>!r.off);
      if (normalized(mappedRuns.map(r=>r.text).join("")) !== normalized(extracted)) throw new AppError("PDF_VISIBILITY_UNSUPPORTED");
      // Map character spans; PDF.js may merge visible and invisible paint runs into one text item.
      let cursor=0; const chars = mappedRuns.flatMap(r=>Array.from(r.text).filter(c=>!/\s/.test(c)).map(()=>r));
      for (const item of content.items as any[]) {
        if (!item.str?.trim()) continue;
        const count=Array.from(normalized(item.str)).length, matched=chars.slice(cursor,cursor+count); cursor+=count;
        const [x,y] = [item.transform[4],item.transform[5]];
        const [left,bottom,right,top] = page.view;
        const off = x+item.width<left || x>right || y<bottom || y>top;
        if (matched.some(c=>c.suspect) || (!off && item.height<3)) throw new AppError("PDF_VISIBILITY_UNSUPPORTED");
        const hidden = matched.every(c=>c.hidden) || off;
        if (!hidden && matched.some(c=>c.hidden)) throw new AppError("PDF_VISIBILITY_UNSUPPORTED");
        if (hidden) { warnings.push({code:"HIDDEN_TEXT_EXCLUDED",page:pageNum,count:1}); continue; }
        screenText(item.str);
        const id=`p${pageNum}b${occurrence++}`;order.push(id);
        // Only exactly repeated margin text is canonicalized. Occurrence IDs remain explicit.
        const running = pages>=3 && (y<bottom+45 || y>top-45);
        const prior=running ? blocks.find(b=>b.text===item.str && (b as any).running) : undefined;
        if (prior) { (prior.aliases ??= []).push(id); continue; }
        const b: Block={id,text:item.str,page:pageNum}; if(running) (b as any).running=true; blocks.push(b);
      }
      page.cleanup();
    }
    if (!blocks.length) throw new AppError(anyImage ? "SCANNED_PDF_UNSUPPORTED" : "PDF_NO_VISIBLE_TEXT");
    if (anyImage && !acknowledge) throw new AppError("PDF_TEXT_ONLY_CONFIRMATION_REQUIRED");
    if (anyImage) warnings.push({code:"TEXT_ONLY_PDF_IMAGES_EXCLUDED"});
    if (blocks.map(b=>b.text).join(" ").split(/\s+/).length>300_000) throw new AppError("DOCUMENT_WORD_LIMIT");
    return { format:"pdf",blocks,warnings,pages,order };
  } finally { await loading.destroy(); }
}
export async function extract(path: string, format: "md"|"pdf", options:any) {
  let ir:IR;
  if(format==="md"){
    let text:string;try{text=new TextDecoder("utf-8",{fatal:true}).decode(await readFile(path));}catch{throw new AppError("MARKDOWN_UTF8_INVALID");}
    ir=markdownIR(text);
  }else ir=await pdfIR(path,!!options.acknowledge_text_only_pdf);
  if (!ir.blocks.length || ir.blocks.map(b=>b.text).join(" ").split(/\s+/).length>300_000) throw new AppError("DOCUMENT_WORD_LIMIT");
  return {ir,chunks:splitBlocks(ir.blocks)};
}
export async function render(ir: IR, translations: Translated[], path: string) {
  const assembled=new Map<string,string>();
  for(const b of ir.blocks) {
    const direct=translations.find(t=>t.id===b.id);
    const split=translations.filter(t=>t.id.startsWith(b.id+".s")).sort((a,b)=>Number(a.id.split(".s")[1])-Number(b.id.split(".s")[1]));
    if (!direct && !split.length) throw new AppError("ARTIFACT_INCOMPLETE");
    assembled.set(b.id,direct?.text ?? split.map(t=>t.text).join(""));
  }
  if (ir.format==="md") {
    const tree=structuredClone(ir.tree);
    visit(tree,(node:any)=>{if(node.blockId)node.value=assembled.get(node.blockId);});
    await atomic(path,toMarkdown(tree)); return;
  }
  const pdf=await PDFDocument.create(); pdf.registerFontkit(fontkit);
  const font=await pdf.embedFont(await readFile(process.env.FONT_PATH ?? "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),{subset:true});
  let page=pdf.addPage([595,842]), y=790;
  const line=(text:string)=>{
    if(y<50){page=pdf.addPage([595,842]);y=790;}
    page.drawText(text,{x:45,y,size:10,font,color:rgb(0.08,0.09,0.10)});y-=15;
  };
  const occurrenceIds=ir.order??ir.blocks.flatMap(b=>[b.id,...b.aliases??[]]);
  if(new Set(occurrenceIds).size!==occurrenceIds.length)throw new AppError("ARTIFACT_INCOMPLETE");
  for(const occurrenceId of occurrenceIds){
    const b=ir.blocks.find(b=>b.id===occurrenceId||b.aliases?.includes(occurrenceId));
    if(!b)throw new AppError("ARTIFACT_INCOMPLETE");
      let row="";
      for(const word of assembled.get(b.id)!.replace(/\r/g,"").split(/\s+/)){
        if(font.widthOfTextAtSize(word,10)>505){
          if(row){line(row);row="";}
          let part="";
          for(const char of Array.from(word)){
            if(part && font.widthOfTextAtSize(part+char,10)>505){line(part);part="";}
            part+=char;
          }
          row=part;continue;
        }
        if(row && font.widthOfTextAtSize(row+" "+word,10)>505){line(row);row="";}
        row+=(row?" ":"")+word;
      }
      if(row)line(row);y-=7;
  }
  await atomic(path,await pdf.save());
}
