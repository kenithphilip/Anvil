// Selecting an uploaded quote, seeing it, and downloading it — so line items
// can be checked against the document rather than taken on trust.
//
// The card answers "did the upload work". This answers what comes next: "are
// those lines actually right?", which a row count cannot settle.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (p) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the detail endpoint", () => {
  const src = strip(read("src/api/orders/quotes.js"));

  it("serves one document via the SAME endpoint and the same tenant checks", () => {
    // A second route would duplicate the order/tenant authorisation, which is
    // how two copies of a check drift apart.
    expect(src).toMatch(/const detailDocId = req\.query\?\.document_id/);
    expect(src).toMatch(/if \(detailDocId\) \{/);
  });

  it("404s a document that is not attached to THIS order", () => {
    // Otherwise any document id in the tenant could be read through an order
    // the operator happens to have open.
    expect(src).toMatch(/attached\.find\(\(a\) => a\.document_id === detailDocId\)/);
    expect(src).toMatch(/is not attached to this order/);
  });

  it("does NOT mint a second signed URL", () => {
    // ReviewDocPane resolves the document through /api/documents/<id> and
    // re-signs before the TTL expires. A rival URL here would have a shorter
    // life and no refresh.
    expect(src).not.toMatch(/createSignedUrl/);
  });

  it("converts stored FRACTIONS back to percentages for display", () => {
    // quote_lines holds 0.09; the document the operator is checking against
    // prints 9%. Converting here beats making every consumer remember.
    expect(src).toMatch(/Number\(l\.cgst_pct\) \* 100/);
    expect(src).toMatch(/rates_as: "percent"/);
  });

  it("orders lines the way the document does", () => {
    expect(src).toMatch(/order\("line_index", \{ ascending: true \}\)/);
  });

  it("stays read-only", () => {
    for (const w of [".insert(", ".update(", ".upsert(", ".delete("]) expect(src).not.toContain(w);
  });
});

