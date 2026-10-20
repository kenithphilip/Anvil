// /api/orders/handoff: the Mode B handoff to the order processing team
// (docs/SO_TERMS_AND_HANDOFF_SCOPE.md 8.2 to 8.6; plan PR 16, cohesion C-18).
// Requests go through the real router. auth.js is real apart from
// resolveContext, so the write verb and the order.handoff action are the real
// gates. The send core (comms-send.js), the recipient resolver, the SO
// document loader and the audit are real; the database, the mail provider
// and the PDF renderer are in-memory stand-ins. Invented fixtures.

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  T1, T2, ENGINEER, ORDER, ORDER_T2, PRICES, freshState, asEngineer, settingsOf, orderOf, handoffComms, callRoute,
} from "./test-support/handoff-harness.js";

const H = vi.hoisted(() => ({ s: null }));

vi.mock("../api/_lib/auth.js", async (orig) => ({ ...(await orig()), resolveContext: vi.fn(async () => H.s.ctx) }));
vi.mock("../api/_lib/supabase.js", async () => {
  const { makeSvc } = await import("./test-support/handoff-harness.js");
  return { serviceClient: () => makeSvc(H.s), userClient: () => ({}) };
});
vi.mock("../api/_lib/mailer.js", async (orig) => {
  const { fakeSendEmail } = await import("./test-support/handoff-harness.js");
  return { ...(await orig()), sendEmail: (msg) => fakeSendEmail(H.s)(msg) };
});
vi.mock("../api/_lib/pdf-renderer.js", async (orig) => ({
  ...(await orig()),
  renderSalesOrder: vi.fn(async (data) => { H.s.pdf.push(data); return Buffer.from("%PDF handoff"); }),
}));
vi.mock("../api/_lib/graph-client.js", async (orig) => ({ ...(await orig()), graphIsConnected: () => H.s.graphOn }));

const { dispatch } = await import("../api/router.js");
const { SERVER_ACTIONS, hasAction } = await import("../api/_lib/auth.js");
const { ACTIONS } = await import("./lib/rbac");
const { lineOrigin, originGroups } = await import("../api/_lib/order-handoff.js");

const get = (query = { order_id: ORDER }) => callRoute(dispatch, "GET", { query });
const post = (body = { order_id: ORDER }) => callRoute(dispatch, "POST", { body });

beforeEach(() => {
  H.s = freshState();
  asEngineer(H.s);
  process.env.PUBLIC_APP_URL = "https://app.example.com";
});

const ROLES = ["sales_engineer", "sales_manager", "procurement", "finance", "admin", "operator", "viewer", "design_engineer", "design_manager", "customer_support"];

describe("order.handoff: server and client parity", () => {
  const roles = ["sales_engineer", "sales_manager", "operator", "admin"];
  it("is registered in both tables with the same roles", () => {
    expect(SERVER_ACTIONS["order.handoff"]).toBeInstanceOf(Set);
    expect([...SERVER_ACTIONS["order.handoff"]].sort()).toEqual([...roles].sort());
    expect([...ACTIONS["order.handoff"]].sort()).toEqual([...roles].sort());
  });
  it("admits exactly those roles on the server", () => {
    expect(ROLES.filter((role) => hasAction({ role }, "order.handoff")).sort()).toEqual([...roles].sort());
  });
  it("refuses finance (a writer without the action) and a viewer, and sends nothing", async () => {
    H.s.ctx.role = "finance";
    const r = await post();
    expect(r.status).toBe(403);
    expect(r.body.error.message).toMatch(/order\.handoff/);
    H.s.ctx.role = "viewer";
    expect((await get()).status).toBe(403);
    expect(H.s.mail).toHaveLength(0);
    expect(handoffComms(H.s)).toHaveLength(0);
  });
});

