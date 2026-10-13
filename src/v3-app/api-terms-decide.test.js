// Deciding a terms flag (plan PR 13): POST /api/orders/terms_decide, the
// decision history in GET /api/orders/terms, and decisions carried to a
// re-run's flags.
//
// Owner decision 2 (2026-10-13), as applied:
//   - sales_engineer may accept info and warn flags;
//   - sales_manager or admin may accept high and critical flags;
//   - anyone with the decide action may request an amendment or reject a term
//     at any severity;
//   - not_a_deviation follows the accept rule.
//
// The REAL handlers, auth gates, check, audit and comparator run against an
// in-memory Supabase. The terms pass (plan PR 11) is a fixture. Every name,
// id and clause is invented.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMemoryDb, callHandler } from "./test-memory-supabase";

const H = vi.hoisted(() => ({ db: null, ctx: null, termsPass: null, decisionWrites: [] }));

vi.mock("../api/_lib/auth.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, resolveContext: vi.fn(async () => H.ctx) };
});
// Every handler reads the database through this client. Any update, upsert
// or delete aimed at order_term_decisions is recorded, so the append-only
// rule is tested on what the code does, not on what it says.
vi.mock("../api/_lib/supabase.js", () => ({
  serviceClient: () => {
    const svc = H.db.svc();
    return {
      ...svc,
      from: (table) => {
        const b = svc.from(table);
        if (table !== "order_term_decisions") return b;
        return new Proxy(b, {
          get(target, prop) {
            if (prop === "update" || prop === "upsert" || prop === "delete") H.decisionWrites.push(prop);
            return target[prop];
          },
        });
      },
    };
  },
}));
vi.mock("../api/_lib/terms/terms-pass-hook.js", () => ({ loadTermsPass: async () => H.termsPass }));

const { default: termsHandler } = await import("../api/orders/terms.js");
const { default: checkHandler } = await import("../api/orders/terms_check.js");
const { default: decideHandler } = await import("../api/orders/terms_decide.js");

const T1 = "10000000-0000-4000-8000-000000000001";
const T2 = "20000000-0000-4000-8000-000000000002";
const u = (n) => "00000000-0000-4000-8000-0000000000" + n;
const ENG = u("a1"), MGR = u("a2"), ADMIN = u("a3"), VIEWER = u("a4"), OPERATOR = u("a5"), FOREIGN = u("b1");
const CUST = u("c1");
const O1 = u("d1");
const Q1 = u("e1");
const DOC = u("f1");

const clause = (key, text, extra = {}) => ({ clause: key, side: "po", text, value: null, provenance: "po_text", document_id: DOC, page: 3, verified: true, method: "llm:terms_pass@v1", ...extra });
// What PR 11 returns for a PO it read in full.
const passResult = () => ({
  po_terms_status: "read",
  po_text_source: "text_layer",
  prompt_version: "terms_pass@v1",
  po_clauses: [
    clause("payment_terms", "Payment: 60 days from the date of GRN"),
    clause("ld_penalty", "Liquidated damages at 1% per day of delay."),
    clause("warranty", "Warranty 18 months from dispatch."),
  ],
});

const seed = (mode = "on", policy = null) => {
  H.db = createMemoryDb({
    tenant_settings: [
      { tenant_id: T1, terms_check_mode: mode, terms_policy: policy },
      { tenant_id: T2, terms_check_mode: "on", terms_policy: null },
    ],
    customers: [{ id: CUST, tenant_id: T1, default_payment_terms: null, default_incoterms: null }],
    orders: [{
      id: O1, tenant_id: T1, status: "DRAFT", customer_id: CUST, po_number: "PO-D1", po_date: "2026-09-20",
      preflight_payload: { source_document_id: DOC },
      result: { salesOrder: { lineItems: [] }, quoteReconciliation: { quotes_used: [{ quote_id: Q1, quote_number: "Q-1" }] } },
    }],
    quotes: [{ id: Q1, tenant_id: T1, customer_id: CUST, quote_number: "Q-1", status: "SENT", ingest_source: "document", terms: "30 days from invoice", incoterm: "FCA Chennai" }],
    order_documents: [],
    order_term_checks: [],
    order_term_flags: [],
    order_term_decisions: [],
    audit_events: [],
    processing_events: [],
  }, {}, { project: true });
};

const as = (userId, role, tenantId = T1) => { H.ctx = { user: { id: userId }, tenantId, role }; };
const recheck = () => callHandler(checkHandler, { method: "POST", body: { order_id: O1 } });
const view = (extra = {}) => callHandler(termsHandler, { query: { order_id: O1, ...extra } });
const decide = (flagId, decision, reason = "Agreed with the buyer on the phone today.") =>
  callHandler(decideHandler, { method: "POST", body: { order_id: O1, flag_id: flagId, decision, reason } });
const currentFlags = () => H.db.tables.order_term_flags.filter((f) => !f.superseded_at);
const flagOf = (key) => currentFlags().find((f) => f.clause === key);
const decisions = () => H.db.tables.order_term_decisions;

