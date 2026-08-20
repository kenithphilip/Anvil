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
  const src = read("src/v3-app/components/QuoteViewer.tsx");
  const code = strip(src);

  it("reuses ReviewDocPane rather than building a second viewer", () => {
    // ReviewDocPane is what the PO review tab already uses: it resolves the
    // document, renders via pdf.js, zooms, falls back by mime, and downloads.
    expect(code).toMatch(/import \{ ReviewDocPane \} from "\.\/ReviewPane"/);
    expect(code).toMatch(/<ReviewDocPane docId=\{documentId\} \/>/);
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
    expect(code).toMatch(/qv-split/);
    expect(code).toMatch(/qv-doc/);
    expect(code).toMatch(/qv-lines/);
  });

  it("shows the list price only when it differs from the net price", () => {
    // A single-price quote must not imply a discount it never carried.
    expect(code).toMatch(/l\.listed_unit_price !== l\.discounted_unit_price/);
  });

  it("uses the house Modal, which already handles Escape and focus", () => {
    expect(code).toMatch(/from "\.\.\/lib\/primitives"/);
    expect(code).toMatch(/<Modal\b/);
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

describe("the card opens it", () => {
  const src = read("src/v3-app/components/AttachedQuotesCard.tsx");

  it("makes the filename the control", () => {
    expect(src).toMatch(/onClick=\{\(\) => setViewing\(a\.document_id\)\}/);
  });

  it("mounts the viewer and refreshes after a detach", () => {
    expect(src).toMatch(/<QuoteViewer/);
    expect(src).toMatch(/onDetached=\{\(\) => setBump/);
    expect(src).toMatch(/\[orderId, refreshKey, bump\]/);
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
