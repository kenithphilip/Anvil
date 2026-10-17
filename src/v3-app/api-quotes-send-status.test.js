// POST /api/quotes/send sends the quote email in the same request and reports
// whether it left.
//
// The handler used to insert the email as `queued` and answer ok: true while
// the drawer said "Quote sent to customer". Queued email drains only through
// the agents/run reaper, which runs only for tenants with a due agent goal, so
// the email left days late or never, and the quote was already SENT.
//
// Now it sends through the shared send core, the path invoices/send uses. The
// quote moves to SENT (and arms its follow-up goals) only when a provider
// accepted the email. When it was not sent the quote keeps its status and the
// email row is failed, not queued, so the reaper can never send a stale quote
// later or send it twice after a retry.
//
// Runs the real handler and the real send core. The mail provider, the PDF
// renderer, storage, the audit writer and the database are faked. Invented
// fixtures.

import { describe, it, expect, beforeEach, vi } from "vitest";

const H = vi.hoisted(() => ({ ctx: null, store: null, seq: 0, sendEmail: null }));

vi.mock("../api/_lib/auth.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, resolveContext: vi.fn(async () => H.ctx) };
});

vi.mock("../api/_lib/mailer.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, sendEmail: (...args) => H.sendEmail(...args) };
});

vi.mock("../api/_lib/pdf-renderer.js", () => ({
  renderQuote: vi.fn(async () => Buffer.from("%PDF-1.4 test")),
}));

vi.mock("../api/_lib/storage.js", () => ({
  documentsBucket: () => "documents",
  ensureDocumentsBucket: async () => "documents",
  friendlyStorageError: (m) => m,
}));

vi.mock("../api/_lib/audit.js", () => ({
  recordAudit: vi.fn(async () => {}),
  recordEvent: vi.fn(async () => {}),
}));

// In-memory PostgREST stand-in: select / insert / update with eq and in
// filters, single / maybeSingle, and a thenable for plain awaits.
const makeSvc = () => ({
  from(table) {
    const rows = () => (H.store[table] = H.store[table] || []);
    const q = {
      _f: [], _op: "select", _payload: null,
      select() { return this; },
      eq(c, v) { this._f.push((r) => r[c] === v); return this; },
      in(c, vs) { this._f.push((r) => vs.includes(r[c])); return this; },
      order() { return this; },
      limit() { return this; },
      insert(p) { this._op = "insert"; this._payload = p; return this; },
      update(p) { this._op = "update"; this._payload = p; return this; },
      _run() {
        if (this._op === "insert") {
          return (Array.isArray(this._payload) ? this._payload : [this._payload]).map((p) => {
            H.seq += 1;
            const created = { id: table + "-" + H.seq, ...p };
            rows().push(created);
            return created;
          });
        }
        const hit = rows().filter((r) => this._f.every((fn) => fn(r)));
        if (this._op === "update") for (const r of hit) Object.assign(r, this._payload);
        return hit;
      },
      single() { const d = this._run(); return Promise.resolve(d[0] ? { data: d[0], error: null } : { data: null, error: { message: "no rows" } }); },
      maybeSingle() { const d = this._run(); return Promise.resolve({ data: d[0] || null, error: null }); },
      then(res, rej) { return Promise.resolve({ data: this._run(), error: null }).then(res, rej); },
    };
    return q;
  },
  storage: {
    from: () => ({
      upload: async () => ({ data: {}, error: null }),
      createSignedUrl: async () => ({ data: { signedUrl: "https://files.test/q.pdf" }, error: null }),
    }),
  },
});

vi.mock("../api/_lib/supabase.js", () => ({
  serviceClient: () => makeSvc(),
  userClient: () => ({}),
}));

const { default: handler } = await import("../api/quotes/send.js");

const post = async (body) => {
  const res = {
    statusCode: 200, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = JSON.stringify(o); return this; },
    send(p) { this.body = p; return this; },
    end(p) { if (p != null) this.body = p; return this; },
  };
  await handler({ method: "POST", headers: {}, url: "/api/quotes/send", body }, res);
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
};

const quote = () => H.store.quotes.find((r) => r.id === "q-1");
const NO_PROVIDER = async () => ({ ok: false, provider: null, skipped: true, reason: "not_configured" });

