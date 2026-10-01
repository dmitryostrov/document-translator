import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFile, realpath, mkdir, open, link, unlink,stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, relative, dirname, join } from "node:path";
import { config } from "./config";
const root=await realpath(process.env.WORKSPACE_ROOT??"/workspace");
const outRoot=join(root,"out");await mkdir(outRoot,{recursive:true});
const canonicalOut=await realpath(outRoot);
if(relative(root,canonicalOut).startsWith(".."))throw new Error("OUTPUT_PATH_DENIED");
const token=(await readFile(config.tokenFile,"utf8")).trim();
async function api(path:string,body?:BodyInit,key?:string){
  const response=await fetch(config.api+path,{method:body?"POST":"GET",headers:{Authorization:`Bearer ${token}`,...(key?{"Idempotency-Key":key}:{}),...(typeof body==="string"?{"Content-Type":"application/json"}:{})},body});
  const data=await response.json();if(!response.ok)throw new Error(data.error?.code??"REQUEST_FAILED");return data;
}
export async function safeInput(path:string){
  const resolved=await realpath(resolve(root,path));const rel=relative(root,resolved);
  if(rel.startsWith("..")||resolve(root,rel)!==resolved)throw new Error("PATH_DENIED");return resolved;
}
const metadata=(value:unknown)=>({content:[{type:"text" as const,text:JSON.stringify(value)}]});
const server=new McpServer({name:"stark-translator",version:"1.0.0"});
const schema={action:z.enum(["prepare","start"]),input_path:z.string().optional(),target_language:z.string().optional(),idempotency_key:z.string(),job_id:z.string().optional(),quote_version:z.string().optional(),max_cost_usd:z.number().optional(),acknowledge_text_only_pdf:z.boolean().optional()};
server.registerTool("translate_document",{description:"Prepare local document and return cost quote. Start only with explicitly approved quote/cap. Returns metadata, never document text.",inputSchema:schema},async b=>{
  if(b.action==="start")return metadata(await api(`/api/translations/${b.job_id}/start`,JSON.stringify({quote_version:b.quote_version,max_cost_usd:b.max_cost_usd}),b.idempotency_key));
  const path=await safeInput(b.input_path!);const form=new FormData();
  if((await stat(path)).size>25*1024*1024)throw new Error("UPLOAD_SIZE_LIMIT");
  form.append("file",Bun.file(path),path.split(/[/\\]/).pop()!);form.append("target_language",b.target_language!);form.append("acknowledge_text_only_pdf",String(!!b.acknowledge_text_only_pdf));
  return metadata(await api("/api/translations",form,b.idempotency_key));
});
server.registerTool("translation_status",{description:"Persisted job progress, quote, costs, warning codes, receipt and artifact metadata only.",inputSchema:{job_id:z.string(),wait_seconds:z.number().min(0).max(10).optional()}},async b=>{
  if(b.wait_seconds)await Bun.sleep(b.wait_seconds*1000);return metadata(await api(`/api/translations/${b.job_id}`));
});
server.registerTool("save_translation",{description:"Save verified output under workspace/out atomically; refuse overwrite. Returns paths/checksums only.",inputSchema:{job_id:z.string(),output_path:z.string()}},async b=>{
  const target=resolve(root,b.output_path),parent=await realpath(dirname(target));
  const rel=relative(canonicalOut,parent);
  if(rel.startsWith("..") || !target.startsWith(outRoot+"/") && !target.startsWith(outRoot+"\\"))throw new Error("OUTPUT_PATH_DENIED");
  const response=await fetch(`${config.api}/api/translations/${b.job_id}/artifact`,{headers:{Authorization:`Bearer ${token}`}});
  if(!response.ok)throw new Error("ARTIFACT_NOT_READY");
  const bytes=new Uint8Array(await response.arrayBuffer());
  if(createHash("sha256").update(bytes).digest("hex")!==response.headers.get("etag"))throw new Error("ARTIFACT_CHECKSUM_MISMATCH");
  const tmp=join(parent,`.stark-${crypto.randomUUID()}.tmp`);
  const fd=await open(tmp,"wx",0o600);try{await fd.writeFile(bytes);await fd.sync();}finally{await fd.close();}
  // Atomic no-replace publication: hard-link fails if the user's destination already exists.
  try{await link(tmp,target);}finally{await unlink(tmp);}
  return metadata({job_id:b.job_id,output_path:target,checksum:response.headers.get("etag")});
});
server.registerTool("translate_folder",{description:"Prepare bounded Markdown folder glob via the same core, or start fixed group with an explicit aggregate cost cap.",inputSchema:{action:z.enum(["prepare","start"]),glob:z.string().optional(),target_language:z.string().optional(),idempotency_key:z.string(),group_id:z.string().optional(),quote_version:z.string().optional(),max_total_cost_usd:z.number().optional()}},async b=>{
  if(b.action==="start")return metadata(await api(`/api/translation-groups/${b.group_id}/start`,JSON.stringify({quote_version:b.quote_version,max_total_cost_usd:b.max_total_cost_usd}),b.idempotency_key));
  if(!b.glob || b.glob.startsWith("/") || b.glob.includes(".."))throw new Error("PATH_DENIED");
  const matches=Array.from(new Bun.Glob(b.glob).scanSync({cwd:root,onlyFiles:true,followSymlinks:false})).sort();
  if(!matches.length || matches.length>20 || matches.some(p=>!p.endsWith(".md")))throw new Error("FOLDER_LIMIT");
  const form=new FormData();let total=0;
  for(const p of matches){const path=await safeInput(p);total+=(await stat(path)).size;if(total>25*1024*1024)throw new Error("FOLDER_LIMIT");form.append("file",Bun.file(path),p);}
  form.append("target_language",b.target_language!);
  return metadata(await api("/api/translation-groups",form,b.idempotency_key));
});
await server.connect(new StdioServerTransport());