describe("detaching a redundant copy", () => {
  const src = strip(read("src/api/orders/detach_quote.js"));

  it("REFUSES to detach the copy that carries the quote", () => {
    // Removing that one orphans the pricing provenance: the reconciler would
    // still price from a document the order no longer points at.
    expect(src).toMatch(/eq\("source_document_id", documentId\)/);
    expect(src).toMatch(/detaching it would remove the order's link/);
    expect(src).toMatch(/409/);
  });

  it("unlinks only — it does not delete the document", () => {
    expect(src).toMatch(/from\("order_documents"\)\s*\n?\s*\.delete\(\)/);
    expect(src).not.toMatch(/from\("documents"\)[\s\S]{0,80}\.delete\(\)/);
    expect(src).toMatch(/document_deleted: false/);
  });

  it("says out loud that it did less than 'delete'", () => {
    // The request used the word delete; this deliberately does not.
    expect(src).toMatch(/document itself is kept/i);
  });

  it("refuses rather than guesses when it cannot prove redundancy", () => {
    // Without source_document_id we cannot tell which copy is the record, and
    // unlinking the wrong one is the failure worth avoiding.
    expect(src).toMatch(/Cannot confirm this attachment is redundant/);
  });

  it("scopes the order by tenant before touching the link table", () => {
    // order_documents has no tenant_id of its own.
    expect(src).toMatch(/from\("orders"\)[\s\S]{0,120}eq\("tenant_id", ctx\.tenantId\)/);
  });

  it("audits the removal", () => {
    expect(src).toMatch(/order_quote_detached/);
  });
});

describe("the viewer", () => {
  const src = read("src/v3-app/components/QuotePane.tsx");
  const code = strip(src);

  it("reuses ReviewDocPane rather than building a second viewer", () => {
    // ReviewDocPane is what the PO review tab already uses: it resolves the
    // document, renders via pdf.js, zooms, falls back by mime, and downloads.
    expect(code).toMatch(/import \{ ReviewDocPane \} from "\.\/ReviewPane"/);
    expect(code).toMatch(/<ReviewDocPane docId=\{docId\} \/>/);
    expect(code).not.toMatch(/<iframe|<embed|<object/);
  });

  it("does not resolve its own signed URL", () => {
    // Signed URLs here live ten minutes and ReviewDocPane re-signs at nine.
    // A viewer that resolved one once — as an earlier draft did — renders a
    // broken page for anyone who leaves the modal open while checking figures,
    // which is the entire use case.
    expect(code).not.toMatch(/createObjectURL|doc\?\.url/);
  });

  it("has exactly one download control, ReviewDocPane's own", () => {
    expect(code).not.toMatch(/onClick=\{download\}/);
  });

  it("shows the document beside the extraction", () => {
    expect(code).toMatch(/qp-split/);
    expect(code).toMatch(/qp-doc/);
    expect(code).toMatch(/qp-lines/);
  });

  it("shows the list price only when it differs from the net price", () => {
    // A single-price quote must not imply a discount it never carried.
    expect(code).toMatch(/l\.listed_unit_price !== l\.discounted_unit_price/);
  });

  it("is a TAB, not an overlay", () => {
    // Checking line items against a document is slow comparative work. An
    // overlay steals the room the comparison needs and adds a layer to
    // dismiss before anything else can be seen.
    expect(code).not.toMatch(/<Modal\b/);
    const ws = read("src/v3-app/screens/so-workspace.tsx");
    expect(ws).toMatch(/\{ id: "quotes", label: "Quotes"/);
    expect(ws).toMatch(/tab === "quotes" && \(/);
  });

  it("does not set error state after the modal closes", () => {
    expect(code).toMatch(/let live = true/);
    expect(code).toMatch(/if \(live\) setErr/);
  });

  it("puts the duplicate removal behind a confirm", () => {
    expect(code).toMatch(/confirmDetach/);
    expect(code).toMatch(/The file itself is kept/);
  });

  it("offers removal ONLY for a duplicate", () => {
    expect(code).toMatch(/\{superseded && \(/);
  });
});

describe("the strip opens it", () => {
  const src = read("src/v3-app/components/QuotesStrip.tsx");
  const ws = read("src/v3-app/screens/so-workspace.tsx");

  it("makes each attached quote the control", () => {
    expect(src).toMatch(/onClick=\{\(\) => onOpen\?\.\(a\.document_id\)\}/);
  });

  it("opening one switches to the Quotes tab focused on that document", () => {
    expect(ws).toMatch(/onOpen=\{\(docId\) => \{ setQuoteDoc\(docId\); setTab\("quotes"\); \}\}/);
  });

  it("hands its list up rather than making the tab refetch it", () => {
    // Two components fetching the same list is two answers to one question.
    expect(src).toMatch(/onLoaded\?\.\(list\)/);
    expect(ws).toMatch(/onLoaded=\{setAttachedQuotes\}/);
  });

  it("refreshes after a duplicate is removed", () => {
    expect(ws).toMatch(/onChanged=\{\(\) => \{ setQuoteDoc\(null\); setQuotesBump/);
  });
});

describe("layout", () => {
  const css = read("src/v3-app/styles.css");

  it("stacks on a narrow viewport instead of squeezing both panes", () => {
    expect(css).toMatch(/\.qv-split \{[^}]*grid-template-columns/);
    expect(css).toMatch(/@media \(max-width: 1100px\)[\s\S]{0,160}\.qv-split/);
  });

  it("scrolls each pane rather than the page", () => {
    expect(css).toMatch(/\.qv-doc \{[^}]*overflow: auto/);
    expect(css).toMatch(/\.qv-lines \{[^}]*overflow: auto/);
  });
});

// ── Correcting what was read ────────────────────────────────────────────
//
// #489 shipped a kind-agnostic harvest: the moment a human corrects an
// extraction, that document becomes a golden fixture. Only POs had a
// correction UI, so the harvest could only ever fire for POs — the golden set
// stayed a PO set no matter how many kinds the scorer learned to score. This
// is the second kind.

describe("resolving the run a correction attaches to", () => {
  const src = strip(read("src/api/orders/quotes.js"));

  it("finds the run through the document, because quotes has no run column", () => {
    // extraction_runs.source_id IS the document id (run.js stamps
    // `source_id: sourceId || documentId`), so the document on screen
    // resolves its own run without a migration.
    expect(src).toMatch(/from\("extraction_runs"\)/);
    expect(src).toMatch(/eq\("source_id", detailDocId\)/);
    expect(src).toMatch(/eq\("extraction_kind", "quote"\)/);
  });

  it("takes the LATEST run — a re-extraction supersedes the one before it", () => {
    expect(src).toMatch(/order\("finished_at", \{ ascending: false/);
    expect(src).toMatch(/\.limit\(1\)/);
  });

  it("does NOT filter on status", () => {
    // A low-confidence run is the one most likely to need correcting.
    // Refusing to attach a correction to it would silence exactly the
    // documents the learning loop most needs.
    expect(src).not.toMatch(/extraction_kind", "quote"\)[\s\S]{0,200}eq\("status", "ok"\)/);
  });

  it("degrades to read-only rather than failing the tab", () => {
    // A hand-authored quote has no extraction run at all.
    expect(src).toMatch(/let extractionRunId = null/);
    expect(src).toMatch(/extraction_run_id: extractionRunId/);
  });

  it("still writes nothing", () => {
    for (const w of [".insert(", ".update(", ".upsert(", ".delete("]) expect(src).not.toContain(w);
  });
});

describe("the correction affordance", () => {
  const code = strip(read("src/v3-app/components/QuotePane.tsx"));

  it("reuses the PO pane's correction context rather than a second submitter", () => {
    // ReviewPaneSelectionProvider already owns the POST, the 403 message and
    // the per-pane state; it takes extractionRunId as a prop and knows nothing
    // about purchase orders.
    expect(code).toMatch(/import \{ ReviewPaneSelectionProvider, useReviewPaneSelection \} from "\.\/ReviewPaneContext"/);
    expect(code).toMatch(/<ReviewPaneSelectionProvider/);
    expect(code).toMatch(/extractionRunId=\{extractionRunId\}/);
  });

  it("re-keys the provider per document", () => {
    // Otherwise correction state from quote A shows on quote B's cells.
    expect(code).toMatch(/<ReviewPaneSelectionProvider[\s\S]{0,120}key=\{docId \|\| "none"\}/);
  });

  it("maps cells through the shared field map, never inline strings", () => {
    // A hand-written `lines[${i}].unitPrice` at a call site is how a wrong
    // path gets written into a golden.
    expect(code).toMatch(/from "\.\.\/lib\/quote-field-paths"/);
    expect(code).not.toMatch(/`lines\[\$\{/);
  });

  it("addresses a row by line_index, not by render position", () => {
    expect(code).toMatch(/lineIndex=\{l\.line_index\}/);
    expect(code).not.toMatch(/lineIndex=\{i\}/);
  });

  it("leaves the summed GST column read-only", () => {
    // Three extracted fields render as one column; a correction there could
    // not be attributed to cgst vs igst.
    expect(code).toMatch(/column="discounted_unit_price"/);
    expect(code).not.toMatch(/column="cgst_pct"|column="igst_pct"|column="gst"/);
  });

  it("does not rewrite the quote it is correcting", () => {
    // quote_lines is what the supplier's document was read as, and the
    // PO-vs-quote reconciliation is computed from it. A correction records
    // ground truth about the EXTRACTION; it must not move the commercial
    // comparison under the operator.
    expect(code).not.toMatch(/quotes\?\.\w*[Uu]pdate|updateQuoteLine|patchQuote/);
  });

  it("says so, rather than letting the operator infer it from a cell reverting", () => {
    expect(code).toMatch(/it does not change the quote/);
  });

  it("only offers corrections to someone who may approve", () => {
    const ws = strip(read("src/v3-app/screens/so-workspace.tsx"));
    expect(ws).toMatch(/<QuotePane[\s\S]{0,300}canCorrect=\{canApprove\}/);
  });
});
