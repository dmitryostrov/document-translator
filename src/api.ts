import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { readFile } from "node:fs/promises";
import { randomBytes, createHmac } from "node:crypto";
import { atomic } from "./files";
import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { migrate, sql } from "./db";
import { config, AppError, log, failure } from "./config";
import { hash } from "./domain";
import * as core from "./core";
import { upload } from "./uploads";
await migrate();
try { await readFile(config.tokenFile); }
catch { await atomic(config.tokenFile,randomBytes(32).toString("hex")); }
// Browser owners are self-issued: a signed cookie proves we issued it, so anonymous requests need no database row.
const cookieSecret=(await readFile(config.tokenFile,"utf8")).trim();
const sign=(id:string)=>createHmac("sha256",cookieSecret).update(id).digest("hex").slice(0,32);
const app=new Hono();
app.use("*",async(c,next)=>{
  c.header("X-Content-Type-Options","nosniff");c.header("Referrer-Policy","no-referrer");
  c.header("Content-Security-Policy","default-src 'self'; script-src 'self'; style-src 'self'; img-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'");
  await next();
});
app.get("/health",async c=>{await sql`select 1`;return c.json({ok:true,provider_mode:config.mode,model:config.model,reasoning_effort:config.reasoning,rates_version:config.ratesVersion});});
app.use("/api/*",async(c,next)=>{
  const origin=c.req.header("Origin");
  if(origin && origin!==new URL(c.req.url).origin)throw new AppError("ORIGIN_DENIED",403);
  let owner:string;
  const authorization=c.req.header("Authorization");
  if(authorization){
    const supplied=Buffer.from(authorization.replace(/^Bearer /,"")),expected=Buffer.from((await readFile(config.tokenFile,"utf8")).trim());
    if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))throw new AppError("AUTH_REQUIRED",401);
    owner=`mcp-${hash(expected)}`;
  }else{
    const cookie=getCookie(c,"translator-owner");
    const [id,sig=""]=(cookie??"").split(".");
    const signed=!!id&&sig.length===32&&timingSafeEqual(Buffer.from(sig),Buffer.from(sign(id)));
    // Legacy cookies were a bare id stored in the owners table; keep them working.
    const legacy=!signed&&!!cookie&&!cookie.includes(".")&&(await sql`select id from owners where id=${cookie}`).length>0;
    if(signed)owner=id;
    else if(legacy)owner=cookie!;
    else{
      owner=crypto.randomUUID();
      setCookie(c,"translator-owner",owner+"."+sign(owner),{httpOnly:true,sameSite:"Strict",path:"/",maxAge:86400*7});
    }
  }
  c.set("owner" as never,owner as never);await next();
});
// Operator view for the 3am question "what is stuck?". Counts and ages only: no owners, no document content. Not under /api (no cookie owner).
app.get("/ops",async c=>{
  const [units,oldest,expired,jobs,spend]=await Promise.all([
    sql`select state,count(*)::int as n from units group by state`,
    sql`select coalesce(extract(epoch from now()-min(ready_since)),0)::int as seconds from units where state='READY' and not_before<=now()`,
    sql`select count(*)::int as n from units where state='RUNNING' and lease_expires_at<now()`,
    sql`select stage,coalesce(error,'') as error,count(*)::int as n from jobs where stage in ('NEEDS_ATTENTION','FAILED') or updated_at>now()-interval '24 hours' group by stage,error`,
    sql`select coalesce(sum(cost),0)::float as cost_usd,count(*)::int as calls from calls where created_at>now()-interval '1 hour'`
  ]);
  return c.json({units,oldest_ready_seconds:oldest[0].seconds,expired_leases:expired[0].n,jobs,last_hour:spend[0]});
});
const owner=(c:any)=>c.get("owner") as string;
app.get("/api/session",c=>c.json({ok:true}));
app.get("/api/translations",async c=>{
  const rows=await sql`select id from jobs where owner=${owner(c)} order by created_at desc limit 50`;
  return c.json(await Promise.all(rows.map(r=>core.status(owner(c),r.id))));
});
app.post("/api/translations",async c=>{
  const form=await upload(c.req.raw);
  try{return c.json(await core.submit(owner(c),form.files[0].bytes,form.files[0].name,form.fields.target_language,c.req.header("Idempotency-Key")??"",{acknowledge_text_only_pdf:form.fields.acknowledge_text_only_pdf==="true"}),202);}
  finally{await form.cleanup();}
});
app.get("/api/translations/:id",async c=>c.json(await core.status(owner(c),c.req.param("id"))));
app.post("/api/translations/:id/start",async c=>{
  const b=await c.req.json();return c.json(await core.start(owner(c),c.req.param("id"),b.quote_version,Number(b.max_cost_usd),c.req.header("Idempotency-Key")??""));
});
app.post("/api/translations/:id/resume",async c=>{
  const b=await c.req.json().catch(()=>({}));
  return c.json(await core.resume(owner(c),c.req.param("id"),Number(b.max_cost_usd),b.acknowledge_possible_charge===true,c.req.header("Idempotency-Key")??""));
});
app.post("/api/translations/:id/cancel",async c=>c.json(await core.cancel(owner(c),c.req.param("id"))));
app.get("/api/translations/:id/receipt",async c=>{c.header("Content-Disposition",'attachment; filename="translation-receipt.json"');return c.json(await core.receipt(owner(c),c.req.param("id")));});
app.get("/api/translations/:id/artifact",async c=>{
  const a=await core.artifact(owner(c),c.req.param("id"));
  c.header("Content-Disposition",`attachment; filename="translation.${a.format}"`);
  c.header("Content-Type",a.format==="pdf"?"application/pdf":"text/markdown; charset=utf-8");
  c.header("ETag",a.checksum);return c.body(a.bytes);
});
app.post("/api/translation-groups",async c=>{
  const form=await upload(c.req.raw,20);
  try{return c.json(await core.groupPrepare(owner(c),c.req.header("Idempotency-Key")??"",form.files,form.fields.target_language),202);}
  finally{await form.cleanup();}
});
app.get("/api/translation-groups/:id",async c=>c.json(await core.groupStatus(owner(c),c.req.param("id"))));
app.post("/api/translation-groups/:id/start",async c=>{const b=await c.req.json();return c.json(await core.groupStart(owner(c),c.req.param("id"),Number(b.max_total_cost_usd),c.req.header("Idempotency-Key")??"",b.quote_version));});
app.get("/",async c=>c.html(await Bun.file("dist/index.html").text()));
app.get("/app.js",async c=>{c.header("Content-Type","text/javascript");return c.body(await Bun.file("dist/app.js").text());});
app.get("/style.css",async c=>{c.header("Content-Type","text/css");return c.body(await Bun.file("dist/style.css").text());});
app.onError((error,c)=>{
  const known=error instanceof AppError,code=known?error.code:"SERVICE_UNAVAILABLE";
  log("request_failed",{code,path:new URL(c.req.url).pathname.replace(/[0-9a-f-]{36}/gi,":id"),...(known?{}:failure(error))});
  return c.json({error:{code}},error instanceof AppError?error.status as any:503);
});
const requestLimit=26*1024*1024; // 25 MiB source plus bounded multipart overhead.
async function boundedFetch(request:Request){
  if(Number(request.headers.get("content-length")??0)>requestLimit){
    return Response.json({error:{code:"UPLOAD_SIZE_LIMIT"}},{status:413,headers:{"X-Content-Type-Options":"nosniff"}});
  }
  if(!request.body)return app.fetch(request);
  let bytes=0;
  const body=request.body.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({
    transform(chunk,controller){
      bytes+=chunk.byteLength;
      if(bytes>requestLimit)throw new AppError("UPLOAD_SIZE_LIMIT",413);
      controller.enqueue(chunk);
    }
  }));
  return app.fetch(new Request(request,{body}));
}
// A higher transport ceiling lets the application answer ordinary oversized
// uploads with JSON 413 instead of Bun resetting the connection first.
// boundedFetch retains the 26 MiB request bound, including chunked bodies.
Bun.serve({port:config.port,hostname:"0.0.0.0",fetch:boundedFetch,maxRequestBodySize:128*1024*1024});
log("api_ready",{port:config.port});
