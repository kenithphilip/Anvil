// The incoterm check compared the PO's rule against the quote's payment terms.
//
// `quotes` has no incoterm column, so the quote side is read out of the quote's
// terms text, which is usually just its payment terms. When that text named no
// rule, compareIncoterms fell back to a plain string compare, so "EXW" against
// "30 days credit" reported an incoterm mismatch on every such order.
//
// Now only a parsed rule code is compared, then the named place. A quote that
// names no rule reports "quote has no incoterm", which is not a discrepancy.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { compareIncoterms, parseIncoterm } from "../api/_lib/quote-reconcile.js";

const TENANT = "00000000-0000-0000-0000-0000000000aa";
const ORDER = "00000000-0000-0000-0000-0000000000b1";
const CUSTOMER = "00000000-0000-0000-0000-0000000000c1";

describe("compareIncoterms: the same rule written differently", () => {
  it.each([
    ["fob   nhava sheva", "FOB Nhava Sheva"],
    ["FOB Busan", "fob, BUSAN"],
    ["FOB Nhava-Sheva", "FOB Nhava Sheva"],
    ["Ex-Works Pune", "EXW Pune"],
    ["EXW", "exw"],
    ["F.O.B. Busan", "FOB Busan"],
    ["FOB Busan (Incoterms 2020)", "FOB Busan"],
  ])("%p and %p match", (po, quote) => {
    expect(compareIncoterms(po, quote).verdict).toBe("match");
  });

  it("reads the place only up to the next clause", () => {
    const r = compareIncoterms("FOB Busan", "FOB Busan, 30 days net");
    expect(r.verdict).toBe("match");
    expect(r.quote_place).toBe("Busan");
  });

  it("does not call a place different when one side names none", () => {
    // The incoterm picklist stores a bare code. That is not a moved place.
    const r = compareIncoterms("FOB", "FOB Busan");
    expect(r.verdict).toBe("match");
    expect(r.place_compared).toBe(false);
  });

  it("reads the Indian FOR convention the picklist offers", () => {
    expect(compareIncoterms("FOR Halol Plant", "FOR halol plant").verdict).toBe("match");
    expect(compareIncoterms("FOR", "Free on Road Halol").verdict).toBe("match");
  });
});

describe("compareIncoterms: a different rule", () => {
  it.each([
    ["EXW Pune", "FOB Busan"],
    ["CIF Chennai", "C&F Chennai"],
    ["DDP Pune", "DAP Pune"],
  ])("%p against %p is a mismatch", (po, quote) => {
    const r = compareIncoterms(po, quote);
    expect(r.verdict).toBe("mismatch");
    expect(r.po_code).not.toBe(r.quote_code);
  });

  it("compares the place after the code", () => {
    const r = compareIncoterms("FOB Busan", "FOB Incheon");
    expect(r.verdict).toBe("place_differs");
    expect(r.place_compared).toBe(true);
  });
});

describe("compareIncoterms: the quote names no rule", () => {
  it.each([
    ["EXW", "30 days credit"],
    ["FOB Busan", "100% advance against proforma"],
    ["FOB Busan", ""],
    ["FOB Busan", null],
  ])("%p against %p is quote_missing, not a mismatch", (po, quote) => {
    const r = compareIncoterms(po, quote);
    expect(r.verdict).toBe("quote_missing");
    // The payment-terms text is never shown as the quote's incoterm.
    expect(r.quote_incoterm).toBeNull();
    expect(r.po_incoterm).toBe(po);
  });

  it("does not read the English word 'for' as the FOR rule", () => {
    expect(parseIncoterm("30 days for payment").code).toBeNull();
    expect(parseIncoterm("PAYMENT FOR ALL ORDERS 30 DAYS").code).toBeNull();
    expect(compareIncoterms("FOB Busan", "30 days for payment").verdict).toBe("quote_missing");
  });

  it("is po_missing when only the quote names a rule", () => {
    expect(compareIncoterms("within 4 weeks", "FOB Busan").verdict).toBe("po_missing");
  });

  it("is unknown when neither side names a rule", () => {
    expect(compareIncoterms("to be agreed", "30 days credit").verdict).toBe("unknown");
  });
});

// ── The endpoint ─────────────────────────────────────────────────────────

let tables;
let captured;

const makeSvc = () => ({
  from(table) {
    let rows = [...(tables[table] || [])];
    let patch = null;
    const api = {
      select: () => api,
      eq: (c, v) => { rows = rows.filter((r) => String(r[c]) === String(v)); return api; },
      in: (c, vals) => { rows = rows.filter((r) => vals.map(String).includes(String(r[c]))); return api; },
      not: (c, op, list) => {
        const banned = String(list).replace(/[()]/g, "").split(",");
        rows = rows.filter((r) => !banned.includes(String(r[c])));
        return api;
      },
      is: (c, v) => { rows = rows.filter((r) => (r[c] ?? null) === v); return api; },
      order: () => api,
      update: (p) => { patch = p; return api; },
      maybeSingle: async () => ({ data: rows[0] || null, error: null }),
      then: (fn, rej) => {
        if (patch) {
          for (const r of rows) captured.updates.push({ table, id: r.id, patch });
          return Promise.resolve({ data: null, error: null }).then(fn, rej);
        }
        return Promise.resolve({ data: rows, error: null }).then(fn, rej);
      },
    };
    return api;
  },
});

