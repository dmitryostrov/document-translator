import { writeFile } from "node:fs/promises";
import { setup,testStackState,restoreTestStack } from "./test-support";
const before=testStackState(),results=[];
try{
await setup(true);
for(const [name,args] of [
  ["typecheck",["run","check"]],["unit",["run","test"]],["integration",["scripts/integration.ts"]],
  ["regressions",["scripts/regressions.ts"]],["contracts",["scripts/contracts.ts"]],
  ["review-remediation",["scripts/review-regressions.ts"]],
  ["lease-and-native-stalls",["scripts/lease-proof.ts"]],["fairness-and-rerender",["scripts/fairness.ts"]],
  ["folder-api-kill",["scripts/folder-chaos.ts"]],["mcp",["scripts/mcp-test.ts"]],
  ["folder-fairness",["scripts/folder-fairness.ts"]],
  ["browser",["run","test:e2e"]],["pipeline-kills",["scripts/chaos.ts"]],
  ["infrastructure-kills",["scripts/infrastructure-chaos.ts"]]
] as [string,string[]][]){
  const start=Date.now(),p=Bun.spawn(["bun",...args],{stdout:"pipe",stderr:"pipe",env:{...process.env,SKIP_BUILD:"1",LIVE_MCP:"",LIVE_E2E:"",CHAOS_BOUNDARY:""}});
  const [out,err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
  const result={name,passed:code===0,elapsed_ms:Date.now()-start};results.push(result);console.log(JSON.stringify(result));
  if(code!==0){console.error((out+err).slice(-3000));await writeFile("evidence/verification.json",JSON.stringify(results,null,2));throw new Error(`VERIFICATION_FAILED_${name}`);}
}
await writeFile("evidence/verification.json",JSON.stringify(results,null,2));
console.log(JSON.stringify({passed:results.length,evidence:"evidence/verification.json",provider:"fake",paid_calls:0}));
}finally{restoreTestStack(before);}
