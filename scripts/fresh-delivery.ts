import { cp,mkdtemp,mkdir,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve,join } from "node:path";
import { spawnSync } from "node:child_process";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
const destination=await mkdtemp(join(tmpdir(),"translator-fresh-")),project=`translator-fresh-${crypto.randomUUID().slice(0,8)}`;
const files=["package.json","bun.lock","tsconfig.json","Dockerfile","compose.yaml",".dockerignore",".gitignore",".env.example","README.md","DECISIONS.md","PROMPTS.md","src","scripts","tests","web"];
for(const f of files)await cp(resolve(f),join(destination,f),{recursive:true,errorOnExist:true});
const environment={...process.env,APP_PORT:"3112",OPENAI_KEY_PATH:resolve(".vscode/openapi-key.txt").replaceAll("\\","/"),PROVIDER_MODE:"openai"};
function compose(args:string[]){
  const r=spawnSync("docker",["compose","-p",project,...args],{cwd:destination,env:environment,encoding:"utf8",maxBuffer:6*1024*1024});
  if(r.status!==0)throw new Error(`FRESH_DOCKER_COMMAND_FAILED: ${r.stderr.slice(-1000)}`);return r.stdout.trim();
}
const base="http://127.0.0.1:3112";let cookie="";
async function request(path:string,body?:BodyInit,key?:string){
  const r=await fetch(base+path,{method:body?"POST":"GET",body,headers:{...(cookie?{Cookie:cookie}:{}),...(key?{"Idempotency-Key":key}:{}),...(typeof body==="string"?{"Content-Type":"application/json"}:{})}});
  if(r.headers.has("set-cookie"))cookie=r.headers.get("set-cookie")!.split(";")[0];const value=await r.json();assert.ok(r.ok,JSON.stringify(value));return value;
}
try{
  compose(["up","-d","--build","--wait"]);assert.equal((await request("/health")).provider_mode,"openai");
  const f=new FormData();f.append("file",new Blob(["# Battery service\n\nThe battery supplies 12 kW. Service the motor every 100 km."]),"fresh.md");f.append("target_language","german");
  const accepted=await request("/api/translations",f,crypto.randomUUID());let status;
  do{await Bun.sleep(200);status=await request(`/api/translations/${accepted.job_id}`);}while(status.stage==="PREFLIGHT");
  assert.equal(status.stage,"AWAITING_APPROVAL");
  await request(`/api/translations/${accepted.job_id}/start`,JSON.stringify({quote_version:status.quote.version,max_cost_usd:.2}),crypto.randomUUID());
  const deadline=Date.now()+90000;
  do{await Bun.sleep(250);status=await request(`/api/translations/${accepted.job_id}`);if(Date.now()>deadline)throw new Error("FRESH_TRANSLATION_DEADLINE");}while(!["SUCCEEDED","FAILED","NEEDS_ATTENTION"].includes(status.stage));
  assert.equal(status.stage,"SUCCEEDED");
  const bytes=await fetch(base+status.artifact.url,{headers:{Cookie:cookie}}).then(r=>r.arrayBuffer());
  assert.equal(createHash("sha256").update(new Uint8Array(bytes)).digest("hex"),status.artifact.checksum);
  await mkdir("evidence",{recursive:true});await writeFile("evidence/fresh-delivery.json",JSON.stringify({kind:"explicit source-file copy, not a Git clone",directory:destination,project,host_node_modules_copied:false,key_copied:false,healthy:true,provider:"openai",stage:status.stage,checksum:status.artifact.checksum,cost:status.cost},null,2));
  console.log(JSON.stringify({passed:true,evidence:"evidence/fresh-delivery.json",directory:destination}));
}finally{compose(["down"]);} // Preserve this test's named volumes; no destructive volume cleanup.
