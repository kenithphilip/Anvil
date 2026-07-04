// Bet 5: Tally drift reconciliation paid SKU.
//
// Covers:
//   - /api/tally/drift_addon POST + DELETE (enable / disable)
//   - /api/tally/reconcile drift_check returns 402 when addon off
//   - /api/tally/reconcile default GET returns addon flag
//   - cron/tally-reconcile filters tenant list by the addon flag
//   - cron/drift-meter drains unreported rows + skips trial/enterprise
//   - cron/drift-report previousMonthRange + month-1 short-circuit
//   - reconciler writes a tally_drift_billing_meter row at end of run

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../api/_lib/cors.js", () => ({
  applyCors: () => undefined,
  handlePreflight: () => false,
  json: (res, status, body) => { res.statusCode = status; res._json = body; return undefined; },
  readBody: async (req) => req._body || {},
  sendError: (res, err) => { res.statusCode = err?.status || 500; res._json = { error: { message: err?.message || String(err) } }; },
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

// Mock the reconciler so the drift_addon test does not need the
// full real engine (covered by api-tally-reconciler.test.js).
vi.mock("../api/_lib/tally-reconciler.js", () => ({
  driftCheck: vi.fn(async () => ({
    run_id: "run-first",
    vouchers_considered: 8,
    vouchers_drifted: 1,
    vouchers_clean: 7,
    auto_fixes_applied: 0,
    status: "ok",
  })),
  markStatus: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../api/_lib/stripe-client.js", () => ({
  recordStripeMeterEvent: vi.fn(async () => ({ identifier: "evt_test_1", raw: {} })),
}));

vi.mock("../api/_lib/razorpay-client.js", () => ({
  recordRazorpayUsage: vi.fn(async () => ({ addon_id: "addon_test_1", raw: {} })),
  razorpayDecryptCreds: () => ({ razorpay_key_id: "k", razorpay_key_secret: "s" }),
}));

const buildSvc = (seed = {}) => {
  const tables = new Map(Object.entries(seed));
  const get = (t) => tables.get(t) || (tables.set(t, []).get(t));
  const matches = (filters, r) => filters.every((f) => (
    f.op === "eq" ? r[f.col] === f.v
    : f.op === "in" ? Array.isArray(f.v) && f.v.includes(r[f.col])
    : f.op === "gte" ? String(r[f.col]) >= String(f.v)
    : f.op === "lt" ? String(r[f.col]) < String(f.v)
    : f.op === "is_null" ? r[f.col] == null
    : true
  ));
  const builder = (table) => {
    const ctx = { table, filters: [], action: null, patch: null, insertRows: null, orderCol: null, orderAsc: true, lim: null };
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
      in(c, v) { ctx.filters.push({ col: c, op: "in", v }); return api; },
      gte(c, v) { ctx.filters.push({ col: c, op: "gte", v }); return api; },
      lt(c, v) { ctx.filters.push({ col: c, op: "lt", v }); return api; },
      is(c, _v) { ctx.filters.push({ col: c, op: "is_null" }); return api; },
      order(c, opts) { ctx.orderCol = c; ctx.orderAsc = opts?.ascending !== false; return api; },
      limit(n) { ctx.lim = n; return api; },
      maybeSingle() {
        if (ctx.action === "update") {
          const arr = get(table);
          const idx = arr.findIndex((r) => matches(ctx.filters, r));
          if (idx === -1) return Promise.resolve({ data: null, error: null });
          arr[idx] = { ...arr[idx], ...ctx.patch };
          return Promise.resolve({ data: arr[idx], error: null });
        }
        return Promise.resolve({ data: select(get(table))[0] || null, error: null });
      },
      single() {
        if (ctx.action === "update") {
          const arr = get(table);
          const idx = arr.findIndex((r) => matches(ctx.filters, r));
          if (idx === -1) return Promise.resolve({ data: null, error: null });
          arr[idx] = { ...arr[idx], ...ctx.patch };
          return Promise.resolve({ data: arr[idx], error: null });
        }
        return Promise.resolve({ data: select(get(table))[0] || null, error: null });
      },
      update(patch) { ctx.action = "update"; ctx.patch = patch; return api; },
      insert(rowOrRows) {
        const rows = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows];
        for (const row of rows) {
          get(table).push({ id: "row-" + Math.random().toString(36).slice(2, 10), ...row });
        }
        return Promise.resolve({ data: rows, error: null });
      },
      then(resolve) {
        if (ctx.action === "update") {
          const arr = get(table);
          let n = 0;
          for (const r of arr) {
            if (matches(ctx.filters, r)) { Object.assign(r, ctx.patch); n++; }
          }
          resolve({ data: arr, error: null, count: n });
        } else {
          resolve({ data: select(get(table)), error: null });
        }
        return { catch: () => ({}) };
      },
    };
    return api;
  };
  return { from: builder, _tables: tables };
};

