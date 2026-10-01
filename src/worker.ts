import { Worker } from "bullmq";
import { join } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { sql, migrate } from "./db";
import { config, log, AppError } from "./config";
import { connection, queue, notify, notificationId } from "./queue";
import { quote, validateOutput, hash, terminal, type Block } from "./domain";
import { formatProcess } from "./files";
import { terminology, translate, gate } from "./provider";
import { publish } from "./publication";

await migrate();
const workerId=crypto.randomUUID();
export async function claim(id:string,generation:number) {
  return sql.begin(async tx=>{
    await tx`select pg_advisory_xact_lock(91783002)`;
    const [u]=await tx`select u.*,j.approved,j.stage,j.group_id from units u join jobs j on j.id=u.job_id where u.id=${id} for update of u`;
    if(!u || u.generation!==generation || u.state!=="READY" || terminal.includes(u.stage) || new Date(u.not_before).getTime()>Date.now())return null;
    if(u.kind!=="PREFLIGHT" && !u.approved)return null;
    if(["TERMS","TRANSLATE"].includes(u.kind)){
      const [counts]=await tx`select count(*)::int as global,
        count(*) filter(where x.job_id=${u.job_id})::int as document,
        count(*) filter(where j.group_id=${u.group_id})::int as folder
        from units x join jobs j on j.id=x.job_id
        where x.state='RUNNING' and x.lease_expires_at>now() and x.kind in ('TERMS','TRANSLATE')`;
      if(counts.global>=4 || counts.document>=2 || u.group_id && counts.folder>=2)return null;
      // Fair round-robin by least recently admitted job. Ready units of that owner/group cannot jump the head indefinitely.
      const [next]=await tx`select x.id from units x join jobs j on j.id=x.job_id
        where x.state='READY' and x.not_before<=now() and x.kind in ('TERMS','TRANSLATE') and j.approved=true
        and j.stage not in ('FAILED','NEEDS_ATTENTION','SUCCEEDED','CANCELED')
        and (select count(*) from units active where active.job_id=x.job_id and active.state='RUNNING' and active.lease_expires_at>now())<2
        and (j.group_id is null or (select count(*) from units ga join jobs gj on gj.id=ga.job_id
          where gj.group_id=j.group_id and ga.state='RUNNING' and ga.lease_expires_at>now()
          and ga.kind in ('TERMS','TRANSLATE'))<2)
        order by j.updated_at,x.sequence,x.ready_since limit 1`;
      if(next && next.id!==id)return null;
    }
    const [claimed]=await tx`update units set state='RUNNING',lease_owner=${workerId},lease_expires_at=now()+interval '30 seconds' where id=${id} and generation=${generation} returning *`;
    await tx`update jobs set updated_at=now() where id=${u.job_id}`;
    return claimed;
  });
}
async function finished(unit:any,result:any,after:(tx:any)=>Promise<void>) {
  await sql.begin(async tx=>{
    const updated=await tx`update units set state='DONE',result=${tx.json(result)},lease_owner=null,lease_expires_at=null where id=${unit.id} and generation=${unit.generation} and lease_owner=${workerId} and state='RUNNING' returning id`;
    if(!updated.length)throw new AppError("LEASE_LOST");
    await after(tx);
  });
  await gate("unit-checkpointed");
}
async function processUnit(data:{id:string;generation:number}) {
  const unit=await claim(data.id,data.generation);
  if(!unit)return; // Includes duplicates racing a live DB lease: completed no-op; removal is broker policy.
  const heartbeat=setInterval(()=>{void sql`update units set lease_expires_at=now()+interval '30 seconds' where id=${unit.id} and generation=${unit.generation} and lease_owner=${workerId} and state='RUNNING'`.catch(()=>log("heartbeat_failed",{unit_id:unit.id}));},config.heartbeatMs);
  try{
    await gate("unit-claimed");
    const [job]=await sql`select * from jobs where id=${unit.job_id}`;
    const ctx={job,unit,worker:workerId,generation:unit.generation};
    if(unit.kind==="PREFLIGHT"){
      const extracted=await formatProcess("extract",{path:job.source_path,format:job.format,options:job.options});
      const ir={...extracted.ir,chunks:extracted.chunks}, q=quote(ir,job.target);
      await gate("preflight-extracted");
      await finished(unit,{quote:q},async tx=>{
        await tx`update jobs set ir=${tx.json(ir)},quote=${tx.json(q)},warnings=${tx.json([...ir.warnings,{code:job.target==="german"&&q.eta_seconds?"QUALITY_REFERENCE_HUMAN_REVIEW_PENDING":"QUALITY_PAIR_INSUFFICIENT_EVIDENCE"}])},stage='AWAITING_APPROVAL',updated_at=now() where id=${job.id}`;
      });
    }else if(unit.kind==="TERMS"){
      const glossary=await terminology(ctx);
      await finished(unit,{glossary},async tx=>{
        await tx`update jobs set glossary=${tx.json(glossary)},stage='TRANSLATING',updated_at=now() where id=${job.id}`;
        for(let n=0;n<job.ir.chunks.length;n++){
          await tx`insert into units(id,job_id,kind,sequence,payload) values(${crypto.randomUUID()},${job.id},'TRANSLATE',${n},${tx.json({blocks:job.ir.chunks[n],previous:n?job.ir.chunks[n-1].slice(-2):[]})}) on conflict(job_id,kind,sequence) do nothing`;
        }
      });
    }else if(unit.kind==="TRANSLATE"){
      const blocks=await translate(ctx,unit.payload.blocks,unit.payload.previous);
      const quality=validateOutput(unit.payload.blocks,blocks,job.target);
      await sql`insert into cache(owner,key,value) values(${job.owner},${hash(JSON.stringify({glossary:job.glossary,previous:unit.payload.previous.map((b:Block)=>b.text).join("\n").slice(-4000),blocks:unit.payload.blocks.map((b:Block)=>({id:b.id,text:b.text})),target:job.target})+config.model+config.prompt+config.policy)},${sql.json(blocks)}) on conflict do nothing`;
      await finished(unit,{blocks,quality},async tx=>{
        const [left]=await tx`select count(*)::int as n from units where job_id=${job.id} and kind='TRANSLATE' and state!='DONE'`;
        if(left.n===0){
          await tx`update jobs set stage='RENDERING',updated_at=now() where id=${job.id}`;
          await tx`insert into units(id,job_id,kind) values(${crypto.randomUUID()},${job.id},'RENDER') on conflict(job_id,kind,sequence) do nothing`;
          const parts=await tx`select result from units where job_id=${job.id} and kind='TRANSLATE' order by sequence`;
          const expected=parts.reduce((n:number,p:any)=>n+p.result.quality.expected,0),correct=parts.reduce((n:number,p:any)=>n+p.result.quality.correct,0);
          await tx`update jobs set quality=${tx.json({numbers:{expected,correct,rate:expected?correct/expected:null}})} where id=${job.id}`;
        }
      });
    }else if(unit.kind==="RENDER"){
      // A previous render may already have committed SUCCEEDED; never rebuild a paid stage.
      const output=job.artifact ?? await publish(job,unit.id,{worker:workerId,generation:unit.generation});
      // Publication commits the render unit and artifact in the same transaction.
      if(job.artifact)await finished(unit,output,async()=>{});
    }
  }catch(error:any){
    const code=error.code??error.message;
    if(code==="LEASE_LOST")return;
    if(code==="SAFE_RATE_LIMIT_RETRY" && unit.attempts<2){
      await sql`update units set state='READY',attempts=attempts+1,generation=generation+1,not_before=now()+interval '5 seconds'*(attempts+1),ready_since=now(),lease_owner=null,lease_expires_at=null where id=${unit.id} and generation=${unit.generation} and lease_owner=${workerId}`;
    }else{
      const uncertain=["OUTCOME_UNKNOWN","COST_CAP_REACHED"].includes(code);
      const safeCodes=["PDF_PAGE_LIMIT","DOCUMENT_WORD_LIMIT","PDF_NO_VISIBLE_TEXT","CORRUPT_PDF","CORRUPT_OR_ENCRYPTED_PDF","SCANNED_PDF_UNSUPPORTED","PDF_TEXT_ONLY_CONFIRMATION_REQUIRED","PDF_VISIBILITY_UNSUPPORTED","PDF_ANNOTATIONS_UNSUPPORTED","ENCRYPTED_PDF_UNSUPPORTED","SENSITIVE_MARKING_DETECTED","UNICODE_CONCEALMENT_UNSUPPORTED","MARKDOWN_HTML_UNSUPPORTED","MARKDOWN_UTF8_INVALID","MARKDOWN_URI_UNSUPPORTED","INVALID_MODEL_OUTPUT","OUTCOME_UNKNOWN","COST_CAP_REACHED","MODEL_INPUT_LIMIT","ARTIFACT_INCOMPLETE","PROVIDER_REQUEST_REJECTED","SAFE_RATE_LIMIT_RETRY"];
      let publicCode=safeCodes.includes(code)?code:"PIPELINE_FAILED";
      await sql.begin(async tx=>{
        // An infrastructure error must not strand a submitted call as an active reservation.
        await tx`update calls set state='OUTCOME_UNKNOWN',updated_at=now() where unit_id=${unit.id} and state='SUBMITTED'`;
        const [unknown]=await tx`select count(*)::int as n from calls where unit_id=${unit.id} and state='OUTCOME_UNKNOWN'`;
        if(unknown.n)publicCode="OUTCOME_UNKNOWN";
        const attention=uncertain||unknown.n>0;
        const updated=await tx`update units set state='FAILED',lease_owner=null,lease_expires_at=null where id=${unit.id} and generation=${unit.generation} and lease_owner=${workerId} returning job_id`;
        if(updated.length && !attention)await tx`update calls set state='REJECTED',reserved=0,updated_at=now() where unit_id=${unit.id} and state='INTENT'`;
        if(updated.length)await tx`update jobs set stage=${attention?"NEEDS_ATTENTION":"FAILED"},error=${publicCode},updated_at=now() where id=${unit.job_id} and stage not in ('SUCCEEDED','CANCELED')`;
      });
      log("unit_failed",{unit_id:unit.id,code:publicCode});
    }
  }finally{
    clearInterval(heartbeat);
    const ready=await sql`select id,generation from units where job_id=${unit.job_id} and state='READY' and not_before<=now()`;
    for(const u of ready)await notify(u.id,u.generation);
  }
}
let scanning=false;
export async function reconcile() {
  if(scanning)return;scanning=true;
  try{
    await sql`update jobs set stage='FAILED',error='APPROVAL_EXPIRED',updated_at=now() where stage='AWAITING_APPROVAL' and (quote->>'expires_at')::timestamptz<now()`;
    await sql`update jobs set stage='NEEDS_ATTENTION',error='JOB_DEADLINE_EXCEEDED',updated_at=now() where stage not in ('SUCCEEDED','FAILED','CANCELED','NEEDS_ATTENTION') and deadline<now()`;
    const expired=await sql`select id,job_id,generation from units where state='RUNNING' and lease_expires_at<now() limit 100`;
    for(const u of expired){
      await sql.begin(async tx=>{
        const [row]=await tx`select state,generation,lease_expires_at from units where id=${u.id} for update`;
        if(row.state!=="RUNNING"||row.generation!==u.generation||new Date(row.lease_expires_at).getTime()>Date.now())return;
        const unknown=await tx`update calls set state='OUTCOME_UNKNOWN',updated_at=now() where unit_id=${u.id} and state='SUBMITTED' returning id`;
        const ambiguous=unknown.length || (await tx`select id from calls where unit_id=${u.id} and state='OUTCOME_UNKNOWN'`).length;
        if(ambiguous){
          await tx`update units set state='FAILED',lease_owner=null,lease_expires_at=null where id=${u.id}`;
          await tx`update jobs set stage='NEEDS_ATTENTION',error='OUTCOME_UNKNOWN',updated_at=now() where id=${u.job_id} and stage!='CANCELED'`;
        }else{
          await tx`update units set state='READY',generation=generation+1,lease_owner=null,lease_expires_at=null,ready_since=now() where id=${u.id}`;
        }
      });
    }
    const ready=await sql`select u.* from units u join jobs j on j.id=u.job_id
      where u.state='READY' and u.not_before<=now() and j.stage not in ('FAILED','NEEDS_ATTENTION','SUCCEEDED','CANCELED')
      order by j.updated_at,u.sequence,u.ready_since limit 100`;
    for(const u of ready){
      const broker=await queue.getJob(notificationId(u.id,u.generation));
      const state=broker?await broker.getState():null;
      if(state==="completed"||state==="failed"||state==="active"&&Date.now()-new Date(u.ready_since).getTime()>5000){
        const advanced=await sql`update units set generation=generation+1,ready_since=now() where id=${u.id} and generation=${u.generation} and state='READY' returning generation`;
        if(advanced.length)await notify(u.id,advanced[0].generation);
      }else if(!broker)await notify(u.id,u.generation);
    }
    log("reconciled",{eligible:ready.length,expired:expired.length});
  }catch{log("reconciliation_unavailable");}finally{scanning=false;}
}
const worker=new Worker("stark-units",async job=>processUnit(job.data),{connection,concurrency:8,lockDuration:60000,lockRenewTime:20000,stalledInterval:10000,maxStalledCount:1});
let lastQueueError=0;
worker.on("error",error=>{
  if(Date.now()-lastQueueError<5000)return;lastQueueError=Date.now();
  // Broker payloads contain only generated IDs/generations; log a bounded infrastructure diagnostic.
  log("worker_queue_error",{name:error.name,detail:error.message.slice(0,250)});
});
worker.on("stalled",id=>log("broker_stalled",{notification_id:id}));
setInterval(()=>void reconcile(),5000);
await reconcile();
log("worker_ready",{worker_id:workerId});
