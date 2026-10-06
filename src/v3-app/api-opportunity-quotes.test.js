// /api/opportunities/quotes — uploaded external quote revisions per opportunity.
// Covers version auto-numbering, recipients, supersede, tenant scope, and the
// sent-stamp. In-memory Supabase fake.

import { describe, it, expect, beforeEach, vi } from "vitest";

const H = vi.hoisted(() => ({ store: {}, seq: 0 }));

vi.mock("../api/_lib/auth.js", () => ({
  resolveContext: vi.fn(async () => ({ user: { id: "u-1" }, tenantId: "t-1", role: "sales_engineer" })),
  requirePermission: vi.fn(() => {}),
}));
vi.mock("../api/_lib/audit.js", () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock("../api/_lib/supabase.js", () => ({
  serviceClient: () => ({
    from(table) {
      H.store[table] = H.store[table] || [];
      const rows = () => H.store[table];
      const q = { _f: [], _order: null, _asc: true, _limit: null, _mode: null, _payload: null,
        select() { return this; },
        eq(c, v) { this._f.push((r) => r[c] === v); return this; },
        neq(c, v) { this._f.push((r) => r[c] !== v); return this; },
        in(c, arr) { this._f.push((r) => arr.includes(r[c])); return this; },
        order(c, o) { this._order = c; this._asc = !(o && o.ascending === false); return this; },
        limit(n) { this._limit = n; return this; },
        insert(p) { this._mode = "insert"; this._payload = p; return this; },
        update(p) { this._mode = "update"; this._payload = p; return this; },
        delete() { this._mode = "delete"; return this; },
        _match() { let h = rows().filter((r) => this._f.every((fn) => fn(r))); if (this._order) h = [...h].sort((a, b) => ((a[this._order] > b[this._order] ? 1 : -1) * (this._asc ? 1 : -1))); if (this._limit != null) h = h.slice(0, this._limit); return h; },
        _run(single) {
          if (this._mode === "insert") {
            const arr = Array.isArray(this._payload) ? this._payload : [this._payload];
            const created = arr.map((p) => ({ id: "id-" + (++H.seq), ...p }));
            rows().push(...created);
            return { data: single ? created[0] : created, error: null };
          }
          if (this._mode === "update") {
            const hit = this._match();
            hit.forEach((r) => Object.assign(r, this._payload));
            return { data: single ? (hit[0] || null) : hit, error: null };
          }
          if (this._mode === "delete") {
            const hit = this._match();
            H.store[table] = rows().filter((r) => !hit.includes(r));
            return { data: single ? (hit[0] || null) : hit, error: null };
          }
          const hit = this._match();
          return { data: single ? (hit[0] || null) : hit, error: null };
        },
        maybeSingle() { return Promise.resolve(this._run(1)); },
        single() { return Promise.resolve(this._run(1)); },
        then(res, rej) { return Promise.resolve(this._run(0)).then(res, rej); },
      };
      return q;
    },
  }),
}));

const { default: handler } = await import("../api/opportunities/quotes.js");

const run = async (method, { query = {}, body } = {}) => {
  const res = { statusCode: 200, body: null, setHeader() { return this; }, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; }, end(p) { if (p != null) this.body = p; return this; }, send(p) { this.body = p; return this; } };
  await handler({ method, headers: {}, url: "/api/opportunities/quotes", query, body }, res);
  return { status: res.statusCode, body: typeof res.body === "string" ? JSON.parse(res.body) : res.body };
};

beforeEach(() => {
  H.store = { opportunities: [{ id: "opp-1", tenant_id: "t-1", customer_id: "cust-1" }], opportunity_quotes: [], opportunity_quote_recipients: [] };
  H.seq = 0;
});

describe("POST /opportunities/quotes", () => {
  it("auto-numbers versions per opportunity and denormalises customer_id", async () => {
    const a = await run("POST", { body: { opportunity_id: "opp-1", quote_type: "budgetary", amount: 100000 } });
    expect(a.status).toBe(200);
    expect(a.body.quote.version).toBe(1);
    expect(a.body.quote.customer_id).toBe("cust-1");
    const b = await run("POST", { body: { opportunity_id: "opp-1", quote_type: "revised", amount: 120000 } });
    expect(b.body.quote.version).toBe(2);
  });

  it("records recipients (to + cc) and marks status sent with sent_at", async () => {
    const r = await run("POST", { body: {
      opportunity_id: "opp-1", quote_type: "budgetary", amount: 50000, status: "sent",
      recipients: [{ contact_id: "c1", kind: "to", email: "a@x.com" }, { kind: "cc", email: "cc@x.com", name: "Boss" }],
    } });
    expect(r.body.quote.status).toBe("sent");
    expect(r.body.quote.sent_at).toBeTruthy();
    expect(r.body.quote.recipients).toHaveLength(2);
    expect(H.store.opportunity_quote_recipients.filter((x) => x.kind === "cc")).toHaveLength(1);
  });

  it("supersedes the prior revision when supersedes_id is given", async () => {
    const v1 = await run("POST", { body: { opportunity_id: "opp-1" } });
    await run("POST", { body: { opportunity_id: "opp-1", quote_type: "revised", supersedes_id: v1.body.quote.id } });
    const prior = H.store.opportunity_quotes.find((x) => x.id === v1.body.quote.id);
    expect(prior.status).toBe("superseded");
  });

  it("404s an opportunity from another tenant / unknown, and 400s a bad type", async () => {
    expect((await run("POST", { body: { opportunity_id: "nope" } })).status).toBe(404);
    expect((await run("POST", { body: { opportunity_id: "opp-1", quote_type: "weird" } })).status).toBe(400);
  });
});

describe("GET / PATCH", () => {
  it("lists revisions newest-first with recipients", async () => {
    await run("POST", { body: { opportunity_id: "opp-1" } });
    await run("POST", { body: { opportunity_id: "opp-1", recipients: [{ email: "z@x.com", kind: "to" }] } });
    const list = await run("GET", { query: { opportunity_id: "opp-1" } });
    expect(list.body.quotes.map((q) => q.version)).toEqual([2, 1]);
    expect(list.body.quotes[0].recipients).toHaveLength(1);
  });

  it("PATCH to sent stamps sent_at; unknown id 404s", async () => {
    const v1 = await run("POST", { body: { opportunity_id: "opp-1" } });
    const p = await run("PATCH", { query: { id: v1.body.quote.id }, body: { status: "sent", change_note: "sent to purchase" } });
    expect(p.body.quote.status).toBe("sent");
    expect(p.body.quote.sent_at).toBeTruthy();
    expect((await run("PATCH", { query: { id: "ghost" }, body: { status: "accepted" } })).status).toBe(404);
  });
});
