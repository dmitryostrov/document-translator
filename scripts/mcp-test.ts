import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdir,writeFile,readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { setup,environment,project,compose,poll,db } from "./test-support";
import { fixturePDF,source } from "./fixtures";
import { mcpFixtureOutput } from "./mcp-workspace";
const live=process.env.LIVE_MCP==="1";
if(!live)await setup(process.env.SKIP_BUILD!=="1");
const folder=resolve(".runtime",`mcp-${crypto.randomUUID()}`);await mkdir(folder,{recursive:true});await mkdir(folder+"/out");
await mkdir(folder+"/docs");
await writeFile(folder+"/sample.pdf",await fixturePDF());await writeFile(folder+"/sample.md",source);
await writeFile(folder+"/docs/one.md",source);await writeFile(folder+"/docs/two.md",source+"\nSecond document.");
const checksum=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
const originals={pdf:checksum(await readFile(folder+"/sample.pdf")),md:checksum(await readFile(folder+"/sample.md"))};
const composeArgs=["compose",...(live?[]:["-p",project]),"-f",resolve("compose.yaml"),...(live?[]:["-f",resolve("compose.test.yaml")])];
const output=mcpFixtureOutput(folder,composeArgs,environment);output.prepare();
const args=[...composeArgs,"run","--rm","--no-deps","-T","-v",`${folder.replaceAll("\\","/")}:/workspace`,"mcp"];
const client=new Client({name:"clean-translator-verification",version:"1.0.0"});
const transport=new StdioClientTransport({command:"docker",args,env:environment as Record<string,string>,stderr:"pipe"});
await client.connect(transport);
const tools=await client.listTools();assert.deepEqual(tools.tools.map(t=>t.name).sort(),["save_translation","translate_document","translate_folder","translation_status"]);
async function call(name:string,arguments_:any){const result:any=await client.callTool({name,arguments:arguments_});if(result.isError)throw new Error(JSON.stringify(result.content));return JSON.parse(result.content[0].text);}
const evidence:any[]=[];
try{
  for(const format of ["pdf","md"]){
    const job=await call("translate_document",{action:"prepare",input_path:`/workspace/sample.${format}`,target_language:"german",idempotency_key:crypto.randomUUID()});
    const q=await poll(()=>call("translation_status",{job_id:job.job_id}),j=>["AWAITING_APPROVAL","FAILED"].includes(j.stage));
    assert.equal(q.stage,"AWAITING_APPROVAL");
    assert.ok(!JSON.stringify(q).includes("The drive means"));
    await call("translate_document",{action:"start",job_id:q.job_id,quote_version:q.quote.version,max_cost_usd:1,idempotency_key:crypto.randomUUID()});
    const done=await poll(()=>call("translation_status",{job_id:q.job_id}),j=>["SUCCEEDED","FAILED","NEEDS_ATTENTION"].includes(j.stage));
    assert.equal(done.stage,"SUCCEEDED");
    const saved=await call("save_translation",{job_id:q.job_id,output_path:`/workspace/out/sample.de.${format}`});
    assert.equal(await output.checksum(`sample.de.${format}`),saved.checksum);
    await assert.rejects(()=>call("save_translation",{job_id:q.job_id,output_path:`/workspace/out/sample.de.${format}`}));
    evidence.push({format,job_id:q.job_id,checksum:saved.checksum,metadata_only:true});
  }
  await assert.rejects(()=>call("translate_document",{action:"prepare",input_path:"/etc/passwd",target_language:"german",idempotency_key:crypto.randomUUID()}));
  const key=crypto.randomUUID(),g=await call("translate_folder",{action:"prepare",glob:"docs/*.md",target_language:"german",idempotency_key:key});
  const repeat=await call("translate_folder",{action:"prepare",glob:"docs/*.md",target_language:"german",idempotency_key:key});assert.equal(g.group_id,repeat.group_id);
  // Status per child; the core exposes group metadata through the task's prepare result.
  const children=await Promise.all(g.children.map((c:any)=>poll(()=>call("translation_status",{job_id:c.job_id}),j=>["AWAITING_APPROVAL","FAILED"].includes(j.stage))));
  assert.ok(children.every(c=>c.stage==="AWAITING_APPROVAL"));
  const updated=await call("translate_folder",{action:"prepare",glob:"docs/*.md",target_language:"german",idempotency_key:key});
  await call("translate_folder",{action:"start",group_id:g.group_id,quote_version:updated.quote_version,max_total_cost_usd:2,idempotency_key:crypto.randomUUID()});
  for(const c of children){const done=await poll(()=>call("translation_status",{job_id:c.job_id}),j=>["SUCCEEDED","FAILED","NEEDS_ATTENTION"].includes(j.stage));assert.equal(done.stage,"SUCCEEDED");}
  assert.equal(checksum(await readFile(folder+"/sample.pdf")),originals.pdf);assert.equal(checksum(await readFile(folder+"/sample.md")),originals.md);
  evidence.push({case:"folder-idempotency-and-cap",group_id:g.group_id,children:children.length});
  const evidencePath=live?"evidence/mcp-live.json":"evidence/mcp.json";
  await mkdir("evidence",{recursive:true});await writeFile(evidencePath,JSON.stringify(evidence,null,2));
  console.log(JSON.stringify({passed:evidence.length,tools:4,evidence:evidencePath,provider:live?"openai":"fake",inputs_preserved:true}));
}finally{try{await client.close();}finally{output.restore();}}