beforeEach(() => { vi.clearAllMocks(); });

const callHandler = async (importPath, method, url, body) => {
  const handler = (await import(importPath)).default;
  const req = { method, url, headers: {}, _body: body };
  const res = { statusCode: 0, _json: null, setHeader() {}, end() {} };
  await handler(req, res);
  return res;
};

// ---- /api/tally/drift_addon -------------------------------------

describe("/api/tally/drift_addon :: POST + DELETE", () => {
  it("POST flips addon on, stamps started_at, runs first scan", async () => {
    const svc = buildSvc({
      tenant_settings: [{ tenant_id: "t1", tally_drift_addon_enabled: false, tally_drift_addon_started_at: null }],
    });
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(svc);
    const { driftCheck } = await import("../api/_lib/tally-reconciler.js");
    const res = await callHandler("../api/tally/drift_addon.js", "POST", "/api/tally/drift_addon", { plan: "trial" });
    expect(res.statusCode).toBe(200);
    expect(res._json.ok).toBe(true);
    expect(res._json.addon_enabled).toBe(true);
    expect(res._json.addon_started_at).toBeTruthy();
    expect(res._json.addon_billing_plan).toBe("trial");
    expect(res._json.first_run).toBeTruthy();
    expect(driftCheck).toHaveBeenCalledOnce();
    const t1 = svc._tables.get("tenant_settings").find((r) => r.tenant_id === "t1");
    expect(t1.tally_drift_addon_enabled).toBe(true);
    expect(t1.tally_drift_addon_billing_plan).toBe("trial");
  });

  it("POST does NOT re-run first scan when already enabled", async () => {
    const svc = buildSvc({
      tenant_settings: [{ tenant_id: "t1", tally_drift_addon_enabled: true, tally_drift_addon_started_at: "2026-04-01T00:00:00Z" }],
    });
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(svc);
    const { driftCheck } = await import("../api/_lib/tally-reconciler.js");
    const res = await callHandler("../api/tally/drift_addon.js", "POST", "/api/tally/drift_addon", { plan: "growth" });
    expect(res.statusCode).toBe(200);
    expect(res._json.first_run).toBeNull();
    expect(driftCheck).not.toHaveBeenCalled();
  });

  it("POST rejects unknown plan", async () => {
    const svc = buildSvc({ tenant_settings: [{ tenant_id: "t1" }] });
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(svc);
    const res = await callHandler("../api/tally/drift_addon.js", "POST", "/api/tally/drift_addon", { plan: "platinum" });
    expect(res.statusCode).toBe(400);
    expect(res._json.error.message).toMatch(/plan must be one of/);
  });

  it("DELETE flips addon off without clearing started_at", async () => {
    const svc = buildSvc({
      tenant_settings: [{ tenant_id: "t1", tally_drift_addon_enabled: true, tally_drift_addon_started_at: "2026-04-01T00:00:00Z" }],
    });
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(svc);
    const res = await callHandler("../api/tally/drift_addon.js", "DELETE", "/api/tally/drift_addon");
    expect(res.statusCode).toBe(200);
    expect(res._json.addon_enabled).toBe(false);
    const t1 = svc._tables.get("tenant_settings").find((r) => r.tenant_id === "t1");
    expect(t1.tally_drift_addon_enabled).toBe(false);
    expect(t1.tally_drift_addon_started_at).toBe("2026-04-01T00:00:00Z");
  });
});

