import { spawnSync } from "node:child_process";
import { source } from "./fixtures";
export const project=`stark-test-${process.env.TEST_RUN_ID??"local"}`,base=process.env.TEST_API_URL??"http://127.0.0.1:3110";
export const environment={...process.env,MODEL:process.env.TEST_MODEL??"gpt-4.1-mini",PROVIDER_MODE:"fake",APP_PORT:"3110",OPENAI_API_KEY:"",OPENAI_API_KEY_FILE:"",OPENAI_KEY_PATH:"/dev/null"};
export function docker(args:string[]){
  const p=spawnSync("docker",args,{env:environment,encoding:"utf8",maxBuffer:4*1024*1024});
  if(p.status!==0)throw new Error(`DOCKER_COMMAND_FAILED: ${p.stderr.slice(-1500)}`);
  return p.stdout.trim();
}
export const compose=(args:string[])=>docker(["compose","-p",project,"-f","compose.yaml","-f","compose.test.yaml",...args]);
export async function setup(build=true){
  compose(["up","-d",...(build?["--build"]:[]),"--wait","--wait-timeout","120"]);
  const mode=await fetch(base+"/health").then(r=>r.json());
  if(mode.provider_mode!=="fake")throw new Error("REFUSE_LIVE_PROVIDER_TEST");
}
export function testStackState(){
  return new Set(compose(["ps","--status","running","--services"]).split(/\r?\n/).filter(Boolean));
}
export function restoreTestStack(before:Set<string>){
  const started=["api","worker","parser","postgres","redis"].filter(service=>!before.has(service));
  if(started.length)compose(["stop",...started]);
}
export function db(query:string){return compose(["exec","-T","postgres","psql","-U","stark","-d","stark","-Atc",query]);}
export async function poll<T>(fn:()=>Promise<T>,predicate:(v:T)=>boolean,timeout=75_000){
  const begin=Date.now();let last:T;
  while(Date.now()-begin<timeout){last=await fn();if(predicate(last))return last;await new Promise(resolve=>setTimeout(resolve,250));}
  throw new Error("POLL_DEADLINE");
}
export class Session{
  cookie="";
  async request(path:string,body?:BodyInit,key?:string){
    const r=await fetch(base+path,{method:body?"POST":"GET",headers:{...(this.cookie?{Cookie:this.cookie}:{}),...(key?{"Idempotency-Key":key}:{}),...(typeof body==="string"?{"Content-Type":"application/json"}:{})},body});
    if(r.headers.get("set-cookie"))this.cookie=r.headers.get("set-cookie")!.split(";")[0];
    return {code:r.status,data:await r.json()};
  }
  async prepare(bytes:Uint8Array| string=source,name="sample.md",key=crypto.randomUUID(),ack=false){
    const form=new FormData();form.append("file",new Blob([typeof bytes==="string"?bytes:new Uint8Array(bytes)]),name);form.append("target_language","german");form.append("acknowledge_text_only_pdf",String(ack));
    return this.request("/api/translations",form,key);
  }
  async status(id:string){return (await this.request(`/api/translations/${id}`)).data;}
  async quote(id:string){return poll(()=>this.status(id),j=>["AWAITING_APPROVAL","FAILED"].includes(j.stage));}
  async start(j:any){return this.request(`/api/translations/${j.job_id}/start`,JSON.stringify({quote_version:j.quote.version,max_cost_usd:Math.max(1,j.quote.maximum_reserved_usd)}),crypto.randomUUID());}
  async done(id:string){return poll(()=>this.status(id),j=>["SUCCEEDED","FAILED","NEEDS_ATTENTION","CANCELED"].includes(j.stage));}
}
