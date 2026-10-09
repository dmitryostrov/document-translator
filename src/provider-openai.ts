import OpenAI from "openai";
import { OpenAIResponsesModel, type ModelRequest, type ModelResponse } from "@openai/agents";
import { config, key } from "./config";
import type { CallContext, TranslationProvider } from "./provider";

export function client(){return new OpenAI({apiKey:key(),maxRetries:0,timeout:60_000});}

export function createOpenAIProvider():TranslationProvider{
  return {
    // Fails with OPENAI_KEY_UNAVAILABLE before any agent call row is written, as before.
    assertAgentReady(){client();},
    async translateChunk({prompt,schema,maxOutputTokens}){
      const response=await client().responses.create({
        model:config.model,input:prompt,max_output_tokens:maxOutputTokens,store:false,prompt_cache_key:`stark-${config.prompt}`,
        ...(config.reasoning?{reasoning:{effort:config.reasoning}}:{}),
        ...(config.cacheOptions?{prompt_cache_options:config.cacheOptions}:{}),
        text:{format:{type:"json_schema",name:"translation",strict:true,schema}}
      });
      const usage=response.usage!;
      return {value:{raw:response.output_text},responseId:response.id,usage:{input:usage.input_tokens,output:usage.output_tokens,cached:usage.input_tokens_details.cached_tokens,write:(usage.input_tokens_details as any).cache_write_tokens??0,reasoning:usage.output_tokens_details.reasoning_tokens??0}};
    },
    async agentTurn(_ctx:CallContext,_ordinal:number,request:ModelRequest):Promise<ModelResponse>{
      return new OpenAIResponsesModel(client(),config.model).getResponse(request);
    }
  };
}
