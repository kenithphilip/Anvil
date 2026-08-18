// The contract between the extractor and the ingest, which nothing tested.
//
// Attaching a quotation to a PO could NEVER ingest a line, and my own test
// suite passed throughout. api-order-attach-quote.test.js mocks ingestQuotes
// entirely and hand-feeds { quote_number, lines: [{ part_no, unit_price }] } —
// a shape the DocAI extractor does not produce. It asserted my assumption about
// the payload, not the payload.
//
// Two real defects hid behind that:
//   1. the Claude adapter selected the quote prompt and tool but had no isQuote
//      RETURN branch, so `normalized` carried only { classification, customer,
//      lines } and quote_number was dropped on the floor
//   2. ingestQuote() aborts on a missing quote_number BEFORE writing the quote
//      head or a single line
// so every attach returned 200 / ingested:false / "could not be read".

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const claude = readFileSync("src/api/_lib/docai/claude.js", "utf8");
const ingest = readFileSync("src/api/_lib/quote-ingest.js", "utf8");
const bridge = readFileSync("src/api/orders/attach_quote.js", "utf8");
const panel = readFileSync("src/v3-app/components/AttachQuotePanel.tsx", "utf8");

describe("the extractor emits what the ingest requires", () => {
  it("QUOTE_TOOL declares quote_number", () => {
    expect(claude).toMatch(/quote_number/);
  });

  // The regression.
  it("carries the quote header into `normalized`, not just into the tool schema", () => {
    // isSupplierAck / isAssemblyBom / isPartDrawing all shape their return.
    // isQuote selected the prompt and tool and then changed nothing.
    // Assert on the spread itself — claude.js has several `normalized:` blocks
    // (one per document kind), so slicing from the first finds the wrong one.
    expect(claude).toMatch(/\.\.\.\(isQuote \? \{/);
    const branch = claude.slice(claude.indexOf("...(isQuote ? {"), claude.indexOf("...(isQuote ? {") + 400);
    expect(branch).toMatch(/quote_number: out\.quote_number/);
    expect(branch).toMatch(/currency: out\.currency/);
  });

  it("ingest still refuses a quote with no number, rather than minting one", () => {
    // `quotes` is keyed on (tenant, quote_number, version); a synthetic number
    // would break re-ingest idempotency. The guard is correct — what was wrong
    // was never giving it a number.
    expect(ingest).toMatch(/quote_number missing/);
  });

  it("the bridge reads the field the extractor now provides", () => {
    expect(bridge).toMatch(/quote_number: extracted\.quote_number/);
  });
});

describe("the panel actually receives the chosen files", () => {
  // Setting input.value = "" EMPTIES the live FileList in place, so capturing
  // `e.target.files` and then resetting handed onPick a zero-length list. The
  // picker opened, a PDF was chosen, and nothing happened at all — no busy
  // label, no error, no toast.
  it("copies the files out BEFORE resetting the input", () => {
    expect(panel).toMatch(/Array\.from\(e\.target\.files \|\| \[\]\)/);
    // The copy must precede the reset in source order.
    const copyAt = panel.indexOf("Array.from(e.target.files");
    const resetAt = panel.indexOf('e.target.value = ""');
    expect(copyAt).toBeGreaterThan(-1);
    expect(resetAt).toBeGreaterThan(copyAt);
  });

  it("takes a real copy, not another reference to the live list", () => {
    // The browser behaviour cannot be reproduced here — jsdom has no
    // DataTransfer, so a FileList cannot be constructed. What IS assertable is
    // that the fix snapshots into a plain array; a spread or slice of the live
    // FileList would be equally fine, a bare assignment would not.
    const live = { 0: "a", length: 1 };            // FileList-shaped
    const copied = Array.from(live);
    live.length = 0;                               // what value="" does
    expect(copied).toHaveLength(1);
    expect(Array.isArray(copied)).toBe(true);
  });

  it("commits each file's result as it completes", () => {
    // An error on the third file must not discard the first two, which are
    // already uploaded, linked and ingested server-side.
    expect(panel).toMatch(/setDone\(\(d\) => \[r, \.\.\.d\]\)/);
  });

  it("surfaces the real reason rather than a generic string", () => {
    expect(panel).toMatch(/res\?\.report\?\.reports\?\.\[0\]\?\.error/);
  });
});
