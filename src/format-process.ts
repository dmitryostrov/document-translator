import { readFile,realpath,stat } from "node:fs/promises";
import { join,resolve } from "node:path";
import { config } from "./config";
import { extract, render } from "./formats";
import { atomic } from "./files";
const [action,request,result]=process.argv.slice(2);
try {
  const input=JSON.parse(await readFile(request,"utf8"));
  if(action==="extract"){
    const source=await realpath(input.path),root=await realpath(join(config.data,"sources"));
    if(!source.startsWith(root+"/")||!["pdf","md"].includes(input.format))throw new Error("FORMAT_REQUEST_INVALID");
    const extracted=await extract(input.path,input.format,input.options);
    if(process.env.PROVIDER_MODE==="fake"&&input.fixture_hold){
      await atomic(request+".ready","ready");
      while(!await stat(request+".release").then(()=>true,()=>false))await Bun.sleep(50);
    }
    await atomic(result,JSON.stringify(extracted));
  }
  else if(action==="render"){
    if(resolve(input.path)!==resolve(request.replace(/\.json$/,".artifact")))throw new Error("FORMAT_REQUEST_INVALID");
    await render(input.ir,input.translations,input.path);await atomic(result,JSON.stringify({ok:true}));
  }else throw new Error("FORMAT_REQUEST_INVALID");
} catch(error:any){await atomic(result,JSON.stringify({error:error.code??error.message??"FORMAT_FAILED"}));}
