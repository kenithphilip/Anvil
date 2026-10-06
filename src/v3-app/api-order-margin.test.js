// The approvals queue showed a margin column that was blank on every row.
//
// Two derivations existed and only one worked. _lib/approval-evaluator.js
// computed margin correctly — selling from result.salesOrder.lineItems, landed
// cost from result.priceComposition.lineItems — used it to decide whether the
// order needed approval, then discarded it. admin/quote_approvals.js, which
// renders the QUEUE, read `so.marginPct ?? so.margin_pct` instead, with a
// comment claiming the field name "drifts between camel and snake across older
// orders". It does not drift. Nothing writes either spelling.
//
// So the approver's one number for commercial impact was always "—", while the
// working calculation sat in the file that creates the row being displayed.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { orderMargin, orderMarginPct } from "../api/_lib/order-margin.js";

const read = (p) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
// Comments removed: an assertion that a call is GONE otherwise matches the
// comment explaining why it was removed. That has bitten this repo before.
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const order = (lineItems, compLineItems) => ({
  result: { salesOrder: { lineItems }, priceComposition: { lineItems: compLineItems } },
});

describe("the calculation", () => {
  it("computes margin from selling against landed cost", () => {
    const m = orderMargin(order(
      [{ sellerPartNo: "A", qty: 10, rate: 100 }],
      [{ partNumber: "A", landedCostINR: 70 }],
    ));
    expect(m.selling).toBe(1000);
    expect(m.landed).toBe(700);
    expect(m.marginPct).toBeCloseTo(30, 6);
  });

  it("returns null — not zero — when the order was never costed", () => {
    // 0% reads as a disaster; "unknown" is a different fact and the caller
    // has to be able to say which.
    expect(orderMargin(order([{ sellerPartNo: "A", qty: 1, rate: 100 }], []))).toBeNull();
    expect(orderMarginPct(order([], []))).toBeNull();
  });

  it("reports a NEGATIVE margin rather than clamping it", () => {
    // An order below cost is the single most important row in the queue.
    const m = orderMargin(order(
      [{ sellerPartNo: "A", qty: 1, rate: 100 }],
      [{ partNumber: "A", landedCostINR: 130 }],
    ));
    expect(m.marginPct).toBeCloseTo(-30, 6);
  });

  it("says when only PART of the order is costed", () => {
    // Margin over 1 of 2 lines is not the order's margin, and presenting it
    // as complete overstates what is known.
    const m = orderMargin(order(
      [{ sellerPartNo: "A", qty: 1, rate: 100 }, { sellerPartNo: "B", qty: 1, rate: 100 }],
      [{ partNumber: "A", landedCostINR: 50 }],
    ));
    expect(m.partial).toBe(true);
    expect(m.linesMatched).toBe(1);
    expect(m.linesTotal).toBe(2);
  });

  it("is not partial when every line is costed", () => {
    const m = orderMargin(order(
      [{ sellerPartNo: "A", qty: 1, rate: 100 }],
      [{ partNumber: "A", landedCostINR: 50 }],
    ));
    expect(m.partial).toBe(false);
  });

  it("matches part codes case-insensitively across the alias spellings", () => {
    const m = orderMargin(order(
      [{ itemName: "a-1", qty: 2, rate: 50 }],
      [{ partNo: "A-1", unitInr: 20 }],
    ));
    expect(m.linesMatched).toBe(1);
    expect(m.marginPct).toBeCloseTo(60, 6);
  });

  it("survives a malformed order without throwing", () => {
    for (const o of [null, {}, { result: {} }, { result: { salesOrder: {} } }]) {
      expect(() => orderMargin(o)).not.toThrow();
      expect(orderMargin(o)).toBeNull();
    }
  });
});

describe("both consumers use the same one", () => {
  it("the evaluator delegates rather than keeping its own copy", () => {
    const src = read("src/api/_lib/approval-evaluator.js");
    expect(src).toMatch(/import \{ orderMarginPct \} from "\.\/order-margin\.js"/);
    expect(src).toMatch(/const computeMarginPct = orderMarginPct/);
  });

  it("the queue no longer reads the field nothing writes", () => {
    const src = code("src/api/admin/quote_approvals.js");
    expect(src).toMatch(/import \{ orderMargin \} from "\.\.\/_lib\/order-margin\.js"/);
    expect(src).not.toMatch(/so\.marginPct \?\? so\.margin_pct/);
  });

  it("nothing anywhere still writes salesOrder.marginPct — so nothing may read it", () => {
    // If a producer ever appears, this test should fail and the decision
    // re-made deliberately rather than by two halves drifting again.
    const api = code("src/api/admin/quote_approvals.js") + code("src/api/_lib/approval-evaluator.js");
    expect(api).not.toMatch(/salesOrder\.marginPct/);
  });
});

describe("the queue can tell the three states apart", () => {
  const api = code("src/api/admin/quote_approvals.js");
  const ui = code("src/v3-app/screens/approvals.tsx");

  it("the endpoint reports which state each row is in", () => {
    expect(api).toMatch(/margin_state: m \? \(m\.partial \? "partial" : "computed"\) : "not_costed"/);
  });

  it("the screen shows 'not costed' rather than a dash", () => {
    // A dash meant both "thin" and "never costed", in the same colour as a
    // healthy margin.
    expect(ui).toMatch(/not costed/);
    expect(ui).toMatch(/a\.margin_state === "not_costed"/);
  });

  it("the screen flags a partially-costed margin with its coverage", () => {
    expect(ui).toMatch(/a\.margin_state === "partial"/);
    expect(ui).toMatch(/margin_lines_matched/);
  });

  it("does not zero a negative margin", () => {
    // `Number(x) || 0` painted an order below cost as unremarkable.
    expect(ui).not.toMatch(/Number\(a\.margin_pct\) \|\| 0/);
    expect(ui).toMatch(/Number\.isFinite\(Number\(a\.margin_pct\)\)/);
  });

  it("the reason chip can now say why, worst first", () => {
    expect(ui).toMatch(/return "below cost"/);
    expect(ui).toMatch(/return "margin breach"/);
    expect(ui).toMatch(/return "not costed"/);
  });
});
