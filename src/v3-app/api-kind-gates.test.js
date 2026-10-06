// A quote that extracted ZERO lines was recorded as a successful extraction.
//
// The status gates were three hand-written branches — non_po for po, non_ack
// for supplier_ack, non_drawing for the two drawing kinds — plus an
// empty-lines check listing po, rfq and assembly_bom.
//
// Every kind added after that silently skipped both. quote, invoice,
// packing_list and eway_bill each emit their own non_<kind> classification
// that nothing refused, and a quote with no lines fell straight through to
// status 'ok'. A green run with an empty payload — precisely what the
// non_drawing branch's own comment said it existed to prevent.
//
// This is the same drift as the multi-row prompt block landing on claude.js
// and not gemini.js, and the unsupported_kind guard landing on one adapter:
// a guard written per-case, and the next case never added to it.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { KIND_GATES_TABLE } from "../api/_lib/docai/run.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(HERE, "..", "..", rel), "utf8");

// The kinds the database permits, read from whichever migration last said so.
const permittedKinds = () => {
  const dir = join(HERE, "..", "..", "supabase", "migrations");
  const { readdirSync } = require("node:fs");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  let last = null;
  for (const f of files) {
    const sql = readFileSync(join(dir, f), "utf8");
    if (sql.includes("extraction_runs_extraction_kind_check")) last = sql;
  }
  const block = last.slice(last.indexOf("extraction_runs_extraction_kind_check"));
  const inner = block.slice(block.indexOf("check (extraction_kind in ("));
  return [...inner.slice(0, inner.indexOf("));")).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
};

describe("every permitted kind is gated", () => {
  it("has an entry — a missing one is visible, a missing || is not", () => {
    // The whole reason this is a table rather than branches.
    for (const kind of permittedKinds()) {
      expect(KIND_GATES_TABLE[kind], `kind "${kind}" has no status gate`).toBeTruthy();
    }
  });

  it("gates no kind the database does not permit", () => {
    const permitted = new Set(permittedKinds());
    for (const kind of Object.keys(KIND_GATES_TABLE)) {
      expect(permitted.has(kind), `"${kind}" is gated but not a permitted kind`).toBe(true);
    }
  });
});

describe("a document the extractor itself rejected is refused", () => {
  it("refuses each kind's own non_<kind> verdict", () => {
    // quote, invoice, packing_list, eway_bill and sales_order all emit one and
    // NONE of them was refused before.
    expect(KIND_GATES_TABLE.quote.reject).toBe("non_quote");
    expect(KIND_GATES_TABLE.invoice.reject).toBe("non_invoice");
    expect(KIND_GATES_TABLE.packing_list.reject).toBe("non_packing_list");
    expect(KIND_GATES_TABLE.eway_bill.reject).toBe("non_eway_bill");
    expect(KIND_GATES_TABLE.sales_order.reject).toBe("non_sales_order");
  });

  it("matches the enum each tool actually emits", () => {
    // A reject value the extractor never produces is a gate that never fires.
    const claude = read("src/api/_lib/docai/claude.js");
    for (const [kind, gate] of Object.entries(KIND_GATES_TABLE)) {
      if (!gate.reject) continue;
      expect(claude, `nothing emits "${gate.reject}" for kind ${kind}`).toContain(`"${gate.reject}"`);
    }
  });

  it("keeps rfq on the PO classifier, which is the schema it runs", () => {
    expect(KIND_GATES_TABLE.rfq.reject).toBe("non_po");
  });

  it("leaves generic ungated — it has no classifier verdict to trust", () => {
    expect(KIND_GATES_TABLE.generic.reject).toBeNull();
  });
});

describe("zero lines fails the kinds whose schema demands lines", () => {
  it("fails a quote with no lines", () => {
    // The defect that started this. A 23-line quotation returning nothing was
    // status 'ok'.
    expect(KIND_GATES_TABLE.quote.requiresLines).toBe(true);
  });

  it("fails invoice, packing_list and sales_order too", () => {
    for (const k of ["invoice", "packing_list", "sales_order"]) {
      expect(KIND_GATES_TABLE[k].requiresLines, k).toBe(true);
    }
  });

  it("follows each tool's OWN required array", () => {
    // Not a judgement call: every kind marked true declares "lines" required.
    const claude = read("src/api/_lib/docai/claude.js");
    const toolFor = { quote: "QUOTE_TOOL", invoice: "INVOICE_TOOL", packing_list: "PACKING_LIST_TOOL", sales_order: "SALES_ORDER_TOOL" };
    for (const [kind, tool] of Object.entries(toolFor)) {
      if (!KIND_GATES_TABLE[kind].requiresLines) continue;
      const block = claude.slice(claude.indexOf(`${tool} = {`));
      expect(block.slice(0, block.indexOf("\n};")), tool).toMatch(/required: \[[^\]]*"lines"/);
    }
  });

  it("does NOT fail the kinds that legitimately have no lines", () => {
    // part_drawing has no parts list; an e-way bill is a header document about
    // a consignment. Failing them would break good extractions.
    expect(KIND_GATES_TABLE.part_drawing.requiresLines).toBe(false);
    expect(KIND_GATES_TABLE.eway_bill.requiresLines).toBe(false);
    expect(KIND_GATES_TABLE.supplier_ack.requiresLines).toBe(false);
  });

  it("preserves the PO path exactly as it was", () => {
    // po, rfq and assembly_bom were the original three. A refactor that
    // changed them would be a regression dressed as a cleanup.
    for (const k of ["po", "rfq", "assembly_bom"]) {
      expect(KIND_GATES_TABLE[k].requiresLines, k).toBe(true);
    }
  });
});

describe("the quote can now report a short read", () => {
  const claude = read("src/api/_lib/docai/claude.js");

  it("QUOTE_TOOL declares stated_line_count", () => {
    // checkLineCountShortfall reads normalized.stated_line_count. QUOTE_TOOL
    // had no such property, so on a quote it was always undefined and the
    // detector returned nothing — the guard existed and was starved.
    const block = claude.slice(claude.indexOf("QUOTE_TOOL = {"));
    expect(block.slice(0, block.indexOf("\n};"))).toMatch(/stated_line_count/);
  });

  it("the prompt tells the model to report it even when it exceeds the lines returned", () => {
    expect(claude).toMatch(/report it\",\s*\n\s*\"\s*truthfully even when it exceeds them/);
  });

  it("the quote prompt now carries the multi-row guidance the PO prompt has", () => {
    // Its absence is the third instance of one drift pattern: a fix landing
    // where the bug was reported and nowhere else.
    const quotePrompt = claude.slice(claude.indexOf("QUOTE_SYSTEM_PROMPT = ["), claude.indexOf("const QUOTE_TOOL"));
    expect(quotePrompt).toMatch(/MULTI-ROW-PER-ITEM/);
    expect(quotePrompt).toMatch(/do NOT return an empty lines\[\]/);
    expect(quotePrompt).toMatch(/if it\",\s*\n\s*\"prints 23 you must return exactly 23/);
  });

  it("tells it what to do with a row whose description cell is a list", () => {
    // Both quotes carry a "miscellaneous items" row listing a dozen sub-items
    // priced as one line.
    const quotePrompt = claude.slice(claude.indexOf("QUOTE_SYSTEM_PROMPT = ["), claude.indexOf("const QUOTE_TOOL"));
    expect(quotePrompt).toMatch(/description cell/i);
    expect(quotePrompt).toMatch(/Do NOT split it into an entry per/);
  });
});
