// processing_events insert shape — schema guard.
//
// The table has EXACTLY these columns (supabase/migrations/001_init.sql:343):
// tenant_id, case_id, event_type, object_type, object_id, detail, duration_ms,
// created_at. Nine direct inserts across the agents / voice / inbound handlers
// passed a top-level `severity`, which PostgREST rejects (PGRST204) — so every
// one of those events was silently dropped, including the inbound-complaint
// handler. Nothing caught it: the writes are fire-and-forget, and vitest mocks
// Supabase so no insert is ever validated against a real schema.
//
// This scans the actual handler source for the invariant, so a new handler
// inventing a column fails here instead of silently losing events in prod.
// Severity belongs inside `detail` (both readers already select it).

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const API_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "api");
const REPO_ROOT = join(API_DIR, "..", "..");

// Real columns, per 001_init.sql. `id` is bigserial (never written).
const COLUMNS = new Set([
  "tenant_id", "case_id", "event_type", "object_type",
  "object_id", "detail", "duration_ms", "created_at",
]);

const walk = (dir) =>
  readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".js") ? [p] : [];
  });

// Top-level keys of an object literal = the lines sharing the indentation of
// `event_type:`, which every processing_events insert sets. Nested objects
// (detail: { ... }) are indented deeper and correctly ignored.
const topLevelKeys = (block) => {
  const anchor = block.split("\n").find((l) => /^\s*event_type\s*:/.test(l));
  if (!anchor) return [];
  const indent = anchor.match(/^\s*/)[0];
  const re = new RegExp("^" + indent + "([a-zA-Z_][a-zA-Z0-9_]*)\\s*:");
  return block.split("\n").map((l) => l.match(re)).filter(Boolean).map((m) => m[1]);
};

describe("processing_events inserts only use real columns", () => {
  it("no handler passes a column the table does not have (e.g. severity)", () => {
    const offenders = [];
    for (const file of walk(API_DIR)) {
      const src = readFileSync(file, "utf8");
      if (!src.includes("processing_events")) continue;
      const re = /processing_events"\)\s*\n?\s*\.?insert\(\{([\s\S]*?)\n\s*\}\)/g;
      let m;
      while ((m = re.exec(src)) !== null) {
        for (const key of topLevelKeys(m[1])) {
          if (!COLUMNS.has(key)) {
            offenders.push(relative(REPO_ROOT, file) + " → " + key);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("actually parses the inserts it claims to check (guard against a no-op regex)", () => {
    // If the scanner silently matched nothing, the test above would pass
    // vacuously — which is exactly how the original bug survived.
    let blocks = 0;
    for (const file of walk(API_DIR)) {
      const src = readFileSync(file, "utf8");
      if (!src.includes("processing_events")) continue;
      const re = /processing_events"\)\s*\n?\s*\.?insert\(\{([\s\S]*?)\n\s*\}\)/g;
      while (re.exec(src) !== null) blocks++;
    }
    expect(blocks).toBeGreaterThanOrEqual(8);
  });
});
