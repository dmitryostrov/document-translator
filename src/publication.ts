import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { sql } from "./db";
import { config,AppError } from "./config";
import { hash,assembleTranslations,validateOutput } from "./domain";
import { atomic,formatProcess } from "./files";
import { gate } from "./provider";

export async function publish(job:any,artifactId=crypto.randomUUID(),lease?:{worker:string;generation:number}) {
  const rows=await sql`select result from units where job_id=${job.id} and kind='TRANSLATE' and state='DONE' order by sequence`;
  const [coverage]=await sql`select count(*) filter(where state!='DONE')::int as missing,count(*)::int as total from units where job_id=${job.id} and kind='TRANSLATE'`;
  if(coverage.missing || !coverage.total || coverage.total!==job.ir.chunks.length)throw new AppError("ARTIFACT_INCOMPLETE");
  const translations=rows.flatMap(r=>r.result.blocks);
  // Protect literals spanning chunk boundaries after assembling the complete canonical block.
  const quality=validateOutput(job.ir.blocks,assembleTranslations(job.ir.blocks,translations),job.target);
  const id=artifactId, path=join(config.data,"artifacts",`${id}.${job.format}`);
  const expected=hash(JSON.stringify({ir:job.ir,translations,renderer:"reflow-v1"}));
  let manifest:any=null;
  try{manifest=JSON.parse(await readFile(path+".json","utf8"));}catch{}
  let reuse=false;
  if(manifest?.input_hash===expected){
    try{reuse=hash(await readFile(path))===manifest.hash;}catch{}
  }
  if(!reuse)await formatProcess("render",{ir:job.ir,translations,path});
  const bytes=await readFile(path), checksum=hash(bytes), size=bytes.length;
  await atomic(path+".json",JSON.stringify({input_hash:expected,hash:checksum,size}));
  if(!size)throw new AppError("ARTIFACT_INCOMPLETE");
  await gate("artifact-renamed");
  await sql.begin(async tx=>{
    const [current]=await tx`select stage from jobs where id=${job.id} for update`;
    if(current.stage==="CANCELED")throw new AppError("USER_CANCELED");
    if(lease){
      const [valid]=await tx`select id from units where id=${artifactId} and job_id=${job.id}
        and generation=${lease.generation} and lease_owner=${lease.worker} and state='RUNNING'
        and lease_expires_at>now() for update`;
      if(!valid)throw new AppError("LEASE_LOST");
    }else if(current.stage!=="SUCCEEDED")throw new AppError("RERENDER_JOB_NOT_READY");
    await tx`insert into artifacts(id,job_id,path,hash,size,renderer) values(${id},${job.id},${path},${checksum},${size},'reflow-v1') on conflict(id) do nothing`;
    await tx`update units set state='DONE',result=${tx.json({id,hash:checksum,size})},lease_owner=null,lease_expires_at=null where id=${id} and job_id=${job.id} and kind='RENDER'`;
    await tx`update jobs set stage='SUCCEEDED',artifact=${tx.json({id,path,hash:checksum,size,renderer:"reflow-v1"})},quality=${tx.json({numbers:{expected:quality.expected,correct:quality.correct,rate:quality.rate}})},error=null,updated_at=now() where id=${job.id}`;
  });
  return {id,hash:checksum,size};
}
