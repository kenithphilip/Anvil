// Unit tests for src/api/_lib/auto-promote-mappings.js (Wave CM 3.1).

import { describe, it, expect } from "vitest";
import {
  extractTuplesFromRun, findConsensusCandidates,
  loadRecentObservations, sweepCustomer, __test,
} from "../api/_lib/auto-promote-mappings.js";

describe("extractTuplesFromRun", () => {
  it("returns [] on null / no lines", () => {
    expect(extractTuplesFromRun(null)).toEqual([]);
    expect(extractTuplesFromRun({ lines: [] })).toEqual([]);
  });

  it("emits one tuple per mapped line, normalises partNo case", () => {
    const out = extractTuplesFromRun({
      lines: [
        { partNumber: "gd544", _mapped_item: { id: "i1", part_no: "THB-1", match_via: "customer_part" } },
        { partNumber: "ABC-2", _mapped_item: { id: "i2", part_no: "THB-2", match_via: "item_master.alias" } },
      ],
    });
    expect(out.length).toBe(2);
    expect(out[0].customer_part_number).toBe("GD544");
    expect(out[0].item_id).toBe("i1");
    expect(out[1].customer_part_number).toBe("ABC-2");
  });

  it("skips lines with no _mapped_item", () => {
    const out = extractTuplesFromRun({
      lines: [{ partNumber: "X", _mapped_item: null }],
    });
    expect(out).toEqual([]);
  });

  it("skips llm_suggest tier (not yet operator-confirmed)", () => {
    const out = extractTuplesFromRun({
      lines: [
        { partNumber: "X", _mapped_item: { id: "i1", match_via: "llm_suggest" } },
        { partNumber: "Y", _mapped_item: { id: "i2", match_via: "customer_part" } },
      ],
    });
    expect(out.length).toBe(1);
    expect(out[0].customer_part_number).toBe("Y");
  });

  it("skips lines without a partNumber-ish field", () => {
    const out = extractTuplesFromRun({
      lines: [{ description: "Bend", _mapped_item: { id: "i1", match_via: "customer_part" } }],
    });
    expect(out).toEqual([]);
  });
});

describe("findConsensusCandidates", () => {
  const runs = (sequences) => sequences.map((seq) =>
    seq.map(([partNo, itemId, via]) => ({
      customer_part_number: partNo,
      item_id: itemId,
      match_via: via || "customer_part",
    }))
  );

  it("returns the candidate when the same mapping wins N-of-M", () => {
    const out = findConsensusCandidates(runs([
      [["GD544", "i1"]],
      [["GD544", "i1"]],
      [["GD544", "i1"]],
      [["GD544", "i1"]],
    ]));
    expect(out.length).toBe(1);
    expect(out[0].customer_part_number).toBe("GD544");
    expect(out[0].item_id).toBe("i1");
    expect(out[0].occurrences).toBe(4);
  });

  it("returns nothing when N-of-M is not satisfied", () => {
    const out = findConsensusCandidates(runs([
      [["GD544", "i1"]],
      [["GD544", "i1"]],
      [],
      [],
    ]));
    expect(out).toEqual([]);
  });

  it("skips when two items both won >= once (mixed signal)", () => {
    const out = findConsensusCandidates(runs([
      [["GD544", "i1"]],
      [["GD544", "i1"]],
      [["GD544", "i1"]],
      [["GD544", "i2"]],   // conflicting observation
    ]));
    expect(out).toEqual([]);
  });

  it("respects custom n / m thresholds", () => {
    const out = findConsensusCandidates(
      runs([
        [["GD544", "i1"]],
        [["GD544", "i1"]],
      ]),
      { n: 2, m: 2 },
    );
    expect(out.length).toBe(1);
  });

  it("dedupes within a run so a single PO with 3 lines doesn't count thrice", () => {
    const out = findConsensusCandidates(runs([
      [["GD544", "i1"], ["GD544", "i1"], ["GD544", "i1"]],
      [["GD544", "i1"]],
      [["GD544", "i1"]],
    ]));
    // The first run only contributes once.
    expect(out[0].occurrences).toBe(3);
  });
});

describe("loadRecentObservations", () => {
  it("returns [] on missing svc / args", async () => {
    expect(await loadRecentObservations(null, { tenantId: "t", customerId: "c" })).toEqual([]);
    expect(await loadRecentObservations({}, { tenantId: null, customerId: "c" })).toEqual([]);
  });

  it("queries with the right filters and returns observations per run", async () => {
    const svc = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({
                gte: () => ({
                  order: () => ({
                    limit: () => Promise.resolve({
                      data: [
                        { id: "r1", normalized_extract: { lines: [{ partNumber: "X", _mapped_item: { id: "i1", match_via: "customer_part" } }] } },
                        { id: "r2", normalized_extract: { lines: [] } },
                      ],
                      error: null,
                    }),
                  }),
                }),
              }),
            }),
          }),
        }),
      }),
    };
    const out = await loadRecentObservations(svc, { tenantId: "t", customerId: "c" });
    expect(out.length).toBe(2);
    expect(out[0][0].customer_part_number).toBe("X");
    expect(out[1]).toEqual([]);
  });
});

describe("sweepCustomer", () => {
  it("returns ok=true promoted=0 when nothing meets consensus", async () => {
    const svc = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({
                gte: () => ({
                  order: () => ({
                    limit: () => Promise.resolve({ data: [], error: null }),
                  }),
                }),
              }),
            }),
          }),
        }),
        insert: () => Promise.resolve({ error: null }),
      }),
    };
    const out = await sweepCustomer(svc, { tenantId: "t", customerId: "c" });
    expect(out.ok).toBe(true);
    expect(out.promoted).toBe(0);
  });

  it("returns ok=false on missing args", async () => {
    expect((await sweepCustomer(null, { tenantId: "t", customerId: "c" })).ok).toBe(false);
    expect((await sweepCustomer({}, { tenantId: null, customerId: "c" })).ok).toBe(false);
  });
});

describe("__test exports", () => {
  it("exposes thresholds", () => {
    expect(__test.DEFAULT_N).toBe(3);
    expect(__test.DEFAULT_M).toBe(4);
    expect(__test.MIN_OBSERVATION_CONFIDENCE).toBe(0.85);
  });
});
