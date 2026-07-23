// Ask Anvil per-prompt diagnostics.
//
// The constraint: this must be a TOKENLESS feature. It exposes what a turn
// spent and what it read, but must never itself cause a model call — so every
// field is assembled from metadata the turn already produced (the provider's
// own usage counters, the tool_use blocks the model emitted, and the `source`
// each tool reports).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "api", "erp_chat", "send.js"),
  "utf8",
);

describe("erp_chat diagnostics are free", () => {
  it("returns a diagnostics block on the response", () => {
    expect(SRC).toMatch(/diagnostics:\s*\{/);
    for (const field of ["model", "loops", "latency_ms", "tokens_in", "tokens_out", "tools", "schema_refs"]) {
      expect(SRC).toContain(field);
    }
  });

  it("derives schema_refs from the tool results, not a second model call", () => {
    expect(SRC).toMatch(/schema_refs:\s*Array\.from\(new Set\(toolTrace\.map/);
  });

  it("adds NO extra model call — callAnthropic is still invoked exactly once, in the loop", () => {
    // The whole point of the constraint. If a future change adds a
    // "summarise this trace" call, this fails.
    const calls = SRC.match(/await callAnthropic\(/g) || [];
    expect(calls.length).toBe(1);
  });

  it("captures the bound variables + table + row count per tool call", () => {
    expect(SRC).toMatch(/toolTrace\.push\(\{/);
    for (const f of ["args:", "source:", "rows:", "ms:"]) expect(SRC).toContain(f);
  });
});
