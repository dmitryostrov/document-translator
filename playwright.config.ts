import { defineConfig,devices } from "@playwright/test";

export default defineConfig({
  testDir:"./tests/e2e",
  testMatch:/\.spec\.ts$/,
  fullyParallel:false,
  workers:1,
  retries:0,
  forbidOnly:!!process.env.CI,
  timeout:120_000,
  expect:{timeout:30_000},
  globalSetup:"./tests/e2e/global-setup.ts",
  reporter:[["list"],["./tests/e2e/reporter.ts"]],
  outputDir:"test-results",
  use:{
    baseURL:process.env.E2E_BASE_URL??(process.env.LIVE_E2E==="1"?"http://127.0.0.1:3100":"http://127.0.0.1:3110"),
    trace:"retain-on-failure",
    screenshot:"only-on-failure",
    acceptDownloads:true
  },
  projects:[{name:"chromium",use:{...devices["Desktop Chrome"],viewport:{width:1440,height:1000}}}]
});
