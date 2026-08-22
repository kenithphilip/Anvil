// invoice and eway_bill were admitted kinds with no extraction schema.
//
// The DB CHECK admitted ten kinds; claude.js branched on five. There was no
// else, so an unbranched kind silently kept the PURCHASE-ORDER tool and
// prompt. Two shipped endpoints did exactly that:
//
//   invoices/extract.js:137   kind: "invoice"
//   eway_bills/extract.js:87  kind: "eway_bill"
//
// The invoice path half-worked only because an invoice is structurally
// PO-shaped — and the consumer read the vendor's invoice number out of a
// field called `customer.po_number`. The e-way bill path had no slot for a
// vehicle number, a transporter or a distance: everything the document exists
// to carry.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (p) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const src = read("src/api/_lib/docai/claude.js");

describe("the invoice schema", () => {
  const tool = src.slice(src.indexOf("INVOICE_TOOL"), src.indexOf("EWAY_BILL_TOOL"));

  it("keeps the invoice's own number apart from any PO it cites", () => {
    // These are two different documents. Conflating them is what the old
    // customer.po_number hack did.
    expect(tool).toMatch(/invoice_number:/);
    expect(tool).toMatch(/po_reference:/);
    expect(tool).toMatch(/never return the same value for both/i);
  });

  it("carries what a PO has no slot for", () => {
    for (const f of ["due_date:", "payment_terms:", "supplier_gstin:", "grand_total:"]) {
      expect(tool).toContain(f);
    }
  });

  it("tells the model a PO and an invoice are opposite documents", () => {
    // The sentence spans two array elements in the prompt, so match the half
    // that carries the distinction.
    expect(src).toMatch(/A PO and an invoice look alike and are opposite/);
    expect(src).toMatch(/the seller and demands payment/);
  });
});

describe("the e-way bill schema", () => {
  const tool = src.slice(src.indexOf("EWAY_BILL_TOOL"), src.indexOf("PACKING_LIST_TOOL"));

  it("carries the transport block, which is the point of the document", () => {
    for (const f of ["vehicle_no:", "transporter_id:", "trans_mode:", "trans_distance:", "ewb_valid_upto:"]) {
      expect(tool).toContain(f);
    }
  });

  it("uses field names that match the eway_bills table", () => {
    // migration 074's columns, so the result lands without a translation
    // layer that could drift.
    const mig = read("supabase/migrations/074_eway_bills.sql");
    for (const f of ["ewb_no", "doc_type", "from_gstin", "to_pincode", "transporter_name", "taxable_value"]) {
      expect(tool).toContain(f);
      expect(mig).toContain(f);
    }
  });

  it("constrains the mode to what the form allows", () => {
    expect(tool).toMatch(/enum: \["Road", "Rail", "Air", "Ship", null\]/);
  });
});

describe("the fallthrough guard — the systemic fix", () => {
  it("refuses an unhandled kind instead of running the PO schema", () => {
    // run.js's non_po and empty-lines gates are keyed to specific kinds, so an
    // unhandled kind on the PO schema records status "ok" with an empty
    // payload — a silent green failure, the worst outcome available.
    expect(src).toMatch(/reason: "unsupported_kind"/);
    expect(src).toMatch(/rather than letting it fall through to the purchase-order schema/);
  });

  it("still lets po, rfq and generic use the PO schema legitimately", () => {
    expect(src).toMatch(/expectedKind !== "po" && expectedKind !== "rfq" && expectedKind !== "generic"/);
  });

  it("every DB-admitted kind now has a branch or is intentionally PO-shaped", () => {
    const mig = read("supabase/migrations/217_packing_list_kind.sql");
    // Only the CHECK list — scraping the whole file also catches
    // 'extraction_runs'::regclass and the constraint's own name.
    const list = mig.slice(mig.indexOf("check (extraction_kind in ("), mig.lastIndexOf("));"));
    const admitted = [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    const branched = [...src.matchAll(/const is[A-Za-z]+ = expectedKind === "([a-z_]+)"/g)].map((m) => m[1]);
    const poShaped = ["po", "rfq", "generic"];
    const orphans = [...new Set(admitted)].filter((k) => !branched.includes(k) && !poShaped.includes(k));
    // If this fails, a kind was admitted to the DB without a schema — exactly
    // how invoice and eway_bill happened.
    expect(orphans).toEqual([]);
  });

  it("is registered so the capable adapter runs first", () => {
    const idx = read("src/api/_lib/docai/index.js");
    expect(idx).toMatch(/invoice: \["claude"\]/);
    expect(idx).toMatch(/eway_bill: \["claude"\]/);
  });
});

describe("the invoice consumer reads the real fields", () => {
  const ex = read("src/api/invoices/extract.js");

  it("prefers the invoice's own number", () => {
    expect(ex).toMatch(/n\.invoice_number/);
  });

  it("keeps the old path as a fallback for runs stored before the fix", () => {
    // Without it, re-reading an old extraction would fall through to a
    // synthetic EXT- number.
    expect(ex).toMatch(/n\.customer\?\.po_number/);
  });

  it("prefers the STATED totals over a sum of the lines", () => {
    // Summing was the only option under the PO schema and silently disagrees
    // with the document whenever a charge is not a line — freight, rounding,
    // a discount.
    expect(ex).toMatch(/num\(n\.subtotal\) \?\? summed\.subtotal/);
    expect(ex).toMatch(/num\(n\.grand_total\) \?\? summed\.grand_total/);
  });
});
