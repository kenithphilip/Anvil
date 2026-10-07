// Chat complaints: one shared classifier, and a complaint is never an order.
//
// WhatsApp, Slack and Teams messages are classified by keywords. Both chat
// entry points (inbound/process_messages.js, which drains inbound_messages,
// and the legacy token-gated whatsapp/inbound.js) used to carry their own
// copy of a list with no complaint bucket. A complaint was filed as `other`
// and marked resolved with no record, and a complaint that named a price or
// a PO became a DRAFT order.
//
// Covered here:
//   - the shared classifier (_lib/chat-intent.js) on its own;
//   - process_messages: a complaint writes the email path's inbound_complaint
//     event, creates no order, and leaves the message un-resolved but off the
//     queue; an order message still drafts its order;
//   - the legacy webhook: same complaint event, no order, no bundling;
//   - both entry points call the shared classifier.
// In-memory Supabase fake. Invented fixtures only.

import { describe, it, expect, beforeEach, vi } from "vitest";

const H = vi.hoisted(() => {
  process.env.WHATSAPP_INBOUND_TOKEN = "test-inbound-token";
  return { store: {}, seq: 0 };
});

vi.mock("../api/_lib/auth.js", () => ({
  resolveContext: vi.fn(async () => ({ user: { id: "u-1" }, tenantId: "t-1", role: "admin" })),
  requirePermission: vi.fn(() => {}),
}));
vi.mock("../api/_lib/chat-intent.js", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, classifyChatIntent: vi.fn(real.classifyChatIntent) };
});
vi.mock("../api/_lib/supabase.js", () => ({
  serviceClient: () => ({
    from(table) {
      H.store[table] = H.store[table] || [];
      const q = {
        _op: "select", _filters: [], _payload: null, _select: false, _limit: null,
        select() { this._select = true; return this; },
        insert(p) { this._op = "insert"; this._payload = p; return this; },
        update(p) { this._op = "update"; this._payload = p; return this; },
        eq(col, val) { this._filters.push((r) => r[col] === val); return this; },
        in(col, arr) { this._filters.push((r) => arr.includes(r[col])); return this; },
        gte(col, val) { this._filters.push((r) => String(r[col]) >= String(val)); return this; },
        order() { return this; },
        limit(n) { this._limit = n; return this; },
        _exec(single) {
          const store = H.store[table];
          const hit = () => store.filter((r) => this._filters.every((f) => f(r)));
          let data = null;
          if (this._op === "select") {
            let rows = hit();
            if (this._limit != null) rows = rows.slice(0, this._limit);
            data = single ? (rows[0] || null) : rows.map((r) => ({ ...r }));
          } else if (this._op === "insert") {
            const items = Array.isArray(this._payload) ? this._payload : [this._payload];
            const out = items.map((it) => { const rec = { id: it.id || table + "-" + (++H.seq), ...it }; store.push(rec); return rec; });
            data = this._select ? (single ? out[0] : out) : null;
          } else if (this._op === "update") {
            for (const r of hit()) Object.assign(r, this._payload);
          }
          return Promise.resolve({ data, error: null });
        },
        single() { const self = this; return { then: (res, rej) => self._exec(1).then(res, rej) }; },
        maybeSingle() { const self = this; return { then: (res, rej) => self._exec(1).then(res, rej) }; },
        then(resolve, reject) { return this._exec(0).then(resolve, reject); },
      };
      return q;
    },
  }),
}));

const { classifyChatIntent } = await import("../api/_lib/chat-intent.js");
const { default: processMessages } = await import("../api/inbound/process_messages.js");
const { default: whatsappInbound } = await import("../api/whatsapp/inbound.js");

const makeRes = () => ({
  statusCode: 200, body: null,
  setHeader() { return this; },
  status(c) { this.statusCode = c; return this; },
  send(p) { this.body = p; return this; },
  end(p) { if (p != null) this.body = p; return this; },
});
const parsed = (res) => (typeof res.body === "string" ? JSON.parse(res.body) : res.body);

const drain = async () => {
  const res = makeRes();
  await processMessages({ method: "POST", headers: {}, url: "/api/inbound/process_messages", query: {}, body: {} }, res);
  return { statusCode: res.statusCode, body: parsed(res) };
};

