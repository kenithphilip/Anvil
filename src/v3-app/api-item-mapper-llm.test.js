// Unit tests for the Layer C LLM-suggest helper at
// src/api/_lib/item-mapper-llm.js.
//
// Strategy: mock callAnthropic at the module level via Vitest's
// vi.mock so the helper sees a deterministic JSON tool_use
// response. Mock the Supabase svc with the chainable in-memory
// builder used elsewhere in this test suite.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../api/_lib/anthropic.js", () => ({
  callAnthropic: vi.fn(),
}));

import { callAnthropic } from "../api/_lib/anthropic.js";
import {
  suggestMappings,
  getCandidatesForLine,
  __test as llmTest,
} from "../api/_lib/item-mapper-llm.js";

const TENANT = "00000000-0000-0000-0000-0000000000aa";

const makeSvc = (tables) => {
  const buildQuery = (table) => {
    const ds = tables[table] || (tables[table] = []);
    let rows = [...ds];
    const builder = {
      select: () => builder,
      eq: (col, val) => { rows = rows.filter((r) => String(r[col]) === String(val)); return builder; },
      or: () => builder,
      limit: () => builder,
      ilike: () => builder,
      then: (fn) => Promise.resolve(fn({ data: rows, error: null })),
    };
    return builder;
  };
  return { from: buildQuery, _tables: tables };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("significantWords", () => {
  it("strips stop words and short tokens", () => {
    expect(llmTest.significantWords("the BIG bend ADAPTER for nos 2")).toEqual(["big", "bend", "adapter"]);
  });
  it("returns [] on null", () => {
    expect(llmTest.significantWords(null)).toEqual([]);
  });
});

describe("getCandidatesForLine", () => {
  it("returns an empty list when the line has no significant words", async () => {
    const svc = makeSvc({ item_master: [{ id: "im-1", tenant_id: TENANT, part_no: "X" }] });
    const out = await getCandidatesForLine(svc, TENANT, { description: "nos" });
    expect(out).toEqual([]);
  });
  it("scores rows by word-overlap count", async () => {
    const svc = makeSvc({ item_master: [
      { id: "im-1", tenant_id: TENANT, part_no: "A1", description: "Bend Adapter", print_name: "", alias: "" },
      { id: "im-2", tenant_id: TENANT, part_no: "A2", description: "Bend",         print_name: "", alias: "" },
      { id: "im-3", tenant_id: TENANT, part_no: "A3", description: "Random Thing", print_name: "", alias: "" },
    ] });
    const out = await getCandidatesForLine(svc, TENANT, { description: "BEND ADAPTER" });
    expect(out.map((r) => r.id)).toEqual(["im-1", "im-2", "im-3"]);
  });
});

describe("suggestMappings", () => {
  const line = { description: "GUIDE ASSY", partNumber: "GD544", _line_index: 4 };
  const masterRows = [
    { id: "im-1", tenant_id: TENANT, part_no: "THB-L1-70B-2-GA", alias: "GUIDE ASSY", description: "Guide assembly", print_name: "Guide Assembly THB-L1" },
    { id: "im-2", tenant_id: TENANT, part_no: "THB-L1-70B-2-PH", alias: "POINT HOLDER", description: "Tip holder", print_name: "Point Holder THB-L1" },
  ];

  it("hydrates the LLM response with candidate fields and filters hallucinated ids", async () => {
    callAnthropic.mockResolvedValue({
      ok: true,
      data: {
        content: [{
          type: "tool_use",
          name: "return_suggestions",
          input: {
            suggestions: [
              { item_id: "im-1", confidence_pct: 92, reasoning: "Description match." },
              { item_id: "im-hallucinated", confidence_pct: 70, reasoning: "Not in candidates." },
            ],
          },
        }],
      },
    });
    const svc = makeSvc({ item_master: masterRows });
    const out = await suggestMappings(svc, TENANT, "cust-1", [line]);
    expect(out.length).toBe(1);
    expect(out[0].line_index).toBe(4);
    expect(out[0].suggestions.length).toBe(1);
    expect(out[0].suggestions[0].item_id).toBe("im-1");
    expect(out[0].suggestions[0].part_no).toBe("THB-L1-70B-2-GA");
    expect(out[0].suggestions[0].confidence_pct).toBe(92);
  });

  it("returns empty suggestions when callAnthropic fails", async () => {
    callAnthropic.mockResolvedValue({ ok: false, status: 502, error: "upstream" });
    const svc = makeSvc({ item_master: masterRows });
    const out = await suggestMappings(svc, TENANT, "cust-1", [line]);
    expect(out[0].suggestions).toEqual([]);
  });

  it("returns no_candidates when the master has nothing matching the line's words", async () => {
    callAnthropic.mockResolvedValue({ ok: true, data: { content: [] } });
    const svc = makeSvc({ item_master: [] });
    const out = await suggestMappings(svc, TENANT, "cust-1", [line]);
    expect(out[0].suggestions).toEqual([]);
    expect(out[0].reason).toBe("no_candidates");
    expect(callAnthropic).not.toHaveBeenCalled();
  });

  it("caps the call at opts.maxLines lines", async () => {
    callAnthropic.mockResolvedValue({ ok: true, data: { content: [] } });
    const svc = makeSvc({ item_master: masterRows });
    const many = Array.from({ length: 25 }, (_, i) => ({ ...line, _line_index: i }));
    const out = await suggestMappings(svc, TENANT, "cust-1", many, { maxLines: 5 });
    expect(out.length).toBe(5);
  });

  it("clamps confidence_pct to 0-100", async () => {
    callAnthropic.mockResolvedValue({
      ok: true,
      data: {
        content: [{
          type: "tool_use",
          name: "return_suggestions",
          input: {
            suggestions: [
              { item_id: "im-1", confidence_pct: 250, reasoning: "" },
            ],
          },
        }],
      },
    });
    const svc = makeSvc({ item_master: masterRows });
    const out = await suggestMappings(svc, TENANT, "cust-1", [line]);
    expect(out[0].suggestions[0].confidence_pct).toBe(100);
  });
});
