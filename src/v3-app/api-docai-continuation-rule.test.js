// The continuation-row rule reaches BOTH LLM PO adapters, as sent.
//
// claude.js has carried a multi-row-per-item block since #106; gemini.js runs
// FIRST for purchase orders and never had any of it. A PO whose items each
// print as a part row plus description, drawing-code and requisition rows came
// back with every row below the first as a line of its own. The rule is one
// exported string (claude.js CONTINUATION_ROW_RULE) that gemini.js imports, so
// the two prompts cannot drift the way #106 and #485 did.
//
// These drive each adapter's real extract() with the network stubbed and read
// the system prompt it actually SENDS, as the requisition parity test (#550)
// does.

import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ anthropicArgs: null, geminiBodies: [] }));

const REPLY = {
  classification: "po",
  confidence: 0.95,
  customer: { name: "Fixture Buyer", po_number: "PO-7101" },
  lines: [{ partNumber: "ZX-1", description: "Guide block", quantity: 2, unitPrice: 100 }],
  stated_line_count: 1,
};

vi.mock("../api/_lib/anthropic.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    callAnthropic: vi.fn(async (args) => {
      H.anthropicArgs = args;
      return {
        ok: true,
        status: 200,
        data: { stop_reason: "tool_use", content: [{ type: "tool_use", name: "extract_purchase_order", input: REPLY }] },
      };
    }),
  };
});

vi.mock("../api/_lib/safe-fetch.js", () => ({
  safeFetch: async (_url, init) => {
    H.geminiBodies.push(JSON.parse(init.body));
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({
        candidates: [{ content: { parts: [{ text: JSON.stringify(REPLY) }] }, finishReason: "STOP" }],
      }),
    };
  },
}));

const claude = await import("../api/_lib/docai/claude.js");
const gemini = await import("../api/_lib/docai/gemini.js");

const settings = { tenant_id: "t-1" };
const hints = { bodyText: "fixture purchase order text", expectedKind: "po" };

beforeEach(() => {
  H.anthropicArgs = null;
  H.geminiBodies.length = 0;
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.GEMINI_API_KEY = "test-key";
});

const sentGeminiSystemText = () => (H.geminiBodies[0]?.systemInstruction?.parts || [])
  .map((p) => p.text || "").join("\n");
const sentClaudeSystemText = () => (H.anthropicArgs?.system || [])
  .map((b) => (typeof b === "string" ? b : b.text || "")).join("\n");

describe("both PO prompts carry the same continuation-row rule", () => {
  it("claude sends it", async () => {
    const out = await claude.extract({ settings, hints });
    expect(out.ok).toBe(true);
    expect(sentClaudeSystemText()).toContain(claude.CONTINUATION_ROW_RULE);
  });

  it("gemini, which runs first for POs, sends the identical rule", async () => {
    const out = await gemini.extract({ settings, hints });
    expect(out.ok).toBe(true);
    expect(sentGeminiSystemText()).toContain(claude.CONTINUATION_ROW_RULE);
    expect(gemini.PO_SYSTEM_PROMPT).toContain(claude.CONTINUATION_ROW_RULE);
  });

  it("the rule names the rows that were split off, and says where their text goes", () => {
    const rule = claude.CONTINUATION_ROW_RULE;
    expect(rule).toMatch(/requisition \(PR\) number/);
    expect(rule).toMatch(/drawing or specification code/);
    expect(rule).toMatch(/never return it as a lines\[\] entry of its own/);
    expect(rule).toMatch(/never a unit price/);
    expect(rule).toMatch(/exactly one lines\[\] entry per printed S\.No/);
  });
});
