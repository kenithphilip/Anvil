// Regression test for the docai/claude.js extractor system prompt.
// Symptom the user hit: uploaded a PO and the intake flow ignored
// the customer block entirely; the extractor was only asked to
// return name + email + po_number + lines.
//
// Fix: expand the SYSTEM prompt to ask for the full set of fields
// the so-intake "auto-create customer" flow needs (gstin, addresses,
// currency, payment terms, state code).
//
// Test reads the source directly because we don't want to mock
// Anthropic in CI. Locks the contract that the prompt asks for
// every field the frontend matches against / pre-fills.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(
  resolve(process.cwd(), "src/api/_lib/docai/claude.js"),
  "utf8",
);

describe("claude extractor system prompt", () => {
  const requiredFields = [
    "name",
    "email",
    "phone",
    "gstin",
    "state_code",
    "currency",
    "payment_terms",
    "bill_to_address",
    "ship_to_address",
    "po_number",
    "po_date",
  ];

  for (const f of requiredFields) {
    it("asks for customer." + f, () => {
      // The prompt must mention the field name verbatim so Claude
      // knows the exact key the frontend matches against.
      expect(SRC).toMatch(new RegExp('["\']' + f + '["\']'));
    });
  }

  it("includes a GSTIN regex constraint to prevent invented values", () => {
    expect(SRC).toMatch(/15-character/);
    expect(SRC).toMatch(/\\d\{2\}\[A-Z\]\{5\}/);
  });

  it("explicitly forbids inventing values", () => {
    expect(SRC).toMatch(/Do not invent/i);
  });

  it("preserves payment terms verbatim, no re-formatting", () => {
    expect(SRC).toMatch(/payment_terms[\s\S]{0,200}verbatim/i);
  });

  it("instructs the LLM to merge multi-row-per-item table layouts (the 32-line regression)", () => {
    // The regression PO had 32 line items printed as 4-5
    // physical rows each (partNumber row 1, description row 2,
    // specification row 3, requisition row 4). Without explicit
    // guidance the model returned 0 lines because it saw an
    // unfamiliar table shape and emitted an empty lines[] array.
    // The prompt must call out this layout and tell the model to
    // group the rows into one lines[] entry per S.No.
    expect(SRC).toMatch(/MULTI-ROW-PER-ITEM|multi[- ]row[- ]per[- ]item/i);
    expect(SRC).toMatch(/S\.No|s\.no/);
    // Assert the INSTRUCTION, not any buyer's name: the prompt must be
    // entity-agnostic so it does not bias extraction toward one OEM's layout.
    expect(SRC).toMatch(/multiple physical rows/i);
    expect(SRC).toMatch(/ONE line item|SINGLE lines\[\] entry/i);
    // The model must understand that N physical S.No values => N lines[] entries.
    // Source-text assertion: the string literals are line-broken
    // across the array, so we test the discrete phrases rather than
    // a contiguous span.
    expect(SRC).toMatch(/\d+ S\.No values/i);
    expect(SRC).toMatch(/must return exactly \d+/i);
    expect(SRC).toMatch(/lines\[\] entries/i);
  });

  // The letterhead-only-buyer fix must live in BOTH LLM PO adapters: the
  // default provider order runs gemini FIRST for kind=po (claude sits last
  // and often never runs), so a fix in only one adapter is half a fix.
  const GEMINI_SRC = readFileSync(
    resolve(process.cwd(), "src/api/_lib/docai/gemini.js"),
    "utf8",
  );

  for (const [label, src] of [["claude", SRC], ["gemini", GEMINI_SRC]]) {
    it(`[${label}] handles letterhead-only buyers (OEM PO with no bill-to block)`, () => {
      // The P250432265 regression: a Hyundai Motor India PO addressed to
      // Obara prints the BUYER only on the letterhead and has NO bill-to
      // block; the sole GSTIN on the page is the seller's own. The old
      // "name MUST appear in bill_to_address" check backfired -- the model
      // nulled the customer or grabbed the 'TO:' addressee (the tenant
      // itself). The prompt must (a) scope that check to docs that HAVE a
      // bill-to block, and (b) take the letterhead company as the buyer
      // when there is no bill-to.
      expect(src).toMatch(/LETTERHEAD-ONLY BUYERS/);
      expect(src).toMatch(/when the document HAS an explicit bill-to/i);
    });

    it(`[${label}] gates the letterhead rule so it can't invert on seller-issued docs`, () => {
      // Regression guard: the rule must be conditional ("Apply ONLY when
      // the 'TO:' addressee is us/the seller"), not an unconditional
      // "letterhead = buyer" that would mis-extract a supplier's own
      // invoice/quotation, and it must defer to the distributor rule so a
      // famous OEM named as an end-customer isn't picked as the buyer.
      expect(src).toMatch(/Apply (this )?ONLY when/i);
      expect(src).toMatch(/OTHER than us/i);
      expect(src).toMatch(/NEVER overrides the distributor rule/i);
    });

    it(`[${label}] excludes the tenant's own identity (the 'TO:' addressee is the seller)`, () => {
      // With the tenant identity block present, the model must not return
      // the addressee (the tenant/seller) as the customer.
      expect(src).toMatch(/addressed to you \(the seller above\)/i);
      expect(src).toMatch(/ADDRESSEE \/ 'TO:'/);
      expect(src).toMatch(/picked the seller by mistake/i);
    });
  }
});
