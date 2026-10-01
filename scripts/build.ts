import { mkdir, copyFile } from "node:fs/promises";
await mkdir("dist",{recursive:true});
const result=await Bun.build({entrypoints:["web/app.tsx"],outdir:"dist",target:"browser",minify:true,naming:"app.js"});
if(!result.success)throw new Error("FRONTEND_BUILD_FAILED");
await copyFile("web/index.html","dist/index.html");
await copyFile("web/style.css","dist/style.css");
