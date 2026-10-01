import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp,mkdir,readFile,writeFile,stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve,join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { strict as assert } from "node:assert";
import { fixturePDF,source } from "./fixtures";
import { poll } from "./test-support";
import { mcpFixtureOutput } from "./mcp-workspace";

const root=process.cwd();
const run=(command:string,args:string[],cwd=root,env=process.env)=>{
  const p=spawnSync(command,args,{cwd,env:{...env,GIT_TERMINAL_PROMPT:"0"},encoding:"utf8",maxBuffer:8*1024*1024});
  if(p.status!==0)throw new Error(`${command.toUpperCase()}_FAILED: ${p.stderr.slice(-1500)}`);
  return p.stdout.trim();
};
const git=(args:string[],cwd=root)=>run("git",["-c",`safe.directory=${cwd.replaceAll("\\","/")}`,...args],cwd);
const repository=process.argv[2]??git(["remote","get-url","origin"]);
assert.match(repository,/^(?:git@github\.com:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+|https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/,"Use a GitHub URL without embedded credentials");
const expected=git(["rev-parse","HEAD"]);
const scratch=await mkdtemp(join(tmpdir(),"stark-clone-")),checkout=join(scratch,"checkout");
git(["clone","--",repository,checkout]);
const commit=git(["rev-parse","HEAD"],checkout);assert.equal(commit,expected,"Fresh clone must contain the pushed local HEAD");
const files=git(["ls-files"],checkout).split(/\r?\n/);
assert.ok(files.every(p=>!p.startsWith(".vscode/")&&!p.startsWith("node_modules/")&&!p.startsWith(".runtime/")));
assert.equal(await stat(join(checkout,".vscode")).then(()=>true,()=>false),false);
assert.equal(await stat(join(checkout,"node_modules")).then(()=>true,()=>false),false);
const runtimeFiles=files.filter(p=>/^(src\/|scripts\/|tests\/|web\/|\.github\/)/.test(p)||["package.json","bun.lock","Dockerfile","compose.yaml","compose.test.yaml","tsconfig.json","playwright.config.ts",".gitignore",".dockerignore",".env.example"].includes(p));
const digest=createHash("sha256");
for(const path of runtimeFiles.sort()){digest.update(path+"\0");digest.update(await readFile(join(checkout,path)));digest.update("\0");}
const runtimeTreeSha256=digest.digest("hex");
const live=process.env.FRESH_LIVE==="1",project=`stark-clone-${crypto.randomUUID().slice(0,8)}`,base="http://127.0.0.1:3112";
const workspace=join(scratch,"workspace");await mkdir(workspace);await mkdir(join(workspace,"out"));
await writeFile(join(workspace,"manual.md"),source);await writeFile(join(workspace,"manual.pdf"),await fixturePDF());
const unusedKey=join(scratch,"unused-key.txt");if(!live)await writeFile(unusedKey,"");
const keyPath=live?resolve(process.env.FRESH_OPENAI_KEY_PATH??".vscode/openapi-key.txt"):unusedKey;
if(live)assert.ok((await stat(keyPath)).isFile(),"Provide an existing external OpenAI key file");
const environment={...process.env,COMPOSE_PROJECT_NAME:project,APP_PORT:"3112",PROVIDER_MODE:live?"openai":"fake",OPENAI_KEY_PATH:keyPath.replaceAll("\\","/")};
const composeArgs=["compose","--project-directory",checkout,"-p",project,"-f",join(checkout,"compose.yaml"),...(live?[]:["-f",join(checkout,"compose.test.yaml")])];
const compose=(args:string[])=>run("docker",[...composeArgs,...args],checkout,environment);
const hash=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
const originals={pdf:hash(await readFile(join(workspace,"manual.pdf"))),md:hash(await readFile(join(workspace,"manual.md")))};
let cookie="",started=false;
async function api(path:string,body?:BodyInit,key?:string){
  const r=await fetch(base+path,{method:body?"POST":"GET",body,headers:{...(cookie?{Cookie:cookie}:{}),...(key?{"Idempotency-Key":key}:{}),...(typeof body==="string"?{"Content-Type":"application/json"}:{})}});
  if(r.headers.has("set-cookie"))cookie=r.headers.get("set-cookie")!.split(";")[0];
  const value=await r.json();assert.ok(r.ok,JSON.stringify(value));return value;
}
const evidence:any[]=[];
try{
  started=true;compose(["up","-d","--build","--wait","--wait-timeout","120"]);
  assert.equal((await api("/health")).provider_mode,live?"openai":"fake");
  for(const format of ["pdf","md"] as const){
    const form=new FormData();form.append("file",new Blob([new Uint8Array(await readFile(join(workspace,`manual.${format}`)))]),`manual.${format}`);form.append("target_language","german");
    const submitted=await api("/api/translations",form,crypto.randomUUID());
    const quote=await poll(()=>api(`/api/translations/${submitted.job_id}`),j=>["AWAITING_APPROVAL","FAILED"].includes(j.stage));
    assert.equal(quote.stage,"AWAITING_APPROVAL");assert.equal(quote.cost.completed_calls,0);
    await api(`/api/translations/${quote.job_id}/start`,JSON.stringify({quote_version:quote.quote.version,max_cost_usd:.25}),crypto.randomUUID());
    const done=await poll(()=>api(`/api/translations/${quote.job_id}`),j=>["SUCCEEDED","FAILED","NEEDS_ATTENTION"].includes(j.stage));
    assert.equal(done.stage,"SUCCEEDED");
    const response=await fetch(base+done.artifact.url,{headers:{Cookie:cookie}});assert.ok(response.ok);
    const bytes=new Uint8Array(await response.arrayBuffer());assert.equal(hash(bytes),done.artifact.checksum);
    if(format==="pdf")assert.equal(new TextDecoder().decode(bytes.slice(0,5)),"%PDF-");
    else assert.ok(new TextDecoder().decode(bytes).includes("https://example.com/manual"));
    evidence.push({front_door:"api",format,stage:done.stage,checksum:done.artifact.checksum,cost:done.cost});
  }
  const client=new Client({name:"fresh-clone-readme-verification",version:"1.0.0"});
  const output=mcpFixtureOutput(workspace,composeArgs,environment,checkout);output.prepare();
  const transport=new StdioClientTransport({command:"docker",args:[...composeArgs,"run","--rm","--no-deps","-T","-v",`${workspace.replaceAll("\\","/")}:/workspace`,"mcp"],env:environment as Record<string,string>,stderr:"pipe"});
  try{
    await client.connect(transport);
    assert.deepEqual((await client.listTools()).tools.map(t=>t.name).sort(),["save_translation","translate_document","translate_folder","translation_status"]);
    const call=async(name:string,args:any)=>{const result:any=await client.callTool({name,arguments:args});assert.ok(!result.isError,JSON.stringify(result.content));return JSON.parse(result.content[0].text);};
    for(const format of ["pdf","md"] as const){
      const accepted=await call("translate_document",{action:"prepare",input_path:`/workspace/manual.${format}`,target_language:"german",idempotency_key:crypto.randomUUID()});
      const quote=await poll(()=>call("translation_status",{job_id:accepted.job_id}),j=>["AWAITING_APPROVAL","FAILED"].includes(j.stage));
      assert.equal(quote.stage,"AWAITING_APPROVAL");assert.equal(quote.cost.completed_calls,0);
      await call("translate_document",{action:"start",job_id:quote.job_id,quote_version:quote.quote.version,max_cost_usd:.25,idempotency_key:crypto.randomUUID()});
      const done=await poll(()=>call("translation_status",{job_id:quote.job_id}),j=>["SUCCEEDED","FAILED","NEEDS_ATTENTION"].includes(j.stage));
      assert.equal(done.stage,"SUCCEEDED");
      const saved=await call("save_translation",{job_id:quote.job_id,output_path:`/workspace/out/manual.de.${format}`});
      assert.equal(await output.checksum(`manual.de.${format}`),saved.checksum);
      assert.equal(hash(await readFile(join(workspace,`manual.${format}`))),originals[format]);
      evidence.push({front_door:"mcp",format,stage:done.stage,checksum:saved.checksum,cost:done.cost,inputs_preserved:true});
    }
  }finally{try{await client.close();}finally{output.restore();}}
  await mkdir("evidence",{recursive:true});
  const path=live?"evidence/fresh-clone-live.json":"evidence/fresh-clone.json";
  await writeFile(path,JSON.stringify({kind:"fresh Git clone of private GitHub repository",repository,commit,runtime_tree_sha256:runtimeTreeSha256,directory:checkout,project,provider:live?"openai":"fake",vscode_tracked:false,vscode_present:false,host_node_modules_copied:false,host_dependencies_required_for_app:false,key_copied:false,results:evidence},null,2));
  console.log(JSON.stringify({passed:evidence.length,commit,evidence:path,provider:live?"openai":"fake"}));
}finally{if(started)compose(["down"]);} // Keep named volumes; only this run's containers/network are removed.
