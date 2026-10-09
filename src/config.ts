import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { modelProfile } from "./models";
const model=process.env.MODEL??"gpt-6-astra",profile=modelProfile(model);

export const config = {
  database: process.env.DATABASE_URL ?? "postgres://stark:stark-local@localhost:55432/stark",
  redis: process.env.REDIS_URL ?? "redis://localhost:56379",
  data: resolve(process.env.DATA_DIR ?? ".data"),
  port: Number(process.env.PORT ?? 3100),
  mode: process.env.PROVIDER_MODE ?? "openai",
  model,reasoning:profile.reasoning??null,cacheOptions:profile.cacheOptions,
  api: process.env.API_URL ?? "http://localhost:3100",
  tokenFile: process.env.MCP_TOKEN_FILE ?? ".runtime/mcp-token",
  leaseMs: 30_000, heartbeatMs: 10_000, scanMs: 5_000,
  policy: "visible-v3", prompt: "translation-v2", ratesVersion:profile.ratesVersion,
};
export function key(): string {
  if (config.mode !== "openai") throw new Error("LIVE_PROVIDER_DISABLED");
  const secret = process.env.OPENAI_API_KEY_FILE;
  try {
    const value = secret ? readFileSync(secret, "utf8").trim() : process.env.OPENAI_API_KEY?.trim();
    if (!value) throw new Error("EMPTY_KEY");
    return value;
  }catch{throw new AppError("OPENAI_KEY_UNAVAILABLE",503);}
}
export const rates = profile.rates;
export function log(event: string, fields: Record<string, unknown> = {}) {
  // Callers pass identifiers/counts only. Never serialize errors/prompts/SDK objects.
  console.error(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));
}
// Diagnostic for unexpected errors: name, code and a few stack frames. Never the message (SDK/library messages may echo input text).
export function failure(error: any) {
  const frames = String(error?.stack ?? "").split("\n").slice(1, 5).map(s => s.trim().replace(/^at /, ""));
  return { error_name: error?.name, error_code: error?.code, frames };
}
export class AppError extends Error {
  constructor(public code: string, public status = 422) { super(code); }
}
