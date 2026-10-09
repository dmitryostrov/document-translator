import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFile, realpath, mkdir, open, link, unlink,stat,lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, relative, dirname, join } from "node:path";
import { config } from "./config";
const root=await realpath(process.env.WORKSPACE_ROOT??"/workspace");
const outRoot=join(root,"out");await mkdir(outRoot,{recursive:true});
const canonicalOut=await realpath(outRoot);
if(relative(root,canonicalOut).startsWith(".."))throw new Error("OUTPUT_PATH_DENIED");
const token=(await readFile(config.tokenFile,"utf8")).trim();
const TERMINAL_FAILED=new Set(["FAILED","NEEDS_ATTENTION","CANCELED"]);
const MAX_BYTES=25*1024*1024;
async function api(path:string,body?:BodyInit,key?:string){
  const response=await fetch(config.api+path,{method:body?"POST":"GET",headers:{Authorization:`Bearer ${token}`,...(key?{"Idempotency-Key":key}:{}),...(typeof body==="string"?{"Content-Type":"application/json"}:{})},body});
  const data=await response.json();if(!response.ok)throw new Error(data.error?.code??"REQUEST_FAILED");return data;
}
export async function safeInput(path:string){
  const resolved=await realpath(resolve(root,path));const rel=relative(root,resolved);
  if(rel.startsWith("..")||resolve(root,rel)!==resolved)throw new Error("PATH_DENIED");return resolved;
}
// Shared by translate_document (prepare) and translate_file.
async function submitFile(path:string,target:string,ack:boolean|undefined,key:string){
  const form=new FormData();
  if((await stat(path)).size>MAX_BYTES)throw new Error("UPLOAD_SIZE_LIMIT");
  form.append("file",Bun.file(path),path.split(/[/\\]/).pop()!);form.append("target_language",target);form.append("acknowledge_text_only_pdf",String(!!ack));
  return api("/api/translations",form,key);
}
// Shared safe-save: verified bytes, atomic no-replace publication. Identical existing file counts as already saved.
async function saveArtifact(jobId:string,outputPath:string){
  const target=resolve(root,outputPath),parent=await realpath(dirname(target));
  const rel=relative(canonicalOut,parent);
  if(rel.startsWith("..") || !target.startsWith(outRoot+"/") && !target.startsWith(outRoot+"\\"))throw new Error("OUTPUT_PATH_DENIED");
  const response=await fetch(`${config.api}/api/translations/${jobId}/artifact`,{headers:{Authorization:`Bearer ${token}`}});
  if(!response.ok)throw new Error("ARTIFACT_NOT_READY");
  const bytes=new Uint8Array(await response.arrayBuffer());
  const checksum=createHash("sha256").update(bytes).digest("hex");
  if(checksum!==response.headers.get("etag"))throw new Error("ARTIFACT_CHECKSUM_MISMATCH");
  const tmp=join(parent,`.translator-${crypto.randomUUID()}.tmp`);
  const fd=await open(tmp,"wx",0o600);try{await fd.writeFile(bytes);await fd.sync();}finally{await fd.close();}
  // Atomic no-replace publication: hard-link fails if the user's destination already exists.
  try{await link(tmp,target);}
  catch(e){
    if((e as NodeJS.ErrnoException).code!=="EEXIST")throw e;
    const existing=await lstat(target);
    if(!existing.isFile())throw new Error("OUTPUT_EXISTS");
    if(createHash("sha256").update(await readFile(target)).digest("hex")!==checksum)throw new Error("OUTPUT_EXISTS");
    return {output_path:target,checksum,already_saved:true};
  }
  finally{await unlink(tmp);}
  return {output_path:target,checksum,already_saved:false};
}
const metadata=(value:unknown)=>({content:[{type:"text" as const,text:JSON.stringify(value)}]});
const server=new McpServer({name:"document-translator",version:"1.0.0"});
server.registerTool("translate_file",{description:"START HERE to translate one local document in the workspace. One call submits (idempotent), waits, and saves the result to output_path. If done is false, call again with the same arguments to continue. If stage is AWAITING_APPROVAL, nothing is spent: re-call with max_cost_usd >= quote.maximum_reserved_usd to approve. Returns status JSON only, never document text.",inputSchema:{input_path:z.string(),target_language:z.string(),max_cost_usd:z.number().optional(),output_path:z.string().optional(),wait_seconds:z.number().min(0).max(55).optional(),acknowledge_text_only_pdf:z.boolean().optional()}},async b=>{
  const path=await safeInput(b.input_path);const ack=!!b.acknowledge_text_only_pdf;
  if((await stat(path)).size>MAX_BYTES)throw new Error("UPLOAD_SIZE_LIMIT");
  const fileHash=createHash("sha256").update(new Uint8Array(await Bun.file(path).arrayBuffer())).digest("hex");
  const key=`mcp-file-${createHash("sha256").update(`${fileHash}:${b.target_language}:${ack}`).digest("hex")}`;
  const base=b.input_path.split(/[/\\]/).pop()!;const dot=base.lastIndexOf(".");
  const name=dot>0?base.slice(0,dot):base,ext=dot>0?base.slice(dot):"";
  const outputPath=b.output_path??join(outRoot,`${name}.${b.target_language.replace(/[^\w-]/g,"_")}${ext}`);
  const submitted=await submitFile(path,b.target_language,ack,key);
  const id=submitted.job_id;const deadline=Date.now()+(b.wait_seconds??45)*1000;
  let started=false;let data:any=submitted;
  for(;;){
    data=await api(`/api/translations/${id}`);
    if(data.stage==="AWAITING_APPROVAL"){
      const quote=data.quote;
      if(b.max_cost_usd===undefined||b.max_cost_usd<quote.maximum_reserved_usd)return metadata({job_id:id,stage:data.stage,progress:data.progress,cost:data.cost,error:data.error?.code??data.error,quote,done:false,next:"call translate_file again with max_cost_usd >= quote.maximum_reserved_usd to approve"});
      if(!started){await api(`/api/translations/${id}/start`,JSON.stringify({quote_version:quote.version,max_cost_usd:b.max_cost_usd}),`${key}-start-${quote.version}`);started=true;}
    }
    if(data.stage==="SUCCEEDED"||TERMINAL_FAILED.has(data.stage))break;
    const left=deadline-Date.now();if(left<=0)break;
    await Bun.sleep(Math.min(1500,left));
  }
  const status={job_id:id,stage:data.stage,progress:data.progress,cost:data.cost,error:data.error?.code??data.error,...(data.quote?{quote:data.quote}:{})};
  if(data.stage==="SUCCEEDED"){
    const saved=await saveArtifact(id,outputPath);
    return metadata({...status,output_path:saved.output_path,checksum:saved.checksum,...(saved.already_saved?{already_saved:true}:{}),done:true});
  }
  if(TERMINAL_FAILED.has(data.stage))return metadata({...status,done:true});
  return metadata({...status,done:false,next:"call translate_file again with the same arguments to continue"});
});
server.registerTool("translate_document",{description:"Advanced, manual prepare/start step. For a single file prefer translate_file. Prepare a local document and return its cost quote; start only with explicitly approved quote/cap. Returns metadata, never document text.",inputSchema:{action:z.enum(["prepare","start"]),input_path:z.string().optional(),target_language:z.string().optional(),idempotency_key:z.string(),job_id:z.string().optional(),quote_version:z.string().optional(),max_cost_usd:z.number().optional(),acknowledge_text_only_pdf:z.boolean().optional()}},async b=>{
  if(b.action==="start")return metadata(await api(`/api/translations/${b.job_id}/start`,JSON.stringify({quote_version:b.quote_version,max_cost_usd:b.max_cost_usd}),b.idempotency_key));
  const path=await safeInput(b.input_path!);
  return metadata(await submitFile(path,b.target_language!,b.acknowledge_text_only_pdf,b.idempotency_key));
});
server.registerTool("translation_status",{description:"Advanced: read one job's persisted progress, quote, costs, warning codes, receipt and artifact metadata (no text). translate_file already reports this.",inputSchema:{job_id:z.string(),wait_seconds:z.number().min(0).max(10).optional()}},async b=>{
  if(b.wait_seconds)await Bun.sleep(b.wait_seconds*1000);return metadata(await api(`/api/translations/${b.job_id}`));
});
server.registerTool("save_translation",{description:"Advanced: save a finished job's verified output under workspace/out (atomic, refuses overwrite of a different file; identical existing file is reported as saved). translate_file already saves on success. Returns paths/checksums only.",inputSchema:{job_id:z.string(),output_path:z.string()}},async b=>{
  const saved=await saveArtifact(b.job_id,b.output_path);
  return metadata({job_id:b.job_id,output_path:saved.output_path,checksum:saved.checksum});
});
server.registerTool("translate_folder",{description:"Advanced: batch several Markdown files matched by a glob (max 20, 25MB total) into one job group. Prepare returns a quote; start a fixed group only with an explicit aggregate cost cap. For a single file use translate_file.",inputSchema:{action:z.enum(["prepare","start"]),glob:z.string().optional(),target_language:z.string().optional(),idempotency_key:z.string(),group_id:z.string().optional(),quote_version:z.string().optional(),max_total_cost_usd:z.number().optional()}},async b=>{
  if(b.action==="start")return metadata(await api(`/api/translation-groups/${b.group_id}/start`,JSON.stringify({quote_version:b.quote_version,max_total_cost_usd:b.max_total_cost_usd}),b.idempotency_key));
  if(!b.glob || b.glob.startsWith("/") || b.glob.includes(".."))throw new Error("PATH_DENIED");
  const matches=Array.from(new Bun.Glob(b.glob).scanSync({cwd:root,onlyFiles:true,followSymlinks:false})).sort();
  if(!matches.length || matches.length>20 || matches.some(p=>!p.endsWith(".md")))throw new Error("FOLDER_LIMIT");
  const form=new FormData();let total=0;
  for(const p of matches){const path=await safeInput(p);total+=(await stat(path)).size;if(total>MAX_BYTES)throw new Error("FOLDER_LIMIT");form.append("file",Bun.file(path),p);}
  form.append("target_language",b.target_language!);
  return metadata(await api("/api/translation-groups",form,b.idempotency_key));
});
await server.connect(new StdioServerTransport());
