// #467 built the invoice-vs-PO check and shipped it with no caller.
//
// It has been correct and unreachable since — which is why "nothing yet checks
// invoices against POs in practice" sat in the backlog underneath a merged PR.
//
// The commercial point: a large buyer books an incoming invoice against the PO
// it was raised for. Where they disagree no goods receipt is raised, and no
// receipt means no payment. The invoice is not rejected — it just sits, and
// nobody tells you.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(HERE, rel), "utf8");
const src = read("components/InvoicePoCheck.tsx");
const ws = read("screens/so-workspace.tsx");

describe("it is reachable at last", () => {
  it("has a tab on the SO workspace", () => {
    expect(ws).toMatch(/id: "invoice_check", label: "Invoice vs PO"/);
    expect(ws).toMatch(/tab === "invoice_check" && <InvoicePoCheck orderId=\{o\.id\} \/>/);
  });

  it("calls the endpoint #467 built", () => {
    expect(src).toMatch(/orders\?\.reconcileInvoice\?\./);
  });

  it("sits beside the PO-vs-ERP check, which answers to the same document", () => {
    const three = ws.indexOf('id: "threeway"');
    const inv = ws.indexOf('id: "invoice_check"');
    expect(inv).toBeGreaterThan(three);
    expect(inv - three).toBeLessThan(400);
  });
});

describe("it says what a disagreement COSTS, not just that there is one", () => {
  it("leads with the consequence rather than a count", () => {
    // "3 blocking lines" is a number. "A buyer cannot receive this" is why
    // somebody should stop and look.
    // The template interpolates the pluraliser between the words, so match
    // the literal tail rather than a phrase that never appears contiguously.
    expect(src).toMatch(/a buyer cannot receive/);
    expect(src).toMatch(/no receipt means no payment/);
  });

  it("explains each verdict in an AP clerk's terms", () => {
    // The API vocabulary is precise and conveys nothing. "price_mismatch" does
    // not tell you the invoice will sit unpaid.
    for (const v of ["matched", "description_mismatch", "price_mismatch", "qty_over_ordered", "not_on_po"]) {
      expect(src).toMatch(new RegExp(`\\b${v}:`));
    }
    expect(src).toMatch(/hold this for a price query/);
    expect(src).toMatch(/nothing to receive it against/);
  });

  it("distinguishes a wording difference from a payment blocker", () => {
    // description_mismatch is not blocking in the reconciler, and saying so
    // stops it being treated as one.
    expect(src).toMatch(/Not usually a payment blocker/);
  });

  it("counts what earlier invoices already billed when reporting an over-bill", () => {
    expect(src).toMatch(/counting \$\{n\(l\.previously_billed_qty\)\} already billed/);
  });
});

describe("what it does not claim", () => {
  it("says plainly it is a check and not a gate", () => {
    // Refusing to send is PR3, and PR3 is gated on three decisions the owner
    // has not made. Implying a gate by the absence of a button would be worse
    // than saying so.
    expect(src).toMatch(/This is a check, not a gate/);
  });

  it("reports ordered-but-not-invoiced as normal, not as a discrepancy", () => {
    // The ordinary state of a partial invoice. The reconciler already keeps it
    // out of the blocking count; the screen must not put it back.
    expect(src).toMatch(/Normal on a partial invoice/);
  });

  it("shows PO ambiguity rather than picking a line", () => {
    // A part listed twice on the PO means "which line did you mean" has no
    // answer.
    expect(src).toMatch(/ambiguous on the PO/);
  });

  it("flags a missing buyer PO reference, which no line check would catch", () => {
    // Migration 214 put it on the invoice. Without it the buyer has nothing to
    // book against, whatever the lines say.
    expect(src).toMatch(/does not carry the buyer's PO number/);
  });
});

describe("table manners", () => {
  it("scrolls inside itself", () => {
    expect(src).toMatch(/overflowX: "auto"/);
  });

  it("lines the figures up", () => {
    expect(src).toMatch(/fontVariantNumeric: "tabular-nums"/);
  });

  it("does not render an empty table when everything agrees", () => {
    expect(src).toMatch(/problems\.length > 0 && \(/);
    expect(src).toMatch(/Nothing here should stop this being received/);
  });
});
