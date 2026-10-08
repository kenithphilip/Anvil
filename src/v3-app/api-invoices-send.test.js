// POST /api/invoices/send sends the invoice email in the same request.
//
// The screen used to queue the email here and then call
// communications.send({ id }) against a client method whose signature is
// send(id). The body became { id: { id } }, the server answered 404, and no
// invoice email was ever sent. Queued email drains only through the
// agents/run reaper, which runs only for tenants with a due agent goal.
//
// These tests run the real handler and the real send core
// (_lib/comms-send.js). Only the mail provider (_lib/mailer.js sendEmail),
// the PDF renderer and the database are faked. Invented fixtures.

import { describe, it, expect, beforeEach, vi } from "vitest";

const H = vi.hoisted(() => ({
  ctx: null,
  store: null,
  seq: 0,
  sendEmail: null,
}));

vi.mock("../api/_lib/auth.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, resolveContext: vi.fn(async () => H.ctx) };
});

vi.mock("../api/_lib/mailer.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, sendEmail: (...args) => H.sendEmail(...args) };
});

vi.mock("../api/_lib/pdf-renderer.js", () => ({
  renderInvoice: vi.fn(async () => Buffer.from("%PDF-1.4 test")),
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

// A small in-memory PostgREST stand-in: select / insert / update with
// eq filters, single / maybeSingle, and a thenable for plain awaits.
const makeSvc = () => ({
  from(table) {
    const rows = () => (H.store[table] = H.store[table] || []);
    const q = {
      _f: [], _op: "select", _payload: null,
      select() { return this; },
      eq(c, v) { this._f.push((r) => r[c] === v); return this; },
      order() { return this; },
      limit() { return this; },
      insert(p) { this._op = "insert"; this._payload = p; return this; },
      update(p) { this._op = "update"; this._payload = p; return this; },
      _run() {
        if (this._op === "insert") {
          H.seq += 1;
          const created = { id: table + "-" + H.seq, ...this._payload };
          rows().push(created);
          return [created];
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
      createSignedUrl: async () => ({ data: { signedUrl: "https://files.test/inv.pdf" }, error: null }),
    }),
  },
});

vi.mock("../api/_lib/supabase.js", () => ({
  serviceClient: () => makeSvc(),
  userClient: () => ({}),
}));

const { default: handler } = await import("../api/invoices/send.js");

const post = async (body) => {
  const res = {
    statusCode: 200, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = JSON.stringify(o); return this; },
    send(p) { this.body = p; return this; },
    end(p) { if (p != null) this.body = p; return this; },
  };
  await handler({ method: "POST", headers: {}, url: "/api/invoices/send", body }, res);
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
};

const invoice = () => H.store.invoices.find((r) => r.id === "inv-1");

beforeEach(() => {
  H.seq = 0;
  H.ctx = { user: { id: "u-fin" }, tenantId: "t-1", role: "finance" };
  H.sendEmail = vi.fn(async () => ({ ok: true, provider: "resend", status: 200 }));
  H.store = {
    invoices: [
      {
        id: "inv-1", tenant_id: "t-1", customer_id: "c-1", invoice_number: "INV-0001",
        status: "draft", issue_date: "2026-10-01", due_date: "2026-10-31",
        currency: "INR", grand_total: 1180, subtotal: 1000, tax_total: 180, line_items: [],
      },
      {
        id: "inv-other", tenant_id: "t-2", customer_id: "c-9", invoice_number: "INV-OTHER",
        status: "draft", currency: "INR", grand_total: 10,
      },
    ],
    customers: [{ id: "c-1", tenant_id: "t-1", customer_name: "Acme Test Works", contact_email: "ap@acme.test" }],
    tenants: [{ id: "t-1", display_name: "Seller Test" }],
    tenant_settings: [],
    portal_tokens: [],
    communications: [],
  };
});

describe("POST /api/invoices/send: direct send", () => {
  it("sends through the mailer in the same request and marks the invoice sent", async () => {
    const r = await post({ id: "inv-1" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, sent: true, status: "sent", error: null, provider: "resend" });

    expect(H.sendEmail).toHaveBeenCalledTimes(1);
    const msg = H.sendEmail.mock.calls[0][0];
    expect(msg.to).toBe("ap@acme.test");
    expect(msg.subject).toContain("INV-0001");

    const comm = H.store.communications.find((c) => c.id === r.body.communication_id);
    expect(comm).toMatchObject({ tenant_id: "t-1", object_id: "inv-1", document_type: "invoice_email", status: "sent" });
    expect(invoice().status).toBe("sent");
    expect(invoice().sent_at).toBeTruthy();
  });

  it("a provider refusal returns the error and leaves the invoice a draft", async () => {
    H.sendEmail = vi.fn(async () => ({ ok: false, provider: "resend", status: 422, detail: "invalid from" }));
    const r = await post({ id: "inv-1" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, sent: false, status: "failed" });
    expect(r.body.error).toBe("Provider resend returned 422");
    expect(invoice().status).toBe("draft");
    expect(invoice().sent_at).toBeUndefined();
    expect(H.store.communications[0].status).toBe("failed");
  });

  it("no mail provider configured is reported as not sent, never as sent", async () => {
    H.sendEmail = vi.fn(async () => ({ ok: false, provider: null, skipped: true, reason: "not_configured" }));
    const r = await post({ id: "inv-1" });
    expect(r.body).toMatchObject({ sent: false, status: "queued" });
    expect(r.body.error).toMatch(/No mail provider is configured/);
    expect(invoice().status).toBe("draft");
  });
});

describe("POST /api/invoices/send: RBAC and tenant scope", () => {
  it("refuses a role without invoices.write and sends nothing", async () => {
    H.ctx = { user: { id: "u-se" }, tenantId: "t-1", role: "sales_engineer" };
    const r = await post({ id: "inv-1" });
    expect(r.status).toBe(403);
    expect(H.sendEmail).not.toHaveBeenCalled();
    expect(H.store.communications).toEqual([]);
    expect(invoice().status).toBe("draft");
  });

  it("refuses a viewer at the coarse write gate", async () => {
    H.ctx = { user: { id: "u-v" }, tenantId: "t-1", role: "viewer" };
    const r = await post({ id: "inv-1" });
    expect(r.status).toBe(403);
    expect(H.sendEmail).not.toHaveBeenCalled();
  });

  it("cannot send another tenant's invoice", async () => {
    const r = await post({ id: "inv-other" });
    expect(r.status).toBe(404);
    expect(H.sendEmail).not.toHaveBeenCalled();
    expect(H.store.communications).toEqual([]);
    expect(H.store.invoices.find((x) => x.id === "inv-other").status).toBe("draft");
  });
});
