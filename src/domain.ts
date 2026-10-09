import { createHash } from "node:crypto";
import { encode, decode } from "gpt-tokenizer";
import { franc } from "franc-min";
import { rates, AppError, config } from "./config";
import calibration from "./calibration.json";
import type { Rates } from "./models";

export type Block = { id: string; text: string; page?: number; aliases?: string[] };
export type IR = { format: "pdf" | "md"; blocks: Block[]; tree?: any; order?: string[]; warnings: any[]; pages: number };
export type Translated = { id: string; text: string };
export const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export const tokens = (s: string) => encode(s).length;
export const terminal = ["SUCCEEDED", "FAILED", "NEEDS_ATTENTION", "CANCELED"];
export const targetLanguageCodes = { english: "eng", german: "deu", french: "fra", spanish: "spa" } as const;
export const normalizeTarget = (value: unknown) => {
  const target = String(value ?? "").toLowerCase();
  if (!Object.hasOwn(targetLanguageCodes,target)) throw new AppError("LANGUAGE_UNSUPPORTED");
  return target;
};
const withoutTypographicControls = (text:string) => text.replace(/[\u00AD\u200C\u200D\uFE00-\uFE0F]|[\u{E0100}-\u{E01EF}]/gu, "");
const proseForPolicy = (text:string) => withoutTypographicControls(text).normalize("NFKC").replace(/[‘’]/g,"'").replace(/\s+/gu," ");
export function screenText(text: string) {
  const policyText=withoutTypographicControls(text);
  if (/\b(?:VS[\s-]*NfD|NATO[\s-]+RESTRICTED|ITAR)\b/i.test(policyText.normalize("NFKC"))) throw new AppError("SENSITIVE_MARKING_DETECTED");
  if (/[\u202A-\u202E\u2066-\u2069\u200B\uFEFF]|\p{Default_Ignorable_Code_Point}/u.test(policyText)) {
    throw new AppError("UNICODE_CONCEALMENT_UNSUPPORTED");
  }
}
export function splitBlocks(blocks: Block[], max = 1200): Block[][] {
  const pieces: Block[] = [];
  for (const b of blocks) {
    const encoded = encode(b.text);
    if (encoded.length <= max) { pieces.push(b); continue; }
    // Split on Unicode codepoints, never in a tokenizer byte sequence.
    const points=Array.from(b.text);let cursor=0,index=0;
    while(cursor<points.length){
      let low=cursor+1,high=Math.min(points.length,cursor+max*4),end=low;
      while(low<=high){const mid=Math.floor((low+high)/2);
        if(tokens(points.slice(cursor,mid).join(""))<=max){end=mid;low=mid+1;}else high=mid-1;
      }
      const text=points.slice(cursor,end).join("");
      pieces.push({...b,id:`${b.id}.s${index++}`,text});cursor=end;
    }
  }
  const chunks: Block[][] = []; let chunk: Block[] = []; let n = 0;
  for (const b of pieces) {
    if (chunk.length && n + tokens(b.text) > max) { chunks.push(chunk); chunk = []; n = 0; }
    chunk.push(b); n += tokens(b.text);
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
}
const literalPattern = /(?:(?:[Hh][Tt][Tt][Pp][Ss]?:\/\/|[Ww][Ww][Ww]\.)[^\s<>"')\]]+|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|[+-]?\d+(?:[.,]\d+)*(?:[-–]\d+(?:[.,]\d+)*)?|(?:\b[A-Z]{2,}[-_]\w+\b)|\b(?:kg|kW|kWh|Nm|mm|cm|km|mph|rpm|°C|°F)\b)/g;
export const literals = (s: string) => withoutTypographicControls(s).match(literalPattern) ?? [];
export function assembleTranslations(blocks:Block[],translations:Translated[]):Translated[]{
  const exact=new Map<string,Translated[]>(),split=new Map<string,Translated[]>();
  const add=(m:Map<string,Translated[]>,k:string,t:Translated)=>{const g=m.get(k);g?g.push(t):m.set(k,[t]);};
  // A translation is a split piece of every block id X where its id is X+".s"+suffix.
  for(const t of translations){
    add(exact,t.id,t);
    for(let k=t.id.indexOf(".s");k>=0;k=t.id.indexOf(".s",k+1))add(split,t.id.slice(0,k),t);
  }
  return blocks.map(b=>{
    const direct=exact.get(b.id)??[],parts=(split.get(b.id)??[]).sort((a,c)=>Number(a.id.slice(b.id.length+2))-Number(c.id.slice(b.id.length+2)));
    if(direct.length>1||direct.length&&parts.length||!direct.length&&!parts.length||parts.some((p,n)=>p.id!==`${b.id}.s${n}`))throw new AppError("ARTIFACT_INCOMPLETE");
    return {id:b.id,text:direct[0]?.text??parts.map(p=>p.text).join("")};
  });
}
function bag(values: string[]) { return JSON.stringify(values.sort()); }
// Numeric key: sign + digits without separators + separator count + digits after last separator.
// "4.2" and "4,2" share a key; "42" does not.
const numericKey=(s:string)=>{const sign=/^[+-]/.test(s)?s[0]:"",body=s.slice(sign.length),last=Math.max(body.lastIndexOf("."),body.lastIndexOf(","));
  return `${sign}${body.replace(/[.,]/g,"")}|${body.match(/[.,]/g)?.length??0}|${last<0?0:body.length-last-1}`;};
const literalKey=(s:string)=>{const r=s.match(/^([+-]?\d+(?:[.,]\d+)*)[-–](\d+(?:[.,]\d+)*)$/);
  if(r)return `${numericKey(r[1])}-${numericKey(r[2])}`;
  return /^[+-]?\d/.test(s)?numericKey(s):s;};
// Markdown inline placeholders: <x> and </x> wrap children, <x/> is atomic. Ids are letters only.
export const placeholderTags=(s:string)=>[...s.matchAll(/<(\/?)([a-z]+)(\/?)>/g)].map(m=>({tag:m[0],id:m[2],close:m[1]==="/",selfClosing:m[3]==="/",index:m.index}));
const wellNested=(tags:ReturnType<typeof placeholderTags>)=>{const stack:string[]=[];
  for(const t of tags){
    if(t.close&&t.selfClosing)return false;
    if(t.selfClosing)continue;
    if(t.close){if(stack.pop()!==t.id)return false;}else stack.push(t.id);
  }
  return !stack.length;};
export function validateOutput(source: Block[], output: Translated[], target: string) {
  if (output.length !== source.length || new Set(output.map(b => b.id)).size !== source.length) throw new AppError("INVALID_MODEL_OUTPUT");
  let expected = 0, correct = 0; const warnings: string[] = [];
  for (let i = 0; i < source.length; i++) {
    const s = source[i], out = output[i];
    try{screenText(out.text);}catch{throw new AppError("INVALID_MODEL_OUTPUT");}
    if (out.id !== s.id || !out.text.trim() || out.text.length > Math.max(200, s.text.length * 4) || out.text.length < s.text.length / 5) throw new AppError("INVALID_MODEL_OUTPUT");
    const before = literals(s.text), after = literals(out.text);
    const nums = before.filter(x => /^[+-]?\d/.test(x)); expected += nums.length*(1+(s.aliases?.length??0));
    if (bag(before.map(literalKey)) !== bag(after.map(literalKey))) throw new AppError("INVALID_MODEL_OUTPUT");
    correct += nums.length*(1+(s.aliases?.length??0));
    const markup=/!\[|\]\(|<\s*(?:script|img|iframe)\b|\bjavascript:|\bdata:[^,\s]+,/i;
    if (markup.test(out.text) && !markup.test(s.text)) throw new AppError("INVALID_MODEL_OUTPUT");
    // Split pieces can cut a placeholder pair; the whole-block check in publish() covers them.
    if (!s.id.includes(".s")) {
      const sourceTags = placeholderTags(s.text), outputTags = placeholderTags(out.text);
      if (bag(sourceTags.map(t => t.tag)) !== bag(outputTags.map(t => t.tag)) || wellNested(sourceTags) && !wellNested(outputTags)) throw new AppError("INVALID_MODEL_OUTPUT");
    }
    const refusal=/\b(?:I (?:cannot|can't|won't|will not|am unable)|I['’]m sorry|as an AI|ignore previous|here is (?:the|your) translation|no puedo traducir|je ne peux pas traduire|ich kann .*nicht .*übersetzen)\b/i;
    if (refusal.test(proseForPolicy(out.text)) && !refusal.test(proseForPolicy(s.text))) throw new AppError("INVALID_MODEL_OUTPUT");
  }
  const sample=output.map(b=>b.text).join(" ").replace(/https?:\/\/\S+|www\.\S+/gi,"");
  if(sample.length>=100){
    const lang=franc(sample,{only:Object.values(targetLanguageCodes),minLength:100});
    if(lang!=="und"&&lang!==targetLanguageCodes[target as keyof typeof targetLanguageCodes]&&config.mode!=="fake")throw new AppError("INVALID_MODEL_OUTPUT");
    if(lang==="und")warnings.push("LANGUAGE_SAMPLE_UNCERTAIN");
  }else warnings.push("LANGUAGE_SAMPLE_TOO_SHORT");
  return { expected, correct, rate: expected ? correct / expected : null, warnings: [...new Set(warnings)] };
}
export function cost(usage: { input: number; output: number; cached?: number; write?: number },pricing:Rates=rates) {
  return ((usage.input - (usage.cached ?? 0) - (usage.write ?? 0)) * pricing.input + (usage.cached ?? 0) * pricing.cached + (usage.write ?? 0) * pricing.write + usage.output * pricing.output) / 1e6;
}
export const reservedCost = (usage:{input:number;output:number},pricing:Rates=rates) =>
  (usage.input*Math.max(pricing.input,pricing.write)+usage.output*pricing.output)/1e6;
// Worst-case spend for one translation call, from the chunk itself. The quote and the runtime ledger both use this, so the approved
// floor always covers what the worker reserves. Glossary margin covers the 40-entry cap; output includes reasoning tokens when enabled.
export function chunkReservation(chunkTokens:number,blocks:number,previousTokens:number){
  return {input:chunkTokens+previousTokens+800+30*blocks+4500,
    output:Math.min(6000,Math.ceil(chunkTokens*2.5)+600+(config.reasoning?2000:0))};
}
export const previousContext=(chunk:Block[]|undefined)=>(chunk?.slice(-2).map(b=>b.text).join("\n")??"").slice(-4000);
export const chunkTokenCount=(chunk:Block[])=>chunk.reduce((n,b)=>n+tokens(b.text),0);
export function quote(ir: IR,target="german") {
  const chunks = splitBlocks(ir.blocks);
  const sourceText=ir.blocks.map(b=>b.text).join("\n"),inputTokens=tokens(sourceText);
  const measured=target===calibration.target&&calibration.model===config.model&&calibration.prompt===config.prompt&&calibration.policy===config.policy&&chunks.length===1&&inputTokens>=calibration.input_tokens.min&&inputTokens<=calibration.input_tokens.max&&franc(sourceText,{minLength:80})==="eng";
  // Bounded direct outputs plus four bounded agent turns (context/input <= 24000).
  const ceiling = chunks.reduce((n,c,i)=>n+reservedCost(chunkReservation(chunkTokenCount(c),c.length,i?tokens(previousContext(chunks[i-1])):0)),0)
    + 4 * reservedCost({ input: 24000, output: 2000 });
  const previousTokens=chunks.slice(0,-1).reduce((n,c)=>n+tokens(c.slice(-2).map(b=>b.text).join("\n").slice(-4000)),0);
  const projected={
    min:cost({input:inputTokens+previousTokens+chunks.length*600,output:Math.ceil(inputTokens*.9)})+2*cost({input:Math.min(inputTokens,16000)+1000,output:400}),
    max:Math.min(ceiling,cost({input:inputTokens+previousTokens+chunks.length*2400,output:Math.ceil(inputTokens*1.6)})+4*cost({input:24000,output:2000}))
  };
  return { version: hash(JSON.stringify(ir) +target+config.model+config.reasoning+config.prompt+config.policy+config.ratesVersion+JSON.stringify(calibration)), model: config.model,reasoning_effort:config.reasoning,
    policy_version:config.policy,rates_version: config.ratesVersion, prompt_version: config.prompt, maximum_reserved_usd: Math.ceil(ceiling * 1e6) / 1e6,
    estimated_total_usd: measured?{min:calibration.observed_cost_usd.min,max:calibration.observed_cost_usd.max}:projected,
    size_projection:{...projected,source_tokens:inputTokens,translation_chunks:chunks.length,output_token_ratio:{min:.9,max:1.6},agent_turns:{min:2,max:4},basis:"Unmeasured token projection: source + previous-chunk context + 600–2400 prompt/glossary tokens per chunk; 2–4 bounded terminology turns. Excludes discounts/retries and is not a guarantee."},
    estimate_basis:measured?`Observed synthetic English-to-German range, N=${calibration.n}`:"Unmeasured size-based token projection; approval reservation is separate",
    eta_seconds:measured?{min:calibration.latency_seconds.p50,max:calibration.latency_seconds.p95*2,evidence_n:calibration.n}:null,
    expires_at: new Date(Date.now() + 15*60_000).toISOString(), chunk_count: chunks.length, input_tokens:inputTokens };
}
