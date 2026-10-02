export type Rates = { input:number;cached:number;write:number;output:number };
export type ModelProfile = { rates:Rates;ratesVersion:string;reasoning?:"low";cacheOptions?:{ttl:"30m"} };
// Standard synchronous prices; calls remain below long-context surcharge thresholds.
// Sources: developers.openai.com/api/docs/models/gpt-4.1-mini and gpt-6-astra.
export const modelProfiles:Readonly<Record<string,ModelProfile>> = {
  "gpt-4.1-mini":{rates:{input:.4,cached:.1,write:.4,output:1.6},ratesVersion:"2026-09-30"},
  "gpt-6-astra":{rates:{input:10,cached:1,write:12.5,output:50},ratesVersion:"2026-10-02-gpt-6-astra-standard",reasoning:"low",cacheOptions:{ttl:"30m"}}
};
export function modelProfile(model:string):ModelProfile {
  if(!Object.hasOwn(modelProfiles,model))throw new Error("MODEL_RATES_UNCONFIGURED");
  return modelProfiles[model];
}
