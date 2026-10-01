import { Worker,UnrecoverableError } from "bullmq";
import { queue,connection,notificationId } from "../src/queue";
import { sql } from "../src/db";
if(process.env.PROVIDER_MODE!=="fake")throw new Error("TEST_ONLY");
const [unit]=await sql`select * from units where job_id=${process.argv[2]} and state='READY'`;
const jid=notificationId(unit.id,unit.generation);
const existing=await queue.getJob(jid);if(existing)await existing.remove();
await queue.add("unit",{id:unit.id,generation:unit.generation},{jobId:jid,removeOnFail:false,attempts:1});
const worker=new Worker("stark-units",async()=>{},{connection,autorun:false,maxStalledCount:1,stalledInterval:1000});
await worker.waitUntilReady();
let job:any;
for(let n=0;n<2;n++){
  job=await worker.getNextJob(`lost-lock-${n}`,{block:false});
  if(job?.id!==jid)throw new Error("STALL_FIXTURE_QUEUE_NOT_IDLE");
  // Lose the generated fixture's lock, then invoke BullMQ's actual installed stall script.
  await connection.del(queue.toKey(jid)+":lock");
  for(let pass=0;pass<2;pass++){
    await connection.del(queue.toKey("stalled-check"));
    await (worker as any).backend.moveStalledJobsToWait();
  }
}
job=await worker.getNextJob("final-stall-token",{block:false});
if(job.id!==jid||!job.deferredFailure)throw new Error("STALL_LIMIT_NOT_REACHED");
await job.moveToFailed(new UnrecoverableError(job.deferredFailure),"final-stall-token",false);
if(await job.getState()!=="failed")throw new Error("STALL_FAILURE_NOT_RETAINED");
console.log(JSON.stringify({notification_id:jid,stalls:2,max_stalled_count:1,deferred_failure:job.deferredFailure,state:"failed"}));
await worker.close();await queue.close();await connection.quit();await sql.end();
