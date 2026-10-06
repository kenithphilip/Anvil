// EXTRACTION_QUALITY PR 4 — golden fixtures for the non-PO kinds.
//
// Two things are under test. First that the PO path did not move: the scorer
// was refactored from a hardcoded field list to a profile, and the CI gate has
// been enforcing those exact numbers. Second that the non-PO profiles score
// the fields the PO vocabulary silently dropped — the ones whose corruption
// used to produce a clean 1.000.

import { describe, it, expect } from "vitest";
import {
  KIND_PROFILES, SCORABLE_KINDS, profileFor, profileForExpected, kindOfExpected,
  toScorableFor, modelOwnedFor, readPath,
} from "../api/eval/kind-profiles.js";
import { scoreCase } from "../api/eval/score.js";
import { normalizedToScorable } from "../api/eval/eval-normalize.js";
import { parsePath, applyCorrections, caseIdFor, promoteCorrectedRun } from "../api/eval/harvest-corrected.js";

describe("profile resolution", () => {
  it("declares a suite, a doc role and an identity rule per kind", () => {
    for (const kind of SCORABLE_KINDS) {
      const p = KIND_PROFILES[kind];
      expect(p.suite).toBeTruthy();
      expect(p.docRole).toBeTruthy();
      expect(p.identity.rules.length).toBeGreaterThan(0);
      expect(p.header.length).toBeGreaterThan(0);
      expect(p.line.length).toBeGreaterThan(0);
      for (const f of [...p.header, ...p.line]) expect(["text", "number"]).toContain(f.compare);
    }
    // Every suite is distinct — two kinds sharing one suite would replay each
    // other's cases against the wrong schema.
    const suites = SCORABLE_KINDS.map((k) => KIND_PROFILES[k].suite);
    expect(new Set(suites).size).toBe(new Set(SCORABLE_KINDS.map((k) => KIND_PROFILES[k].kind)).size);
  });

  it("treats a golden with no recorded kind as a purchase order", () => {
    // Every golden promoted before PR 4 is a PO and carries no kind.
    expect(profileForExpected({ poNumber: "PO-1" }).kind).toBe("po");
    expect(profileForExpected({ _provenance: { order_id: "o1" } }).kind).toBe("po");
    expect(kindOfExpected({ _provenance: { order_id: "o1" } })).toBeNull();
  });

  it("returns null for a kind with no profile, so a caller skips instead of mis-scoring", () => {
    expect(profileFor("assembly_bom")).toBeNull();
    expect(profileFor("part_drawing")).toBeNull();
    expect(profileForExpected({ _provenance: { extraction_kind: "assembly_bom" } })).toBeNull();
  });

  it("reads dotted paths out of a nested extract", () => {
    expect(readPath({ customer: { po_number: "PO-9" } }, "customer.po_number")).toBe("PO-9");
    expect(readPath({ customer: null }, "customer.po_number")).toBeUndefined();
    expect(readPath(null, "a.b")).toBeUndefined();
  });
});

describe("the PO profile reproduces the previous hardcoded scorer", () => {
  const normalized = {
    classification: "po",
    customer: { name: "ACME PVT LTD", po_number: "PO-77", po_date: "2026-01-02" },
    stated_line_count: 2,
    lines: [
      { partNumber: "BRG-6204", quantity: 10, unitPrice: 120.5, hsn: "8482", description: "BEARING" },
      { partNumber: "SKT-4410", quantity: 4, unitPrice: 1980, hsn: "8515", description: "SOCKET" },
    ],
  };

  it("produces the identical scorable shape", () => {
    expect(toScorableFor(normalized, profileFor("po"))).toEqual(normalizedToScorable(normalized));
  });

  it("produces the identical checks — names, order and outcomes", () => {
    const expected = normalizedToScorable(normalized);
    const legacy = scoreCase(expected, normalizedToScorable(normalized));
    const viaProfile = scoreCase(expected, toScorableFor(normalized, profileFor("po")), profileFor("po"));
    expect(viaProfile.checks.map((c) => c.name)).toEqual(legacy.checks.map((c) => c.name));
    expect(viaProfile.score).toBe(legacy.score);
  });

  it("still drops the fields the model does not own on a live replay", () => {
    const expected = { ...normalizedToScorable(normalized), grandTotal: 1000, _provenance: { order_id: "x" } };
    const stripped = modelOwnedFor(expected, profileFor("po"));
    expect(stripped.grandTotal).toBeUndefined();
    expect(stripped._provenance).toBeUndefined();
    expect(stripped.lineItems[0].hsn).toBeUndefined();
    expect(stripped.lineItems[0].partNo).toBe("BRG-6204");   // identity survives
  });

  it("marks the identity check so recall is computable without parsing names", () => {
    const expected = normalizedToScorable(normalized);
    const scored = scoreCase(expected, toScorableFor(normalized, profileFor("po")), profileFor("po"));
    const identity = scored.checks.filter((c) => c.identity);
    expect(identity.length).toBe(2);
    expect(identity.map((c) => c.name)).toEqual(["line[0].partNo", "line[1].partNo"]);
  });
});

