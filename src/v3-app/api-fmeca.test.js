// Step 4c: FMECA. Covers the pure helpers (suggestOccurrence, computeRpn), the
// gated computeMinMax RPN augment (LAND-DARK: no rpn -> unchanged; high rpn ->
// raises), and the /api/fmeca endpoint (tenant isolation, mode validation,
// occurrence-suggest rollup). In-memory Supabase fake.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { suggestOccurrence, computeRpn } from "../api/_lib/fmeca.js";
import { computeMinMax } from "../api/_lib/spare-minmax.js";

// Regression guard (the in-memory fake can't enforce a real upsert conflict):
// dedup MUST key on part_no, not the trigger-derived item_id (NULL for unmastered
// parts -> NULLS-DISTINCT lets edits insert duplicates).
describe("fmeca dedup key (source contract)", () => {
  it("migration + endpoint dedup on (tenant_id, part_no, failure_mode_id)", () => {
    const mig = readFileSync(resolve(process.cwd(), "supabase/migrations/178_fmeca_criticality.sql"), "utf8");
    const ep = readFileSync(resolve(process.cwd(), "src/api/fmeca/index.js"), "utf8");
    expect(mig).toMatch(/unique \(tenant_id, part_no, failure_mode_id\)/);
    expect(mig).not.toMatch(/unique \(tenant_id, item_id, failure_mode_id\)/);
    expect(ep).toContain('onConflict: "tenant_id,part_no,failure_mode_id"');
  });
});

describe("suggestOccurrence", () => {
  it("is 1 for no events and monotonic up to 10", () => {
    expect(suggestOccurrence({ count: 0, windowWeeks: 104 })).toBe(1);
    const seq = [0, 1, 2, 4, 12, 26, 60, 200].map((c) => suggestOccurrence({ count: c, windowWeeks: 104 }));
    for (let i = 1; i < seq.length; i += 1) expect(seq[i]).toBeGreaterThanOrEqual(seq[i - 1]);
    expect(suggestOccurrence({ count: 300, windowWeeks: 104 })).toBe(10);
  });
  it("scales with rate, not raw count (window matters)", () => {
    const over2y = suggestOccurrence({ count: 4, windowWeeks: 104 });
    const over1y = suggestOccurrence({ count: 4, windowWeeks: 52 });
    expect(over1y).toBeGreaterThan(over2y);   // same count, shorter window -> higher rate
  });
});

describe("computeRpn", () => {
  it("is S*O*D for valid 1-10 inputs, null otherwise", () => {
    expect(computeRpn(10, 10, 10)).toBe(1000);
    expect(computeRpn(5, 4, 2)).toBe(40);
    expect(computeRpn(0, 5, 5)).toBe(null);   // out of range
    expect(computeRpn(5, null, 5)).toBe(null);
  });
});

describe("computeMinMax FMECA rpn augment (land-dark)", () => {
  const base = { installed_qty: 50, item_type: "consumable", description: "cap tip", lead_time_days: null };
  it("is byte-identical when rpn is absent or null", () => {
    const without = computeMinMax(base);
    const withNull = computeMinMax({ ...base, rpn: null });
    expect(withNull.recommended_min).toBe(without.recommended_min);
    expect(withNull.recommended_max).toBe(without.recommended_max);
    expect(withNull.basis.rpn_mult).toBe(1);
  });
  it("raises the min as rpn rises (bulk)", () => {
    const lo = computeMinMax({ ...base, rpn: 0 });
    const hi = computeMinMax({ ...base, rpn: 1000 });
    expect(hi.recommended_min).toBeGreaterThan(lo.recommended_min);
    expect(hi.basis.rpn_mult).toBeGreaterThan(1);
  });
});

// ---- endpoint ----
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
      const rows = () => H.store[table];
      const q = {
        _op: "select", _f: [], _or: null, _payload: null, _select: false, _limit: null,
        select() { this._select = true; return this; },
        insert(p) { this._op = "insert"; this._payload = p; return this; },
        upsert(p) { this._op = "upsert"; this._payload = p; return this; },
        delete() { this._op = "delete"; return this; },
        eq(c, v) { this._f.push((r) => r[c] === v); return this; },
        gte(c, v) { this._f.push((r) => String(r[c] ?? "") >= String(v)); return this; },
        in(c, arr) { this._f.push((r) => arr.includes(r[c])); return this; },
        not(c, _op, _v) { this._f.push((r) => r[c] != null); return this; },
        or(str) {
          const terms = String(str).split(",").map((t) => {
            const [col, op, val] = t.split(".");
            if (op === "is" && val === "null") return (r) => r[col] == null;
            return (r) => String(r[col]) === val;
          });
          this._f.push((r) => terms.some((fn) => fn(r)));
          return this;
        },
        order() { return this; },
        limit(n) { this._limit = n; return this; },
        _match(r) { return this._f.every((fn) => fn(r)); },
        _exec(single) {
          const store = rows();
          let data = null;
          if (this._op === "select") {
            let hit = store.filter((r) => this._match(r));
            if (this._limit != null) hit = hit.slice(0, this._limit);
            data = single ? (hit[0] || null) : hit;
          } else if (this._op === "insert" || this._op === "upsert") {
            const items = Array.isArray(this._payload) ? this._payload : [this._payload];
            const out = items.map((it) => { const rec = { id: it.id || "id-" + (++H.seq), ...it }; store.push(rec); return rec; });
            data = this._select ? (single ? out[0] : out) : null;
          } else if (this._op === "delete") { H.store[table] = store.filter((r) => !this._match(r)); }
          return Promise.resolve({ data, error: null });
        },
        single() { const s = this; return { then: (res, rej) => s._exec(1).then(res, rej) }; },
        maybeSingle() { const s = this; return { then: (res, rej) => s._exec(1).then(res, rej) }; },
        then(res, rej) { return this._exec(0).then(res, rej); },
      };
      return q;
    },
  }),
}));

