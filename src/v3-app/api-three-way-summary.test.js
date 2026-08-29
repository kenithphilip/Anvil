// The running score across orders — the number the Mode A/B decision turns on.
//
// The per-order panel answers "did this one go right". This answers "across
// our own orders, how often is Anvil wrong, and how often is the process we
// have today already wrong". A customer deciding whether to hand over
// sales-order processing needs the second question.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { summariseReports, confidence, MIN_DECIDABLE_FOR_CONFIDENCE } from "../api/_lib/three-way-summary.js";
import { VERDICT } from "../api/_lib/three-way-adjudicate.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(HERE, "..", "..", rel), "utf8");

const f = (key, verdict) => ({ key, verdict, decidable: true });
const order = (id, fields, extra = {}) => ({
  order_id: id, po_number: "PO-" + id,
  report: { header: fields, lines: [], both_deviated: [], missing_from_erp: 0, erp_only: [], ...extra },
});

describe("pooling, not averaging", () => {
  it("counts every decidable field once, wherever it came from", () => {
    // THE correctness of the whole thing. Averaging per-order rates weights a
    // two-field order exactly as heavily as a forty-field one.
    const tiny = order("a", [f("qty", VERDICT.ANVIL_WRONG)]);                 // 1 field, 100% wrong
    const big = order("b", Array.from({ length: 9 }, (_, i) => f("q" + i, VERDICT.AGREE))); // 9 fields, 0%
    const s = summariseReports([tiny, big]);
    expect(s.score.decidable).toBe(10);
    // Pooled: 1 of 10. An average of the two order rates would be 50%.
    expect(s.score.anvil_error_rate).toBeCloseTo(0.1, 4);
  });

  it("keeps per-order rows so a bad aggregate can be traced", () => {
    // A rate with nothing behind it is a number somebody has to take on trust.
    const s = summariseReports([order("a", [f("qty", VERDICT.ANVIL_WRONG)])]);
    expect(s.orders[0]).toMatchObject({ order_id: "a", anvil_error_rate: 1 });
  });

  it("counts both_deviate against BOTH rates", () => {
    const s = summariseReports([order("a", [f("qty", VERDICT.BOTH_DEVIATE)])]);
    expect(s.score.anvil_error_rate).toBe(1);
    expect(s.score.process_deviation_rate).toBe(1);
  });

  it("excludes undecidable from the denominator", () => {
    const s = summariseReports([order("a", [f("q", VERDICT.AGREE), f("r", VERDICT.UNDECIDABLE)])]);
    expect(s.score.decidable).toBe(1);
  });

  it("survives empty input", () => {
    expect(summariseReports([]).orders_compared).toBe(0);
    expect(summariseReports(null).score.anvil_error_rate).toBeNull();
  });
});

describe("which field goes wrong, not just how often", () => {
  it("ranks fields worst first", () => {
    // "Anvil is wrong 4% of the time" is a number; "the quantity is what goes
    // wrong" is somewhere to start.
    const s = summariseReports([
      order("a", [f("qty", VERDICT.ANVIL_WRONG), f("rate", VERDICT.AGREE)]),
      order("b", [f("qty", VERDICT.ANVIL_WRONG), f("rate", VERDICT.AGREE)]),
    ]);
    expect(s.by_field[0].field).toBe("qty");
    expect(s.by_field[0].anvil_wrong).toBe(2);
  });

  it("does not count undecidable fields as a disagreement", () => {
    const s = summariseReports([order("a", [f("terms", VERDICT.UNDECIDABLE)])]);
    expect(s.by_field).toEqual([]);
  });
});

describe("a thin score is not a verdict", () => {
  it("refuses confidence on a small sample", () => {
    // A rate over four fields is arithmetic, not evidence, and putting it
    // beside a mode selector invites somebody to act on it.
    const s = summariseReports([order("a", [f("qty", VERDICT.AGREE)])]);
    const c = confidence(s);
    expect(c.sufficient).toBe(false);
    expect(c.reason).toBe("small_sample");
    expect(c.needed).toBe(MIN_DECIDABLE_FOR_CONFIDENCE);
  });

  it("measures the floor in FIELDS, not orders", () => {
    // Ten one-line orders carry less than one order of forty.
    const many = Array.from({ length: MIN_DECIDABLE_FOR_CONFIDENCE }, (_, i) => f("q" + i, VERDICT.AGREE));
    expect(confidence(summariseReports([order("a", many)])).sufficient).toBe(true);
  });

  it("says 'nothing decidable' rather than 'small sample' when there is nothing", () => {
    expect(confidence(summariseReports([])).reason).toBe("nothing_decidable");
  });
});

describe("the endpoint", () => {
  const src = read("src/api/orders/three_way_summary.js");

  it("bulk-fetches rather than looping per order", () => {
    // A round trip per order would make this the slowest screen in the app,
    // and would scale with the very thing it measures.
    expect(src).toMatch(/\.in\("source_id", docIds/);
    expect(src).toMatch(/\.in\("customer_id", customerIds/);
    expect(src).not.toMatch(/for \(const o of orders\)[\s\S]{0,200}await svc\.from/);
  });

  it("counts orders it could NOT compare rather than dropping them", () => {
    // An order silently missing from a denominator is how a score flatters
    // itself.
    expect(src).toMatch(/skipped\.push\(/);
    expect(src).toMatch(/sales_order_not_extracted/);
  });

  it("is bounded", () => {
    expect(src).toMatch(/const MAX_ORDERS = 100/);
    expect(src).toMatch(/Math\.min\(MAX_ORDERS/);
  });

  it("skips dedupe_hit and other non-usable extract runs", () => {
    // dedupe_hit (a content-hash re-mint) plus the failure statuses that still
    // write an empty normalized_extract, so a newer failed re-run cannot shadow
    // an older good read.
    expect(src).toMatch(/UNUSABLE_EXTRACT_STATUS/);
    expect(src).toMatch(/"dedupe_hit"/);
    expect(src).toMatch(/"empty_lines"/);
  });

  it("reads only ACTIVE dual-code mappings", () => {
    expect(src).toMatch(/\.is\("valid_to", null\)/);
  });

  it("distinguishes 'nothing attached' from 'compared, no differences'", () => {
    expect(src).toMatch(/no_sales_orders_attached/);
  });
});

describe("the mode card carries the score", () => {
  const src = read("src/v3-app/components/SoProcessingModeEditor.tsx");

  it("shows both rates where the decision is made", () => {
    expect(src).toMatch(/Anvil differs from the PO/);
    expect(src).toMatch(/Your process differs from the PO/);
  });

  it("warns when the sample is too thin to act on", () => {
    expect(src).toMatch(/Not enough compared yet to decide on/);
  });

  it("prints an em-dash, not 0%, for a null rate", () => {
    expect(src).toMatch(/v === null \|\| v === undefined \? "—"/);
  });

  it("does not let a failed summary block the mode itself", () => {
    // Somebody must still be able to read, and change, their mode.
    expect(src).toMatch(/\.catch\(\(\) => setSummary\(null\)\)/);
  });

  it("names the orders excluded from the figures", () => {
    expect(src).toMatch(/excluded from the figures above/);
  });
});
