import { readFile } from "node:fs/promises";
import { extract, render } from "./formats";
import { atomic } from "./files";
const [action,request,result]=process.argv.slice(2);
try {
  const input=JSON.parse(await readFile(request,"utf8"));
  if(action==="extract"){
    const extracted=await extract(input.path,input.format,input.options);
    if(process.env.PROVIDER_MODE==="fake"&&input.format==="pdf"){
      const {gate}=await import("./provider");await gate("slow-pdf-subprocess");
      const {sql}=await import("./db");await sql.end();
    }
    await atomic(result,JSON.stringify(extracted));
  }
  else {await render(input.ir,input.translations,input.path);await atomic(result,JSON.stringify({ok:true}));}
} catch(error:any){await atomic(result,JSON.stringify({error:error.code??error.message??"FORMAT_FAILED"}));}