// ---- /api/tally/reconcile gating --------------------------------

describe("/api/tally/reconcile :: drift_check gates on addon flag", () => {
  it("POST drift_check returns 402 when addon disabled", async () => {
    const svc = buildSvc({
      tenant_settings: [{ tenant_id: "t1", tally_drift_addon_enabled: false }],
    });
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(svc);
    const res = await callHandler("../api/tally/reconcile.js", "POST", "/api/tally/reconcile", { mode: "drift_check" });
    expect(res.statusCode).toBe(402);
    expect(res._json.error.code).toBe("addon_required");
    expect(res._json.error.upgrade_url).toMatch(/admin/);
  });

  it("default GET returns addon_enabled flag", async () => {
    const svc = buildSvc({
      tenant_settings: [{ tenant_id: "t1", tally_drift_addon_enabled: true, tally_drift_addon_billing_plan: "growth", tally_drift_addon_started_at: "2026-05-01T00:00:00Z" }],
    });
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(svc);
    const res = await callHandler("../api/tally/reconcile.js", "GET", "/api/tally/reconcile");
    expect(res.statusCode).toBe(200);
    expect(res._json.addon_enabled).toBe(true);
    expect(res._json.addon_billing_plan).toBe("growth");
  });
});

// ---- cron/tally-reconcile filtering ------------------------------

describe("cron/tally-reconcile :: filters tenants by addon flag", () => {
  it("only tenants with tally_drift_addon_enabled=true get drained", async () => {
    const svc = buildSvc({
      tally_voucher_records: [
        { id: "v1", tenant_id: "t1", status: "exported", created_at: new Date().toISOString() },
        { id: "v2", tenant_id: "t2", status: "exported", created_at: new Date().toISOString() },
      ],
      tenant_settings: [
        { tenant_id: "t1", tally_drift_addon_enabled: true },
        { tenant_id: "t2", tally_drift_addon_enabled: false },
      ],
    });
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(svc);
    const { driftCheck } = await import("../api/_lib/tally-reconciler.js");
    // The cron handler is auth-gated; bypass with the CRON_SECRET path.
    const handler = (await import("../api/cron/tally-reconcile.js")).default;
    process.env.CRON_SECRET = "test";
    const req = { method: "GET", url: "/api/cron/tally-reconcile", headers: { authorization: "Bearer test" } };
    const res = { statusCode: 0, _json: null, setHeader() {}, end() {} };
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res._json.tenants_processed).toBe(1);
    expect(driftCheck).toHaveBeenCalledOnce();
    const args = driftCheck.mock.calls[0][1];
    expect(args.tenantId).toBe("t1");
  });
});

// ---- drift-meter drain ------------------------------------------

describe("cron/drift-meter :: drains unreported rows", () => {
  it("trial / enterprise tenants get reported_at stamped without provider call", async () => {
    const svc = buildSvc({
      tally_drift_billing_meter: [
        { id: "m1", tenant_id: "t1", vouchers_reconciled: 5, drift_caught_value_inr: 0, reported_to_stripe_at: null, reported_to_razorpay_at: null, created_at: new Date().toISOString() },
      ],
      tenant_settings: [
        { tenant_id: "t1", tally_drift_addon_billing_plan: "trial", stripe_account_id: "acct_t1" },
      ],
    });
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(svc);
    const { recordStripeMeterEvent } = await import("../api/_lib/stripe-client.js");
    const handler = (await import("../api/cron/drift-meter.js")).default;
    process.env.CRON_SECRET = "test";
    const req = { method: "GET", url: "/api/cron/drift-meter", headers: { authorization: "Bearer test" } };
    const res = { statusCode: 0, _json: null, setHeader() {}, end() {} };
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res._json.drained).toBe(1);
    expect(recordStripeMeterEvent).not.toHaveBeenCalled();
    const m = svc._tables.get("tally_drift_billing_meter")[0];
    expect(m.reported_to_stripe_at).toBeTruthy();
  });

  it("starter plan with stripe_account_id calls Stripe meter", async () => {
    const svc = buildSvc({
      tally_drift_billing_meter: [
        { id: "m1", tenant_id: "t1", vouchers_reconciled: 12, drift_caught_value_inr: 0, reported_to_stripe_at: null, reported_to_razorpay_at: null, created_at: new Date().toISOString() },
      ],
      tenant_settings: [
        { tenant_id: "t1", tally_drift_addon_billing_plan: "starter", tally_drift_addon_stripe_subscription_id: "cus_test_t1" },
      ],
    });
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(svc);
    const { recordStripeMeterEvent } = await import("../api/_lib/stripe-client.js");
    const handler = (await import("../api/cron/drift-meter.js")).default;
    process.env.CRON_SECRET = "test";
    const req = { method: "GET", url: "/api/cron/drift-meter", headers: { authorization: "Bearer test" } };
    const res = { statusCode: 0, _json: null, setHeader() {}, end() {} };
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(recordStripeMeterEvent).toHaveBeenCalledOnce();
    const args = recordStripeMeterEvent.mock.calls[0][0];
    expect(args.value).toBe(12);
    expect(args.stripeCustomerId).toBe("cus_test_t1");
  });
});

