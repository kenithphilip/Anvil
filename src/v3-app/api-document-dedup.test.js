// The same file, uploaded twice, is one document — and an earlier copy of a
// document that DID ingest is not a failure.
//
// Observed on a live order: one quotation PDF, two documents rows (same
// filename, same 289,766 bytes), one showing "read · 2 lines" and the other
// "not read". Nothing had failed. quotes.source_document_id is single-valued,
// so only the most recent upload associates with the quote the earlier one had
// already produced — and after the hollow-quote fix, "not read" reads as
// "extraction failed", which is the opposite of what happened.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (p) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("upload returns the document it already holds", () => {
  const src = strip(read("src/api/documents/upload.js"));

  it("looks for an existing row by (tenant, sha256)", () => {
    expect(src).toMatch(/eq\("tenant_id", ctx\.tenantId\)\.eq\("sha256", sha256\)/);
  });

  it("only dedupes on a well-formed hash", () => {
    // A caller passing junk must not match, and must not throw.
    expect(src).toMatch(/\^\[a-f0-9\]\{64\}\$/);
  });

  it("does nothing when the caller supplies no hash", () => {
    // Bulk import and inbound email attachments send none; they must behave
    // exactly as before rather than dedupe against a hash nobody computed.
    expect(src).toMatch(/if \(sha256\) \{/);
  });

  it("requires the existing row's bytes to have reached storage", () => {
    // Handing back a document whose upload never completed would return an id
    // that cannot be read.
    expect(src).toMatch(/\.not\("storage_path", "is", null\)/);
  });

  it("returns no uploadUrl when deduping, so the caller cannot PUT over it", () => {
    const i = src.indexOf("deduped: true");
    expect(i).toBeGreaterThan(-1);
    const block = src.slice(src.lastIndexOf("return json", i), src.indexOf("}", i + 200));
    expect(block).not.toMatch(/uploadUrl/);
  });

  it("persists the hash on new documents, so the NEXT upload can match it", () => {
    // The column and its index have existed since 001_init; nothing filled it.
    expect(src).toMatch(/\n\s+sha256,/);
  });

  it("records the dedupe distinguishably in the audit trail", () => {
    expect(src).toMatch(/document_upload_deduped/);
  });
});

describe("the client hashes before asking for a URL", () => {
  const src = strip(read("src/client/anvil-client.js"));

  it("computes SHA-256 of the file bytes", () => {
    expect(src).toMatch(/crypto\?\.subtle/);
    expect(src).toMatch(/digest\("SHA-256"/);
  });

  it("degrades to the old behaviour when subtle crypto is unavailable", () => {
    // crypto.subtle requires a secure context; a missing hash must not break
    // uploading, it must only forgo deduping.
    expect(src).toMatch(/catch \(_\) \{ sha256 = null; \}/);
  });

  it("skips the transfer when the server already has the bytes", () => {
    expect(src).toMatch(/if \(!meta\.deduped\) \{/);
  });

  it("does not re-scan a document that was already scanned", () => {
    expect(src).toMatch(/opts\.autoScan !== false && !meta\.deduped/);
  });
});

describe("the card tells a duplicate apart from a failure", () => {
  const api = strip(read("src/api/orders/quotes.js"));
  const ui = strip(read("src/v3-app/components/AttachedQuotesCard.tsx"));

  it("matches on content hash as proof", () => {
    expect(api).toMatch(/basis: "content_hash", certain: true/);
  });

  it("falls back to name+size but marks it uncertain", () => {
    // Existing duplicates predate the hash, so this is the only signal for
    // them — and it is circumstantial, so it is reported as such.
    expect(api).toMatch(/basis: "same_name_and_size", certain: false/);
    expect(api).toMatch(/r\.size_bytes === doc\.size_bytes/);
  });

  it("never calls a document superseded by itself", () => {
    expect(api).toMatch(/if \(byDoc\.has\(doc\.id\)\) return null/);
  });

  it("counts superseded separately from not_ingested", () => {
    // Counting a duplicate as a failure is what made a correct re-upload look
    // broken in the summary.
    expect(api).toMatch(/superseded: attached\.filter\(\(a\) => !a\.ingested && a\.superseded_by\)/);
    expect(api).toMatch(/not_ingested: attached\.filter\(\(a\) => !a\.ingested && !a\.superseded_by\)/);
  });

  it("selects sha256, or the hash comparison silently never fires", () => {
    expect(api).toMatch(/select\("id, filename, mime_type, size_bytes, sha256, created_at"\)/);
  });

  it("labels it 'duplicate' rather than 'not read'", () => {
    expect(ui).toMatch(/a\.superseded_by \? "duplicate" : "not read"/);
  });

  it("says nothing is missing, and hedges when the evidence is circumstantial", () => {
    expect(ui).toMatch(/nothing is missing/i);
    expect(ui).toMatch(/Looks like another copy/i);
  });
});
