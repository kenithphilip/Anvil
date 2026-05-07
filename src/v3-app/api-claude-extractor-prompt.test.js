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
});
