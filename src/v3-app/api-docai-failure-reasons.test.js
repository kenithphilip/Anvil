// Regression test: docai adapters must carry a `reason` on every
// early failure return, so extraction_runs.status_reason records a
// precise cause instead of the orchestrator's 'fail_unknown'
// fallback ("Unknown failure / model —").
//
// This is the observability gap behind the P250432265 report: the
// Claude adapter returned { ok: false } with no reason when no
// document bytes reached it (re-extraction path), and the
// diagnostics tab could only say "Unknown failure".

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as claude from "../api/_lib/docai/claude.js";
import * as gemini from "../api/_lib/docai/gemini.js";

const ENV_KEYS = ["ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"];
let saved = {};

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("claude adapter early failures carry a reason", () => {
  it("no_api_key when ANTHROPIC_API_KEY is unset", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const out = await claude.extract({ settings: { tenant_id: "t-1" }, hints: {} });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("no_api_key");
  });

  it("no_tenant when settings.tenant_id is missing (key present)", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test-fake";
    const out = await claude.extract({ settings: {}, hints: {} });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("no_tenant");
  });

  it("no_source_bytes when no bytes / bodyText / url reach the adapter", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test-fake";
    const out = await claude.extract({ settings: { tenant_id: "t-1" }, hints: {} });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("no_source_bytes");
  });
});

describe("gemini adapter early failures carry a reason", () => {
  it("no_api_key when no Gemini key is configured", async () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    const out = await gemini.extract({ settings: { tenant_id: "t-1" }, hints: {} });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("no_api_key");
  });

  it("no_source_bytes when nothing to extract from (key present)", async () => {
    process.env.GEMINI_API_KEY = "g-test-fake";
    const out = await gemini.extract({ settings: { tenant_id: "t-1" }, hints: {} });
    expect(out.ok).toBe(false);
    // either no_tenant or no_source_bytes depending on order; here
    // tenant IS present so it must be the body-block gate.
    expect(out.reason).toBe("no_source_bytes");
  });
});
