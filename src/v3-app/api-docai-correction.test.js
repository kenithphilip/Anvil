// /api/docai/correction: verifies the operator-correction endpoint
//   - records extraction_corrections with the real actor id (ctx.user.id),
//   - closes the learning loop by writing a learned_corrections row,
//   - skips the learned_corrections write on a no-op "correction".
// In-memory Supabase fake.

import { describe, it, expect, beforeEach, vi } from "vitest";

const H = vi.hoisted(() => ({ store: {}, seq: 0 }));

vi.mock("../api/_lib/auth.js", () => ({
  resolveContext: vi.fn(async () => ({ user: { id: "u-1" }, tenantId: "t-1", role: "admin" })),
  requirePermission: vi.fn(() => {}),
}));
vi.mock("../api/_lib/audit.js", () => ({ recordAudit: async () => {}, recordEvent: async () => {} }));
vi.mock("../api/_lib/stripe-client.js", () => ({
  tenantSettings: async () => ({}),
  updateTenantSettings: async () => {},
}));
vi.mock("../api/_lib/docai/overrides.js", () => ({
  promoteCorrectionIfStable: async () => ({ promoted: false }),
}));
vi.mock("../api/_lib/supabase.js", () => ({
  serviceClient: () => ({
    from(table) {
      H.store[table] = H.store[table] || [];
      const rows = () => H.store[table];
      const q = {
        _op: "select", _f: [], _payload: null, _select: false, _count: false, _head: false, _onConflict: null,
        select(_cols, opts) { this._select = true; if (opts?.count) this._count = true; if (opts?.head) this._head = true; return this; },
        insert(p) { this._op = "insert"; this._payload = p; return this; },
        upsert(p, opts) { this._op = "upsert"; this._payload = p; this._onConflict = opts?.onConflict || null; return this; },
        eq(c, v) { this._f.push((r) => r[c] === v); return this; },
        _match(r) { return this._f.every((fn) => fn(r)); },
        _exec(single) {
          const store = rows();
          if (this._op === "insert" || this._op === "upsert") {
            const items = Array.isArray(this._payload) ? this._payload : [this._payload];
            const out = [];
            for (const it of items) {
              if (this._op === "upsert" && this._onConflict) {
                const keys = this._onConflict.split(",").map((s) => s.trim());
                const ex = store.find((r) => keys.every((k) => r[k] === it[k]));
                if (ex) { Object.assign(ex, it); out.push(ex); continue; }
              }
              const rec = { id: it.id || "id-" + (++H.seq), ...it }; store.push(rec); out.push(rec);
            }
            return Promise.resolve({ data: this._select ? (single ? out[0] : out) : null, error: null });
          }
          // select
          const hit = store.filter((r) => this._match(r));
          if (this._count && this._head) return Promise.resolve({ data: null, count: hit.length, error: null });
          return Promise.resolve({ data: single ? (hit[0] || null) : hit, error: null });
        },
        single() { const s = this; return { then: (res, rej) => s._exec(1).then(res, rej) }; },
        maybeSingle() { const s = this; return { then: (res, rej) => s._exec(1).then(res, rej) }; },
        then(res, rej) { return this._exec(0).then(res, rej); },
      };
      return q;
    },
  }),
}));

const { default: correction } = await import("../api/docai/correction.js");

const flush = () => new Promise((r) => setTimeout(r, 0));
const run = async (body) => {
  const res = { statusCode: 200, body: null, setHeader() { return this; }, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; }, send(p) { this.body = p; return this; }, end(p) { if (p != null) this.body = p; return this; } };
  await correction({ method: "POST", headers: {}, url: "/api/docai/correction", query: {}, body }, res);
  await flush();
  return { statusCode: res.statusCode, body: typeof res.body === "string" ? JSON.parse(res.body) : res.body };
};

beforeEach(() => {
  H.seq = 0;
  H.store = {
    extraction_runs: [{ id: "run-1", tenant_id: "t-1", customer_id: "c1" }],
    extraction_corrections: [],
    rlhf_feedback: [],
    learned_corrections: [],
  };
});

describe("docai/correction endpoint", () => {
  it("400s without extraction_run_id or field_path", async () => {
    const out = await run({ extraction_run_id: "run-1" });
    expect(out.statusCode).toBe(400);
  });

  it("records the correction with the real actor id (ctx.user.id, not ctx.userId)", async () => {
    const out = await run({ extraction_run_id: "run-1", field_path: "lines[0].partNumber", original_value: "X", corrected_value: "Y" });
    expect(out.statusCode).toBe(200);
    const rec = H.store.extraction_corrections[0];
    expect(rec.user_id).toBe("u-1");
    expect(rec.field_path).toBe("lines[0].partNumber");
    expect(H.store.rlhf_feedback[0].user_id).toBe("u-1");
  });

  it("closes the learning loop: writes a learned_corrections row on a real change", async () => {
    await run({ extraction_run_id: "run-1", field_path: "lines[0].partNumber", original_value: "X", corrected_value: "Y" });
    expect(H.store.learned_corrections.length).toBe(1);
    const lc = H.store.learned_corrections[0];
    expect(lc.model_value).toBe("X");
    expect(lc.operator_value).toBe("Y");
    expect(lc.extraction_run_id).toBe("run-1");
    expect(lc.tenant_id).toBe("t-1");
  });

  it("skips the learned_corrections write when the value did not change (no-op)", async () => {
    const out = await run({ extraction_run_id: "run-1", field_path: "customer.gstin", original_value: "27AAA", corrected_value: "27AAA" });
    expect(out.statusCode).toBe(200);
    expect(H.store.extraction_corrections.length).toBe(1); // still logs the click
    expect(H.store.learned_corrections.length).toBe(0);    // but nothing to learn
  });
});