beforeEach(async () => {
  seed("on");
  H.decisionWrites = [];
  H.termsPass = vi.fn(async () => passResult());
  as(ENG, "sales_engineer");
  await recheck();
});

describe("the fixture", () => {
  it("has one flag at each severity", () => {
    expect(Object.fromEntries(currentFlags().map((f) => [f.clause, f.severity]))).toEqual({
      ld_penalty: "critical", payment_terms: "high", warranty: "warn", incoterm: "info",
    });
  });
});

describe("a reason is required", () => {
  it("refuses a decision with no reason, a blank one, or one too short to say why", async () => {
    for (const reason of [null, "", "      ", "ok fine"]) {
      const r = await decide(flagOf("warranty").id, "accept", reason);
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("REASON_REQUIRED");
    }
    expect(decisions()).toEqual([]);
  });

  it("refuses a decision that is not one of the four", async () => {
    const r = await decide(flagOf("warranty").id, "approve");
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("BAD_DECISION");
  });
});

describe("decision 2: who may decide what", () => {
  it("an engineer may accept a warn flag", async () => {
    const r = await decide(flagOf("warranty").id, "accept", "  Standard for this buyer; covered by our margin.  ");
    expect(r.status).toBe(200);
    expect(r.body.flag).toMatchObject({ state: "decided", decision: { decision: "accept", decided_by: ENG, decided_role: "sales_engineer" } });
    // Stored trimmed.
    expect(decisions()).toEqual([expect.objectContaining({
      tenant_id: T1, order_id: O1, flag_id: flagOf("warranty").id, decision: "accept",
      reason: "Standard for this buyer; covered by our margin.", decided_by: ENG, decided_role: "sales_engineer",
    })]);
  });

  it("an engineer may not accept, or call not a deviation, a high or critical flag (403)", async () => {
    for (const [key, d] of [["payment_terms", "accept"], ["ld_penalty", "accept"], ["ld_penalty", "not_a_deviation"], ["payment_terms", "not_a_deviation"]]) {
      const r = await decide(flagOf(key).id, d);
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe("ACTION_FORBIDDEN");
      expect(r.body.error.message).toContain("order.terms_accept_high");
    }
    expect(decisions()).toEqual([]);
  });

  it("an engineer may request an amendment on a critical flag, and reject a high term", async () => {
    const a = await decide(flagOf("ld_penalty").id, "request_amendment", "Ask the buyer to cap LD at 5% of the order value.");
    expect(a.status).toBe(200);
    expect(a.body.flag.state).toBe("amendment_requested");
    const b = await decide(flagOf("payment_terms").id, "reject_term", "We cannot carry 60 days from GRN on this order.");
    expect(b.status).toBe(200);
    expect(b.body.flag.state).toBe("decided");
  });

  it("a manager may accept a critical flag and call a high one not a deviation", async () => {
    as(MGR, "sales_manager");
    expect((await decide(flagOf("ld_penalty").id, "accept", "Accepted for this strategic order, signed off.")).status).toBe(200);
    expect((await decide(flagOf("payment_terms").id, "not_a_deviation", "Same terms as our standing agreement.")).status).toBe(200);
    expect(decisions().map((d) => [d.decision, d.decided_role])).toEqual([["accept", "sales_manager"], ["not_a_deviation", "sales_manager"]]);
  });

  it("an admin may accept a critical flag", async () => {
    as(ADMIN, "admin");
    expect((await decide(flagOf("ld_penalty").id, "accept")).status).toBe(200);
  });

  it("roles without the decide action may not decide at all", async () => {
    as(VIEWER, "viewer");
    expect((await decide(flagOf("warranty").id, "reject_term")).status).toBe(403);
    as(OPERATOR, "operator");
    expect((await decide(flagOf("warranty").id, "reject_term")).status).toBe(403);
    expect(decisions()).toEqual([]);
  });

  it("GET offers each caller exactly the decisions it may make", async () => {
    const allowed = (body) => Object.fromEntries(body.flags.map((f) => [f.clause, f.allowed]));
    const eng = allowed((await view()).body);
    expect(eng.ld_penalty).toEqual(["request_amendment", "reject_term"]);
    expect(eng.payment_terms).toEqual(["request_amendment", "reject_term"]);
    expect(eng.warranty).toEqual(["accept", "request_amendment", "reject_term", "not_a_deviation"]);
    as(MGR, "sales_manager");
    expect(allowed((await view()).body).ld_penalty).toEqual(["accept", "request_amendment", "reject_term", "not_a_deviation"]);
    as(VIEWER, "viewer");
    expect(allowed((await view()).body).warranty).toEqual([]);
  });

  it("a tenant policy may require a manager to accept a clause at any severity, and never loosen", async () => {
    seed("on", { clauses: { warranty: { accept_requires: "order.terms_accept_high" }, ld_penalty: { accept_requires: "order.terms_decide" } } });
    as(ENG, "sales_engineer");
    await recheck();
    expect((await decide(flagOf("warranty").id, "accept")).status).toBe(403);
    expect((await decide(flagOf("warranty").id, "request_amendment")).status).toBe(200);
    // A policy naming the plain decide action does not let an engineer accept critical.
    expect((await decide(flagOf("ld_penalty").id, "accept")).status).toBe(403);
  });
});