describe("the packing-list profile sees the measurement columns", () => {
  const pl = {
    classification: "packing_list",
    packing_list_no: "PL-1",
    supplier_name: "OVERSEAS SUPPLIER CO LTD",
    total_packages: 4,
    weight_uom: "kg",
    lines: [
      { partNumber: "GB-1140", description: "GUN BODY", quantity: 40, packages: 4, weight: 78, weight_uom: "kg", weight_basis: "per_package", volume_cbm: 0.42, volume_basis: "per_package" },
    ],
  };
  const p = profileFor("packing_list");

  it("carries weight, its unit, its basis and volume into the scorable", () => {
    const s = toScorableFor(pl, p);
    expect(s.weightUom).toBe("kg");
    expect(s.lineItems[0]).toMatchObject({
      partNo: "GB-1140", qty: 40, packages: 4, weight: 78,
      weightUom: "kg", weightBasis: "per_package", volumeCbm: 0.42,
    });
    // What the PO adapter did with the same document: the identity and the
    // quantity survive, and every measurement column — the reason a packing
    // list is read at all — is dropped before scoring.
    expect(normalizedToScorable(pl).lineItems[0]).toEqual({ partNo: "GB-1140", itemName: "GUN BODY", qty: 40 });
  });

  it("fails a basis flip that the PO vocabulary scored 1.000", () => {
    const expected = toScorableFor(pl, p);
    const broken = JSON.parse(JSON.stringify(pl));
    broken.lines[0].weight_basis = "per_unit";
    expect(scoreCase(normalizedToScorable(pl), normalizedToScorable(broken)).score).toBe(1);
    const scored = scoreCase(expected, toScorableFor(broken, p), p);
    expect(scored.score).toBeLessThan(1);
    expect(scored.checks.find((c) => c.name === "line[0].weightBasis").ok).toBe(false);
  });
});

describe("the quote profile scores BOTH price columns", () => {
  const q = {
    quote_number: "Q-1", customer_name: "ACME PVT LTD", currency: "INR", grand_total: 1000,
    lines: [{ partNumber: "SKT-4410", quantity: 25, unitPrice: 1980, listUnitPrice: 2200, uom: "PCS" }],
  };
  const p = profileFor("quote");

  it("keeps the discounted and the list price apart", () => {
    const s = toScorableFor(q, p);
    expect(s.lineItems[0].rate).toBe(1980);
    expect(s.lineItems[0].listRate).toBe(2200);
  });

  it("reads the customer from the shape a quote is actually STORED in", () => {
    // The fixture above uses the QUOTE_TOOL shape (`customer_name` at the
    // root). A stored normalized_extract does not look like that: the
    // normalizer consumes customer_name and re-emits `customer: { name }`
    // (claude.js), and only the isQuote spread survives flat. Reading the
    // schema name found nothing, toScorableFor omitted `customer`, and
    // scoreCase's `if (exp[f.key] === undefined) continue` skipped it — so
    // every quote golden scored the customer as a pass, including when the
    // model read the seller's name instead of the buyer's.
    const stored = {
      classification: "quote",
      customer: { name: "ACME PVT LTD" },
      quote_number: "Q-1", currency: "INR", grand_total: 1000,
      lines: [{ partNumber: "SKT-4410", quantity: 25, unitPrice: 1980 }],
    };
    expect(toScorableFor(stored, p).customer).toBe("ACME PVT LTD");
  });

  it("still reads a flat customer_name, if an adapter ever emits one raw", () => {
    expect(toScorableFor(q, p).customer).toBe("ACME PVT LTD");
  });

  it("actually scores the customer now, instead of skipping the check", () => {
    const stored = (name) => ({ customer: { name }, lines: [] });
    const expected = toScorableFor(stored("ACME PVT LTD"), p);
    const wrong = toScorableFor(stored("OUR OWN COMPANY"), p);
    const s = scoreCase(expected, wrong, p);
    expect(s.checks.some((c) => c.name === "customer")).toBe(true);
    expect(s.checks.find((c) => c.name === "customer").ok).toBe(false);
  });

  it("fails when the discounted price is lost to the list price (#462)", () => {
    const broken = JSON.parse(JSON.stringify(q));
    broken.lines[0].unitPrice = 2200;
    const scored = scoreCase(toScorableFor(q, p), toScorableFor(broken, p), p);
    expect(scored.checks.find((c) => c.name === "line[0].rate").ok).toBe(false);
  });

  it("does not score a price column the document never printed", () => {
    const single = { ...q, lines: [{ partNumber: "SKT-4410", quantity: 25, unitPrice: 1980, listUnitPrice: null }] };
    const s = toScorableFor(single, p);
    expect(s.lineItems[0].listRate).toBeUndefined();
    const scored = scoreCase(s, s, p);
    expect(scored.checks.map((c) => c.name)).not.toContain("line[0].listRate");
  });
});

