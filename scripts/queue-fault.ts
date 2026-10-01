import { connection,queue,notificationId } from "../src/queue";
import { sql } from "../src/db";
if(process.env.PROVIDER_MODE!=="fake")throw new Error("TEST_ONLY");
const [id,mode]=process.argv.slice(2);
const [u]=await sql`select * from units where job_id=${id} and state='READY' order by sequence limit 1`;
if(!u)throw new Error("TEST_READY_UNIT_REQUIRED");
const jid=notificationId(u.id,u.generation),key=queue.toKey(jid);
await queue.add("unit",{id:u.id,generation:u.generation},{jobId:jid,removeOnComplete:false,removeOnFail:false});
if(mode==="clear")await queue.drain(true);
else if(mode==="missing")await (await queue.getJob(jid))!.remove();
else{
  await connection.lrem(queue.toKey("wait"),0,jid);
  if(mode==="active"){
    await connection.lpush(queue.toKey("active"),jid);
    await connection.set(`${key}:lock`,"fixture", "PX",60000);
  }else{
    await connection.zadd(queue.toKey(mode),Date.now(),jid);
    if(mode==="failed")await connection.hset(key,"failedReason","job stalled more than allowable limit","stalledCounter","2");
  }
}
console.log(JSON.stringify({unit_id:u.id,generation:u.generation,broker:mode}));
await queue.close();await connection.quit();await sql.end();
