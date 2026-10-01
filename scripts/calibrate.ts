import { readFile,writeFile } from "node:fs/promises";
const m=JSON.parse(await readFile("evidence/live-measurements.json","utf8"));
const rows=m.rows.filter((r:any)=>[1,4].includes(r.concurrency)&&r.target==="german");
if(rows.length<20 || m.failures.length)throw new Error("CALIBRATION_REQUIRES_20_COMPLETED_COLD_SAMPLES");
await writeFile("src/calibration.json",JSON.stringify({
  model:m.model,prompt:"translation-v2",source:"english",target:"german",n:rows.length,
  measured_at:m.measured_at,input_tokens:{min:Math.min(...rows.map((r:any)=>r.quote.input_tokens)),max:Math.max(...rows.map((r:any)=>r.quote.input_tokens))},
  observed_cost_usd:{min:Math.min(...rows.map((r:any)=>r.cost.known_cost_usd)),max:Math.max(...rows.map((r:any)=>r.cost.known_cost_usd))},
  latency_seconds:{p50:m.cold.p50_ms/1000,p95:m.cold.p95_ms/1000},
  reference_status:"human_review_pending",scope:"Synthetic prose corpus; provider prefix caching enabled; local result-memory misses."
},null,2));
console.log("Wrote versioned synthetic-corpus calibration.");