describe("field_path grammar — corrections address lines by index", () => {
  it("parses the bracket form the review pane emits", () => {
    expect(parsePath("lines[0].partNumber")).toEqual(["lines", 0, "partNumber"]);
    expect(parsePath("customer.po_number")).toEqual(["customer", "po_number"]);
    expect(parsePath("po_number")).toEqual(["po_number"]);
    expect(parsePath("lines[12]")).toEqual(["lines", 12]);
    expect(parsePath("")).toBeNull();
    expect(parsePath(null)).toBeNull();
  });

  it("writes into the real array element, not a literal 'lines[0]' key", () => {
    const norm = { customer: { po_number: "PO-1" }, lines: [{ partNumber: "WRONG", quantity: 5 }] };
    const { normalized, fields } = applyCorrections(norm, [
      { field_path: "lines[0].partNumber", corrected_value: "RIGHT" },
      { field_path: "customer.po_number", corrected_value: "PO-2" },
    ]);
    expect(normalized.lines[0].partNumber).toBe("RIGHT");
    expect(normalized.customer.po_number).toBe("PO-2");
    expect(normalized["lines[0]"]).toBeUndefined();
    expect(fields).toEqual(["lines[0].partNumber", "customer.po_number"]);
  });

  it("does not mutate the run's stored extract", () => {
    const norm = { lines: [{ partNumber: "WRONG" }] };
    applyCorrections(norm, [{ field_path: "lines[0].partNumber", corrected_value: "RIGHT" }]);
    expect(norm.lines[0].partNumber).toBe("WRONG");
  });

  it("lets the last edit of a field win", () => {
    const { normalized } = applyCorrections({ lines: [{ quantity: 1 }] }, [
      { field_path: "lines[0].quantity", corrected_value: 5 },
      { field_path: "lines[0].quantity", corrected_value: 9 },
    ]);
    expect(normalized.lines[0].quantity).toBe(9);
  });

  it("refuses to invent a line the extract never produced", () => {
    // A correction against lines[3] of a 1-line extract cannot be applied by
    // writing it — that would fabricate a line and score the model against a
    // document it never saw.
    const { normalized, skipped, fields } = applyCorrections({ lines: [{ partNumber: "A" }] }, [
      { field_path: "lines[3].partNumber", corrected_value: "GHOST" },
    ]);
    expect(normalized.lines.length).toBe(1);
    expect(fields).toEqual([]);
    expect(skipped[0].reason).toBe("path_not_in_extract");
  });
});

// ── the harvest ──────────────────────────────────────────────────────
const makeSvc = (seed, sink = {}) => ({
  from: (table) => {
    const rows = seed[table] || [];
    const b = {
      _f: [],
      select: () => b,
      eq: (k, v) => { b._f.push([k, v]); return b; },
      order: () => b,
      limit: () => b,
      maybeSingle: async () => ({ data: rows.find((r) => b._f.every(([k, v]) => r[k] === v)) || null, error: null }),
      single: async () => ({ data: sink.upserted ? { id: "case-1" } : null, error: null }),
      upsert: (row) => { sink.upserted = row; return b; },
      then: (r) => r({ data: rows.filter((x) => b._f.every(([k, v]) => x[k] === v)), error: null }),
    };
    return b;
  },
});

const RUN = {
  id: "run-1", tenant_id: "t1", extraction_kind: "packing_list", status: "ok", status_reason: "ok",
  source_id: "doc-1", customer_id: "c1", prompt_version: { name: "po_extractor", version: "v1" },
  normalized_extract: {
    packing_list_no: "PL-9", supplier_name: "OVERSEAS SUPPLIER CO LTD", weight_uom: "kg", total_packages: 3,
    lines: [{ partNumber: "GB-1140", quantity: 40, packages: 3, weight: 78, weight_uom: "kg", weight_basis: "per_unit", volume_cbm: 0.4 }],
  },
};
const CORR = [{ tenant_id: "t1", extraction_run_id: "run-1", field_path: "lines[0].weight_basis", corrected_value: "per_package", applied_at: "2026-08-01T00:00:00Z" }];