describe("off unless the tenant turned it on, Mode B only", () => {
  it("with the flag off, GET hides the button and POST refuses", async () => {
    settingsOf(H.s).order_handoff_enabled = false;
    const g = await get();
    expect(g.status).toBe(200);
    expect(g.body).toEqual({ enabled: false, reason: "off" });
    const p = await post();
    expect(p.status).toBe(409);
    expect(p.body.error.code).toBe("HANDOFF_OFF");
    expect(H.s.mail).toHaveLength(0);
    expect(handoffComms(H.s)).toHaveLength(0);
    expect(orderOf(H.s).handoff_status).toBeNull();
  });
  it("a Mode A tenant is refused", async () => {
    settingsOf(H.s).so_processing_mode = "A";
    expect((await get()).body).toEqual({ enabled: false, reason: "not_mode_b" });
    const p = await post();
    expect(p.status).toBe(409);
    expect(p.body.error.code).toBe("NOT_MODE_B");
    expect(H.s.mail).toHaveLength(0);
  });
  it("a database without migration 251 is a 503 that names it, never 'not handed off'", async () => {
    const s = settingsOf(H.s);
    for (const k of Object.keys(s)) if (k.startsWith("order_handoff_")) delete s[k];
    const r = await get();
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe("migration_251_not_applied");
  });
});

describe("the preview (GET)", () => {
  it("prefills each field with its source, groups the lines by origin and names every recipient", async () => {
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(true);
    expect(r.body.prefill.required_by).toEqual({ value: "2026-10-30", source: "po_header" });
    expect(r.body.prefill.committed).toEqual({ value: "2026-11-05", source: "committed" });
    expect(r.body.prefill.contact).toEqual({ name: "Buyer Desk", phone: "+91 00000 11111", source: "po_buyer" });
    expect(r.body.groups.map((g) => [g.group, g.country, g.line_nos, g.default_mode])).toEqual([
      ["import", "KR", [1], "ocean"],
      ["local", "IN", [2], "road"],
    ]);
    expect(r.body.groups[0].allowed_modes).toEqual(["ocean", "air"]);
    expect(r.body.recipients.to.map((x) => [x.email, x.reason])).toEqual([["orders-desk@example.com", "listed address"]]);
    expect(r.body.recipients.cc.map((x) => [x.email, x.reason])).toEqual([["eng@example.com", "sending engineer"]]);
    expect(r.body.subject).toBe("SO entry: PO PO-T-100 / Test Buyer Ltd / 2 lines");
    expect(r.body.attachments.map((a) => a.label)).toEqual(["SO PDF", "original PO"]);
    expect(r.body.blockers).toEqual([]);
    expect(r.body.handoff).toEqual({ status: "not_sent" });
    expect(r.body.body).toContain("Anvil order: https://app.example.com/#/so?id=" + ORDER);
  });

  it("another tenant's order is not found, and nothing is written", async () => {
    const r = await post({ order_id: ORDER_T2 });
    expect(r.status).toBe(404);
    expect(H.s.writes).toHaveLength(0);
    expect(orderOf(H.s, ORDER_T2).handoff_status).toBeNull();
  });
});

describe("the send (POST)", () => {
  it("sends one email with no prices, the SO PDF and the original PO, and records it on the order", async () => {
    const r = await post();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, status: "sent" });
    expect(H.s.mail).toHaveLength(1);
    const m = H.s.mail[0];
    expect(m.to).toBe("orders-desk@example.com");
    expect(m.cc).toEqual(["eng@example.com"]);
    expect(m.subject).toBe("SO entry: PO PO-T-100 / Test Buyer Ltd / 2 lines");
    for (const price of PRICES) {
      expect(m.body).not.toContain(price);
      expect(m.subject).not.toContain(price);
    }
    expect(m.body).toContain("GC100 | customer part CP-1 | 4 NOS");
    expect(m.body).toContain("Imported lines (1): By Ocean");
    expect(m.body).toContain("Local lines (1): By Road");
    expect(m.body).toContain("Material required date: 30-Oct-26   (source: PO delivery date)");
    expect(m.attachments.map((a) => a.filename)).toEqual(["SO-PO-T-100.pdf", "po.pdf"]);

    const comm = handoffComms(H.s)[0];
    expect(comm).toMatchObject({ status: "sent", object_type: "order", order_id: ORDER, tenant_id: T1 });
    const o = orderOf(H.s);
    expect(o.handoff_status).toBe("sent");
    expect(o.handoff_comm_id).toBe(comm.id);
    expect(o.handoff_sent_at).toBeTruthy();
    expect(o.dispatch_plan.map((g) => [g.group, g.mode, g.line_nos])).toEqual([["import", "ocean", [1]], ["local", "road", [2]]]);
    // Two groups: dispatch_mode is not written, and the PDF points at the plan.
    expect(o.dispatch_mode).toBeNull();
    expect(H.s.pdf[0].dispatchedThrough).toBe("As per dispatch plan");
  });

  it("the actor is ctx.user.id, on the order and on the communication", async () => {
    await post();
    expect(orderOf(H.s).handoff_sent_by).toBe(ENGINEER);
    expect(handoffComms(H.s)[0].sent_by).toBe(ENGINEER);
  });

  it("stores the order's payload_hash at send in handoff_payload.payload_hash", async () => {
    await post();
    expect(orderOf(H.s).handoff_payload.payload_hash).toBe("hash-1");
  });

  it("the audit row holds counts and ids, no contact name or phone", async () => {
    await post();
    const a = H.s.store.audit_events.find((x) => x.action === "order_handoff_sent");
    expect(a).toBeTruthy();
    expect(a.after_payload).toMatchObject({ status: "sent", groups: [{ group: "import", mode: "ocean", lines: 1 }, { group: "local", mode: "road", lines: 1 }] });
    const text = JSON.stringify(a);
    expect(text).not.toContain("Buyer Desk");
    expect(text).not.toContain("00000 11111");
  });

  it("a one-group order writes dispatch_mode with the PDF label", async () => {
    orderOf(H.s).result.salesOrder.lineItems = [orderOf(H.s).result.salesOrder.lineItems[1]];
    await post({ order_id: ORDER, fields: { modes: { local: "hand_carry_engineer" } } });
    expect(orderOf(H.s).dispatch_mode).toBe("By Hand Carry (our engineer)");
    expect(H.s.pdf[0].dispatchedThrough).toBe("By Hand Carry (our engineer)");
  });

  it("a second click returns the first result; Send again makes a new email", async () => {
    await post();
    const again = await post();
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ idempotent: true, status: "sent" });
    expect(H.s.mail).toHaveLength(1);
    const resend = await post({ order_id: ORDER, resend: true });
    expect(resend.body.status).toBe("sent");
    expect(H.s.mail).toHaveLength(2);
    expect(handoffComms(H.s)).toHaveLength(2);
  });
});

