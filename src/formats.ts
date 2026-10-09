import { readFile } from "node:fs/promises";
import { fromMarkdown } from "mdast-util-from-markdown";
import { toMarkdown } from "mdast-util-to-markdown";
import { visit } from "unist-util-visit";
import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { AppError } from "./config";
import { screenText, splitBlocks, placeholderTags, type IR, type Block, type Translated } from "./domain";
import { atomic } from "./files";
import { fileURLToPath } from "node:url";

type Span = { node: any; wrap: boolean };
// Letters only: a..z, then aa..zz, ... in order of appearance.
const placeholderId = (n: number) => { let s = ""; for (n++; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(97 + (n - 1) % 26) + s; return s; };
const phrasingParents = new Set(["paragraph", "heading", "tableCell"]);
const hasText = (nodes: any[]): boolean => nodes.some(n => n.type === "text" ? n.value.trim() !== "" : hasText(n.children ?? []));
export function markdownIR(text: string): IR {
  screenText(text);
  const tree = fromMarkdown(text); const blocks: Block[] = [];
  // One block per phrasing container: text is kept, inline wrappers and atoms become placeholders.
  const inline = (nodes: any[], ctx: { n: number; spans: Record<string, Span> }): string => nodes.map((node: any) => {
    if (node.type === "text") {
      if (/<\/?[a-z]+\/?>/.test(node.value)) throw new AppError("MARKDOWN_HTML_UNSUPPORTED");
      return node.value;
    }
    if (node.type === "html") throw new AppError("MARKDOWN_HTML_UNSUPPORTED");
    const { children, position, ...attrs } = node; const id = placeholderId(ctx.n++);
    if (!children) { ctx.spans[id] = { node: attrs, wrap: false }; return `<${id}/>`; }
    ctx.spans[id] = { node: attrs, wrap: true };
    return `<${id}>${inline(children, ctx)}</${id}>`;
  }).join("");
  visit(tree, (node: any) => {
    if (node.type === "html") throw new AppError("MARKDOWN_HTML_UNSUPPORTED");
    if (node.url) {
      const scheme=/^([a-z][a-z0-9+.-]*):/i.exec(node.url)?.[1];
      if (/[\u0000-\u001f\u007f]/.test(node.url) || /^[\\/]{2}/.test(node.url) || scheme && !/^(https?|mailto)$/i.test(scheme)) throw new AppError("MARKDOWN_URI_UNSUPPORTED");
    }
    if (phrasingParents.has(node.type) && node.children && hasText(node.children)) {
      const ctx = { n: 0, spans: {} as Record<string, Span> };
      const body = inline(node.children, ctx);
      node.blockId = `b${blocks.length}`; node.spans = ctx.spans; blocks.push({ id: node.blockId, text: body });
    }
  });
  return { format: "md", blocks, tree, warnings: [], pages: 0 };
}
// Rebuild phrasing nodes from a translated block. Placeholders must match the source exactly once each and nest properly.
function rebuild(text: string, spans: Record<string, Span>): any[] {
  function fail(): never { throw new AppError("ARTIFACT_INCOMPLETE"); }
  const root: any = { children: [] }, stack: { id: string; node: any }[] = [{ id: "", node: root }], seen = new Set<string>();
  const addText = (s: string) => { if (s) stack.at(-1)!.node.children.push({ type: "text", value: s }); };
  let at = 0;
  for (const t of placeholderTags(text)) {
    addText(text.slice(at, t.index)); at = t.index + t.tag.length;
    const span = Object.hasOwn(spans, t.id) ? spans[t.id] : undefined;
    if (!span || seen.has(t.tag) || t.close && t.selfClosing) fail();
    seen.add(t.tag);
    const top = stack.at(-1)!;
    if (t.selfClosing) { if (span.wrap) fail(); top.node.children.push({ ...span.node }); }
    else if (t.close) { if (!span.wrap || top.id !== t.id) fail(); stack.pop(); }
    else { if (!span.wrap) fail(); const node = { ...span.node, children: [] }; top.node.children.push(node); stack.push({ id: t.id, node }); }
  }
  addText(text.slice(at));
  const expected = Object.values(spans).reduce((n, s) => n + (s.wrap ? 2 : 1), 0);
  if (stack.length !== 1 || seen.size !== expected) fail();
  return root.children;
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
  const loading = pdfjs.getDocument({ data: bytes, stopAtErrors: true, disableFontFace: true, standardFontDataUrl: fileURLToPath(new URL("../node_modules/pdfjs-dist/standard_fonts/",import.meta.url)).replaceAll("\\","/") });
  const pdf = await loading.promise;
  const optional = await pdf.getOptionalContentConfig({ intent: "display" });
  const blocks: Block[] = [], warnings: any[] = [],order:string[]=[]; let anyImage = false,occurrence=0;
  try {
    for (let pageNum = 1; pageNum <= pages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      if ((await page.getAnnotations()).some((a:any)=>a.subtype!=="Link")) throw new AppError("PDF_ANNOTATIONS_UNSUPPORTED");
      const content = await page.getTextContent();
      const operators = await page.getOperatorList({ annotationMode: pdfjs.AnnotationMode.DISABLE, intent: "display" });
      let mode = 0, color = "#000000", alpha = 1, markedHidden = false,fontSize=12,hScale=1,matrix=[1,0,0,1,0,0],ctm=[1,0,0,1,0,0],clip=Array.from(page.view);
      let background="#ffffff",backgroundPainted=false,clipWarned=false;
      const multiply=(a:number[],b:number[])=>[a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]];
      const states: any[] = [], marked: boolean[] = [], runs: { text:string; hidden:boolean; suspect:boolean; off:boolean; clip:number[]; index:number }[] = [];
      const snapshot=()=>({mode,color,alpha,markedHidden,fontSize,hScale,matrix:[...matrix],ctm:[...ctm],clip:[...clip]});
      const restore=()=>{const s=states.pop();if(!s)throw new AppError("PDF_VISIBILITY_UNSUPPORTED");({mode,color,alpha,markedHidden,fontSize,hScale,matrix,ctm,clip}=s);};
      const bounds=(box:ArrayLike<number>)=>{
        const points=[[box[0],box[1]],[box[0],box[3]],[box[2],box[1]],[box[2],box[3]]].map(([x,y])=>[ctm[0]*x+ctm[2]*y+ctm[4],ctm[1]*x+ctm[3]*y+ctm[5]]);
        return [Math.min(...points.map(p=>p[0])),Math.min(...points.map(p=>p[1])),Math.max(...points.map(p=>p[0])),Math.max(...points.map(p=>p[1]))];
      };
      const luminance=(value:string)=>{const channels=value.match(/[a-f0-9]{2}/gi)?.map(s=>parseInt(s,16)/255)??[0,0,0];return channels.reduce((n,c,i)=>n+[.2126,.7152,.0722][i]*(c<=.04045?c/12.92:((c+.055)/1.055)**2.4),0);};
      const images:{index:number;box:number[]}[]=[];
      let pageImage = false;
      for (let n = 0; n < operators.fnArray.length; n++) {
        const op = operators.fnArray[n], args = operators.argsArray[n] ?? [];
        if (op === pdfjs.OPS.save) states.push(snapshot());
        if (op === pdfjs.OPS.restore) restore();
        if (op === pdfjs.OPS.paintFormXObjectBegin) {
          states.push(snapshot());
          if(args[0])ctm=multiply(ctm,Array.from(args[0]));
          if(args[1]){const b=bounds(args[1]);clip=[Math.max(clip[0],b[0]),Math.max(clip[1],b[1]),Math.min(clip[2],b[2]),Math.min(clip[3],b[3])];}
        }
        if (op === pdfjs.OPS.paintFormXObjectEnd) restore();
        if (op === pdfjs.OPS.setFont)fontSize=Math.abs(args[1]);
        if (op === pdfjs.OPS.setHScale)hScale=Number(args[0])/100;
        if (op === pdfjs.OPS.setTextMatrix)matrix=Array.from(args[0]);
        if (op === pdfjs.OPS.transform)ctm=multiply(ctm,Array.isArray(args[0])||ArrayBuffer.isView(args[0])?Array.from(args[0] as ArrayLike<number>):args);
        if (op === pdfjs.OPS.setTextRenderingMode) mode = args[0];
        if (op === pdfjs.OPS.setFillRGBColor) color = paint(args);
        if (op === pdfjs.OPS.setFillGray) color = paint([args[0],args[0],args[0]]);
        if (op === pdfjs.OPS.setGState) for (const [k,v] of args[0]) {
          if (k === "ca") alpha=Number(v);
          if(k==="SMask"&&v || k==="BM"&&v!=="Normal")throw new AppError("PDF_VISIBILITY_UNSUPPORTED");
        }
        // Clip regions are not applied to text visibility; the warning tells the caller so.
        if (op === pdfjs.OPS.clip || op === pdfjs.OPS.eoClip) { if(!clipWarned){clipWarned=true;warnings.push({code:"CLIP_REGIONS_NOT_EVALUATED",page:pageNum});} }
        if (op === pdfjs.OPS.shadingFill) throw new AppError("PDF_VISIBILITY_UNSUPPORTED");
        // PDF.js 6 encodes path painting inside constructPath. Stroke-only and no-paint
        // ops never fill. Any fill-type op is limited to an opaque, uniform full-page
        // rectangle before content has resolved visibility.
        if(op===pdfjs.OPS.constructPath && ![pdfjs.OPS.stroke,pdfjs.OPS.closeStroke,pdfjs.OPS.endPath].includes(args[0])){
          const path=Array.from(args[1]?.[0]??[]) as number[], box=args[2]?bounds(args[2]):[];
          const rectangle=path.length===13&&path[0]===0&&path[3]===1&&path[6]===1&&path[9]===1&&path[12]===4
            && new Set([path[1],path[4],path[7],path[10]]).size===2&&new Set([path[2],path[5],path[8],path[11]]).size===2
            && new Set([1,4,7,10].map(i=>path[i]+","+path[i+1])).size===4;
          if(args[0]!==pdfjs.OPS.fill||!rectangle||runs.length||pageImage||backgroundPainted||states.length>1||alpha!==1
            ||ctm[1]!==0||ctm[2]!==0||box.length!==4||box[0]>page.view[0]||box[1]>page.view[1]||box[2]<page.view[2]||box[3]<page.view[3]
            ||clip.some((v,i)=>v!==page.view[i]))throw new AppError("PDF_VISIBILITY_UNSUPPORTED");
          background=color;backgroundPainted=true;
        }
        if ([pdfjs.OPS.fill,pdfjs.OPS.eoFill,pdfjs.OPS.fillStroke,pdfjs.OPS.eoFillStroke,pdfjs.OPS.closeFillStroke,pdfjs.OPS.closeEOFillStroke,pdfjs.OPS.rawFillPath,
          pdfjs.OPS.setFillColorN,pdfjs.OPS.setFillTransparent,pdfjs.OPS.beginGroup,pdfjs.OPS.paintSolidColorImageMask,pdfjs.OPS.paintImageMaskXObjectGroup,
          pdfjs.OPS.paintImageXObjectRepeat,pdfjs.OPS.paintImageMaskXObjectRepeat,pdfjs.OPS.paintInlineImageXObjectGroup].includes(op)) throw new AppError("PDF_VISIBILITY_UNSUPPORTED");
        if (op === pdfjs.OPS.beginMarkedContentProps) { marked.push(markedHidden); if(args[0]==="OC") markedHidden ||= !optional.isVisible(args[1]); }
        if (op === pdfjs.OPS.endMarkedContent) markedHidden=marked.pop() ?? false;
        if ([pdfjs.OPS.paintImageXObject,pdfjs.OPS.paintInlineImageXObject,pdfjs.OPS.paintImageMaskXObject].includes(op)){pageImage=true;images.push({index:n,box:bounds([0,0,1,1])});}
        if([pdfjs.OPS.showSpacedText,pdfjs.OPS.nextLineShowText,pdfjs.OPS.nextLineSetSpacingShowText].includes(op))throw new AppError("PDF_VISIBILITY_UNSUPPORTED");
        if (op === pdfjs.OPS.showText) {
          const text = args[0].filter((g:any)=>typeof g!=="number").map((g:any)=>g.unicode ?? "").join("");
          if (![0,3].includes(mode)) throw new AppError("PDF_VISIBILITY_UNSUPPORTED");
          const position=multiply(ctm,matrix),[left,bottom,right,top]=page.view;
          if(!Number.isFinite(hScale)||Math.abs(hScale)<.1||fontSize*Math.hypot(position[0],position[1])*Math.abs(hScale)<3)throw new AppError("PDF_VISIBILITY_UNSUPPORTED");
          const width=args[0].filter((g:any)=>typeof g!=="number").reduce((n:number,g:any)=>n+(g.width??0),0)/1000*fontSize*Math.abs(position[0]);
          const off=position[4]>right || position[4]+width<left || position[5]>top || position[5]+fontSize*Math.abs(position[3])<bottom;
          if(off)warnings.push({code:"HIDDEN_TEXT_EXCLUDED",page:pageNum,count:1});
          const a=luminance(color),b=luminance(background),contrast=(Math.max(a,b)+.05)/(Math.min(a,b)+.05);
          runs.push({ text, off,hidden: mode===3 || alpha===0 || color===background || markedHidden,
            suspect: alpha>0&&alpha<.95 || color!==background&&contrast<1.5,clip:[...clip],index:n });
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
        const box=[x,y-item.height*.3,x+item.width,y+item.height];
        if(!off&&matched.some(c=>box[0]<c.clip[0]||box[1]<c.clip[1]||box[2]>c.clip[2]||box[3]>c.clip[3]))throw new AppError("PDF_VISIBILITY_UNSUPPORTED");
        if(images.some(image=>matched.some(c=>c.index<image.index)&&box[0]<image.box[2]&&box[2]>image.box[0]&&box[1]<image.box[3]&&box[3]>image.box[1]))throw new AppError("PDF_VISIBILITY_UNSUPPORTED");
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
  // Index once: direct translations by id (first wins, as find did); split parts keyed by every
  // block id that is a prefix before ".s", preserving translation order for the stable sort.
  const direct=new Map<string,Translated>(), parts=new Map<string,Translated[]>();
  for(const t of translations){
    if(!direct.has(t.id))direct.set(t.id,t);
    for(let k=t.id.indexOf(".s");k!==-1;k=t.id.indexOf(".s",k+1)){
      const key=t.id.slice(0,k);
      (parts.get(key)??parts.set(key,[]).get(key)!).push(t);
    }
  }
  const assembled=new Map<string,string>();
  for(const b of ir.blocks) {
    const d=direct.get(b.id);
    const split=(parts.get(b.id)??[]).slice().sort((a,b)=>Number(a.id.split(".s")[1])-Number(b.id.split(".s")[1]));
    if (!d && !split.length) throw new AppError("ARTIFACT_INCOMPLETE");
    assembled.set(b.id,d?.text ?? split.map(t=>t.text).join(""));
  }
  if (ir.format==="md") {
    const tree=structuredClone(ir.tree);
    visit(tree,(node:any)=>{if(node.blockId){node.children=rebuild(assembled.get(node.blockId)!,node.spans);delete node.blockId;delete node.spans;}});
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
  // Lookup by id or alias; the earliest block in ir.blocks order wins, as find did.
  const byId=new Map<string,number>(), byAlias=new Map<string,number>();
  ir.blocks.forEach((b,i)=>{
    if(!byId.has(b.id))byId.set(b.id,i);
    for(const alias of b.aliases??[])if(!byAlias.has(alias))byAlias.set(alias,i);
  });
  for(const occurrenceId of occurrenceIds){
    const hit=[byId.get(occurrenceId),byAlias.get(occurrenceId)].filter((i):i is number=>i!==undefined);
    if(!hit.length)throw new AppError("ARTIFACT_INCOMPLETE");
    const b=ir.blocks[Math.min(...hit)];
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
