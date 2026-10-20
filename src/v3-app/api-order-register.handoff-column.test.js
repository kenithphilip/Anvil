// The register's Handoff column and its "not handed off" filter
// (docs/SO_TERMS_AND_HANDOFF_SCOPE.md 7.2, plan PR 16). The real GET
// /api/orders/register runs against an in-memory PostgREST stand-in that
// applies the select (aliases and JSON paths), the filters and the paging.
// Invented fixtures.

import { describe, it, expect, beforeEach, vi } from "vitest";

const H = vi.hoisted(() => ({ ctx: null, store: null }));

vi.mock("../api/_lib/auth.js", async (orig) => ({ ...(await orig()), resolveContext: vi.fn(async () => H.ctx) }));
vi.mock("../api/_lib/audit.js", () => ({ recordAudit: vi.fn(async () => {}), recordEvent: vi.fn(async () => {}) }));

const getPath = (row, path) => {
  const parts = String(path).split(/(->>|->)/);
  let v = row[parts[0]];
  for (let i = 1; i < parts.length; i += 2) v = v == null || typeof v !== "object" ? undefined : v[parts[i + 1]];
  if (v === undefined || v === null) return null;
  return parts.length > 1 && parts[parts.length - 2] === "->>" && typeof v === "object" ? JSON.stringify(v) : v;
};
const splitTop = (s) => {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
};
const condPred = (cond) => {
  const [col, op, ...rest] = cond.split(".");
  const val = rest.join(".");
  if (op === "is" && val === "null") return (r) => getPath(r, col) === null;
  if (op === "neq") return (r) => { const v = getPath(r, col); return v !== null && v !== val; };
  if (op === "eq") return (r) => getPath(r, col) === val;
  throw new Error("fake: unsupported or-condition " + cond);
};
const project = (row, cols) => {
  const out = {};
  for (const item of splitTop(cols)) {
    const embed = item.match(/^(\w+):(\w+)\((.*)\)$/);
    if (embed) {
      const target = (H.store.customers || []).find((t) => t.id === row[embed[2]]);
      out[embed[1]] = target ? Object.fromEntries(embed[3].split(",").map((f) => [f.trim(), target[f.trim()]])) : null;
      continue;
    }
    const colon = item.indexOf(":");
    if (colon > -1) out[item.slice(0, colon)] = getPath(row, item.slice(colon + 1));
    else out[item] = getPath(row, item);
  }
  return out;
};
const makeSvc = () => ({
  auth: { admin: { getUserById: async (id) => ({ data: { user: H.users[id] || null }, error: null }) } },
  from(table) {
    const q = {
      preds: [], cols: "*", count: false, range: null,
      select(cols, opts) { this.cols = cols; this.count = opts?.count === "exact"; return this; },
      eq(c, v) { this.preds.push((r) => getPath(r, c) === v); return this; },
      neq(c, v) { this.preds.push((r) => { const x = getPath(r, c); return x !== null && x !== v; }); return this; },
      in(c, vs) { this.preds.push((r) => vs.includes(getPath(r, c))); return this; },
      is(c, v) { this.preds.push((r) => (v === null ? getPath(r, c) === null : getPath(r, c) === v)); return this; },
      not(c) { this.preds.push((r) => getPath(r, c) !== null); return this; },
      or(s) { const ps = splitTop(s).map(condPred); this.preds.push((r) => ps.some((p) => p(r))); return this; },
      gte() { return this; },
      lt() { return this; },
      order() { return this; },
      range(a, b) { this.range = [a, b]; return this; },
      run() {
        let rows = (H.store[table] || []).filter((r) => this.preds.every((p) => p(r)));
        const count = rows.length;
        if (this.range) rows = rows.slice(this.range[0], this.range[1] + 1);
        return { data: this.cols === "*" ? rows : rows.map((r) => project(r, this.cols)), error: null, count: this.count ? count : null };
      },
      maybeSingle() { const r = this.run(); return Promise.resolve({ data: r.data[0] || null, error: null }); },
      then(res, rej) { return Promise.resolve(this.run()).then(res, rej); },
    };
    return q;
  },
});
vi.mock("../api/_lib/supabase.js", () => ({ serviceClient: () => makeSvc(), userClient: () => ({}) }));