const postWhatsapp = async (twilioBody) => {
  const res = makeRes();
  await whatsappInbound({
    method: "POST",
    headers: { "x-anvil-tenant": "t-1" },
    query: { token: "test-inbound-token" },
    body: twilioBody,
  }, res);
  return { statusCode: res.statusCode, body: parsed(res) };
};

const chatMsg = (id, text, extra = {}) => ({
  id, tenant_id: "t-1", channel: "whatsapp", external_id: "ext-" + id, thread_external_id: "thr-" + id,
  sender_handle: "+910000000" + id.slice(-3), sender_name: "Buyer " + id, text_body: text,
  customer_id: "cust-1", status: "arrived", received_at: "2026-10-01T10:00:00Z", ...extra,
});

const DEFECT_PRICE = "the gun you supplied is defective, send price for replacement";

beforeEach(() => {
  H.seq = 0;
  H.store = { inbound_messages: [], orders: [], processing_events: [], audit_events: [], documents: [] };
  classifyChatIntent.mockClear();
});

// ── The shared classifier ──────────────────────────────────────────────────

describe("classifyChatIntent", () => {
  it("does not read an ordinary PO as a complaint", () => {
    expect(classifyChatIntent("PO issued")).toBe("purchase_order");
    expect(classifyChatIntent("Please find our PO 7781 attached")).toBe("purchase_order");
    expect(classifyChatIntent("PO issued with revised rates")).not.toBe("complaint");
  });

  it("reads a defect report as a complaint even when it asks for a price", () => {
    expect(classifyChatIntent(DEFECT_PRICE)).toBe("complaint");
    expect(classifyChatIntent("Wrong part received against PO 4410, please send the price")).toBe("complaint");
  });

  it.each([
    "We have a complaint about the last lot",
    "The customer complained twice",
    "Two defects found on inspection",
    "Gun not working since Monday",
    "Tip holder broken on arrival",
    "Cooling line is leaking",
    "Leakage at the coupling",
    "Repeated failure of the cable",
    "Received damaged in transit",
    "Wrong parts in the box",
    "This unit is under warranty, please check",
    "Raising a warranty claim for gun 12",
    "We have an issue with the controller",
  ])("reads %j as a complaint", (text) => {
    expect(classifyChatIntent(text)).toBe("complaint");
  });

  it.each([
    ["please replace PO 4501 with the attached", "purchase_order"],
    ["Need quote for 50 replacement tips", "quote_request"],
    ["PO terms: 12 months warranty", "purchase_order"],
    ["Quote for leakproof seals", "quote_request"],
    ["Quote for unbroken pallets", "quote_request"],
  ])("keeps the order language %j out of the complaint bucket", (text, intent) => {
    expect(classifyChatIntent(text)).toBe(intent);
  });

  it("leaves the order buckets as they were", () => {
    expect(classifyChatIntent("Need quote for WGC-K12464 qty 50")).toBe("quote_request");
    expect(classifyChatIntent("Please amend PO 7781 line 2")).toBe("po_revision");
    expect(classifyChatIntent("Where is my delivery")).toBe("status_request");
    expect(classifyChatIntent("hello there")).toBe("other");
  });
});

// ── process_messages (Slack, Teams, newer WhatsApp) ────────────────────────

describe("process_messages: complaints", () => {
  it("writes the email path's inbound_complaint event and creates no order", async () => {
    H.store.inbound_messages = [chatMsg("m-101", DEFECT_PRICE)];
    const out = await drain();
    expect(out.statusCode).toBe(200);

    expect(H.store.orders).toHaveLength(0);
    expect(H.store.processing_events).toHaveLength(1);
    const ev = H.store.processing_events[0];
    expect(ev).toMatchObject({
      tenant_id: "t-1",
      case_id: "m-101",
      event_type: "inbound_complaint",
      object_type: "inbound_message",
      object_id: "m-101",
    });
    expect(ev.detail).toEqual({ from: "+910000000101", subject: DEFECT_PRICE, severity: "warn" });
  });

  it("leaves the complaint un-resolved but takes it off the queue", async () => {
    H.store.inbound_messages = [chatMsg("m-102", "Tip holder broken on arrival")];
    await drain();
    const msg = H.store.inbound_messages[0];
    expect(msg.status).toBe("intake-extracted");
    expect(msg.status).not.toBe("resolved");
    expect(msg.processed_at).toBeTruthy();
    expect(msg.linked_order_id).toBeUndefined();

    // A second drain does not record it again.
    await drain();
    expect(H.store.processing_events).toHaveLength(1);
  });

  it("still drafts an order for an ordinary order message", async () => {
    H.store.inbound_messages = [chatMsg("m-103", "Please find our PO 7781 for 50 nos WGC-K12464")];
    await drain();
    expect(H.store.orders).toHaveLength(1);
    expect(H.store.orders[0]).toMatchObject({ tenant_id: "t-1", status: "DRAFT", customer_id: "cust-1" });
    expect(H.store.orders[0].preflight_payload.intent).toBe("purchase_order");
    const msg = H.store.inbound_messages[0];
    expect(msg.status).toBe("linked");
    expect(msg.linked_order_id).toBe(H.store.orders[0].id);
    expect(H.store.processing_events).toHaveLength(0);
  });

  it("routes a mixed batch: the complaint to an event, the order to an order", async () => {
    H.store.inbound_messages = [
      chatMsg("m-104", "Need quote for WGC-K12464 qty 50"),
      chatMsg("m-105", "Cooling line is leaking again"),
    ];
    await drain();
    expect(H.store.orders.map((o) => o.preflight_payload.inbound_message_id)).toEqual(["m-104"]);
    expect(H.store.processing_events.map((e) => e.case_id)).toEqual(["m-105"]);
  });
});

