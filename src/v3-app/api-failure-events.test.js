// Step 4a: /api/failure_events — capture + list an asset's failure/replacement
// events. Verifies tenant-scoped equipment validation (no cross-tenant events),
// the event_type whitelist + numeric coercion + failed_at defaulting, created_by
// from ctx.user.id, and GET filtering by equipment_id. In-memory Supabase fake.

import { describe, it, expect, beforeEach, vi } from "vitest";

const H = vi.hoisted(() => ({ store: {}, seq: 0 }));

vi.mock("../api/_lib/auth.js", () => ({
  resolveContext: vi.fn(async () => ({ user: { id: "u-1" }, tenantId: "t-1", role: "admin" })),
  requirePermission: vi.fn(() => {}),
}));
vi.mock("../api/_lib/audit.js", () => ({ recordAudit: async () => {}, recordEvent: async () => {} }));
vi.mock("../api/_lib/supabase.js", () => ({
  serviceClient: () => ({
    from(table) {
      H.store[table] = H.store[table] || [];
      const rowsRef = () => H.store[table];
      const q = {
        _op: "select", _filters: [], _payload: null, _select: false, _limit: null,
        select() { this._select = true; return this; },
        insert(p) { this._op = "insert"; this._payload = p; return this; },
        update(p) { this._op = "update"; this._payload = p; return this; },
        delete() { this._op = "delete"; return this; },
        eq(col, val) { this._filters.push({ t: "eq", col, val }); return this; },
        in(col, arr) { this._filters.push({ t: "in", col, arr }); return this; },
        order() { return this; },
        limit(n) { this._limit = n; return this; },
        _match(r) {
          return this._filters.every((f) =>
            f.t === "eq" ? r[f.col] === f.val
            : f.t === "in" ? f.arr.includes(r[f.col])
            : true);
        },
        _exec(single) {
          const store = rowsRef();
          let data = null;
          if (this._op === "select") {
            let hit = store.filter((r) => this._match(r));
            if (this._limit != null) hit = hit.slice(0, this._limit);
            data = single ? (hit[0] || null) : hit;
          } else if (this._op === "insert") {
            const items = Array.isArray(this._payload) ? this._payload : [this._payload];
            const out = items.map((it) => { const rec = { id: it.id || "id-" + (++H.seq), ...it }; store.push(rec); return rec; });
            data = this._select ? (single ? out[0] : out) : null;
          }
          return Promise.resolve({ data, count: null, error: null });
        },
        single() { const self = this; return { then: (res, rej) => self._exec(1).then(res, rej) }; },
        maybeSingle() { const self = this; return { then: (res, rej) => self._exec(1).then(res, rej) }; },
        then(resolve, reject) { return this._exec(0).then(resolve, reject); },
      };
      return q;
    },
  }),
}));

const { default: failureEvents } = await import("../api/failure_events/index.js");

const run = async (handler, { method = "POST", query = {}, body } = {}) => {
  const res = { statusCode: 200, body: null, setHeader() { return this; }, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; }, send(p) { this.body = p; return this; }, end(p) { if (p != null) this.body = p; return this; } };
  const req = { method, headers: {}, url: "/api/failure_events", query, body: body || {} };
  await handler(req, res);
  return { statusCode: res.statusCode, body: typeof res.body === "string" ? JSON.parse(res.body) : res.body };
};

beforeEach(() => {
  H.seq = 0;
  H.store = {
    equipment_hierarchy: [
      { id: "eq-1", tenant_id: "t-1", customer_id: "c1", gun_no: "G1" },
      { id: "eq-other", tenant_id: "t-2", customer_id: "c9", gun_no: "G9" }, // another tenant
    ],
    failure_events: [],
  };
});

describe("failure_events (step 4a)", () => {
  it("creates an event for a tenant-owned asset with defaults + numeric coercion", async () => {
    const out = await run(failureEvents, {
      body: { equipment_id: "eq-1", part_no: " 4-TP2109-1 ", replaced_qty: "3", downtime_hours: "1.5", event_type: "replacement", notes: " tip worn " },
    });
    expect(out.statusCode).toBe(200);
    const ev = out.body.event;
    expect(ev.tenant_id).toBe("t-1");
    expect(ev.equipment_id).toBe("eq-1");
    expect(ev.part_no).toBe("4-TP2109-1");      // trimmed
    expect(ev.event_type).toBe("replacement");
    expect(ev.replaced_qty).toBe(3);            // coerced to number
    expect(ev.downtime_hours).toBe(1.5);
    expect(ev.notes).toBe("tip worn");
    expect(ev.created_by).toBe("u-1");          // ctx.user.id
    expect(ev.failed_at).toBeTruthy();          // defaulted to now
    expect(H.store.failure_events).toHaveLength(1);
  });

  it("defaults an unknown event_type to breakdown", async () => {
    const out = await run(failureEvents, { body: { equipment_id: "eq-1", event_type: "explosion" } });
    expect(out.statusCode).toBe(200);
    expect(out.body.event.event_type).toBe("breakdown");
  });

  it("coerces a fractional/out-of-range replaced_qty to a bounded integer (no 500)", async () => {
    const out = await run(failureEvents, { body: { equipment_id: "eq-1", replaced_qty: 1.5, downtime_hours: -3 } });
    expect(out.statusCode).toBe(200);
    expect(out.body.event.replaced_qty).toBe(2);          // rounded to a valid integer
    expect(out.body.event.downtime_hours).toBe(0);        // clamped non-negative
    const huge = await run(failureEvents, { body: { equipment_id: "eq-1", replaced_qty: 9e12 } });
    expect(huge.body.event.replaced_qty).toBe(2147483647); // clamped to int4 max
  });

  it("rejects a missing equipment_id with 400", async () => {
    const out = await run(failureEvents, { body: { part_no: "X" } });
    expect(out.statusCode).toBe(400);
    expect(H.store.failure_events).toHaveLength(0);
  });

  it("rejects a cross-tenant equipment_id (no event written)", async () => {
    const out = await run(failureEvents, { body: { equipment_id: "eq-other" } });
    expect(out.statusCode).toBe(400);
    expect(out.body.error.message).toMatch(/not found in this tenant/i);
    expect(H.store.failure_events).toHaveLength(0);
  });

  it("lists only this tenant's events, filtered by equipment_id", async () => {
    H.store.failure_events = [
      { id: "f1", tenant_id: "t-1", equipment_id: "eq-1", event_type: "breakdown" },
      { id: "f2", tenant_id: "t-1", equipment_id: "eq-2", event_type: "pm" },
      { id: "f3", tenant_id: "t-2", equipment_id: "eq-1", event_type: "breakdown" }, // other tenant
    ];
    const out = await run(failureEvents, { method: "GET", query: { equipment_id: "eq-1" } });
    expect(out.statusCode).toBe(200);
    expect(out.body.events.map((e) => e.id)).toEqual(["f1"]);   // tenant + equipment filter
  });
});
