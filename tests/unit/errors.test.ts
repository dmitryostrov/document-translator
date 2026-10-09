import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const { errorCatalog, describeError } = await import("../../src/errors");

const srcDir = join(import.meta.dir, "../../src");
const sources = readdirSync(srcDir).filter(f => f.endsWith(".ts")).map(f => readFileSync(join(srcDir, f), "utf8"));
const patterns = [/AppError\("([A-Z][A-Z0-9_]+)"/g, /new Error\("([A-Z][A-Z0-9_]+)"/g, /error:\s*"([A-Z][A-Z0-9_]+)"/g, /error='([A-Z][A-Z0-9_]+)'/g, /code:\s*"([A-Z][A-Z0-9_]+)"/g];

function codesIn(text: string) {
  const found = new Set<string>();
  for (const re of patterns) for (const m of text.matchAll(re)) found.add(m[1]!);
  const safe = text.match(/const safeCodes=\[([^\]]*)\]/);
  if (safe) for (const m of safe[1]!.matchAll(/"([A-Z][A-Z0-9_]+)"/g)) found.add(m[1]!);
  return found;
}

describe("error catalog", () => {
  const thrown = new Set<string>();
  for (const text of sources) for (const c of codesIn(text)) thrown.add(c);

  test("extracts a non-trivial set of codes from src", () => {
    expect(thrown.size).toBeGreaterThan(40);
  });

  test("every code thrown or reported in src has a catalog entry", () => {
    const missing = [...thrown].filter(c => !Object.hasOwn(errorCatalog, c));
    expect(missing).toEqual([]);
  });

  test("every catalog entry has a non-empty message and remedy", () => {
    for (const [code, info] of Object.entries(errorCatalog)) {
      expect(info.message.trim(), code).not.toBe("");
      expect(info.remedy.trim(), code).not.toBe("");
      expect(typeof info.retryable, code).toBe("boolean");
    }
  });

  test("describeError returns catalog entries and a fallback for unknown codes", () => {
    expect(describeError("CORRUPT_PDF")).toEqual(errorCatalog.CORRUPT_PDF!);
    const unknown = describeError("NOT_A_REAL_CODE");
    expect(unknown.message).toContain("NOT_A_REAL_CODE");
    expect(unknown.remedy).not.toBe("");
    expect(describeError(undefined).message).not.toBe("");
  });
});
