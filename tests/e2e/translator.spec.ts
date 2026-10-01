import { test,expect,type Page,type TestInfo } from "@playwright/test";
import { createHash } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { source,fixturePDF } from "../../scripts/fixtures";

const downloadLink=(page:Page)=>page.getByRole("link",{name:"Download translation"});
const pageErrors=new WeakMap<Page,string[]>();
async function job(page:Page,id:string){
  const response=await page.request.get(`/api/translations/${id}`);
  expect(response.ok()).toBe(true);return response.json();
}
async function prepare(page:Page,bytes:Uint8Array|string,name:string){
  await page.getByLabel("Document file").setInputFiles({name,mimeType:name.endsWith(".pdf")?"application/pdf":"text/markdown",buffer:typeof bytes==="string"?Buffer.from(bytes):Buffer.from(bytes)});
  const [response]=await Promise.all([
    page.waitForResponse(r=>new URL(r.url()).pathname==="/api/translations"&&r.request().method()==="POST"),
    page.getByRole("button",{name:"Prepare and estimate"}).click()
  ]);
  expect(response.status()).toBe(202);return response.json();
}
async function awaitStage(page:Page,id:string,stage:string){
  await expect.poll(async()=>(await job(page,id)).stage,{timeout:90_000,intervals:[250,500,1000]}).toBe(stage);
  return job(page,id);
}
function expectNoPaidCalls(value:any){
  expect(value.cost.known_cost_usd).toBe(0);
  expect(value.cost.completed_calls).toBe(0);
  expect(value.cost.active_reserved_usd).toBe(0);
  expect(value.cost.unresolved_exposure_usd).toBe(0);
}
test.beforeEach(async({page})=>{
  const errors:string[]=[];pageErrors.set(page,errors);page.on("pageerror",error=>errors.push(error.message));
  // Wait for the first session/history response so cookie creation cannot race submit.
  await Promise.all([
    page.waitForResponse(r=>new URL(r.url()).pathname==="/api/translations"&&r.request().method()==="GET"),
    page.goto("/")
  ]);
  await expect(page.getByRole("heading",{name:"Prepare a document"})).toBeVisible();
});
test.afterEach(async({page})=>{expect(pageErrors.get(page)).toEqual([]);});

for(const format of ["md","pdf"] as const){
  test(`${format==="md"?"Markdown":"PDF"}: approve, download verified bytes and retain completion after reload`,async({page})=>{
    const accepted=await prepare(page,format==="pdf"?await fixturePDF():source,`manual.${format}`);
    const quoted=await awaitStage(page,accepted.job_id,"AWAITING_APPROVAL");
    expectNoPaidCalls(quoted);
    await expect(downloadLink(page)).toHaveCount(0);
    await expect(page.getByRole("button",{name:"Approve and translate"})).toBeVisible();
    await page.getByRole("button",{name:"Approve and translate"}).click();
    const complete=await awaitStage(page,accepted.job_id,"SUCCEEDED");
    await expect(downloadLink(page)).toBeVisible();
    expect(complete.cost.completed_calls).toBeGreaterThan(0);
    expect(complete.cost.known_cost_usd).toBeGreaterThan(0);
    expect(complete.cost.active_reserved_usd).toBe(0);
    expect(complete.cost.unresolved_exposure_usd).toBe(0);
    expect(complete.quality.numbers.rate).toBe(1);
    const [download]=await Promise.all([page.waitForEvent("download"),downloadLink(page).click()]);
    expect(await download.failure()).toBeNull();
    expect(download.suggestedFilename()).toBe(`translation.${format}`);
    const stream=await download.createReadStream();
    expect(stream).not.toBeNull();
    const chunks:Buffer[]=[];for await(const chunk of stream!)chunks.push(Buffer.from(chunk));
    const bytes=Buffer.concat(chunks);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(complete.artifact.checksum);
    if(format==="pdf"){
      expect(bytes.subarray(0,5).toString()).toBe("%PDF-");
      expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThan(0);
    }else{
      const text=bytes.toString("utf8");
      expect(text).toContain("https://example.com/manual");
      expect(text).toContain("`MODEL-X`");
      expect(text).toContain("12 kW");
      expect(text).toContain("100 km");
      expect(text).toMatch(/Batterie|Akku/i);
    }
    const receiptResponse=await page.request.get(complete.receipt_url);
    expect(receiptResponse.ok()).toBe(true);
    const receipt=await receiptResponse.json();
    expect(receipt.cost).toEqual(complete.cost);
    expect(receipt.source_checksum).toMatch(/^[a-f0-9]{64}$/);
    const before=await downloadLink(page).getAttribute("href");
    await page.reload();await expect(downloadLink(page)).toBeVisible();
    expect(await downloadLink(page).getAttribute("href")).toBe(before);
    expect((await job(page,accepted.job_id)).cost).toEqual(complete.cost);
  });
}

for(const input of [
  {name:"corrupt.pdf",bytes:async()=>Buffer.from("%PDF-corrupt"),error:"CORRUPT_OR_ENCRYPTED_PDF",hint:"cannot be opened"},
  {name:"scanned.pdf",bytes:async()=>fixturePDF(1,"scan"),error:"SCANNED_PDF_UNSUPPORTED",hint:"needs OCR"}
]){
  test(`${input.name}: specific preparation error with no model calls or artifact`,async({page})=>{
    const accepted=await prepare(page,await input.bytes(),input.name);
    const failed=await awaitStage(page,accepted.job_id,"FAILED");
    expect(failed.error).toBe(input.error);expectNoPaidCalls(failed);
    expect(failed.artifact).toBeNull();
    await expect(page.getByRole("alert")).toContainText(input.error);
    await expect(page.getByRole("alert")).toContainText(input.hint);
    await expect(downloadLink(page)).toHaveCount(0);
    await expect(page.getByRole("button",{name:"Approve and translate"})).toHaveCount(0);
  });
}

test("Unsupported format: immediate named rejection",async({page})=>{
  await page.getByLabel("Document file").setInputFiles({name:"unsupported.docx",mimeType:"application/octet-stream",buffer:Buffer.from("unsupported")});
  const [response]=await Promise.all([
    page.waitForResponse(r=>new URL(r.url()).pathname==="/api/translations"&&r.request().method()==="POST"),
    page.getByRole("button",{name:"Prepare and estimate"}).click()
  ]);
  expect(response.status()).toBe(415);
  expect((await response.json()).error.code).toBe("FORMAT_UNSUPPORTED");
  await expect(page.getByRole("alert")).toContainText("FORMAT_UNSUPPORTED");
  await expect(downloadLink(page)).toHaveCount(0);
});

test("Cancel before approval: persisted cancellation without spending",async({page})=>{
  const accepted=await prepare(page,source,"cancel.md");
  await awaitStage(page,accepted.job_id,"AWAITING_APPROVAL");
  await expect(page.getByRole("button",{name:"Cancel",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Cancel",exact:true}).click();
  const canceled=await awaitStage(page,accepted.job_id,"CANCELED");
  expectNoPaidCalls(canceled);
  await page.reload();await expect(page.locator(".badge")).toHaveText("CANCELED");
  await expect(downloadLink(page)).toHaveCount(0);
});

test("Workbench: desktop/mobile layout and keyboard navigation",async({page},info:TestInfo)=>{
  await page.screenshot({path:info.outputPath("desktop.png"),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.screenshot({path:info.outputPath("mobile.png"),fullPage:true});
  await page.keyboard.press("Tab");
  expect(await page.evaluate(()=>document.activeElement?.tagName)).not.toBe("BODY");
});
