import type { FullResult,Reporter,TestCase,TestResult } from "@playwright/test/reporter";
import { mkdir,writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export default class EvidenceReporter implements Reporter{
  private results:{name:string;status:string;elapsed_ms:number}[]=[];
  onTestEnd(test:TestCase,result:TestResult){
    this.results.push({name:test.title,status:result.status,elapsed_ms:result.duration});
  }
  async onEnd(result:FullResult){
    if(!this.results.length&&result.status==="passed")return; // Listing tests must not erase execution evidence.
    const path=process.env.E2E_EVIDENCE_PATH??(process.env.LIVE_E2E==="1"?"evidence/e2e-live.json":"evidence/e2e.json");
    await mkdir(dirname(path),{recursive:true});
    await writeFile(path,JSON.stringify({runner:"Playwright Test",provider:process.env.LIVE_E2E==="1"?"openai":"fake",status:result.status,tests:this.results,test_retries:0},null,2));
  }
}
