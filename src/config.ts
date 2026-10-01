import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const config = {
  database: process.env.DATABASE_URL ?? "postgres://stark:stark-local@localhost:55432/stark",
  redis: process.env.REDIS_URL ?? "redis://localhost:56379",
  data: resolve(process.env.DATA_DIR ?? ".data"),
  port: Number(process.env.PORT ?? 3100),
  mode: process.env.PROVIDER_MODE ?? "openai",
  model: process.env.MODEL ?? "gpt-4.1-mini",
  api: process.env.API_URL ?? "http://localhost:3100",
  tokenFile: process.env.MCP_TOKEN_FILE ?? ".runtime/mcp-token",
  leaseMs: 30_000, heartbeatMs: 10_000, scanMs: 5_000,
  policy: "visible-v2", prompt: "translation-v2", ratesVersion: "2026-09-30",
};
export function key(): string {
  if (config.mode !== "openai") throw new Error("LIVE_PROVIDER_DISABLED");
  const secret = process.env.OPENAI_API_KEY_FILE;
  const value = secret ? readFileSync(secret, "utf8").trim() : process.env.OPENAI_API_KEY;
  if (!value) throw new Error("OPENAI_KEY_UNAVAILABLE");
  return value;
}
export const rates = { input: 0.40, cached: 0.10, write: 0.40, output: 1.60 };
if(config.model!=="gpt-4.1-mini")throw new Error("MODEL_RATES_UNCONFIGURED");
export function log(event: string, fields: Record<string, unknown> = {}) {
  // Callers pass identifiers/counts only. Never serialize errors/prompts/SDK objects.
  console.error(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));
}
export class AppError extends Error {
  constructor(public code: string, public status = 422) { super(code); }
}
