import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

// Linux bind mounts retain host ownership. Keep permission changes confined to
// a newly generated fixture's out directory; never apply them to user documents.
export function mcpFixtureOutput(workspace:string,composeArgs:string[],env:NodeJS.ProcessEnv,cwd=process.cwd()){
  const run=(args:string[])=>{
    const p=spawnSync("docker",[...composeArgs,"run","--rm","--no-deps","-T","-v",`${workspace.replaceAll("\\","/")}:/workspace`,...args],{env,cwd,encoding:"utf8"});
    if(p.status!==0)throw new Error(`MCP_FIXTURE_FILESYSTEM_FAILED: ${p.stderr.slice(-1500)}`);
    return p.stdout.trim();
  };
  return {
    prepare(){
      if(process.platform!=="win32")run(["--user","0","--entrypoint","chown","mcp","bun:bun","/workspace/out"]);
    },
    async checksum(name:string){
      if(!/^[A-Za-z0-9_.-]+$/.test(name))throw new Error("FIXTURE_FILENAME_DENIED");
      if(process.platform!=="win32")return run(["--entrypoint","sha256sum","mcp",`/workspace/out/${name}`]).split(/\s+/)[0];
      return createHash("sha256").update(await readFile(`${workspace}/out/${name}`)).digest("hex");
    },
    restore(){
      if(process.platform!=="win32")run(["--user","0","--entrypoint","chown","mcp","-R",`${process.getuid!()}:${process.getgid!()}`,"/workspace/out"]);
    }
  };
}
