// Record context is loaded server-side and lives in the SYSTEM prompt.
//
// The bug: the panel told the agent which order it was on by prefixing the
// operator's first message. A configured rule in redaction_rules matched the
// ten-digit PO number as a phone number, so the model received
//
//   Context: I am looking at sales order PO [redacted-phone].
//
// and answered — correctly — that it could not tell which order was meant.
//
// callAnthropic applies redactMessages() to MESSAGES only; applyFirewall()
// prepends a header to the system prompt and strips nothing. So the fix is not
// to weaken redaction, it is to stop routing our own identifiers through a
// filter built for untrusted user text.

import { describe, it, expect, vi } from "vitest";
import { loadOrderContext, loadPersonaContext, CONTEXT_LOADERS } from "../api/_lib/agent-context.js";
import { REDACTION_PATTERNS, redactMessages, applyFirewall } from "../api/_lib/anthropic.js";

// Minimal Supabase stub: records the filters applied so tenant scoping can be
// asserted, not assumed.
const stubSvc = (rows, spy) => ({
  from: (table) => {
    const state = { table, filters: {} };
    const api = {
      select: () => api,
      eq: (col, val) => { state.filters[col] = val; return api; },
      maybeSingle: async () => {
        if (spy) spy(state);
        const row = rows[table];
        if (!row) return { data: null, error: null };
        // Emulate RLS-by-filter: a row is only returned when both filters match.
        const ok = Object.entries(state.filters).every(([k, v]) => row[k] === v);
        return { data: ok ? row : null, error: null };
      },
    };
    return api;
  },
});

const ORDER = {
  id: "o1", tenant_id: "t1", po_number: "0066026562", po_date: "2026-04-08",
  status: "DRAFT", customer_id: "c1",
  rule_findings: [{ code: "x" }],
  result: {
    salesOrder: {
      customer: { name: "ACME LTD" },
      lineItems: [
        { quantity: 1, unitPrice: 1000.8, lineTotal: 1180.94 },
        { quantity: 2, unitPrice: 500, lineTotal: 1180 },
      ],
    },
  },
};

describe("loadOrderContext", () => {
  it("names the order, the customer, and the line count", async () => {
    const ctx = await loadOrderContext(stubSvc({ orders: ORDER }), "t1", "o1");
    expect(ctx.text).toContain("0066026562");
    expect(ctx.text).toContain("ACME LTD");
    expect(ctx.text).toContain("Extracted line items: 2");
    expect(ctx.poNumber).toBe("0066026562");
    expect(ctx.lineCount).toBe(2);
  });

  it("sums the lines rather than trusting a stored total", async () => {
    // 1×1000.80 + 2×500 = 2000.80 taxable; 1180.94 + 1180 = 2360.94 gross.
    const ctx = await loadOrderContext(stubSvc({ orders: ORDER }), "t1", "o1");
    expect(ctx.text).toMatch(/2,000\.8/);
    expect(ctx.text).toMatch(/2,360\.94/);
  });

  it("tells the agent not to invent numbers beyond the block", async () => {
    const ctx = await loadOrderContext(stubSvc({ orders: ORDER }), "t1", "o1");
    expect(ctx.text).toMatch(/never infer a number/i);
  });

  // Tenant scoping is the whole security boundary here.
  it("returns nothing for an order belonging to another tenant", async () => {
    expect(await loadOrderContext(stubSvc({ orders: ORDER }), "OTHER", "o1")).toBeNull();
  });

  it("returns nothing — not an error — for an id that does not exist", async () => {
    // An error would confirm which ids are real.
    expect(await loadOrderContext(stubSvc({ orders: ORDER }), "t1", "nope")).toBeNull();
  });

  it("applies BOTH the id and the tenant filter", async () => {
    const seen = [];
    await loadOrderContext(stubSvc({ orders: ORDER }, (s) => seen.push(s)), "t1", "o1");
    const orderQuery = seen.find((s) => s.table === "orders");
    expect(orderQuery.filters.tenant_id).toBe("t1");
    expect(orderQuery.filters.id).toBe("o1");
  });

  it("survives a database failure without failing the turn", async () => {
    const broken = { from: () => { throw new Error("connection reset"); } };
    await expect(loadOrderContext(broken, "t1", "o1")).resolves.toBeNull();
  });

  it.each([[null, "svc"], ["", "tenant"], [undefined, "record"]])("returns null on missing input %p", async (v) => {
    expect(await loadOrderContext(v ? stubSvc({}) : null, v, v)).toBeNull();
  });
});

describe("loadPersonaContext", () => {
  it("routes the so persona to the order loader", async () => {
    const ctx = await loadPersonaContext("so", stubSvc({ orders: ORDER }), "t1", "o1");
    expect(ctx.poNumber).toBe("0066026562");
  });

  // A persona without a loader gets no record context, so adding one is opt-in.
  it("returns null for a persona with no loader registered", async () => {
    expect(await loadPersonaContext("spares", stubSvc({ orders: ORDER }), "t1", "o1")).toBeNull();
    expect(CONTEXT_LOADERS.spares).toBeUndefined();
  });

  it("returns null when no record id is supplied", async () => {
    expect(await loadPersonaContext("so", stubSvc({ orders: ORDER }), "t1", null)).toBeNull();
  });
});

describe("why the system prompt and not the message", () => {
  it("the built-in patterns alone do NOT eat a 10-digit PO", async () => {
    // Pinning this so the diagnosis is not mis-attributed later: the built-ins
    // are credit-card, Aadhaar and PAN. The phone rule that broke this lives in
    // the redaction_rules TABLE.
    const names = REDACTION_PATTERNS.map((r) => r.name);
    expect(names).toEqual(["credit_card", "aadhaar", "pan"]);
    const out = redactMessages([{ role: "user", content: "PO 0066026562" }], []);
    expect(JSON.stringify(out)).toContain("0066026562");
  });

  it("a configured phone-shaped rule DOES eat it — which is what happened", async () => {
    const rules = [{ enabled: true, pattern: "\\b\\d{10}\\b", replacement: "[redacted-phone]" }];
    const out = redactMessages([{ role: "user", content: "PO 0066026562" }], rules);
    expect(JSON.stringify(out)).toContain("[redacted-phone]");
    expect(JSON.stringify(out)).not.toContain("0066026562");
  });

  it("the system prompt is only prefixed, never redacted — so context survives", async () => {
    const ctx = await loadOrderContext(stubSvc({ orders: ORDER }), "t1", "o1");
    const system = applyFirewall("PERSONA PROMPT\n\n" + ctx.text);
    expect(system).toContain("0066026562");         // intact
    expect(system).toContain("SYSTEM_FIREWALL");    // firewall header still applied
  });
});
