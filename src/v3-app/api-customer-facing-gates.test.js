// Two customer-facing surfaces that showed work nobody had signed off.
//
// Neither was a breach — both serve a customer their own data. Both were
// nonetheless wrong, and in the same way: an extraction Anvil has not reviewed
// carries prices and quantities a model read off a PDF, and the whole point of
// the approval gate is that nobody acts on those until a human has. Handing
// them to the customer routes around the gate from the far side.
//
//   portal/view.js  — `kind=quotes` queried `orders` with NO status filter
//                     while `kind=orders`, the same table, filtered to
//                     APPROVED+. One access rule, written twice, once.
//   orders/so_pdf.js — minted a SEVEN-DAY signed URL for the customer-facing
//                     acknowledgment on an order carrying the same unresolved
//                     blocking findings that stop approve, Tally and the ERP
//                     runner.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(HERE, "..", "..", rel), "utf8");

describe("the portal serves one access rule, not two", () => {
  const src = read("src/api/portal/view.js");

  it("names the customer-visible statuses once", () => {
    expect(src).toMatch(/const CUSTOMER_VISIBLE_ORDER_STATUSES = \[/);
  });

  it("no branch carries its own inline copy of the list", () => {
    // The drift that caused this: `orders` had the list inline and `quotes`
    // had nothing. A second literal is how it comes back.
    const inline = src.match(/\.in\("status", \["APPROVED"/g) || [];
    expect(inline).toHaveLength(0);
  });

  it("applies it to every branch that reads orders", () => {
    // quotes, orders, and both summary counts.
    const uses = src.match(/CUSTOMER_VISIBLE_ORDER_STATUSES/g) || [];
    expect(uses.length).toBeGreaterThanOrEqual(5);   // 1 declaration + 4 uses
  });

  it("keeps DRAFT and the internal states out of the list", () => {
    const list = src.slice(
      src.indexOf("const CUSTOMER_VISIBLE_ORDER_STATUSES"),
      src.indexOf("];", src.indexOf("const CUSTOMER_VISIBLE_ORDER_STATUSES")),
    );
    for (const internal of ["DRAFT", "PENDING_REVIEW", "BLOCKED", "DUPLICATE", "FAILED_TALLY_IMPORT", "CANCELLED"]) {
      expect(list, internal + " is an internal working state and must not be customer-visible").not.toContain(internal);
    }
    expect(list).toContain("APPROVED");
  });
});

describe("the shareable acknowledgment respects the blocker gate", () => {
  const src = read("src/api/orders/so_pdf.js");

  it("refuses to SHARE an order with an unresolved blocker", () => {
    expect(src).toMatch(/format === "share" && hasUnresolvedBlocker\(order\.rule_findings\)/);
    expect(src).toMatch(/ORDER_HAS_UNRESOLVED_BLOCKER/);
  });

  it("still renders the PDF at any status", () => {
    // Deliberate: this is the acknowledgment a seller returns on RECEIVING a
    // PO, not the post-tax voucher. You acknowledge before you approve, so a
    // status gate on the PDF itself would break what it is for. Only the
    // outward-facing share link is gated.
    expect(src).not.toMatch(/status !== "APPROVED"/);
    expect(src).not.toMatch(/\.in\("status"/);
  });

  it("actually selects rule_findings, or the guard reads undefined", () => {
    // The column was absent from the select, which is why nothing could have
    // been gated on it before.
    expect(src).toMatch(/\.select\("id, status, rule_findings,/);
  });

  it("reuses the shared predicate rather than re-deciding what blocks", () => {
    // Same helper as the approve gate, the Tally push and the ERP runner. A
    // second definition of "blocking" is how one surface starts disagreeing.
    expect(src).toMatch(/from "\.\.\/_lib\/blocking-findings\.js"/);
  });

  it("tells the operator what to do instead", () => {
    expect(src).toMatch(/download the PDF for internal review/);
  });
});