beforeEach(() => {
  H.seq = 0;
  H.ctx = { user: { id: "u-mgr" }, tenantId: "t-1", role: "sales_manager" };
  H.sendEmail = vi.fn(async () => ({ ok: true, provider: "resend", status: 200 }));
  H.store = {
    quotes: [{
      id: "q-1", tenant_id: "t-1", customer_id: "c-1", quote_number: "Q-202610-0001", version: 1,
      status: "DRAFT", currency: "INR", subtotal: 1000, tax_total: 180, grand_total: 1180,
      validity_days: 30, created_at: "2026-10-10T09:00:00Z", line_items: [],
    }],
    quote_lines: [{ id: "ql-1", tenant_id: "t-1", quote_id: "q-1", line_index: 0, part_no: "NZ-100", description: "Nozzle", qty: 2, unit_price: 500 }],
    customers: [{ id: "c-1", tenant_id: "t-1", customer_name: "Acme Test Works", contact_email: "buyer@acme.test" }],
    tenants: [{ id: "t-1", display_name: "Seller Test" }],
    tenant_settings: [],
    price_composition_lines: [],
    portal_tokens: [],
    agent_goals: [],
    communications: [],
  };
});

describe("POST /api/quotes/send: direct send", () => {
  it("sends in the same request, then marks the quote SENT and arms its goals", async () => {
    const r = await post({ id: "q-1" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, sent: true, status: "sent", error: null, provider: "resend" });
    expect(H.sendEmail).toHaveBeenCalledTimes(1);
    expect(H.sendEmail.mock.calls[0][0].to).toBe("buyer@acme.test");

    const comm = H.store.communications.find((c) => c.id === r.body.communication_id);
    expect(comm).toMatchObject({ tenant_id: "t-1", object_id: "q-1", document_type: "quote_email", status: "sent" });
    expect(quote().status).toBe("SENT");
    expect(quote().sent_at).toBeTruthy();
    expect(quote().payload_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.body.quote.status).toBe("SENT");
    expect(H.store.agent_goals.map((g) => g.goal_type).sort()).toEqual(["expiring_quote_nudge", "quote_accept_within_14d"]);
  });

  it("with no mail provider says not sent, keeps the quote a DRAFT and leaves nothing queued", async () => {
    H.sendEmail = vi.fn(NO_PROVIDER);
    const r = await post({ id: "q-1" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, sent: false, status: "failed" });
    expect(r.body.error).toMatch(/No provider is configured/);
    expect(r.body.quote.status).toBe("DRAFT");

    expect(quote().status).toBe("DRAFT");
    expect(quote().sent_at).toBeUndefined();
    expect(H.store.agent_goals).toEqual([]);
    // The agents/run reaper reads status = 'queued' only. A row left queued
    // would be sent later, stale, by a tick the operator never sees.
    expect(H.store.communications.map((c) => c.status)).toEqual(["failed"]);
    expect(H.store.communications[0].metadata.not_sent_reason).toMatch(/No provider is configured/);
  });

  it("a provider refusal says not sent with the provider's status and keeps the quote a DRAFT", async () => {
    H.sendEmail = vi.fn(async () => ({ ok: false, provider: "resend", status: 422, detail: "invalid from" }));
    const r = await post({ id: "q-1" });
    expect(r.body).toMatchObject({ sent: false, status: "failed", error: "Provider resend returned 422" });
    expect(quote().status).toBe("DRAFT");
    expect(H.store.agent_goals).toEqual([]);
  });

  it("a retry after a failed send reaches the customer once, and only the retry is sent", async () => {
    H.sendEmail = vi.fn(NO_PROVIDER);
    const first = await post({ id: "q-1" });
    expect(first.body.sent).toBe(false);

    const delivered = [];
    H.sendEmail = vi.fn(async (msg) => { delivered.push(msg.to); return { ok: true, provider: "resend", status: 200 }; });
    const second = await post({ id: "q-1" });
    expect(second.body.sent).toBe(true);

    expect(delivered).toEqual(["buyer@acme.test"]);
    expect(H.store.communications.map((c) => c.status).sort()).toEqual(["failed", "sent"]);
    expect(H.store.communications.filter((c) => c.status === "queued")).toEqual([]);
    expect(quote().status).toBe("SENT");
  });
});