const { default: handler } = await import("../api/orders/register.js");
const { registerAoa, REGISTER_COLUMNS } = await import("../api/_lib/order-register.js");

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const ENG = "e0000000-0000-4000-8000-000000000001";

const order = (id, at, handoff = {}) => ({
  id, tenant_id: T1, status: "DRAFT", po_number: "PO-" + id, created_at: at, payload_hash: "h-" + id,
  result: { salesOrder: { lineItems: [{ part_no: "P1" }] } },
  handoff_status: null, handoff_sent_at: null, handoff_sent_by: null, handoff_payload: null,
  ...handoff,
});
const sent = (hash, extra = {}) => ({
  handoff_status: "sent", handoff_sent_at: "2026-10-10T05:00:00.000Z", handoff_sent_by: ENG,
  handoff_payload: { payload_hash: hash, contact: { name: "Stores Desk", phone: "+91 00000 22222" } }, ...extra,
});

const get = async (query = {}) => {
  const res = {
    statusCode: 200, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    send(p) { this.body = p; return this; },
    end(p) { if (p != null) this.body = p; return this; },
  };
  await handler({ method: "GET", headers: {}, query }, res);
  return { status: res.statusCode, body: typeof res.body === "string" ? JSON.parse(res.body) : res.body };
};

beforeEach(() => {
  H.ctx = { user: { id: ENG }, tenantId: T1, role: "sales_engineer", anonymous: false };
  H.users = { [ENG]: { id: ENG, email: "eng@example.com", user_metadata: { name: "Test Engineer" } } };
  H.store = {
    orders: [
      order("o1", "2026-10-05T00:00:00.000Z"),
      order("o2", "2026-10-04T00:00:00.000Z", sent("h-o2")),
      order("o3", "2026-10-03T00:00:00.000Z", sent("h-old")),
      order("o4", "2026-10-02T00:00:00.000Z", { handoff_status: "failed", handoff_sent_at: "2026-10-09T05:00:00.000Z", handoff_sent_by: ENG }),
      order("o5", "2026-10-01T00:00:00.000Z", { handoff_status: "not_configured", handoff_sent_at: "2026-10-09T06:00:00.000Z", handoff_sent_by: ENG }),
      { ...order("x1", "2026-10-06T00:00:00.000Z"), tenant_id: T2 },
    ],
  };
});

const byId = (rows) => Object.fromEntries(rows.map((r) => [r.id, r.handoff]));

describe("order-register: the Handoff column", () => {
  it("shows not sent, sent at and by, changed since handoff, failed and not configured", async () => {
    const r = await get();
    expect(r.status).toBe(200);
    const h = byId(r.body.rows);
    expect(h.o1).toEqual({ status: "not_sent" });
    expect(h.o2).toEqual({ status: "sent", sent_at: "2026-10-10T05:00:00.000Z", sent_by: ENG, sent_by_name: "Test Engineer", changed_since: false });
    expect(h.o3).toMatchObject({ status: "sent", changed_since: true });
    expect(h.o4).toMatchObject({ status: "failed", sent_by_name: "Test Engineer" });
    expect(h.o5).toMatchObject({ status: "not_configured" });
    expect(Object.keys(h)).not.toContain("x1");
  });

  it("never returns the handoff payload's contact", async () => {
    const text = JSON.stringify((await get()).body);
    expect(text).not.toContain("Stores Desk");
    expect(text).not.toContain("00000 22222");
  });

  it("the not handed off filter keeps the orders not sent, failed or not configured", async () => {
    const r = await get({ not_handed_off: "1" });
    expect(r.body.rows.map((x) => x.id)).toEqual(["o1", "o4", "o5"]);
    expect(r.body.total).toBe(3);
  });

  it("the export says it in words", async () => {
    const rows = (await get()).body.rows;
    const aoa = registerAoa(rows);
    const col = REGISTER_COLUMNS.indexOf("Handoff");
    expect(aoa.slice(1).map((row) => row[col])).toEqual([
      "not sent",
      "sent 2026-10-10T05:00:00.000Z by Test Engineer",
      "sent 2026-10-10T05:00:00.000Z by Test Engineer (changed since handoff)",
      "failed 2026-10-09T05:00:00.000Z by Test Engineer",
      "not sent: no mail provider",
    ]);
  });
});
