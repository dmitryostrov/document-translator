import { Queue } from "bullmq";
import Redis from "ioredis";
import { config, log } from "./config";
const url=new URL(config.redis);
export const connection=new Redis(config.redis,{maxRetriesPerRequest:null,enableOfflineQueue:false});
export const queue=new Queue("stark-units",{connection});
queue.on("error",()=>log("queue_unavailable"));
export const notificationId=(id:string,g:number)=>`wu-${id}-g${g}`;
export async function notify(id:string,generation:number,delay=0) {
  try {await queue.add("unit",{id,generation},{jobId:notificationId(id,generation),attempts:1,removeOnComplete:true,removeOnFail:true,delay});}
  catch {log("notification_deferred",{unit_id:id});}
}
