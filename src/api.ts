import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { atomic } from "./files";
import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { migrate, sql } from "./db";
import { config, AppError, log } from "./config";
import { hash } from "./domain";
import * as core from "./core";
import { upload } from "./uploads";
await migrate();
try { await readFile(config.tokenFile); }
catch { await atomic(config.tokenFile,randomBytes(32).toString("hex")); }
const app=new Hono();
app.use("*",async(c,next)=>{
  c.header("X-Content-Type-Options","nosniff");c.header("Referrer-Policy","no-referrer");
  c.header("Content-Security-Policy","default-src 'self'; script-src 'self'; style-src 'self'; img-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'");
  await next();
});
app.get("/health",async c=>{await sql`select 1`;return c.json({ok:true,provider_mode:config.mode});});
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
    const cookie=getCookie(c,"stark-owner");
    const known=cookie?await sql`select id from owners where id=${cookie}`:[];
    if(known.length)owner=cookie!;
    else{
      owner=crypto.randomUUID();await sql`insert into owners(id) values(${owner})`;
      setCookie(c,"stark-owner",owner,{httpOnly:true,sameSite:"Strict",path:"/",maxAge:86400*7});
    }
  }
  c.set("owner" as never,owner as never);await next();
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
  const code=error instanceof AppError?error.code:"SERVICE_UNAVAILABLE";log("request_failed",{code});
  return c.json({error:{code}},error instanceof AppError?error.status as any:503);
});
Bun.serve({port:config.port,hostname:"0.0.0.0",fetch:app.fetch,maxRequestBodySize:26*1024*1024});
log("api_ready",{port:config.port});