// ── The legacy WhatsApp webhook ────────────────────────────────────────────

describe("whatsapp/inbound (legacy): complaints", () => {
  it("records a complaint with no order", async () => {
    const out = await postWhatsapp({ From: "whatsapp:+919800000001", Body: DEFECT_PRICE, MessageSid: "SM-test-1" });
    expect(out.statusCode).toBe(200);
    expect(out.body).toMatchObject({ ok: true, order_id: null, bundled: false, intent: "complaint" });
    expect(H.store.orders).toHaveLength(0);

    expect(H.store.processing_events).toHaveLength(1);
    const ev = H.store.processing_events[0];
    expect(ev).toMatchObject({
      tenant_id: "t-1",
      case_id: "SM-test-1",
      event_type: "inbound_complaint",
      object_type: "whatsapp_message",
      object_id: "SM-test-1",
    });
    expect(ev.detail).toMatchObject({ from: "+919800000001", subject: DEFECT_PRICE, severity: "warn" });
  });

  it("does not bundle a complaint into the sender's open DRAFT order", async () => {
    H.store.orders = [{
      id: "ord-open", tenant_id: "t-1", status: "DRAFT", created_at: new Date().toISOString(),
      preflight_payload: { source: "whatsapp_inbound", from: "+919800000002", intent: "purchase_order" },
    }];
    const out = await postWhatsapp({ From: "whatsapp:+919800000002", Body: "Gun not working since Monday", MessageSid: "SM-test-2" });
    expect(out.body).toMatchObject({ order_id: null, bundled: false, intent: "complaint" });
    expect(H.store.orders).toHaveLength(1);
    expect(H.store.audit_events.some((a) => a.object_id === "ord-open")).toBe(false);
  });

  it("still drafts an order for an ordinary order message", async () => {
    const out = await postWhatsapp({ From: "whatsapp:+919800000003", Body: "Please find our PO 7781", MessageSid: "SM-test-3" });
    expect(out.statusCode).toBe(200);
    expect(out.body.intent).toBe("purchase_order");
    expect(out.body.order_id).toBeTruthy();
    expect(H.store.orders).toHaveLength(1);
    expect(H.store.orders[0]).toMatchObject({ tenant_id: "t-1", status: "DRAFT" });
    expect(H.store.processing_events.some((e) => e.event_type === "inbound_complaint")).toBe(false);
  });
});

// ── One classifier for both entry points ───────────────────────────────────

describe("both chat entry points use the shared classifier", () => {
  it("process_messages classifies through _lib/chat-intent.js", async () => {
    H.store.inbound_messages = [chatMsg("m-201", "Need quote for WGC-K12464 qty 50")];
    await drain();
    expect(classifyChatIntent).toHaveBeenCalledWith("Need quote for WGC-K12464 qty 50");
  });

  it("the legacy WhatsApp webhook classifies through _lib/chat-intent.js", async () => {
    await postWhatsapp({ From: "whatsapp:+919800000004", Body: "Tip holder broken on arrival", MessageSid: "SM-test-4" });
    expect(classifyChatIntent).toHaveBeenCalledWith("Tip holder broken on arrival");
  });
});
