// lines[].requisition_no: the buyer's purchase requisition (PR) number, read
// per PO line by BOTH LLM PO adapters.
//
// The claude prompt has told the model since #106 that row 4 of an OEM item
// block prints a requisition number, but a line was additionalProperties:false
// with no slot for it, so a consolidated PO raised against several PRs kept
// one at most (in customer.requisition_no). gemini.js runs FIRST for POs and
// never asked at all.
//
// The drift this guards is the repo's most repeated one: the multi-row block
// (#106) and the unsupported-kind guard (#485) each landed on one adapter
// only. So these tests drive BOTH adapters' real extract() with the network
// stubbed, and assert on what each one actually SENDS (the schema and the
// prompt the model sees) and what each one RETURNS. A line value that the
// schema does not declare is never emitted by a structured-output model, so
// "the schema sent declares it" is the assertion that matters.

import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ anthropicArgs: null, geminiBodies: [], geminiReply: null, claudeReply: null }));

vi.mock("../api/_lib/anthropic.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    callAnthropic: vi.fn(async (args) => {
      H.anthropicArgs = args;
      return {
        ok: true,
        status: 200,
        data: {
          stop_reason: "tool_use",
          content: [{ type: "tool_use", name: "extract_purchase_order", input: H.claudeReply }],
        },
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
        candidates: [{ content: { parts: [{ text: JSON.stringify(H.geminiReply) }] }, finishReason: "STOP" }],
      }),
    };
  },
}));

const claude = await import("../api/_lib/docai/claude.js");
const gemini = await import("../api/_lib/docai/gemini.js");
const { canonicaliseLine, CANONICAL_LINE_FIELDS } = await import("../api/_lib/docai/line-schema.js");

// A consolidated PO: two item blocks raised against two different PRs, and a
// header that prints the first one. Tenant-neutral values.
const EXTRACTED = {
  classification: "po",
  confidence: 0.95,
  customer: { name: "Fixture Buyer", po_number: "PO-7001", requisition_no: "1000343964" },
  lines: [
    { partNumber: "PN-1", description: "Head assy", quantity: 2, unitPrice: 100, requisition_no: "1000343964" },
    { partNumber: "PN-2", description: "Shank", quantity: 1, unitPrice: 50, requisition_no: "1000344102" },
  ],
  stated_line_count: 2,
};

const settings = { tenant_id: "t-1" };
const hints = { bodyText: "fixture purchase order text", expectedKind: "po" };

beforeEach(() => {
  H.anthropicArgs = null;
  H.geminiBodies.length = 0;
  H.claudeReply = EXTRACTED;
  H.geminiReply = EXTRACTED;
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.GEMINI_API_KEY = "test-key";
});

const sentGeminiSystemText = () => (H.geminiBodies[0]?.systemInstruction?.parts || [])
  .map((p) => p.text || "").join("\n");
const sentClaudeSystemText = () => (H.anthropicArgs?.system || [])
  .map((b) => (typeof b === "string" ? b : b.text || "")).join("\n");

describe("both adapter schemas declare lines[].requisition_no", () => {
  it("claude: the tool schema it sends has a nullable string slot on the line", async () => {
    const out = await claude.extract({ settings, hints });
    expect(out.ok).toBe(true);
    const tool = H.anthropicArgs.tools.find((t) => t.name === "extract_purchase_order");
    const line = tool.input_schema.properties.lines.items;
    // additionalProperties:false is what made the prompt's row-4 instruction
    // unanswerable; the slot has to be inside the line object it governs.
    expect(line.additionalProperties).toBe(false);
    expect(line.properties.requisition_no).toEqual({
      type: ["string", "null"],
      description: claude.LINE_REQUISITION_DESCRIPTION,
    });
  });

  it("gemini: the responseSchema it sends (after conversion) has the slot on the line", async () => {
    const out = await gemini.extract({ settings, hints });
    expect(out.ok).toBe(true);
    const line = H.geminiBodies[0].generationConfig.responseSchema.properties.lines.items;
    expect(line.properties.requisition_no).toEqual({
      type: "string",
      nullable: true,
      description: claude.LINE_REQUISITION_DESCRIPTION,
    });
  });

  it("the exported schema objects agree with each other", () => {
    const c = claude.TOOL_DEFINITION.input_schema.properties.lines.items.properties.requisition_no;
    const g = gemini.PO_SCHEMA.properties.lines.items.properties.requisition_no;
    expect(c).toBeDefined();
    expect(g).toEqual(c);
  });

  it("the header-level slot stays on both", () => {
    expect(claude.TOOL_DEFINITION.input_schema.properties.customer.properties.requisition_no.type)
      .toEqual(["string", "null"]);
    expect(gemini.PO_SCHEMA.properties.customer.properties.requisition_no.type)
      .toEqual(["string", "null"]);
  });
});

describe("both prompts name lines[].requisition_no with the same rule", () => {
  it("claude's system prompt, as sent, carries the per-line rule", async () => {
    await claude.extract({ settings, hints });
    const sys = sentClaudeSystemText();
    expect(sys).toContain("lines[].requisition_no " + claude.LINE_REQUISITION_RULE);
  });

  it("gemini's system prompt, as sent, carries the identical rule", async () => {
    await gemini.extract({ settings, hints });
    const sys = sentGeminiSystemText();
    expect(sys).toContain("lines[].requisition_no = " + claude.LINE_REQUISITION_RULE);
  });

  it("the rule keeps the line value apart from the header value", () => {
    // Copying the header PR onto every line would make a consolidated PO look
    // like it answers one PR, which is the exact thing the per-line slot is
    // there to reveal.
    expect(claude.LINE_REQUISITION_RULE).toMatch(/never copy customer\.requisition_no onto a line/);
    expect(claude.LINE_REQUISITION_RULE).toMatch(/Null when the line prints none/);
  });
});

describe("the per-line value survives each adapter and the schema boundary", () => {
  it.each([
    ["claude", () => claude.extract({ settings, hints })],
    ["gemini", () => gemini.extract({ settings, hints })],
  ])("%s returns a different PR on each line, and the header PR beside them", async (_name, run) => {
    const out = await run();
    expect(out.ok).toBe(true);
    expect(out.normalized.lines.map((l) => l.requisition_no)).toEqual(["1000343964", "1000344102"]);
    expect(out.normalized.customer.requisition_no).toBe("1000343964");
  });

  it.each([
    ["claude", () => claude.extract({ settings, hints })],
    ["gemini", () => gemini.extract({ settings, hints })],
  ])("%s: the dispatcher's conformance step keeps it and does not report it as unknown", async (_name, run) => {
    const out = await run();
    const { line, unknown } = canonicaliseLine(out.normalized.lines[1]);
    expect(line.requisition_no).toBe("1000344102");
    expect(unknown).toEqual([]);
    expect(CANONICAL_LINE_FIELDS).toContain("requisition_no");
  });
});