describe("append-only, with the whole history", () => {
  it("a changed mind is a new row; the earlier row is untouched and the newest is current", async () => {
    const id = flagOf("ld_penalty").id;
    await decide(id, "request_amendment", "Ask the buyer to cap LD at 5% of the order value.");
    const first = { ...decisions()[0] };
    as(MGR, "sales_manager");
    await decide(id, "accept", "Buyer refused the cap; accepted for this order only.");
    expect(decisions()).toHaveLength(2);
    expect(decisions()[0]).toEqual(first);
    expect(H.decisionWrites).toEqual([]);

    const f = (await view()).body.flags.find((x) => x.id === id);
    expect(f.decision).toMatchObject({ decision: "accept", decided_role: "sales_manager" });
    expect(f.decisions.map((d) => d.decision)).toEqual(["accept", "request_amendment"]);
    expect(f.state).toBe("decided");
  });

  it("each decision writes an audit row and a timeline event, without the reason or the wording", async () => {
    const flag = flagOf("warranty");
    await decide(flag.id, "accept", "Standard for this buyer; covered by our margin.");
    const audit = H.db.tables.audit_events.filter((a) => a.action === "order_term_decided");
    expect(audit).toEqual([expect.objectContaining({
      object_type: "order", object_id: O1, actor: ENG,
      detail: { flag_id: flag.id, clause: "warranty", severity: "warn", decision: "accept" },
    })]);
    const events = H.db.tables.processing_events.filter((e) => e.event_type === "term_decided");
    expect(events).toEqual([expect.objectContaining({ case_id: O1, object_id: O1, detail: { flag_id: flag.id, clause: "warranty", severity: "warn", decision: "accept" } })]);
    expect(JSON.stringify([audit, events])).not.toContain("margin");
    expect(JSON.stringify([audit, events])).not.toContain("18 months");
  });

  it("a flag a newer check replaced is refused", async () => {
    const old = flagOf("payment_terms").id;
    H.db.tables.quotes[0].terms = "45 days from invoice";
    await recheck();
    const r = await decide(old, "reject_term");
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("FLAG_SUPERSEDED");
  });
});

describe("a re-run carries a decision only when nothing it judged has changed", () => {
  it("unchanged wording keeps the decision; changed wording reopens the flag", async () => {
    const warranty = flagOf("warranty").id;
    const payment = flagOf("payment_terms").id;
    await decide(warranty, "accept", "Standard for this buyer; covered by our margin.");
    await decide(payment, "reject_term", "We cannot carry 60 days from GRN on this order.");
    H.db.tables.quotes[0].terms = "45 days from invoice";
    expect((await recheck()).body.ran).toBe("checked");

    const g = (await view()).body;
    const w = g.flags.find((f) => f.clause === "warranty");
    expect(w.id).not.toBe(warranty);
    expect(w).toMatchObject({ state: "decided", decision: { decision: "accept", decided_by: ENG } });
    expect(w.decision.carried_from).toBe(decisions().find((d) => d.flag_id === warranty).id);
    const p = g.flags.find((f) => f.clause === "payment_terms");
    expect(p).toMatchObject({ state: "undecided", decision: null, decisions: [] });
  });

  it("a policy that lifts a flag above what its decider may accept reopens it", async () => {
    await decide(flagOf("warranty").id, "accept", "Standard for this buyer; covered by our margin.");
    H.db.tables.tenant_settings[0].terms_policy = { version: 2, clauses: { warranty: { severity: { po_only: "high" } } } };
    await recheck();
    const w = (await view()).body.flags.find((f) => f.clause === "warranty");
    expect(w).toMatchObject({ severity: "high", state: "undecided", decision: null });
  });
});

describe("modes, migration and tenancy", () => {
  it("shadow: an engineer sees nothing and may not decide; an admin may", async () => {
    seed("shadow");
    as(ENG, "sales_engineer");
    await recheck();
    expect((await view()).body).toMatchObject({ visible: false, flags: [] });
    const r = await decide(currentFlags()[0].id, "reject_term");
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("TERMS_SHADOW");
    as(ADMIN, "admin");
    expect((await decide(currentFlags()[0].id, "not_a_deviation")).status).toBe(200);
  });

  it("off: no decision is taken", async () => {
    H.db.tables.tenant_settings[0].terms_check_mode = "off";
    const r = await decide(flagOf("warranty").id, "accept");
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("TERMS_CHECK_OFF");
  });

  it("before migration 250: 409 MIGRATION_NOT_APPLIED", async () => {
    H.db.failRead.tenant_settings = { code: "42703", message: "column tenant_settings.terms_check_mode does not exist" };
    const r = await decide(flagOf("warranty").id, "accept");
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: "MIGRATION_NOT_APPLIED", migration: "250_order_terms.sql" });
  });

  it("another tenant cannot decide this tenant's flag", async () => {
    as(FOREIGN, "sales_manager", T2);
    const r = await decide(flagOf("ld_penalty").id, "accept");
    expect(r.status).toBe(404);
    expect(decisions()).toEqual([]);
  });
});