describe("the blockers, decided again on the server", () => {
  const expectBlocked = async (body, codes, code = "HANDOFF_BLOCKED") => {
    const r = await post(body);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe(code);
    expect(r.body.error.blockers.map((b) => b.code)).toEqual(codes);
    expect(H.s.mail).toHaveLength(0);
    expect(handoffComms(H.s)).toHaveLength(0);
    expect(orderOf(H.s).handoff_status).toBeNull();
  };

  it("a blank required date or contact blocks; the engineer's values unblock it, labelled entered", async () => {
    const so = orderOf(H.s).result.salesOrder;
    delete so.customer.delivery_date;
    delete so.customer.contact_name;
    await expectBlocked({ order_id: ORDER }, ["required_by_missing", "contact_missing"]);
    const r = await post({ order_id: ORDER, fields: { required_by: "2026-12-01", contact_name: "Stores Desk" } });
    expect(r.body.status).toBe("sent");
    expect(orderOf(H.s).handoff_payload.required_by).toEqual({ value: "2026-12-01", source: "entered" });
    expect(orderOf(H.s).handoff_payload.contact).toMatchObject({ name: "Stores Desk", source: "entered" });
  });

  it("an unknown origin group has no default mode; a mode outside its group is refused", async () => {
    orderOf(H.s).result.salesOrder.lineItems.push({ part_no: "QQ77", description: "Bracket", quantity: 1, uom: "NOS" });
    await expectBlocked({ order_id: ORDER }, ["mode_missing"]);
    await expectBlocked({ order_id: ORDER, fields: { modes: { unknown: "air", import: "road" } } }, ["mode_invalid"]);
    const r = await post({ order_id: ORDER, fields: { modes: { unknown: "air" } } });
    expect(r.body.status).toBe("sent");
  });

  it("an unresolved blocking finding blocks", async () => {
    orderOf(H.s).rule_findings = [{ code: "line_count_shortfall", blocks: true, resolved: false, detail: "6 of 9 lines" }];
    await expectBlocked({ order_id: ORDER }, ["blocking_finding"]);
  });

  it("a cancelled order is not handed off", async () => {
    orderOf(H.s).status = "CANCELLED";
    await expectBlocked({ order_id: ORDER }, ["order_status"]);
  });

  it("no To recipient blocks", async () => {
    settingsOf(H.s).order_handoff_to = ["role:finance"];
    await expectBlocked({ order_id: ORDER }, ["no_recipient"]);
  });

  describe("terms (decision 3: an undecided critical flag blocks)", () => {
    const CHECK = "b0000000-0000-4000-8000-000000000001";
    const FLAG = (id, severity) => ({ id, tenant_id: T1, order_id: ORDER, check_id: CHECK, clause: "payment_terms", outcome: "deviates", severity, method: "rule" });
    beforeEach(() => {
      settingsOf(H.s).terms_check_mode = "on";
      H.s.store.order_term_checks.push({ id: CHECK, tenant_id: T1, order_id: ORDER, po_terms_status: "read", superseded_at: null, created_at: "2026-10-02T00:00:00Z" });
    });

    it("an undecided critical flag blocks with TERMS_UNDECIDED; a decision on it lets the send go", async () => {
      H.s.store.order_term_flags.push(FLAG("b0000000-0000-4000-8000-0000000000f1", "critical"));
      await expectBlocked({ order_id: ORDER }, ["terms_undecided"], "TERMS_UNDECIDED");
      H.s.store.order_term_decisions.push({ id: "dd1", tenant_id: T1, order_id: ORDER, flag_id: "b0000000-0000-4000-8000-0000000000f1", decision: "accept", reason: "agreed on the phone", decided_by: ENGINEER, decided_at: "2026-10-03T00:00:00Z" });
      const r = await post();
      expect(r.body.status).toBe("sent");
      expect(H.s.mail[0].body).toContain("Payment terms: accepted");
    });

    it("an undecided high flag does not block, and the email lists it as undecided", async () => {
      H.s.store.order_term_flags.push(FLAG("b0000000-0000-4000-8000-0000000000f2", "high"));
      const r = await post();
      expect(r.body.status).toBe("sent");
      expect(H.s.mail[0].body).toContain("Payment terms: undecided");
      expect(H.s.mail[0].body).toContain("Open flags: 1");
    });

    it("a shadow-mode check is hidden from the engineer and blocks nothing", async () => {
      settingsOf(H.s).terms_check_mode = "shadow";
      H.s.store.order_term_flags.push(FLAG("b0000000-0000-4000-8000-0000000000f3", "critical"));
      expect((await post()).body.status).toBe("sent");
    });
  });
});