vi.mock("../api/_lib/cors.js", () => ({
  applyCors: () => {}, handlePreflight: () => false,
  readBody: async (req) => req._body,
  json: (res, status, body) => { res._status = status; res._json = body; return res; },
  sendError: (res, err) => { res._status = err.status || 500; res._json = { error: { message: err.message } }; return res; },
}));
vi.mock("../api/_lib/auth.js", () => ({
  resolveContext: async () => ({ tenantId: TENANT, user: { id: "u1" }, role: "sales_engineer" }),
  requirePermission: () => {},
}));
vi.mock("../api/_lib/supabase.js", () => ({ serviceClient: () => makeSvc() }));
vi.mock("../api/_lib/audit.js", () => ({ recordAudit: async () => {} }));

const { default: reconcile } = await import("../api/orders/reconcile_quotes.js");

const run = async () => {
  const res = {};
  await reconcile({ method: "POST", headers: {}, _body: { order_id: ORDER } }, res);
  return res;
};

const order = (over = {}) => ({
  id: ORDER, tenant_id: TENANT, customer_id: CUSTOMER, quote_id: null, quote_number: null,
  rule_findings: [], incoterm_code: null, delivery_terms: null,
  result: {
    salesOrder: {
      customer: { payment_terms: "30 days credit" },
      lineItems: [{ line_no: 1, part_no: "PART-100", description: "Test valve", qty: 2, rate: 500 }],
    },
  },
  ...over,
});

const quote = (over = {}) => ({
  id: "q1", tenant_id: TENANT, customer_id: CUSTOMER, quote_number: "Q-TEST-1",
  created_at: "2026-09-01T00:00:00Z", status: "SENT", terms: "30 days credit", ...over,
});

const quoteLine = (over = {}) => ({
  quote_id: "q1", tenant_id: TENANT, line_index: 0, part_no: "PART-100", description: "Test valve",
  qty: 2, discounted_unit_price: 500, ...over,
});

const stored = () => captured.updates.find((u) => u.table === "orders")?.patch?.result?.quoteReconciliation;

beforeEach(() => {
  captured = { updates: [] };
  tables = { orders: [order()], quotes: [quote()], quote_lines: [quoteLine()], item_customer_parts: [], item_master: [] };
});

describe("POST /api/orders/reconcile_quotes: the incoterm check", () => {
  it("reports a quote whose terms are only payment terms as having no incoterm", async () => {
    tables.orders = [order({ incoterm_code: "EXW" })];
    const res = await run();
    expect(res._status).toBe(200);
    expect(res._json.incoterms.verdict).toBe("quote_missing");
    expect(res._json.flags.filter((f) => String(f.verdict).startsWith("incoterms_"))).toEqual([]);
    expect(stored().incoterms.verdict).toBe("quote_missing");
    expect(stored().incoterms.source_quote_number).toBe("Q-TEST-1");
  });

  it("keeps comparing payment terms against the quote's terms text", async () => {
    tables.orders = [order({ incoterm_code: "EXW" })];
    tables.quotes = [quote({ terms: "45 days credit" })];
    const res = await run();
    expect(res._json.payment_terms.verdict).toBe("mismatch");
    expect(res._json.flags.map((f) => f.verdict)).toContain("payment_terms_mismatch");
  });

  it("flags a different rule as a mismatch", async () => {
    tables.orders = [order({ incoterm_code: "FOB Busan" })];
    tables.quotes = [quote({ terms: "CIF Busan, 30 days credit" })];
    const res = await run();
    const flag = res._json.flags.find((f) => f.verdict === "incoterms_mismatch");
    expect(flag).toBeTruthy();
    expect(flag.po_incoterm).toBe("FOB Busan");
    expect(flag.quote_incoterm).toBe("CIF Busan");
  });

  it("matches the same rule written in a different case and spacing", async () => {
    tables.orders = [order({ incoterm_code: "fob   busan" })];
    tables.quotes = [quote({ terms: "FOB Busan, 30 days credit" })];
    const res = await run();
    expect(res._json.incoterms.verdict).toBe("match");
    expect(res._json.flags.filter((f) => String(f.verdict).startsWith("incoterms_"))).toEqual([]);
  });

  it("reads a rule from a later PO source when an earlier one names none", async () => {
    tables.orders = [order({ incoterm_code: "As per PO", delivery_terms: "FOB Busan" })];
    tables.quotes = [quote({ terms: "FOB Busan, 30 days credit" })];
    const res = await run();
    expect(res._json.incoterms.po_code).toBe("FOB");
    expect(res._json.incoterms.verdict).toBe("match");
  });

  it("does not blame a quote when no quote priced any line", async () => {
    tables.orders = [order({ incoterm_code: "EXW" })];
    tables.quote_lines = [quoteLine({ part_no: "OTHER-9" })];
    const res = await run();
    expect(res._json.incoterms.verdict).toBe("unknown");
  });
});
