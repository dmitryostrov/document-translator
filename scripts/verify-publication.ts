import {setup} from "./test-support";
import {writeFile} from "node:fs/promises";
await setup(true);const results=[];
for(const [name,args,extra] of [
  ["typecheck",["run","check"],{}],["unit-with-split-literal",["test"],{}],
  ["formats-and-isolation",["scripts/integration.ts"],{}],["aliases-catalog-caps",["scripts/contracts.ts"],{}],
  ["large-document-rerender",["scripts/fairness.ts"],{}],
  ["artifact-publication-kill",["scripts/chaos.ts"],{CHAOS_BOUNDARY:"artifact-renamed"}]
] as [string,string[],Record<string,string>][]){
  const p=Bun.spawn(["bun",...args],{stdout:"pipe",stderr:"pipe",env:{...process.env,SKIP_BUILD:"1",...extra}});
  const [out,err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
  results.push({name,passed:code===0});console.log(JSON.stringify(results.at(-1)));
  if(code!==0){console.error((out+err).slice(-2000));throw new Error("PUBLICATION_VERIFICATION_FAILED");}
}
await writeFile("evidence/publication-verification.json",JSON.stringify(results,null,2));
