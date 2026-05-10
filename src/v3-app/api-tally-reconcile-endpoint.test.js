// /api/tally/reconcile endpoint dispatch tests.
//
// Pairs with api-tally-reconciler.test.js (which covers the pure
// helpers). This file exercises the HTTP-layer dispatch:
//   POST mode='mark'         -> back-compat status flip
//   POST mode='drift_check'  -> driftCheck path
//   GET  ?run_id             -> run + findings
//   GET  ?order_id           -> voucher_record + findings
//   GET  ?scope=runs         -> runs list
//   GET  ?scope=findings     -> open findings
//   PATCH ?finding_id        -> resolve a finding
//   Routing + cron entry + client wrapper.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p) => readFileSync(resolve(process.cwd(), p), "utf8");

vi.mock("../api/_lib/cors.js", () => ({
  applyCors: () => undefined,
  handlePreflight: () => false,
  json: (res, status, body) => { res.statusCode = status; res._json = body; return undefined; },
  readBody: async (req) => req._body || {},
  sendError: (res, err) => { res.statusCode = 500; res._json = { error: { message: err?.message || String(err) } }; },
}));

vi.mock("../api/_lib/auth.js", () => ({
  resolveContext: async (req) => req._ctx || { tenantId: "t1", userId: "u1" },
  requirePermission: () => undefined,
}));

vi.mock("../api/_lib/audit.js", () => ({
  recordAudit: vi.fn(async () => undefined),
  recordEvent: vi.fn(async () => undefined),
}));

vi.mock("../api/_lib/supabase.js", () => {
  let svc = null;
  return { serviceClient: () => svc, __setSvc: (s) => { svc = s; } };
});

vi.mock("../api/_lib/tally-reconciler.js", () => ({
  driftCheck: vi.fn(async () => ({
    run_id: "run-123",
    status: "ok",
    vouchers_considered: 5,
    vouchers_drifted: 1,
    findings_persisted: 1,
    auto_fixes_applied: 0,
    findings: [{ finding_kind: "total_mismatch", severity: "warn" }],
  })),
  markStatus: vi.fn(async () => ({ ok: true, order_id: "o1", status: "reconciled" })),
}));

const buildSvc = (seed = {}) => {
  const tables = new Map(Object.entries(seed));
  const get = (t) => tables.get(t) || [];
  const matches = (filters, r) => filters.every((f) => (
    f.op === "eq"  ? r[f.col] === f.v
    : f.op === "is" ? r[f.col] == null
    : true
  ));
  const builder = (table) => {
    const ctx = { table, filters: [], orderCol: null, orderAsc: true, lim: null, action: null, patch: null };
    const select = (rows) => {
      let out = rows.filter((r) => matches(ctx.filters, r));
      if (ctx.orderCol) {
        const dir = ctx.orderAsc ? 1 : -1;
        out = [...out].sort((a, b) => (a[ctx.orderCol] > b[ctx.orderCol] ? dir : a[ctx.orderCol] < b[ctx.orderCol] ? -dir : 0));
      }
      if (ctx.lim != null) out = out.slice(0, ctx.lim);
      return out;
    };
    const api = {
      select() { return api; },
      eq(c, v) { ctx.filters.push({ col: c, op: "eq", v }); return api; },
      is(c, _v) { ctx.filters.push({ col: c, op: "is" }); return api; },
      order(c, opts) { ctx.orderCol = c; ctx.orderAsc = opts?.ascending !== false; return api; },
      limit(n) { ctx.lim = n; return api; },
      maybeSingle() { return Promise.resolve({ data: select(get(table))[0] || null, error: null }); },
      single() {
        if (ctx.action === "update") {
          const arr = get(table);
          const idx = arr.findIndex((r) => matches(ctx.filters, r));
          if (idx === -1) return Promise.resolve({ data: null, error: { message: "not found" } });
          arr[idx] = { ...arr[idx], ...ctx.patch };
          return Promise.resolve({ data: arr[idx], error: null });
        }
        return Promise.resolve({ data: select(get(table))[0] || null, error: null });
      },
      update(patch) { ctx.action = "update"; ctx.patch = patch; return api; },
      then(resolve) {
        resolve({ data: select(get(table)), error: null });
        return { catch: () => ({}) };
      },
    };
    return api;
  };
  return { from: builder, _tables: tables };
};

beforeEach(() => { vi.clearAllMocks(); });

