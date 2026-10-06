// The PO, Anvil and the ERP put side by side.
//
// The first caller adjudicateField has ever had outside its own test. The
// adjudicator settled WHO WAS RIGHT for one field; this decides which fields
// to ask about and which three values to ask with.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildThreeWayReport, alignLines } from "../api/_lib/three-way-report.js";
import { VERDICT } from "../api/_lib/three-way-adjudicate.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(HERE, "..", "..", rel), "utf8");

const anvilLine = (o = {}) => ({
  customer_part_number: "AB-L1-70B-2", part_no: "3-000000-0-I",
  qty: 1, discounted_unit_price: 9790,
  _match: { po_qty: 1, po_rate: 9790, verdict: "matched" }, ...o,
});
const erpLine = (o = {}) => ({
  customerPartNumber: "AB-L1-70B-2", partNumber: "3-000000-0-I",
  quantity: 1, rate: 9790, ...o,
});
const MAP = new Map([["AB-L1-70B-2", "3-000000-0-I"]]);

describe("alignment", () => {
  it("aligns on the CUSTOMER's code, not ours", () => {
    // Ours is the field the comparison exists to check. Aligning on it would
    // make the two documents agree by construction, and the mapping a person
    // performed by hand would never be examined.
    const { pairs } = alignLines(
      [anvilLine({ part_no: "OURS-DIFFERENT" })],
      [erpLine()],
    );
    expect(pairs[0].erp).toBeTruthy();
    expect(pairs[0].aligned_on).toBe("customer_part_number");
  });

  it("falls back to our code only when there is no customer code", () => {
    const { pairs } = alignLines(
      [anvilLine({ customer_part_number: null })],
      [erpLine({ customerPartNumber: null })],
    );
    expect(pairs[0].aligned_on).toBe("part_no");
  });

  it("reports a line the ERP has and Anvil does not", () => {
    // Somebody added it by hand. One of the more interesting things this can
    // find, and invisible from Anvil's side alone.
    const { erpOnly } = alignLines([], [erpLine()]);
    expect(erpOnly).toHaveLength(1);
  });

  it("does not reuse one ERP line for two Anvil lines", () => {
    const { pairs } = alignLines([anvilLine(), anvilLine()], [erpLine()]);
    expect(pairs.filter((p) => p.erp).length).toBeGreaterThan(0);
    expect(pairs).toHaveLength(2);
  });
});

describe("the worked example from the real pair", () => {
  // PO says payment after 60 days; the ERP recorded 30. Anvil read it right.
  const r = buildThreeWayReport({
    anvilLines: [anvilLine()],
    erpLines: [erpLine()],
    poTerms: "AFTER 60 DAYS ON RECEIPT OF GOODS",
    anvilTerms: "Net 60",
    erpTerms: "30 Days",
    customerPartMap: MAP,
  });

  it("blames the process, not Anvil", () => {
    expect(r.header[0].verdict).toBe(VERDICT.ANVIL_CORRECT);
    expect(r.score.anvil_error_rate).toBe(0);
    expect(r.score.process_deviation_rate).toBeGreaterThan(0);
  });

  it("folds '60 days after receipt' and 'Net 60' onto one value", () => {
    expect(r.header[0].truth).toBe("60");
    expect(r.header[0].anvil).toBe("60");
  });

  it("adjudicates our part number against item_master, not the PO", () => {
    // The PO carries the buyer's code and never states ours. Judged against
    // the PO this would be permanently undecidable — and it is the single most
    // valuable field in the comparison.
    const f = r.lines[0].fields.find((x) => x.key === "ourPartNo");
    expect(f.authority).toBe("item_master");
    expect(f.verdict).toBe(VERDICT.AGREE);
  });
});