// ---- drift-report cron ------------------------------------------

describe("cron/drift-report :: month-start gating + range computation", () => {
  it("previousMonthRange returns the prior calendar month UTC", async () => {
    const { __test__ } = await import("../api/cron/drift-report.js");
    const range = __test__.previousMonthRange(new Date("2026-05-10T03:00:00Z"));
    expect(range.start).toBe("2026-04-01T00:00:00.000Z");
    expect(range.end).toBe("2026-05-01T00:00:00.000Z");
    expect(range.label).toMatch(/^Apr/);
  });

  it("drainOnce skips on non-month-start days", async () => {
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(buildSvc({}));
    const { __test__ } = await import("../api/cron/drift-report.js");
    const out = await __test__.drainOnce(buildSvc({}), new Date("2026-05-10T03:00:00Z"));
    expect(out.skipped).toBe("not-day-1");
  });

  it("renderHtmlBody includes the headline numbers", async () => {
    const { __test__ } = await import("../api/cron/drift-report.js");
    const html = __test__.renderHtmlBody({
      tenantName: "Summit Automation",
      label: "Apr 2026",
      runs: [],
      findings: [],
      totals: { considered: 84, drifted: 3, autoFixed: 1, driftValueInr: 12500 },
    });
    expect(html).toMatch(/Summit Automation/);
    expect(html).toMatch(/84/);
    expect(html).toMatch(/12,500/);
  });
});

// ---- routing + outcomes -----------------------------------------

describe("Bet 5 :: routing + outcomes", () => {
  it("router maps /tally/drift_addon, /cron/drift-meter, /cron/drift-report", async () => {
    const router = (await import("node:fs")).readFileSync(
      (await import("node:path")).resolve(process.cwd(), "src/api/router.js"), "utf8");
    expect(router).toMatch(/["']\/tally\/drift_addon["']\s*:\s*tallyDriftAddon/);
    expect(router).toMatch(/["']\/cron\/drift-meter["']\s*:\s*driftMeterCron/);
    expect(router).toMatch(/["']\/cron\/drift-report["']\s*:\s*driftReportCron/);
  });

  it("outcomes maps tally_recon_run -> drift_check_run", async () => {
    const { ACTION_TO_OUTCOME, OUTCOME_LABELS, OUTCOME_ORDER } = await import("../api/_lib/outcomes.js");
    expect(ACTION_TO_OUTCOME.tally_recon_run).toBe("drift_check_run");
    expect(ACTION_TO_OUTCOME.tally_drift_detected).toBe("drift_check_run");
    expect(OUTCOME_LABELS.drift_check_run).toBe("Drift checks (Tally)");
    expect(OUTCOME_ORDER).toContain("drift_check_run");
  });

  it("anvil-client exposes getReconState + enableDriftAddon + disableDriftAddon", async () => {
    const client = (await import("node:fs")).readFileSync(
      (await import("node:path")).resolve(process.cwd(), "src/client/anvil-client.js"), "utf8");
    expect(client).toMatch(/getReconState/);
    expect(client).toMatch(/enableDriftAddon/);
    expect(client).toMatch(/disableDriftAddon/);
  });
});