const { default: fmeca } = await import("../api/fmeca/index.js");
const run = async (h, { method = "POST", query = {}, body } = {}) => {
  const res = { statusCode: 200, body: null, setHeader() { return this; }, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; }, send(p) { this.body = p; return this; }, end(p) { if (p != null) this.body = p; return this; } };
  await h({ method, headers: {}, url: "/api/fmeca", query, body: body || {} }, res);
  return { statusCode: res.statusCode, body: typeof res.body === "string" ? JSON.parse(res.body) : res.body };
};

beforeEach(() => {
  H.seq = 0;
  H.store = {
    failure_mode_catalog: [
      { id: "m-glob", tenant_id: null, code: "GENERIC_WEAR", label: "General wear-out", active: true },
      { id: "m-t1", tenant_id: "t-1", code: "MY_MODE", label: "My mode", active: true },
      { id: "m-t2", tenant_id: "t-2", code: "OTHER", label: "Other tenant", active: true },
    ],
    fmeca_criticality: [],
    failure_events: [
      { tenant_id: "t-1", item_id: "i1", part_no: "P1", failure_mode: "tip wear", event_type: "breakdown", failed_at: "2026-06-01T00:00:00Z" },
      { tenant_id: "t-1", item_id: "i1", part_no: "P1", failure_mode: "tip wear", event_type: "replacement", failed_at: "2026-05-01T00:00:00Z" },
      { tenant_id: "t-2", item_id: "i9", part_no: "P1", failure_mode: "tip wear", event_type: "breakdown", failed_at: "2026-06-01T00:00:00Z" },
    ],
  };
});

describe("fmeca endpoint", () => {
  it("upserts a tenant failure mode (normalized code)", async () => {
    const out = await run(fmeca, { body: { kind: "mode", code: "seal leak", label: "Seal leak", category: "wear" } });
    expect(out.statusCode).toBe(200);
    expect(out.body.mode.tenant_id).toBe("t-1");
    expect(out.body.mode.code).toBe("SEAL_LEAK");
  });

  it("requires part_no + failure_mode_id for an fmeca row", async () => {
    expect((await run(fmeca, { body: { kind: "fmeca", failure_mode_id: "m-glob" } })).statusCode).toBe(400);
    expect((await run(fmeca, { body: { kind: "fmeca", part_no: "P1" } })).statusCode).toBe(400);
  });

  it("accepts a global or own-tenant mode, rejects another tenant's mode", async () => {
    const ok = await run(fmeca, { body: { kind: "fmeca", part_no: "P1", failure_mode_id: "m-glob", severity: 8, occurrence: 5, detection: 4 } });
    expect(ok.statusCode).toBe(200);
    expect(ok.body.row.tenant_id).toBe("t-1");
    const bad = await run(fmeca, { body: { kind: "fmeca", part_no: "P1", failure_mode_id: "m-t2" } });
    expect(bad.statusCode).toBe(400);
    expect(bad.body.error.message).toMatch(/not found in this tenant/i);
  });

  it("clamps S/O/D to 1-10 (out of range -> null)", async () => {
    const out = await run(fmeca, { body: { kind: "fmeca", part_no: "P2", failure_mode_id: "m-t1", severity: 99, occurrence: 5, detection: 0 } });
    expect(out.statusCode).toBe(200);
    expect(out.body.row.severity).toBe(null);   // 99 out of range
    expect(out.body.row.occurrence).toBe(5);
    expect(out.body.row.detection).toBe(null);   // 0 out of range
  });

  it("suggest rolls up only this tenant's breakdown/replacement events", async () => {
    const out = await run(fmeca, { method: "GET", query: { view: "suggest", part_no: "P1" } });
    expect(out.statusCode).toBe(200);
    expect(out.body.suggestions).toHaveLength(1);       // t-2's event excluded
    expect(out.body.suggestions[0].count).toBe(2);
    expect(out.body.suggestions[0].suggested_occurrence).toBeGreaterThanOrEqual(1);
  });
});