describe("rate is not scored when Anvil differs from the PO on purpose", () => {
  it("skips a line the reconciler already flagged as a price mismatch", () => {
    // Anvil prices from the agreed QUOTE. On a line where the PO disagrees
    // with the quote, Anvil differs deliberately and the reconciler has said
    // so — adjudicating it here would report the same disagreement a second
    // time, as an Anvil error.
    const r = buildThreeWayReport({
      anvilLines: [anvilLine({ discounted_unit_price: 9000, _match: { po_qty: 1, po_rate: 9790, verdict: "price_mismatch" } })],
      erpLines: [erpLine()],
      customerPartMap: MAP,
    });
    const rate = r.lines[0].fields.find((f) => f.key === "rate");
    expect(rate.verdict).toBe(VERDICT.NOT_APPLICABLE);
    expect(rate.note).toMatch(/already reports this line as a price mismatch/);
  });

  it("DOES score rate on an ordinary line", () => {
    const r = buildThreeWayReport({
      anvilLines: [anvilLine()],
      erpLines: [erpLine({ rate: 8000 })],
      customerPartMap: MAP,
    });
    const rate = r.lines[0].fields.find((f) => f.key === "rate");
    expect(rate.verdict).toBe(VERDICT.ANVIL_CORRECT);
  });
});

describe("the findings a two-way comparison cannot make", () => {
  it("surfaces both_deviated separately", () => {
    // Anvil and the ERP agreeing with each other and NOT with the PO. A
    // two-way test scores this 100%.
    const r = buildThreeWayReport({
      anvilLines: [anvilLine({ qty: 5, _match: { po_qty: 2, po_rate: 9790, verdict: "matched" } })],
      erpLines: [erpLine({ quantity: 5 })],
      customerPartMap: MAP,
    });
    expect(r.both_deviated).toContain("qty");
  });

  it("counts a line the ERP never recorded", () => {
    // A line the customer ordered that nobody entered — the most consequential
    // single finding this produces.
    const r = buildThreeWayReport({ anvilLines: [anvilLine()], erpLines: [], customerPartMap: MAP });
    expect(r.missing_from_erp).toBe(1);
    expect(r.lines[0].fields).toEqual([]);
  });
});

describe("nothing resolves in anybody's favour by accident", () => {
  it("leaves our part number undecidable with no map", () => {
    const r = buildThreeWayReport({ anvilLines: [anvilLine()], erpLines: [erpLine()] });
    const f = r.lines[0].fields.find((x) => x.key === "ourPartNo");
    expect(f.verdict).toBe(VERDICT.UNDECIDABLE);
    expect(f.decidable).toBe(false);
  });

  it("leaves payment terms undecidable when the PO is silent", () => {
    const r = buildThreeWayReport({ anvilLines: [], erpLines: [], erpTerms: "30 Days" });
    expect(r.header[0].verdict).toBe(VERDICT.UNDECIDABLE);
  });

  it("reports null rates, not zero, when nothing was decidable", () => {
    const r = buildThreeWayReport({ anvilLines: [], erpLines: [] });
    expect(r.score.anvil_error_rate).toBeNull();
  });

  it("survives empty input", () => {
    expect(() => buildThreeWayReport({})).not.toThrow();
    expect(buildThreeWayReport({}).lines).toEqual([]);
  });
});

describe("the route", () => {
  const src = read("src/api/orders/three_way_report.js");

  it("distinguishes 'nothing attached' from 'compared, no differences'", () => {
    // Identical in any summary that reports only a score, and they call for
    // opposite responses.
    expect(src).toMatch(/no_sales_order_attached/);
    expect(src).toMatch(/sales_order_not_extracted/);
    expect(src).toMatch(/available: false/);
  });

  it("skips a dedupe_hit run", () => {
    // A content-hash match mints a fresh run with a new finished_at, so it
    // sorts first while carrying a copy of an older read.
    expect(src).toMatch(/status_reason !== "dedupe_hit"/);
  });

  it("takes the newest sales order — a re-issue supersedes", () => {
    expect(src).toMatch(/order\("finished_at", \{ ascending: false/);
  });

  it("reads only the ACTIVE dual-code mappings", () => {
    // Superseded mappings stay in the table; reading one would judge today's
    // line against a part the code used to mean.
    expect(src).toMatch(/\.is\("valid_to", null\)/);
  });

  it("stores no verdict", () => {
    // Three documents can each change; storing a verdict means deciding when
    // to invalidate it against all three.
    expect(src).not.toMatch(/\.insert\(|\.upsert\(/);
  });
});
