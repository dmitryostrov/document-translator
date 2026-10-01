import { createHash } from "node:crypto";
import { encode, decode } from "gpt-tokenizer";
import { franc } from "franc-min";
import { rates, AppError, config } from "./config";
import calibration from "./calibration.json";

export type Block = { id: string; text: string; page?: number; aliases?: string[] };
export type IR = { format: "pdf" | "md"; blocks: Block[]; tree?: any; order?: string[]; warnings: any[]; pages: number };
export type Translated = { id: string; text: string };
export const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export const tokens = (s: string) => encode(s).length;
export const terminal = ["SUCCEEDED", "FAILED", "NEEDS_ATTENTION", "CANCELED"];
export const normalizeTarget = (value: unknown) => {
  const target = String(value ?? "").toLowerCase();
  if (!["english", "german", "french"].includes(target)) throw new AppError("LANGUAGE_UNSUPPORTED");
  return target;
};
export function screenText(text: string) {
  if (/\b(?:VS[\s-]*NfD|NATO[\s-]+RESTRICTED|ITAR)\b/i.test(text.normalize("NFKC"))) throw new AppError("SENSITIVE_MARKING_DETECTED");
  if (/[\u202A-\u202E\u2066-\u2069\u200B\uFEFF]|\p{Default_Ignorable_Code_Point}/u.test(text.replace(/[\u200C\u200D]/g, ""))) {
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
const literalPattern = /(?:https?:\/\/[^\s<>"')\]]+|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|[+-]?\d+(?:[.,]\d+)*(?:[-–]\d+(?:[.,]\d+)*)?|(?:\b[A-Z]{2,}[-_]\w+\b)|\b(?:kg|kW|kWh|Nm|mm|cm|km|mph|rpm|°C|°F)\b)/g;
export const literals = (s: string) => s.match(literalPattern) ?? [];
export function assembleTranslations(blocks:Block[],translations:Translated[]):Translated[]{
  return blocks.map(b=>{
    const direct=translations.filter(t=>t.id===b.id),parts=translations.filter(t=>t.id.startsWith(b.id+".s")).sort((a,c)=>Number(a.id.slice(b.id.length+2))-Number(c.id.slice(b.id.length+2)));
    if(direct.length>1||direct.length&&parts.length||!direct.length&&!parts.length||parts.some((p,n)=>p.id!==`${b.id}.s${n}`))throw new AppError("ARTIFACT_INCOMPLETE");
    return {id:b.id,text:direct[0]?.text??parts.map(p=>p.text).join("")};
  });
}
function bag(values: string[]) { return JSON.stringify(values.sort()); }
export function validateOutput(source: Block[], output: Translated[], target: string) {
  if (output.length !== source.length || new Set(output.map(b => b.id)).size !== source.length) throw new AppError("INVALID_MODEL_OUTPUT");
  let expected = 0, correct = 0; const warnings: string[] = [];
  for (let i = 0; i < source.length; i++) {
    const s = source[i], out = output[i];
    try{screenText(out.text);}catch{throw new AppError("INVALID_MODEL_OUTPUT");}
    if (out.id !== s.id || !out.text.trim() || out.text.length > Math.max(200, s.text.length * 4) || out.text.length < s.text.length / 5) throw new AppError("INVALID_MODEL_OUTPUT");
    const before = literals(s.text), after = literals(out.text);
    const nums = before.filter(x => /^[+-]?\d/.test(x)); expected += nums.length*(1+(s.aliases?.length??0));
    if (bag(before) !== bag(after)) throw new AppError("INVALID_MODEL_OUTPUT");
    correct += nums.length*(1+(s.aliases?.length??0));
    if (/!\[|\]\(|<\s*(?:script|img|iframe)|javascript:|data:/i.test(out.text) && !/!\[|\]\(|<\s*(?:script|img|iframe)|javascript:|data:/i.test(s.text)) throw new AppError("INVALID_MODEL_OUTPUT");
    if (/\b(?:I (?:cannot|can't)|as an AI|ignore previous|here is (?:the|your) translation)\b/i.test(out.text) && !/\b(?:I (?:cannot|can't)|as an AI|ignore previous|here is (?:the|your) translation)\b/i.test(s.text)) throw new AppError("INVALID_MODEL_OUTPUT");
    if (out.text.length > 100) {
      const lang = franc(out.text, { only: ["eng", "deu", "fra"], minLength: 100 });
      const wanted: Record<string,string> = { english: "eng", german: "deu", french: "fra" };
      if (lang !== "und" && lang !== wanted[target] && config.mode !== "fake") throw new AppError("INVALID_MODEL_OUTPUT");
    } else warnings.push("LANGUAGE_SAMPLE_TOO_SHORT");
  }
  return { expected, correct, rate: expected ? correct / expected : null, warnings: [...new Set(warnings)] };
}
export function cost(usage: { input: number; output: number; cached?: number; write?: number }) {
  return ((usage.input - (usage.cached ?? 0) - (usage.write ?? 0)) * rates.input + (usage.cached ?? 0) * rates.cached + (usage.write ?? 0) * rates.write + usage.output * rates.output) / 1e6;
}
export function quote(ir: IR,target="german") {
  const chunks = splitBlocks(ir.blocks);
  const sourceText=ir.blocks.map(b=>b.text).join("\n"),inputTokens=tokens(sourceText);
  const measured=target===calibration.target&&calibration.model===config.model&&calibration.prompt===config.prompt&&chunks.length===1&&inputTokens>=calibration.input_tokens.min&&inputTokens<=calibration.input_tokens.max&&franc(sourceText,{minLength:80})==="eng";
  // Bounded direct outputs plus four bounded agent turns (context/input <= 24000).
  const ceiling = chunks.length * cost({ input:20000,output:6000 })
    + 4 * cost({ input: 24000, output: 2000 });
  return { version: hash(JSON.stringify(ir) +target+config.model+config.prompt+config.policy+config.ratesVersion+JSON.stringify(calibration)), model: config.model,
    policy_version:config.policy,rates_version: config.ratesVersion, prompt_version: config.prompt, maximum_reserved_usd: Math.ceil(ceiling * 1e6) / 1e6,
    estimated_total_usd: measured?{min:calibration.observed_cost_usd.min,max:calibration.observed_cost_usd.max}:{min:0,max:ceiling},
    estimate_basis:measured?`Observed synthetic English-to-German range, N=${calibration.n}`:"Conservative reservation bound; no matching measurement",
    eta_seconds:measured?{min:calibration.latency_seconds.p50,max:calibration.latency_seconds.p95*2,evidence_n:calibration.n}:null,
    expires_at: new Date(Date.now() + 15*60_000).toISOString(), chunk_count: chunks.length, input_tokens:inputTokens };
}
