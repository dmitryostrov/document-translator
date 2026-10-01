import { join } from "node:path";
import { readFile, stat, rename, open } from "node:fs/promises";
import { dirname } from "node:path";
import type { Uploaded } from "./uploads";
import { sql } from "./db";
import { AppError, config } from "./config";
import { atomic } from "./files";
import { hash, normalizeTarget, terminal } from "./domain";
import { notify } from "./queue";
import { gate } from "./provider";

export async function jobFor(owner: string, id: string) {
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))throw new AppError("INVALID_JOB_ID",400);
  const rows=await sql`select * from jobs where id=${id} and owner=${owner}`;
  if(!rows.length)throw new AppError("JOB_NOT_FOUND",404);return rows[0];
}
export async function submit(owner:string, bytes:Uint8Array|Uploaded, filename:string, language:unknown, requestKey:string, options:any={}) {
  if(!requestKey || requestKey.length>200)throw new AppError("IDEMPOTENCY_KEY_REQUIRED",400);
  const size=bytes instanceof Uint8Array?bytes.length:bytes.size;
  if(size>25*1024*1024 || !size)throw new AppError("UPLOAD_SIZE_LIMIT",413);
  const target=normalizeTarget(language), ext=filename.toLowerCase().split(".").pop();
  if(!["md","pdf"].includes(ext??""))throw new AppError("FORMAT_UNSUPPORTED",415);
  const canonicalOptions={acknowledge_text_only_pdf:options.acknowledge_text_only_pdf===true};
  const sourceHash=bytes instanceof Uint8Array?hash(bytes):bytes.checksum, fingerprint=hash(JSON.stringify({sourceHash,target,format:ext,options:canonicalOptions}));
  const old=await sql`select id,fingerprint from jobs where owner=${owner} and request_key=${requestKey}`;
  if(old.length){if(old[0].fingerprint!==fingerprint)throw new AppError("IDEMPOTENCY_CONFLICT",409);return status(owner,old[0].id);}
  const id=crypto.randomUUID(), path=join(config.data,"sources",`${id}.${ext}`), unit=crypto.randomUUID();
  if(bytes instanceof Uint8Array)await atomic(path,bytes);
  else{
    const {mkdir}=await import("node:fs/promises");await mkdir(dirname(path),{recursive:true});
    await rename(bytes.path,path);
    const dir=await open(dirname(path),"r");try{await dir.sync();}finally{await dir.close();}
  } // Flush source and directory before acknowledging durable acceptance.
  const accepted=await sql.begin(async tx=>{
    await tx`insert into jobs(id,owner,request_key,fingerprint,format,target,options,source_path,source_hash)
      values(${id},${owner},${requestKey},${fingerprint},${ext!},${target},${tx.json(canonicalOptions)},${path},${sourceHash})
      on conflict(owner,request_key) do nothing returning id`;
    const [row]=await tx`select id,fingerprint from jobs where owner=${owner} and request_key=${requestKey}`;
    if(row.fingerprint!==fingerprint)throw new AppError("IDEMPOTENCY_CONFLICT",409);
    await tx`insert into units(id,job_id,kind) values(${unit},${row.id},'PREFLIGHT') on conflict(job_id,kind,sequence) do nothing`;
    return row.id;
  });
  await gate("api-committed");
  const [ready]=await sql`select id,generation from units where job_id=${accepted} and kind='PREFLIGHT'`;
  await notify(ready.id,ready.generation);return status(owner,accepted);
}
export async function totals(id:string) {
  const [r]=await sql`select coalesce(sum(cost),0) as known,
    coalesce(sum(case when state in ('INTENT','SUBMITTED') then reserved else 0 end),0) as active,
    coalesce(sum(case when state='OUTCOME_UNKNOWN' then reserved else 0 end),0) as unknown,
    count(*) filter(where state='COMPLETED')::int as completed,
    coalesce(sum((usage->>'input')::bigint),0) as input_tokens,
    coalesce(sum((usage->>'output')::bigint),0) as output_tokens,
    coalesce(sum((usage->>'cached')::bigint),0) as cached_tokens,
    coalesce(sum((usage->>'write')::bigint),0) as cache_write_tokens from calls where job_id=${id}`;
  return {currency:"USD",known_cost_usd:Number(r.known),active_reserved_usd:Number(r.active),
    unresolved_exposure_usd:Number(r.unknown),completed_calls:r.completed,
    tokens:{input:Number(r.input_tokens),output:Number(r.output_tokens),cached:Number(r.cached_tokens),cache_write:Number(r.cache_write_tokens)}};
}
export async function status(owner:string,id:string) {
  const job=await jobFor(owner,id);
  const [count]=await sql`select count(*) filter(where kind='TRANSLATE')::int as total,
    count(*) filter(where kind='TRANSLATE' and state='DONE')::int as done from units where job_id=${id}`;
  return {job_id:id,stage:job.stage,target_language:job.target,format:job.format,quote:job.quote,
    progress:{completed:count.done,total:count.total},warnings:job.warnings,error:job.error,
    cost:{...await totals(id),cap_usd:Number(job.cap)},quality:job.quality,
    artifact:job.artifact ? {id:job.artifact.id,checksum:job.artifact.hash,size:job.artifact.size,url:`/api/translations/${id}/artifact`} : null,
    receipt_url:`/api/translations/${id}/receipt`,created_at:job.created_at,updated_at:job.updated_at};
}
export async function start(owner:string,id:string,version:string,cap:number,requestKey:string) {
  await jobFor(owner,id);
  if(!requestKey || !Number.isFinite(cap) || cap<=0 || cap>1000)throw new AppError("INVALID_BUDGET_OR_START_KEY",400);
  await sql.begin(async tx=>{
    await tx`select pg_advisory_xact_lock(91783002)`;
    const [job]=await tx`select * from jobs where id=${id} and owner=${owner} for update`;
    if(!job)throw new AppError("JOB_NOT_FOUND",404);
    const fp=hash(JSON.stringify({version,cap}));
    const [old]=await tx`select fingerprint from starts where job_id=${id} and request_key=${requestKey}`;
    if(old){if(old.fingerprint!==fp)throw new AppError("IDEMPOTENCY_CONFLICT",409);return;}
    if(!job.quote || job.quote.version!==version)throw new AppError("QUOTE_STALE",409);
    if(job.quote.model!==config.model||job.quote.prompt_version!==config.prompt||job.quote.rates_version!==config.ratesVersion)throw new AppError("QUOTE_STALE",409);
    if(job.quote.policy_version!==config.policy)throw new AppError("QUOTE_STALE",409);
    if(!job.approved && new Date(job.quote.expires_at).getTime()<Date.now())throw new AppError("APPROVAL_EXPIRED",409);
    if(cap<job.quote.maximum_reserved_usd)throw new AppError("COST_CAP_TOO_LOW",409);
    const recoverCap=job.stage==="NEEDS_ATTENTION"&&job.error==="COST_CAP_REACHED";
    if(terminal.includes(job.stage)&&!recoverCap)throw new AppError("JOB_TERMINAL",409);
    const [committed]=await tx`select coalesce(sum(cost+case when state in ('INTENT','SUBMITTED','OUTCOME_UNKNOWN') then reserved else 0 end),0) as n from calls where job_id=${id}`;
    if(cap<Number(committed.n))throw new AppError("COST_CAP_TOO_LOW",409);
    if(job.group_id) {
      const [g]=await tx`select approved from groups where id=${job.group_id}`;
      if(!g.approved)throw new AppError("GROUP_APPROVAL_REQUIRED",409);
    }
    await tx`insert into starts(job_id,request_key,fingerprint) values(${id},${requestKey},${fp})`;
    await tx`update jobs set approved=true,cap=${cap},stage=${job.approved?(recoverCap?"TRANSLATING":job.stage):"TERMINOLOGY"},error=null,updated_at=now() where id=${id}`;
    if(recoverCap)await tx`update units set state='READY',generation=generation+1,not_before=now(),ready_since=now() where job_id=${id} and state='FAILED'`;
    await tx`insert into units(id,job_id,kind) values(${crypto.randomUUID()},${id},'TERMS') on conflict(job_id,kind,sequence) do nothing`;
  });
  const units=await sql`select id,generation from units where job_id=${id} and state='READY'`;
  for(const u of units)await notify(u.id,u.generation);return status(owner,id);
}
export async function cancel(owner:string,id:string) {
  await jobFor(owner,id);
  await sql.begin(async tx=>{
    await tx`select pg_advisory_xact_lock(91783002)`;
    const changed=await tx`update jobs set stage='CANCELED',error='USER_CANCELED',updated_at=now() where id=${id} and stage not in ('SUCCEEDED','FAILED','CANCELED') returning id`;
    if(!changed.length)return;
    await tx`update units set state='CANCELED',generation=generation+1,lease_owner=null,lease_expires_at=null where job_id=${id} and state!='DONE'`;
    await tx`update calls set state='REJECTED',reserved=0,updated_at=now() where job_id=${id} and state='INTENT'`;
    await tx`update calls set state='OUTCOME_UNKNOWN',updated_at=now() where job_id=${id} and state='SUBMITTED'`;
  });return status(owner,id);
}
export async function receipt(owner:string,id:string) {
  const j=await jobFor(owner,id), result=await status(owner,id);
  const [events]=await sql`select count(*)::int as count from tool_events where job_id=${id}`;
  return {...result,source_checksum:j.source_hash,model:j.quote?.model??config.model,prompt_version:j.quote?.prompt_version??config.prompt,
    policy_version:j.quote?.policy_version??"visible-v1",rates_version:j.quote?.rates_version??config.ratesVersion,glossary:{hash:hash(JSON.stringify(j.glossary)),entries:j.glossary.entries.length,tool_calls:events.count}};
}
export async function artifact(owner:string,id:string) {
  const j=await jobFor(owner,id);
  if(!j.artifact)throw new AppError("ARTIFACT_NOT_READY",409);
  const bytes=await readFile(j.artifact.path);
  if(hash(bytes)!==j.artifact.hash)throw new AppError("ARTIFACT_CHECKSUM_MISMATCH",503);
  return {bytes,format:j.format,checksum:j.artifact.hash};
}
export async function groupPrepare(owner:string,requestKey:string,files:{name:string;bytes:Uint8Array|Uploaded}[],target:string,options:any={}) {
  if(!requestKey || requestKey.length>200)throw new AppError("IDEMPOTENCY_KEY_REQUIRED",400);
  target=normalizeTarget(target);
  if(files.length>20 || !files.length || files.reduce((n,f)=>n+(f.bytes instanceof Uint8Array?f.bytes.length:f.bytes.size),0)>25*1024*1024)throw new AppError("FOLDER_LIMIT");
  if(files.some(f=>!f.name.endsWith(".md") || /(?:^|[/\\])\.\.(?:[/\\]|$)/.test(f.name)))throw new AppError("FOLDER_PATH_UNSUPPORTED");
  if(new Set(files.map(f=>f.name)).size!==files.length)throw new AppError("FOLDER_PATH_UNSUPPORTED");
  const fingerprint=hash(JSON.stringify({files:files.map(f=>({name:f.name,hash:f.bytes instanceof Uint8Array?hash(f.bytes):f.bytes.checksum})).sort((a,b)=>a.name.localeCompare(b.name)),target,options}));
  const groupId=crypto.randomUUID();
  await sql`insert into groups(id,owner,request_key,fingerprint) values(${groupId},${owner},${requestKey},${fingerprint}) on conflict(owner,request_key) do nothing`;
  const [g]=await sql`select * from groups where owner=${owner} and request_key=${requestKey}`;
  if(g.fingerprint!==fingerprint)throw new AppError("IDEMPOTENCY_CONFLICT",409);
  const children=[];
  for(const f of files){
    const j=await submit(owner,f.bytes,f.name,target,`folder-${g.id}-${hash(f.name)}`,options);
    await sql`update jobs set group_id=${g.id} where id=${j.job_id}`;
    children.push({path:f.name,job_id:j.job_id});
  }
  await sql`update groups set children=${sql.json(children)} where id=${g.id}`;
  return groupStatus(owner,g.id);
}
export async function groupStatus(owner:string,id:string) {
  const [g]=await sql`select * from groups where id=${id} and owner=${owner}`;
  if(!g)throw new AppError("GROUP_NOT_FOUND",404);
  const children=[];for(const c of g.children)children.push({...c,...await status(owner,c.job_id)});
  const quoteVersion=hash(g.fingerprint+JSON.stringify(children.map(c=>({id:c.job_id,quote:c.quote?.version??null}))));
  return {group_id:id,quote_version:quoteVersion,cap_usd:Number(g.cap),approved:g.approved,children};
}
export async function groupStart(owner:string,id:string,cap:number,key:string,version:string) {
  const g=await groupStatus(owner,id);
  if(!key || version!==g.quote_version)throw new AppError("QUOTE_STALE",409);
  const accepted=g.children.filter(c=>c.stage==="AWAITING_APPROVAL"||c.quote&&c.stage!=="FAILED");
  if(accepted.length+g.children.filter(c=>c.stage==="FAILED").length!==g.children.length)throw new AppError("FOLDER_PREFLIGHT_PENDING",409);
  const maximum=accepted.reduce((n,c)=>n+c.quote.maximum_reserved_usd,0);
  if(!accepted.length || !Number.isFinite(cap) || cap<maximum || cap>1000)throw new AppError("COST_CAP_TOO_LOW",409);
  await sql.begin(async tx=>{
    await tx`select pg_advisory_xact_lock(91783002)`;
    const fp=hash(JSON.stringify({version,cap}));
    const [prior]=await tx`select fingerprint from group_starts where group_id=${id} and request_key=${key}`;
    if(prior){if(prior.fingerprint!==fp)throw new AppError("IDEMPOTENCY_CONFLICT",409);return;}
    const [spent]=await tx`select coalesce(sum(c.cost+case when c.state in ('INTENT','SUBMITTED','OUTCOME_UNKNOWN') then c.reserved else 0 end),0) as n from calls c join jobs j on j.id=c.job_id where j.group_id=${id}`;
    if(cap<Number(spent.n))throw new AppError("COST_CAP_TOO_LOW",409);
    await tx`insert into group_starts(group_id,request_key,fingerprint) values(${id},${key},${fp})`;
    await tx`update groups set approved=true,cap=${cap} where id=${id} and owner=${owner}`;
  });
  await gate("group-approved");
  for(const c of accepted)if(!terminal.includes(c.stage)||c.error==="COST_CAP_REACHED"){
    await start(owner,c.job_id,c.quote.version,c.quote.maximum_reserved_usd,`${key}-${c.job_id}`);
    await gate("group-child-started");
  }
  return groupStatus(owner,id);
}
