import type { FullConfig } from "@playwright/test";
import { setup,testStackState,restoreTestStack } from "../../scripts/test-support";

export default async function globalSetup(config:FullConfig){
  if(process.env.LIVE_E2E==="1"){
    const url=config.projects[0].use.baseURL!;
    const response=await fetch(url+"/health");
    if(!response.ok||(await response.json()).provider_mode!=="openai")throw new Error("LIVE_E2E_REQUIRES_OPENAI_STACK");
    return;
  }
  const before=testStackState();
  try{await setup(process.env.SKIP_BUILD!=="1");}
  catch(error){restoreTestStack(before);throw error;}
  return async()=>{restoreTestStack(before);};
}
