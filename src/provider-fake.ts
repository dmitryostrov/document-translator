import { Usage, type ModelRequest, type ModelResponse } from "@openai/agents";
import { sql } from "./db";
import { AppError } from "./config";
import { tokens, type Block } from "./domain";
import type { CallContext, Hooks, TranslationProvider } from "./provider";

// Test-only provider: deterministic fixtures, gates and injected failures. Loaded only when PROVIDER_MODE=fake.
function fakeText(text:string,target:string) {
  // A deterministic fixture double, never presented as real translation quality.
  if(target==="german")return text.replace(/The/g,"Die").replace(/motor/g,"Motor").replace(/battery/g,"Batterie").replace(/service/g,"Wartung");
  if(target==="french")return text.replace(/The/g,"La").replace(/motor/g,"moteur").replace(/battery/g,"batterie").replace(/service/g,"service");
  if(target==="spanish")return text.replace(/The/g,"La").replace(/motor/g,"motor").replace(/battery/g,"batería").replace(/service/g,"servicio");
  return text;
}
export function install(hooks:Hooks){
  hooks.gate=async(name:string)=>{
    const changed=await sql`update test_gates set hits=hits+1 where name=${name} and enabled=true returning name`;
    if(!changed.length)return;
    while(true){const [g]=await sql`select enabled from test_gates where name=${name}`;if(!g?.enabled)return;await Bun.sleep(100);}
  };
}
export function createFakeProvider():TranslationProvider{
  return {
    async translateChunk({prompt,blocks,target}){
      const fail=(await sql`select enabled from test_gates where name='fake-invalid-output'`)[0]?.enabled;
      await Bun.sleep(Number(process.env.FAKE_DELAY_MS??100));
      return {value:{blocks:blocks.map(b=>({id:b.id,text:fakeText(b.text,target)+(fail?" https://attacker.invalid":"")}))},usage:{input:tokens(JSON.stringify(prompt)),output:tokens(JSON.stringify(blocks)),cached:0,write:0}};
    },
    async agentTurn(ctx:CallContext,ordinal:number,_request:ModelRequest):Promise<ModelResponse>{
      if(ordinal===0)return {usage:new Usage({inputTokens:200,outputTokens:30}),output:[{type:"function_call",id:"fc_context",callId:"context",name:"find_source_context",arguments:JSON.stringify({term:"drive"})} as any]};
      const blocks=ctx.job.ir.blocks as Block[];
      const evidence=blocks.find(b=>/drive/i.test(b.text));
      return {usage:new Usage({inputTokens:300,outputTokens:50}),output:[{type:"message",role:"assistant",status:"completed",content:[{type:"output_text",text:JSON.stringify({entries:evidence?[{term:"drive",translation:ctx.job.target==="german"?"Antrieb":"drive",evidence_ids:[evidence.id]}]:[],warnings:[]})}]} as any]};
    },
    async beforeSubmit(callId:string,jobId:string,kind:string){
      await sql`insert into fake_events(call_id,job_id,kind,state) values(${callId},${jobId},${kind},'ACCEPTED')`;
    },
    async injectFailure(){
      const failures=await sql`select name from test_gates where enabled=true and name in ('fake-500','fake-timeout','fake-429')`;
      if(failures.length)throw Object.assign(new Error("FIXTURE_PROVIDER_FAILURE"),{status:failures[0].name==="fake-429"?429:failures[0].name==="fake-500"?500:undefined});
    }
  };
}