const callHandler = async (method, url, body) => {
  const handler = (await import("../api/tally/reconcile.js")).default;
  const req = { method, url, headers: {}, _body: body };
  const res = { statusCode: 0, _json: null, setHeader() {}, end() {} };
  await handler(req, res);
  return res;
};

describe("POST /api/tally/reconcile :: mode dispatch", () => {
  it("mark mode requires orderId + status", async () => {
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(buildSvc({}));
    const res = await callHandler("POST", "/api/tally/reconcile", { mode: "mark" });
    expect(res.statusCode).toBe(400);
    expect(res._json.error.message).toMatch(/orderId/);
  });

  it("mark mode rejects unknown status", async () => {
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(buildSvc({}));
    const res = await callHandler("POST", "/api/tally/reconcile", { mode: "mark", orderId: "o1", status: "weird" });
    expect(res.statusCode).toBe(400);
    expect(res._json.error.message).toMatch(/reconciled/);
  });

  it("mark mode delegates to markStatus and returns its result", async () => {
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(buildSvc({}));
    const { markStatus } = await import("../api/_lib/tally-reconciler.js");
    const res = await callHandler("POST", "/api/tally/reconcile", { mode: "mark", orderId: "o1", status: "reconciled" });
    expect(res.statusCode).toBe(200);
    expect(res._json.mode).toBe("mark");
    expect(res._json.status).toBe("reconciled");
    expect(markStatus).toHaveBeenCalledOnce();
  });

  it("drift_check mode delegates to driftCheck with the right shape", async () => {
    // Bet 5: drift_check is gated on the paid add-on. Seed
    // tenant_settings with the flag enabled.
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(buildSvc({
      tenant_settings: [{ tenant_id: "t1", tally_drift_addon_enabled: true }],
    }));
    const { driftCheck } = await import("../api/_lib/tally-reconciler.js");
    const res = await callHandler("POST", "/api/tally/reconcile", { mode: "drift_check", scope: "tenant_recent" });
    expect(res.statusCode).toBe(200);
    expect(res._json.mode).toBe("drift_check");
    expect(res._json.run_id).toBe("run-123");
    expect(driftCheck).toHaveBeenCalledOnce();
    const args = driftCheck.mock.calls[0][1];
    expect(args.tenantId).toBe("t1");
    expect(args.scope).toBe("tenant_recent");
    expect(args.trigger).toBe("manual");
  });

  it("Bet 5: drift_check returns 402 when add-on is disabled", async () => {
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(buildSvc({
      tenant_settings: [{ tenant_id: "t1", tally_drift_addon_enabled: false }],
    }));
    const res = await callHandler("POST", "/api/tally/reconcile", { mode: "drift_check", scope: "tenant_recent" });
    expect(res.statusCode).toBe(402);
    expect(res._json.error.code).toBe("addon_required");
  });

  it("rejects unknown mode", async () => {
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(buildSvc({}));
    const res = await callHandler("POST", "/api/tally/reconcile", { mode: "vibe_check" });
    expect(res.statusCode).toBe(400);
    expect(res._json.error.message).toMatch(/unknown mode/);
  });

  it("infers mode='mark' when orderId+status provided without explicit mode", async () => {
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(buildSvc({}));
    const res = await callHandler("POST", "/api/tally/reconcile", { orderId: "o1", status: "reconciled" });
    expect(res.statusCode).toBe(200);
    expect(res._json.mode).toBe("mark");
  });
});

