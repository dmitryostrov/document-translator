import { mkdir, open, rename, readFile, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { config } from "./config";
import { hash } from "./domain";

export async function atomic(path: string, bytes: Uint8Array | string) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${crypto.randomUUID()}.tmp`;
  const fd = await open(tmp, "wx", 0o600);
  try { await fd.writeFile(bytes); await fd.sync(); } finally { await fd.close(); }
  await rename(tmp, path);
  // Persist the directory entry on the Linux delivery filesystem.
  if (process.platform !== "win32") {
    const dir = await open(dirname(path), "r"); try { await dir.sync(); } finally { await dir.close(); }
  }
}
export async function formatProcess(action: "extract" | "render", input: object) {
  const id = crypto.randomUUID(), request = join(config.data, "scratch", `${id}.json`), result = `${request}.result`;
  const original=input as {path:string;format?:string};
  const staged=join(config.data,"scratch",`${id}.artifact`);
  const fixtureHold=config.mode==="fake"&&action==="extract"&&original.format==="pdf";
  await atomic(request, JSON.stringify({...input,...(action==="render"?{path:staged}:{}),fixture_hold:fixtureHold}));
  let settled=false;
  const relay=fixtureHold?(async()=>{
    while(!settled){
      if(await stat(request+".ready").then(()=>true,()=>false)){
        const {sql}=await import("./db");
        await sql`update test_gates set hits=hits+1 where name='slow-pdf-subprocess' and enabled=true`;
        while(!settled){const [g]=await sql`select enabled from test_gates where name='slow-pdf-subprocess'`;if(!g?.enabled)break;await Bun.sleep(100);}
        if(!settled)await atomic(request+".release","release");return;
      }
      await Bun.sleep(50);
    }
  })():Promise.resolve();
  try {
    const response=await fetch("http://parser/format",{unix:process.env.FORMAT_SOCKET_PATH??"/ipc/format.sock",method:"POST",
      headers:{"Content-Type":"application/json"},body:JSON.stringify({id,action}),signal:AbortSignal.timeout(65_000)});
    if(!response.ok)throw new Error("FORMAT_SERVICE_UNAVAILABLE");
    const data = JSON.parse(await readFile(result, "utf8"));
    if (data.error) throw new Error(data.error);
    if(action==="render")await atomic(original.path,await readFile(staged));
    return data;
  }catch(error:any){
    if(["ConnectionRefused","ECONNREFUSED","ENOENT","ECONNRESET","TimeoutError","AbortError"].includes(error.code??error.name))throw new Error("FORMAT_SERVICE_UNAVAILABLE");
    throw error;
  } finally {
    settled=true;
    // Result and artifact were read or copied above; remove every scratch file, including the fixture gate files.
    try{await relay;}finally{
      await Promise.all([request,result,staged,request+".ready",request+".release"].map(p=>unlink(p).catch(()=>{})));
    }
  }
}