describe("promoteCorrectedRun — the §8 guard against a golden set of easy documents", () => {
  it("snapshots the operator's answer as the golden, for a NON-PO kind", async () => {
    const sink = {};
    const out = await promoteCorrectedRun(
      makeSvc({ extraction_runs: [RUN], extraction_corrections: CORR }, sink),
      { tenantId: "t1", extractionRunId: "run-1", nowIso: "2026-08-22T00:00:00Z" },
    );
    expect(out.promoted).toBe(true);
    expect(out.kind).toBe("packing_list");
    expect(out.suite).toBe("packing-list-extraction");
    expect(out.case_id).toBe("PL-9");                       // the document's own id, so a re-correction refreshes it
    expect(out.corrected_fields).toEqual(["lines[0].weight_basis"]);
    // The golden holds the CORRECTED value, not what the model said.
    expect(sink.upserted.expected.lineItems[0].weightBasis).toBe("per_package");
    expect(sink.upserted.expected._provenance).toMatchObject({
      extraction_kind: "packing_list", harvest: "corrected_run", extraction_run_id: "run-1",
    });
    // The source document rides along so the case can be REPLAYED, not just re-scored.
    expect(sink.upserted.documents).toEqual([{ documentId: "doc-1", role: "packing_list", sha256: null }]);
  });

  it("records which fields a human actually verified", async () => {
    const sink = {};
    await promoteCorrectedRun(makeSvc({ extraction_runs: [RUN], extraction_corrections: CORR }, sink), { tenantId: "t1", extractionRunId: "run-1" });
    // Everything is scored, but the provenance says which half was checked —
    // without it, a later failure is unattributable.
    expect(sink.upserted.expected._provenance.corrected_fields).toEqual(["lines[0].weight_basis"]);
    expect(sink.upserted.expected._provenance.corrections_not_applied).toEqual([]);
  });

  it("declines rather than harvesting something that is not ground truth", async () => {
    const cases = [
      [{ ...RUN, status: "failed" }, CORR, /^status_failed$/],
      [{ ...RUN, status_reason: "dedupe_hit" }, CORR, /dedupe_hit/],
      [{ ...RUN, normalized_extract: null }, CORR, /no_normalized_extract/],
      [{ ...RUN, source_id: null }, CORR, /no_source_document/],
      [{ ...RUN, extraction_kind: "assembly_bom" }, CORR, /no_profile_for_kind/],
      [RUN, [], /no_corrections/],
    ];
    for (const [run, corr, reason] of cases) {
      const out = await promoteCorrectedRun(makeSvc({ extraction_runs: [run], extraction_corrections: corr }), { tenantId: "t1", extractionRunId: "run-1" });
      expect(out.promoted).toBe(false);
      expect(out.reason).toMatch(reason);
    }
  });

  it("rescues a run whose caller never passed a document id, via the content hash", async () => {
    // extraction_runs.content_hash and documents.sha256 are the same SHA-256
    // of the same bytes. Every quote run recorded before the QuotesStrip fix
    // has a null source_id and is reachable only this way.
    const sink = {};
    const run = { ...RUN, source_id: null, content_hash: "abc123" };
    const out = await promoteCorrectedRun(
      makeSvc({ extraction_runs: [run], extraction_corrections: CORR, documents: [{ id: "doc-9", tenant_id: "t1", sha256: "abc123" }] }, sink),
      { tenantId: "t1", extractionRunId: "run-1" },
    );
    expect(out.promoted).toBe(true);
    expect(sink.upserted.documents).toEqual([{ documentId: "doc-9", role: "packing_list", sha256: "abc123" }]);
  });

  it("still declines when neither a source id nor a matching hash exists", async () => {
    const out = await promoteCorrectedRun(
      makeSvc({ extraction_runs: [{ ...RUN, source_id: null, content_hash: "nope" }], extraction_corrections: CORR, documents: [] }),
      { tenantId: "t1", extractionRunId: "run-1" },
    );
    expect(out).toMatchObject({ promoted: false, reason: "no_source_document" });
  });

  it("needs both a tenant and a run", async () => {
    expect((await promoteCorrectedRun(makeSvc({}), { tenantId: "t1" })).reason).toBe("missing_args");
    expect((await promoteCorrectedRun(makeSvc({}), {})).reason).toBe("missing_args");
  });

  it("falls back to the run id when the document prints no identifier", () => {
    expect(caseIdFor({ packingListNo: "PL-9" }, profileFor("packing_list"), "run-1")).toBe("PL-9");
    expect(caseIdFor({}, profileFor("packing_list"), "run-1")).toBe("run-1");
    expect(caseIdFor({ packingListNo: "  " }, profileFor("packing_list"), "run-1")).toBe("run-1");
  });
});