describe("GET /api/tally/reconcile :: read modes", () => {
  it("?run_id returns run + findings", async () => {
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(buildSvc({
      tally_reconciliation_runs: [{ id: "r1", tenant_id: "t1", started_at: "2026-05-01T00:00:00Z", status: "ok" }],
      tally_reconciliation_findings: [
        { id: "f1", tenant_id: "t1", reconciliation_run_id: "r1", finding_kind: "total_mismatch", severity: "warn", created_at: "2026-05-01T00:01:00Z" },
        { id: "f2", tenant_id: "t1", reconciliation_run_id: "r1", finding_kind: "line_count_mismatch", severity: "error", created_at: "2026-05-01T00:02:00Z" },
      ],
    }));
    const res = await callHandler("GET", "/api/tally/reconcile?run_id=r1");
    expect(res.statusCode).toBe(200);
    expect(res._json.run.id).toBe("r1");
    expect(res._json.findings).toHaveLength(2);
  });

  it("?run_id 404 when run absent", async () => {
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(buildSvc({}));
    const res = await callHandler("GET", "/api/tally/reconcile?run_id=missing");
    expect(res.statusCode).toBe(404);
  });

  it("?order_id returns voucher_record + findings", async () => {
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(buildSvc({
      tally_voucher_records: [{ id: "v1", tenant_id: "t1", order_id: "o1", voucher_no: "VN1", status: "exported", last_drift_at: "2026-05-01T00:00:00Z" }],
      tally_reconciliation_findings: [
        { id: "f1", tenant_id: "t1", order_id: "o1", finding_kind: "total_mismatch", severity: "warn", created_at: "2026-05-01T00:01:00Z" },
      ],
    }));
    const res = await callHandler("GET", "/api/tally/reconcile?order_id=o1");
    expect(res.statusCode).toBe(200);
    expect(res._json.voucher_record.voucher_no).toBe("VN1");
    expect(res._json.findings).toHaveLength(1);
  });

  it("?scope=runs returns recent runs", async () => {
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(buildSvc({
      tally_reconciliation_runs: [
        { id: "r1", tenant_id: "t1", started_at: "2026-04-01T00:00:00Z" },
        { id: "r2", tenant_id: "t1", started_at: "2026-05-01T00:00:00Z" },
      ],
    }));
    const res = await callHandler("GET", "/api/tally/reconcile?scope=runs&limit=5");
    expect(res.statusCode).toBe(200);
    expect(res._json.runs).toHaveLength(2);
    expect(res._json.runs[0].id).toBe("r2");
  });

  it("?scope=findings returns only unresolved findings", async () => {
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(buildSvc({
      tally_reconciliation_findings: [
        { id: "f1", tenant_id: "t1", finding_kind: "total_mismatch", resolved_at: null, created_at: "2026-05-01T00:01:00Z" },
        { id: "f2", tenant_id: "t1", finding_kind: "line_count_mismatch", resolved_at: "2026-05-01T00:05:00Z", created_at: "2026-05-01T00:02:00Z" },
      ],
    }));
    const res = await callHandler("GET", "/api/tally/reconcile?scope=findings");
    expect(res.statusCode).toBe(200);
    expect(res._json.findings).toHaveLength(1);     // only the open one
    expect(res._json.findings[0].id).toBe("f1");
  });

  it("default GET returns latest_run", async () => {
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(buildSvc({
      tally_reconciliation_runs: [
        { id: "r1", tenant_id: "t1", started_at: "2026-04-01T00:00:00Z" },
        { id: "r2", tenant_id: "t1", started_at: "2026-05-01T00:00:00Z" },
      ],
    }));
    const res = await callHandler("GET", "/api/tally/reconcile");
    expect(res.statusCode).toBe(200);
    expect(res._json.latest_run.id).toBe("r2");
  });
});

describe("PATCH /api/tally/reconcile :: resolve finding", () => {
  it("rejects missing finding_id", async () => {
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(buildSvc({}));
    const res = await callHandler("PATCH", "/api/tally/reconcile", {});
    expect(res.statusCode).toBe(400);
    expect(res._json.error.message).toMatch(/finding_id/);
  });

  it("marks resolved_at + resolved_by", async () => {
    const svc = buildSvc({
      tally_reconciliation_findings: [
        { id: "f1", tenant_id: "t1", finding_kind: "total_mismatch", resolved_at: null },
      ],
    });
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(svc);
    const res = await callHandler("PATCH", "/api/tally/reconcile?finding_id=f1");
    expect(res.statusCode).toBe(200);
    expect(res._json.finding.resolved_at).toBeTruthy();
    expect(res._json.finding.resolved_by).toBe("u1");
  });
});

describe("/api/tally/reconcile :: routing + cron + client", () => {
  it("router maps the path", () => {
    const router = read("src/api/router.js");
    expect(router).toMatch(/["']\/tally\/reconcile["']/);
  });

  it("cron tick imports the tally-reconcile cron", () => {
    const tick = read("src/api/cron/tick.js");
    expect(tick).toMatch(/tallyReconcileCron/);
    expect(tick).toMatch(/["']tally\/reconcile["']/);
  });

  it("anvil-client exposes the new tally helpers", () => {
    const client = read("src/client/anvil-client.js");
    expect(client).toMatch(/driftCheck/);
    expect(client).toMatch(/getOrderRecon/);
    expect(client).toMatch(/listReconRuns/);
    expect(client).toMatch(/resolveFinding/);
  });

  it("returns 405 for unsupported methods", async () => {
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(buildSvc({}));
    const res = await callHandler("PUT", "/api/tally/reconcile");
    expect(res.statusCode).toBe(405);
  });
});
