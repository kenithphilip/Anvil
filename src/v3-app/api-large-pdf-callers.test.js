// Every caller of documents.extract has to answer for large_pdf.
//
// extract.js reads page 1 and no further past the background threshold — it
// sets hints.keepPages=[1] and returns large_pdf, with a comment saying the
// CALLER must then queue the rest. There is no exemption by kind: a 40-page
// assembly drawing truncates exactly like a 40-page purchase order.
//
// Two callers handled it, two ignored it entirely. The two that ignored it are
// the ones where truncation is hardest to notice: a parts list that is short
// because pages were dropped looks identical to a parts list that is short,
// and a part drawing still yields a plausible determination because the title
// block is on page 1.
//
// Neither can QUEUE the rest — extraction_jobs keys a job to an order and
// neither screen has one, and the worker has no writeback for those kinds. So
// they report. That is the honest ceiling here, and it beats both silence and
// a promise that would not be kept.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(HERE, "..", "..", rel), "utf8");
// No comment-stripping here, deliberately.
//
// The usual helper — replace(/\/\*[\s\S]*?\*\//g, "") — is unsafe on these
// files: an `accept="…image/*"` attribute opens a false block comment, and
// everything up to the next `*/` disappears, including the banner this file
// asserts on. It silently removed ~3KB of pdm-material.tsx.
//
// So assertions below match CODE (a warning code, a state setter, a prop)
// rather than prose, which makes stripping unnecessary rather than merely
// survivable.
const strip = (s) => s;

// Every frontend call site of documents.extract, and how each one answers.
const CALLERS = [
  ["src/v3-app/screens/so-intake.tsx", "queues"],
  ["src/v3-app/components/QuotesStrip.tsx", "queues"],
  ["src/v3-app/screens/bom-from-drawing.tsx", "reports"],
  ["src/v3-app/screens/pdm-material.tsx", "reports"],
  ["src/v3-app/components/OpportunityQuoteRevisions.tsx", "reports"],
];

describe("no caller ignores a truncated read", () => {
  it.each(CALLERS)("%s handles large_pdf (%s)", (path) => {
    const src = strip(read(path));
    expect(src).toMatch(/large_pdf/);
  });

  it("the threshold applies to every kind, which is why they all must", () => {
    // If this ever grew a per-kind exemption the list above would need
    // revisiting rather than silently over-asserting.
    const extract = strip(read("src/api/docai/extract.js"));
    expect(extract).toMatch(/totalPages > BACKGROUND_PAGE_THRESHOLD/);
    // No kind appears in the truncation condition.
    const cond = extract.slice(extract.indexOf("let largePdf = false;"), extract.indexOf("const result = await runExtractionPipeline"));
    expect(cond).not.toMatch(/kind/);
  });
});

describe("the parts list says so where the decision is made", () => {
  const src = strip(read("src/v3-app/screens/bom-from-drawing.tsx"));

  it("puts it in the preview's warnings, not a toast", () => {
    // The preview is the last point at which anyone can tell a truncated
    // parts list from a short one. A toast is dismissed and gone.
    expect(src).toMatch(/code: "truncated_to_first_page"/);
    expect(src).toMatch(/warnings: \[\.\.\.truncation, \.\.\.\(pv\.warnings \|\| \[\]\)\]/);
  });

  it("rates it 'bad', not 'warn'", () => {
    // Every other warning describes something the preview is SHOWING. This one
    // describes rows that are not in it.
    expect(src).toMatch(/truncated_to_first_page: "bad"/);
  });

  it("says what to do about it", () => {
    expect(src).toMatch(/Split the drawing/);
  });
});

describe("the part drawing says so before the verdict is saved", () => {
  const src = strip(read("src/v3-app/screens/pdm-material.tsx"));

  it("renders a banner rather than failing the extraction", () => {
    // The title block is on page 1, so the read is usually still usable —
    // refusing it would be worse than flagging it.
    expect(src).toMatch(/truncatedPages/);
    expect(src).toMatch(/Only page 1 was read/);
  });

  it("clears the flag when a new file is picked", () => {
    // A stale banner on a second, shorter drawing would be its own lie.
    expect(src).toMatch(/setVerdict\(null\); setTruncatedPages\(null\)/);
  });

  it("names what a later sheet might have carried", () => {
    // \s+ because JSX wraps the sentence across lines with indentation.
    expect(src).toMatch(/dimension,\s+material note or revision/);
  });
});
