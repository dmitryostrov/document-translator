import {test,expect} from "bun:test";
import {modelProfile} from "../../src/models";
process.env.PROVIDER_MODE="fake";
process.env.MODEL="gpt-4.1-mini";
const {cost,reservedCost}=await import("../../src/domain");
test("Astra cache reads and writes are priced separately; reasoning is already part of output",()=>{
  const pricing=modelProfile("gpt-6-astra").rates;
  expect(cost({input:1000,cached:500,write:250,output:100},pricing)).toBeCloseTo(.011125,9);
  expect(reservedCost({input:20000,output:6000},pricing)).toBeCloseTo(.55,9);
  expect(reservedCost({input:20000,output:6000},pricing)).toBeGreaterThan(cost({input:20000,output:6000},pricing));
});
test("unknown or inherited model names cannot silently use another model's rates",()=>{
  for(const model of ["unconfigured-model","__proto__","toString"])expect(()=>modelProfile(model)).toThrow("MODEL_RATES_UNCONFIGURED");
});
test("the stronger runtime quote binds model, effort and its cache-write-safe approval ceiling",async()=>{
  const script='import {quote} from "./src/domain";console.log(JSON.stringify(quote({format:"md",blocks:[{id:"b",text:"The battery supplies 12 kW."}],warnings:[],pages:0})))';
  const p=Bun.spawn(["bun","-e",script],{stdout:"pipe",stderr:"pipe",env:{PATH:process.env.PATH!,MODEL:"gpt-6-astra",PROVIDER_MODE:"fake"}});
  const q=JSON.parse(await new Response(p.stdout).text());expect(await p.exited).toBe(0);
  expect(q.model).toBe("gpt-6-astra");expect(q.reasoning_effort).toBe("low");expect(q.maximum_reserved_usd).toBeGreaterThanOrEqual(2.15);expect(q.maximum_reserved_usd).toBeLessThanOrEqual(2.150001);
  expect(q.rates_version).toBe("2026-10-02-gpt-6-astra-standard");expect(q.eta_seconds).toBeNull();
});
