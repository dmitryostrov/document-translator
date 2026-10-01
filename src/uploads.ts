import busboy from "busboy";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { mkdir, open, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { config, AppError } from "./config";
export type Uploaded={path:string;size:number;checksum:string};
// The HTTP body is streamed with backpressure; source bytes never enter a full-body buffer.
export async function upload(request:Request,maxFiles=1){
  if(!request.body)throw new AppError("FILE_REQUIRED",400);
  await mkdir(join(config.data,"uploads"),{recursive:true});
  let parser;try{parser=busboy({headers:Object.fromEntries(request.headers),preservePath:true,limits:{fileSize:25*1024*1024,files:maxFiles,fields:3,fieldSize:1024,parts:maxFiles+3}});}catch{throw new AppError("MULTIPART_INVALID",400);}
  const fields:Record<string,string>={},files:{name:string;bytes:Uploaded}[]=[],pending:Promise<void>[]=[],paths:string[]=[];
  let total=0,error:Error|undefined;
  parser.on("field",(name,value,info)=>{if(info.valueTruncated || fields[name]!==undefined)error=new AppError("MULTIPART_INVALID",400);fields[name]=value;});
  for(const limit of ["filesLimit","fieldsLimit","partsLimit"] as const)parser.on(limit,()=>{error=new AppError("UPLOAD_SIZE_LIMIT",413);});
  parser.on("file",(name,stream,info)=>{
    if(name!=="file"){error=new AppError("FILE_REQUIRED",400);stream.resume();return;}
    const path=join(config.data,"uploads",`${crypto.randomUUID()}.tmp`),digest=createHash("sha256");
    paths.push(path);let size=0;
    stream.on("limit",()=>{error=new AppError("UPLOAD_SIZE_LIMIT",413);});
    const meter=new Transform({transform(chunk,_,callback){
      total+=chunk.length;size+=chunk.length;
      if(total>25*1024*1024){callback(new AppError("UPLOAD_SIZE_LIMIT",413));return;}
      digest.update(chunk);callback(null,chunk);
    }});
    pending.push(pipeline(stream,meter,createWriteStream(path,{flags:"wx",mode:0o600})).then(async()=>{
      const fd=await open(path,"r+");try{await fd.sync();}finally{await fd.close();}
      files.push({name:info.filename,bytes:{path,size,checksum:digest.digest("hex")}});
    }).catch(e=>{error=e;}));
  });
  const cleanup=async()=>{for(const path of paths)await unlink(path).catch(()=>{});};
  try{
    await pipeline(Readable.fromWeb(request.body as any),parser);
    await Promise.all(pending);
    if(error)throw error;if(!files.length)throw new AppError("FILE_REQUIRED",400);
    return {fields,files,cleanup};
  }catch(e){await Promise.all(pending);await cleanup();throw e instanceof AppError?e:new AppError("MULTIPART_INVALID",400);}
}
