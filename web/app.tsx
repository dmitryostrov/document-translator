import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { describeError, errorCatalog } from "../src/errors";
const brand={name:"DOCUMENT TRANSLATOR",product:"Document Translator"};
async function request(url:string,options:RequestInit={}){
  const response=await fetch(url,options);const data=await response.json();
  if(!response.ok)throw new Error(data.error?.code??"REQUEST_FAILED");return data;
}
const money=(n:number)=>new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",minimumFractionDigits:4}).format(n);
function App(){
  const [jobs,setJobs]=useState<any[]>([]),[file,setFile]=useState<File|null>(null),[target,setTarget]=useState("german"),[ack,setAck]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(""),[selected,setSelected]=useState<string|null>(null),[caps,setCaps]=useState<Record<string,string>>({});
  async function refresh(){try{setJobs(await request("/api/translations"));setError(old=>["SERVICE_UNAVAILABLE","Failed to fetch"].includes(old)?"":old);}catch(e:any){setError(e.message);}}
  useEffect(()=>{void refresh();const t=setInterval(refresh,6000);return()=>clearInterval(t);},[]);
  const openId=(selected??jobs[0]?.job_id)||null,openStage=jobs.find(j=>j.job_id===openId)?.stage;
  useEffect(()=>{
    if(!openId||["SUCCEEDED","FAILED","CANCELED","NEEDS_ATTENTION"].includes(openStage))return;
    const t=setInterval(async()=>{try{const j=await request(`/api/translations/${openId}`);setJobs(old=>old.map(o=>o.job_id===openId?j:o));}catch{}},1500);
    return()=>clearInterval(t);
  },[openId,openStage]);
  const [ackResume,setAckResume]=useState(false);
  async function resume(j:any){
    setError("");
    const cap=Number((j.cost.cap_usd+j.cost.unresolved_exposure_usd+(j.quote?.maximum_reserved_usd??0)).toFixed(6));
    try{await request(`/api/translations/${j.job_id}/resume`,{method:"POST",headers:{"Content-Type":"application/json","Idempotency-Key":crypto.randomUUID()},body:JSON.stringify({max_cost_usd:cap,acknowledge_possible_charge:true})});setAckResume(false);await refresh();}catch(e:any){setError(e.message);}
  }
  const current=jobs.find(j=>j.job_id===selected)??jobs[0];
  async function prepare(e:React.FormEvent){
    e.preventDefault();if(!file)return;setError("");
    if(file.size>25*1024*1024){setError("UPLOAD_SIZE_LIMIT");return;}
    setBusy(true);
    try{const form=new FormData();form.append("file",file);form.append("target_language",target);form.append("acknowledge_text_only_pdf",String(ack));
      const j=await request("/api/translations",{method:"POST",headers:{"Idempotency-Key":crypto.randomUUID()},body:form});setSelected(j.job_id);await refresh();
    }catch(e:any){setError(e.message);}finally{setBusy(false);}
  }
  async function start(j:any){
    setError("");try{await request(`/api/translations/${j.job_id}/start`,{method:"POST",headers:{"Content-Type":"application/json","Idempotency-Key":crypto.randomUUID()},body:JSON.stringify({quote_version:j.quote.version,max_cost_usd:Number(caps[j.job_id]??Math.max(0.25,j.quote.maximum_reserved_usd*1.1).toFixed(6))})});await refresh();}catch(e:any){setError(e.message);}
  }
  return <main>
    <header><a className="wordmark" href="/">{brand.name}<span>DOCUMENT SERVICES</span></a><span className="environment">LOCAL WORKBENCH</span></header>
    <section className="intro"><p className="eyebrow">TECHNICAL DOCUMENTATION · SUPPORT · DEALERS</p><h1>Clear documents.<br/><span>Any supported language.</span></h1><p>Translate non-sensitive PDF and Markdown files with consistent terminology, visible costs, and a recoverable workflow.</p></section>
    <div className="workspace">
      <section className="card upload"><div className="card-top"><span className="step">01</span><h2>Prepare a document</h2></div>
        <form onSubmit={prepare}>
          <label className="filebox">PDF or Markdown<input aria-label="Document file" type="file" accept=".pdf,.md" onChange={e=>setFile(e.target.files?.[0]??null)}/><span>{file?file.name:"Choose a searchable PDF or .md file"}</span></label>
          <label>Translate into<select value={target} onChange={e=>setTarget(e.target.value)}><option value="german">German</option><option value="french">French</option><option value="english">English</option><option value="spanish">Spanish</option></select></label>
          <label className="checkbox"><input type="checkbox" checked={ack} onChange={e=>setAck(e.target.checked)}/>I accept a text-only PDF if the source contains images.</label>
          <p className="hint">Up to 25 MiB · 250 PDF pages. Prose and bullets. Scans, complex tables and ambiguous text visibility are excluded.</p>
          <button disabled={!file||busy}>{busy?"Preparing…":"Prepare and estimate"}<span>↗</span></button>
        </form><p className="hint">Extraction and screening happen locally. OpenAI calls start only after you approve a quote.</p>
      </section>
      <section className="card progress"><div className="card-top"><span className="step">02</span><h2>Translation workspace</h2></div>
        {!current?<div className="empty"><div className="document-icon">↗</div><h3>Your next translation starts here</h3><p>Prepare a document to see its quote, progress and receipt.</p></div>:<>
          <div className="statusline"><span className={`badge ${current.stage==="SUCCEEDED"?"success":""}`}>{current.stage.replaceAll("_"," ")}</span><span>{current.format.toUpperCase()} → {current.target_language}</span></div>
          <div className="progress-track"><div style={{width:`${current.progress.total?current.progress.completed/current.progress.total*100:0}%`}}/></div>
          <p className="hint" role="status" aria-live="polite">{current.progress.completed} / {current.progress.total} translation units completed</p>
          <div className="metrics"><div><span>Known cost</span><strong>{money(current.cost.known_cost_usd)}</strong></div><div><span>Active reservation</span><strong>{money(current.cost.active_reserved_usd)}</strong></div><div><span>Possible unresolved charge</span><strong>{money(current.cost.unresolved_exposure_usd)}</strong></div></div>
          {current.quote&&<div className="quote"><h3>Cost estimate</h3><p>{money(current.quote.estimated_total_usd.min)} – {money(current.quote.estimated_total_usd.max)}</p><p className="hint">Model: {current.quote.model}{current.quote.reasoning_effort?` · ${current.quote.reasoning_effort} reasoning`:""}</p><p className="hint">{current.quote.estimate_basis}. Maximum planned reservation: {money(current.quote.maximum_reserved_usd)} · {current.quote.eta_seconds?`Estimated time: ${Math.ceil(current.quote.eta_seconds.min)}–${Math.ceil(current.quote.eta_seconds.max)} seconds for a matching sample.`:"Time estimate unavailable for this document size or language pair."}</p>
            {current.quote.size_projection&&<p className="hint">{current.quote.size_projection.source_tokens} source tokens · {current.quote.size_projection.translation_chunks} chunks. Projection assumes output at 0.9–1.6× source tokens and 2–4 terminology turns. This is an unmeasured planning range; actual usage, retries and caching can differ.</p>}
            {current.stage==="AWAITING_APPROVAL"&&<><label>Approved cap (USD)<input aria-label="Approved cap" type="number" step="0.01" min={current.quote.maximum_reserved_usd} value={caps[current.job_id]??Math.max(0.25,current.quote.maximum_reserved_usd*1.1).toFixed(6)} onChange={e=>setCaps({...caps,[current.job_id]:e.target.value})}/></label><button onClick={()=>start(current)}>Approve and translate<span>↗</span></button></>}</div>}
          {current.warnings?.length>0&&<div className="warnings"><h3>Document notes</h3>{current.warnings.map((w:any,i:number)=><p key={i}>{w.code.replaceAll("_"," ")}{w.page?` · page ${w.page}`:""}</p>)}</div>}
          {current.error&&<div className="error" role="alert"><strong>{current.error}</strong><p>{describeError(current.error).message} {describeError(current.error).remedy}</p></div>}
          {current.stage==="NEEDS_ATTENTION"&&["OUTCOME_UNKNOWN","JOB_DEADLINE_EXCEEDED"].includes(current.error)&&<div className="quote"><h3>Resume translation</h3>
            <p className="hint">Completed work is kept and will not be paid for again. The interrupted request may already have been charged ({money(current.cost.unresolved_exposure_usd)} at most); resuming sends it once more, so that amount could be charged a second time.</p>
            <label className="checkbox"><input type="checkbox" checked={ackResume} onChange={e=>setAckResume(e.target.checked)}/>I accept a possible second charge of up to {money(current.cost.unresolved_exposure_usd)}.</label>
            <button disabled={!ackResume} onClick={()=>resume(current)}>Resume translation<span>↗</span></button></div>}
          <div className="actions">{current.artifact&&<a className="button" href={current.artifact.url}>Download translation ↗</a>}<a href={current.receipt_url}>Cost and quality receipt</a>{!["SUCCEEDED","FAILED","CANCELED","NEEDS_ATTENTION"].includes(current.stage)&&<button className="secondary" onClick={async()=>{try{await request(`/api/translations/${current.job_id}/cancel`,{method:"POST"});await refresh();}catch(e:any){setError(e.message);}}}>Cancel</button>}</div>
        </>}
      </section>
    </div>
    {error&&<div className="error" role="alert"><strong>{error}</strong>{Object.hasOwn(errorCatalog,error)&&<p>{describeError(error).message} {describeError(error).remedy}</p>}</div>}
    <section className="history"><div className="section-label"><h2>Your translations</h2><span>{jobs.length} DOCUMENTS</span></div>{jobs.length===0?<p className="hint">Accepted jobs and completed work remain available after a service restart.</p>:jobs.map(j=><button className="history-row" key={j.job_id} onClick={()=>setSelected(j.job_id)}><span>{j.format.toUpperCase()} <strong>{j.target_language}</strong></span><span>{j.stage.replaceAll("_"," ")}</span><span>{money(j.cost.known_cost_usd)} ↗</span></button>)}</section>
    <footer><span>{brand.name} · Translation workbench</span><span>Source files are preserved. Review translated technical material before use.</span></footer>
  </main>;
}
createRoot(document.getElementById("root")!).render(<App/>);