describe("origin precedence (decision 6)", () => {
  it("a part marker and the quote line agree: imported", () => {
    expect(lineOrigin({ part_no: "GC1", description: "Case (O/C)", source_country: "O-CHINA" })).toMatchObject({ group: "import", country: "CN", conflict: false });
  });
  it("a part marker and the quote line disagree: unknown, with both signals", () => {
    const o = lineOrigin({ part_no: "GC1", description: "Case (O/C)", source_country: "O-INDIA" });
    expect(o.group).toBe("unknown");
    expect(o.conflict).toBe(true);
    expect(o.signals.map((s) => s.signal)).toEqual(["part_marker", "quote_line"]);
  });
  it("the item master is weak: it never overrides a stronger signal", () => {
    expect(lineOrigin({ part_no: "GC1", description: "Case (O/K)", _mapped_item: { source_country: "O-INDIA" } }).group).toBe("import");
  });
  it("the item master decides only when nothing stronger exists", () => {
    expect(lineOrigin({ part_no: "GC1", _mapped_item: { source_country: "O-JAPAN" } })).toMatchObject({ group: "import", country: "JP" });
    expect(lineOrigin({ part_no: "GC1" }).group).toBe("unknown");
  });
  it("groups keep the line numbers, and a group's country only when every line agrees", () => {
    const g = originGroups([
      { part_no: "A1", description: "x (O/K)" }, { part_no: "B2-I" }, { part_no: "C3", description: "y (O/C)" },
    ]);
    expect(g.map((x) => [x.group, x.country, x.line_nos])).toEqual([["import", null, [1, 3]], ["local", "IN", [2]]]);
  });
});

describe("tenancy", () => {
  it("every order read and write is filtered by the tenant", async () => {
    await post();
    const orderWrites = H.s.writes.filter((w) => w.table === "orders" && w.mode === "update");
    expect(orderWrites).toHaveLength(1);
    expect(orderWrites[0].filters).toContain("tenant_id=" + T1);
    expect(orderOf(H.s, ORDER_T2).handoff_status).toBeNull();
    expect(settingsOf(H.s, T2).order_handoff_to).toEqual(["t2-desk@example.com"]);
    expect(H.s.mail[0].to).not.toBe("t2-desk@example.com");
  });
});
