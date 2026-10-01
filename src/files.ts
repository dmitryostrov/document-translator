import { mkdir, open, rename, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { config } from "./config";
import { hash } from "./domain";

export async function atomic(path: string, bytes: Uint8Array | string) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${crypto.randomUUID()}.tmp`;
  const fd = await open(tmp, "wx", 0o600);
  try { await fd.writeFile(bytes); await fd.sync(); } finally { await fd.close(); }
  await rename(tmp, path);
  // Persist the directory entry on the Linux delivery filesystem.
  if (process.platform !== "win32") {
    const dir = await open(dirname(path), "r"); try { await dir.sync(); } finally { await dir.close(); }
  }
}
export async function formatProcess(action: "extract" | "render", input: object) {
  const id = crypto.randomUUID(), request = join(config.data, "scratch", `${id}.json`), result = `${request}.result`;
  await atomic(request, JSON.stringify(input));
  const proc = Bun.spawn(["bun", "src/format-process.ts", action, request, result], { stdout: "ignore", stderr: "pipe", env: process.env });
  const timer = setTimeout(() => proc.kill("SIGKILL"), 60_000);
  try {
    const code = await proc.exited;
    // stderr may contain library content/paths: consume, never expose.
    await new Response(proc.stderr).text();
    if (code !== 0) throw new Error("FORMAT_PROCESS_FAILED");
    const data = JSON.parse(await readFile(result, "utf8"));
    if (data.error) throw new Error(data.error);
    return data;
  } finally { clearTimeout(timer); }
}
