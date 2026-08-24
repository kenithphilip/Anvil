// The sales order: the third side of the Mode A/B comparison.
//
// The customer's PO says what was asked for. Anvil produces what it would do.
// This document records what a person actually did. Anvil already reads the
// first and produces the second; this kind reads the third.
//
// It is read from a PDF the customer exports, not pulled through an ERP
// bridge. PR 0 found the Tally bridge has never carried a byte for any tenant,
// while every customer already exports the document — and requiring an
// integration before a customer will trust the software is a bigger ask than
// the thing being evaluated.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { KIND_PROFILES, toScorableFor } from "../api/eval/kind-profiles.js";
import { scoreCase } from "../api/eval/score.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(HERE, "..", "..", rel), "utf8");
const fixture = () => JSON.parse(read("scripts/eval/fixtures/sales-order-dual-part-columns.json"));

describe("the schema keeps the two references apart", () => {
  const src = read("src/api/_lib/docai/claude.js");

  it("names the buyer's order number as the join key, not the voucher number", () => {
    // The voucher number is the ERP's internal sequence and means nothing
    // outside it. Joining on it would match nothing, ever.
    expect(src).toMatch(/buyer_ref_order_no/);
    expect(src).toMatch(/THE MOST IMPORTANT FIELD ON THE DOCUMENT/);
    expect(src).toMatch(/Do NOT put this document's own voucher number here/);
  });

  it("tells the model what to do with a SINGLE part column", () => {
    // The dangerous case. With two columns the labels decide it; with one, a
    // guess either way is silent and inverts the mapping downstream.
    expect(src).toMatch(/it is OURS — put it in partNumber and leave customerPartNumber null/);
    expect(src).toMatch(/Never guess which is which from the format of the code itself/);
  });

  it("forbids recomputing an amount that does not add up", () => {
    // A row whose arithmetic is wrong is a FINDING. Silently correcting it
    // destroys the thing the comparison exists to surface.
    expect(src).toMatch(/do not reconcile a row that does not add up/);
  });

  it("does not let the model infer whether a total includes tax", () => {
    // The scope doc's finding: one layout's body total is ex-tax and equals
    // the PO's SUBTOTAL, while the PO's own grand total is tax-inclusive.
    // Guessing here makes every correct order look wrong.
    expect(src).toMatch(/do NOT infer it from the presence of a tax column/);
  });
});

describe("the header survives normalization", () => {
  const src = read("src/api/_lib/docai/claude.js");

  it("spreads the sales-order header, as the quote block had to", () => {
    // Selecting the prompt and tool does NOT carry the header through. On the
    // quote kind that silently broke ingestion for a year; here it would drop
    // buyer_ref_order_no and the comparison would have nothing to join on.
    expect(src).toMatch(/\.\.\.\(isSalesOrder \? \{/);
    expect(src).toMatch(/buyer_ref_order_no: out\.buyer_ref_order_no \|\| null/);
  });

  it("keeps total_is_tax_inclusive null rather than false when unstated", () => {
    // false is an assertion the document never made.
    expect(src).toMatch(/total_is_tax_inclusive: out\.total_is_tax_inclusive \?\? null/);
  });

  it("routes the kind to its own prompt and tool", () => {
    expect(src).toMatch(/const isSalesOrder = expectedKind === "sales_order"/);
    expect(src).toMatch(/activeToolName = "extract_sales_order"/);
  });
});

describe("gemini refuses it, which is the correct lockstep", () => {
  const src = read("src/api/_lib/docai/gemini.js");

  it("has no sales_order branch, so the guard refuses", () => {
    // Not an oversight. gemini implements supplier_ack, assembly_bom and
    // part_drawing; quote, invoice, packing_list and now sales_order all fall
    // to the refusal and the dispatcher moves to claude, which has the schema.
    // The drift that matters is an adapter SILENTLY using the PO schema —
    // #485's guard is what prevents that, and it covers this kind for free.
    expect(src).not.toMatch(/sales_order/);
    expect(src).toMatch(/reason: "unsupported_kind"/);
  });
});

describe("the scoring profile", () => {
  const p = KIND_PROFILES.sales_order;

  it("exists, or a fixture would pass vacuously", () => {
    expect(p).toBeTruthy();
    expect(p.kind).toBe("sales_order");
  });

  it("scores the customer's part number explicitly", () => {
    // The mapping a person performed by hand — the field most worth verifying
    // in the whole comparison.
    expect(p.line.map((f) => f.key)).toContain("customerPartNo");
  });

  it("scores the join key", () => {
    expect(p.header.map((f) => f.key)).toContain("buyerRefOrderNo");
  });

  it("drops the ERP's own sequence and clock from a live replay", () => {
    // Neither is a claim about the model's reading; scoring them would fail
    // every replay for being unable to predict another system's counter.
    expect(p.modelOwned.dropHeader).toEqual(expect.arrayContaining(["voucherNo", "voucherDate"]));
  });
});

describe("the golden fixture earns its place", () => {
  it("scores clean on a correct extract", () => {
    const fx = fixture();
    const s = scoreCase(fx.expected, toScorableFor(fx.normalized, KIND_PROFILES.sales_order), KIND_PROFILES.sales_order);
    expect(s.score).toBe(1);
    expect(s.total).toBeGreaterThan(10);
  });

  it("CATCHES the two part columns being read the wrong way round", () => {
    // The failure the schema spends four lines warning about. A fixture that
    // did not detect it would let the mapping invert with every test green.
    const fx = fixture();
    const swapped = JSON.parse(JSON.stringify(fx.normalized));
    for (const l of swapped.lines) {
      const t = l.partNumber; l.partNumber = l.customerPartNumber; l.customerPartNumber = t;
    }
    const s = scoreCase(fx.expected, toScorableFor(swapped, KIND_PROFILES.sales_order), KIND_PROFILES.sales_order);
    expect(s.score).toBeLessThan(1);
    expect(s.checks.filter((c) => !c.ok).map((c) => c.name)).toContain("line[0].customerPartNo");
  });

  it("CATCHES the voucher number being used as the buyer reference", () => {
    const fx = fixture();
    const wrong = { ...fx.normalized, buyer_ref_order_no: fx.normalized.voucher_no };
    const s = scoreCase(fx.expected, toScorableFor(wrong, KIND_PROFILES.sales_order), KIND_PROFILES.sales_order);
    expect(s.checks.find((c) => c.name === "buyerRefOrderNo")?.ok).toBe(false);
  });

  it("carries no real customer identity", () => {
    // Synthetic values, real layout. Fixtures are committed.
    const raw = read("scripts/eval/fixtures/sales-order-dual-part-columns.json").toUpperCase();
    for (const needle of ["OBARA", "MAHINDRA", "HYUNDAI", "KIA", "FAITH AUTOMATION"]) {
      expect(raw).not.toContain(needle);
    }
  });
});

describe("the kind is permitted everywhere it has to be", () => {
  it("is in migration 220's extraction_runs CHECK", () => {
    expect(read("supabase/migrations/220_sales_order_kind.sql")).toMatch(/'sales_order'/);
  });

  it("is permitted on extraction_jobs too", () => {
    // A kind allowed on a run but refused at enqueue fails with a confusing
    // error on exactly the long documents that need backgrounding.
    const m = read("supabase/migrations/220_sales_order_kind.sql");
    expect(m).toMatch(/extraction_jobs_extraction_kind_check/);
  });

  it("is in the enqueue's allow-list", () => {
    expect(read("src/api/orders/extraction_jobs.js")).toMatch(/"sales_order",/);
  });
});
