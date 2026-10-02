import { mkdir,stat,unlink,chmod } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config";
const socket=process.env.FORMAT_SOCKET_PATH??"/ipc/format.sock";
await mkdir("/ipc",{recursive:true});
const old=await stat(socket).catch(()=>null);
if(old){if(!old.isSocket())throw new Error("FORMAT_SOCKET_INVALID");await unlink(socket);}
let active=0;
const server=Bun.serve({unix:socket,maxRequestBodySize:4096,async fetch(request){
  if(new URL(request.url).pathname==="/health")return Response.json({ok:true});
  if(request.method!=="POST"||new URL(request.url).pathname!=="/format")return new Response(null,{status:404});
  let payload:any;try{payload=await request.json();}catch{return Response.json({error:"FORMAT_REQUEST_INVALID"},{status:400});}
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(payload.id??"")||!["extract","render"].includes(payload.action))return Response.json({error:"FORMAT_REQUEST_INVALID"},{status:400});
  if(active>=4)return Response.json({error:"FORMAT_SERVICE_BUSY"},{status:503});
  active++;
  const input=join(config.data,"scratch",payload.id+".json"),output=input+".result";
  const proc=Bun.spawn(["bun","src/format-process.ts",payload.action,input,output],{stdout:"ignore",stderr:"pipe",
    env:{PATH:"/usr/local/bin:/usr/bin:/bin",DATA_DIR:config.data,FONT_PATH:process.env.FONT_PATH??"/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",PROVIDER_MODE:config.mode==="fake"?"fake":"parser"}});
  const abort=()=>proc.kill("SIGKILL");
  const timer=setTimeout(abort,60_000);request.signal.addEventListener("abort",abort,{once:true});
  try{
    // Library stderr may contain input paths/text. Drain it concurrently and discard it.
    const [code]=await Promise.all([proc.exited,new Response(proc.stderr).text()]);
    return Response.json({ok:code===0},{status:code===0?200:503});
  }finally{clearTimeout(timer);request.signal.removeEventListener("abort",abort);active--;}
}});
await chmod(socket,0o600);
console.error(JSON.stringify({event:"format_service_ready",isolated:true}));
