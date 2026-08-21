// "I am unable to understand if quote upload works."
//
// Attaching a quotation reported success in the upload panel and then, once
// that panel re-rendered, the order said nothing: not which quote, not what it
// was worth, not when it was issued. The reconcile banner is not the answer
// either — it names only the quotes that MATCHED, and a quote that attached
// but extracted nothing is exactly the case an operator needs to see.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (p) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the endpoint", () => {
  const src = read("src/api/orders/quotes.js");
  const code = strip(src);

  it("is read-only", () => {
    for (const w of [".insert(", ".update(", ".upsert(", ".delete("]) {
      expect(code).not.toContain(w);
    }
  });

  it("is a GET and requires read, not write", () => {
    // A card that only displays should not demand write access; the operator
    // reading an order may not be the one who may change it.
    expect(code).toMatch(/req\.method !== "GET"/);
    expect(code).toMatch(/requirePermission\(ctx, "read"\)/);
  });

  it("scopes documents by tenant, not just by the order link", () => {
    // order_documents carries no tenant_id of its own.
    expect(code).toMatch(/from\("documents"\)[\s\S]{0,200}eq\("tenant_id", ctx\.tenantId\)/);
  });

  it("counts lines in ONE query rather than per quote", () => {
    // A per-quote count is N round-trips inside a 60s function. The LIST path
    // batches with .in(); the detail path (?document_id=) reads one quote's
    // lines and is allowed its own query — what must never appear is a
    // per-quote count inside a loop.
    expect(code).toMatch(/from\("quote_lines"\)[\s\S]{0,300}\.in\("quote_id"/);
    const listPath = code.slice(0, code.indexOf("if (detailDocId)"));
    expect((listPath.match(/from\("quote_lines"\)/g) || []).length).toBe(1);
    // No quote_lines read inside a for/map over quotes, anywhere.
    expect(code).not.toMatch(/for \([^)]*of [^)]*quotes[^)]*\)[\s\S]{0,200}from\("quote_lines"\)/);
  });

  it("survives a database without migration 215", () => {
    // Migrations here are applied BY HAND and PostgREST rejects the whole
    // select over one unknown column. Without this the card 500s on any
    // tenant that has not run 215.
    expect(code).toMatch(/42703/);
    expect(code).toMatch(/optionalKnown/);
    expect(code).toMatch(/revision_fields_available/);
  });

  it("reports every field the operator asked for", () => {
    for (const f of ["filename", "line_count", "grand_total", "effective_date", "quote_number"]) {
      expect(code).toContain(f);
    }
  });

  it("prefers a revision date over the issue date for 'as of when'", () => {
    expect(code).toMatch(/revised_date\) \|\| qt\.sent_at/);
    expect(code).toContain("effective_date_is_revision");
  });

  it("reports an attached document that produced no quote row", () => {
    // The whole point: a PDF that attached and extracted nothing is the case
    // worth surfacing, and it appears in no reconciliation result.
    expect(code).toMatch(/ingested: !!qt/);
    expect(code).toContain("not_ingested");
  });
});

describe("the card", () => {
  const src = read("src/v3-app/components/AttachedQuotesCard.tsx");
  const code = strip(src);

  it("shows filename, line count, value and date", () => {
    expect(code).toContain("a.filename");
    expect(code).toMatch(/line_count/);
    expect(code).toMatch(/fmtMoney\(a\.quote\.grand_total/);
    expect(code).toMatch(/fmtDate\(a\.quote\.effective_date\)/);
  });

  it("says when the total was summed from lines rather than read off the document", () => {
    // A derived figure presented as the quoted total is a number the operator
    // cannot check against the PDF in front of them.
    expect(code).toContain("(from lines)");
  });

  it("marks a revision date as such", () => {
    expect(code).toContain("(revised)");
  });

  it("says plainly when a document was attached but not read", () => {
    expect(code).toMatch(/nothing was read from it/i);
  });

  it("does not set error state after unmount", () => {
    // An error written to a component that unmounts in the same tick is an
    // error nobody sees — this repo has shipped that repeatedly.
    expect(code).toMatch(/let live = true/);
    expect(code).toMatch(/if \(live\) setErr/);
    expect(code).toMatch(/return \(\) => \{ live = false; \}/);
  });
});

describe("wiring", () => {
  it("is routed", () => {
    const r = strip(read("src/api/router.js"));
    expect(r).toMatch(/"\/orders\/quotes":\s*ordersQuotes/);
    expect(r).toMatch(/import ordersQuotes\s+from "\.\/orders\/quotes\.js"/);
  });

  it("has a client method, and the card calls it", () => {
    expect(strip(read("src/client/anvil-client.js"))).toMatch(/attachedQuotes:\s*async \(orderId\)/);
    expect(read("src/v3-app/components/AttachedQuotesCard.tsx")).toMatch(/orders\?\.attachedQuotes\?\./);
  });

  it("is mounted on the workspace next to the attach control", () => {
    const ws = read("src/v3-app/screens/so-workspace.tsx");
    const panel = ws.indexOf("<AttachQuotePanel");
    const card = ws.indexOf("<AttachedQuotesCard");
    expect(panel).toBeGreaterThan(-1);
    expect(card).toBeGreaterThan(panel);
  });

  it("refreshes after an upload", () => {
    const ws = strip(read("src/v3-app/screens/so-workspace.tsx"));
    expect(ws).toMatch(/setQuotesBump\(\(n\) => n \+ 1\)/);
    expect(ws).toMatch(/refreshKey=\{quotesBump\}/);
  });

  it("declares its hook with the other hooks, not after the early returns", () => {
    // "Rendered more hooks than during the previous render" took this whole
    // screen out once already this session.
    const ws = read("src/v3-app/screens/so-workspace.tsx");
    const hook = ws.indexOf("const [quotesBump");
    const firstReturn = ws.indexOf("if (!o)");
    expect(hook).toBeGreaterThan(-1);
    if (firstReturn > -1) expect(hook).toBeLessThan(firstReturn);
  });
});

describe("migration 215", () => {
  const sql = read("supabase/migrations/215_quotes_revision.sql");

  it("adds both columns idempotently", () => {
    expect(sql).toMatch(/add column if not exists revision text/i);
    expect(sql).toMatch(/add column if not exists revised_date date/i);
  });

  it("does not touch quotes.version", () => {
    // version is Anvil's own counter and part of the unique key; folding a
    // seller's printed REV-1 into it would make a re-ingest look like a new
    // version and create a duplicate row instead of updating in place.
    expect(sql).not.toMatch(/alter\s+column\s+version|drop\s+column\s+version/i);
  });
});
