// /api/forecast
// Forecasting dashboard segmented by territory, customer_type, and order_mode.
// Real-time aggregation when called with ?fresh=1, otherwise reads from the
// nightly forecast_snapshots table.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const DIMENSIONS = new Set(["overall", "territory", "customer_type", "order_mode"]);

const todayUtc = () => new Date().toISOString().slice(0, 10);
const dateInDays = (n) => new Date(Date.now() + n * 86400 * 1000).toISOString().slice(0, 10);

const aggregate = (opportunities, customersById, dimension) => {
  const rollup = new Map();
  const get = (key) => {
    if (!rollup.has(key)) rollup.set(key, {
      open_count: 0, open_amount_inr: 0, weighted_amount_inr: 0,
      won_count: 0, won_amount_inr: 0,
      lost_count: 0, lost_amount_inr: 0,
      next_30_days_amount_inr: 0, next_90_days_amount_inr: 0,
    });
    return rollup.get(key);
  };
  const today = new Date(todayUtc());
  const in30 = new Date(dateInDays(30));
  const in90 = new Date(dateInDays(90));
  for (const opp of opportunities) {
    const cust = opp.customer_id ? customersById.get(opp.customer_id) : null;
    let segment = "ALL";
    if (dimension === "territory") segment = (cust && cust.state_code) || "UNK";
    else if (dimension === "customer_type") segment = (cust && cust.customer_type) || "UNK";
    else if (dimension === "order_mode") segment = opp.order_mode || "UNK";
    const bucket = get(segment);
    const amount = Number(opp.amount_inr) || 0;
    const prob = (Number(opp.probability) || 0) / 100;
    if (opp.stage === "CLOSE_WON") {
      bucket.won_count += 1;
      bucket.won_amount_inr += amount;
    } else if (opp.stage === "CLOSE_LOST" || opp.stage === "REGRETTED") {
      bucket.lost_count += 1;
      bucket.lost_amount_inr += amount;
    } else {
      bucket.open_count += 1;
      bucket.open_amount_inr += amount;
      bucket.weighted_amount_inr += amount * prob;
      if (opp.close_date) {
        const close = new Date(opp.close_date);
        if (close >= today && close <= in30) bucket.next_30_days_amount_inr += amount * prob;
        if (close >= today && close <= in90) bucket.next_90_days_amount_inr += amount * prob;
      }
    }
  }
  return rollup;
};

// Recompute every dimension for ONE tenant and persist it.
//
// Extracted so the nightly cron and the admin button run the same code. It was
// inline in the POST branch, reachable only by an authenticated admin — which
// is why the "nightly" snapshot this endpoint's own header describes was never
// nightly: cron/daily.js registers thirteen jobs and forecast was not one of
// them, so forecast_snapshots only ever advanced when somebody clicked.
// Everything reading it — the cockpit's weighted pipeline — was as old as the
// last click, with no indication of that anywhere on the screen.
export const writeForecastSnapshot = async (svc, tenantId) => {
  const asOf = todayUtc();
  const opps = await svc.from("opportunities")
    .select("id, customer_id, stage, amount_inr, probability, close_date, order_mode")
    .eq("tenant_id", tenantId);
  if (opps.error) return { error: opps.error.message, tenant_id: tenantId };
  const cust = await svc.from("customers").select("id, customer_type, state_code").eq("tenant_id", tenantId);
  if (cust.error) return { error: cust.error.message, tenant_id: tenantId };
  const custMap = new Map();
  (cust.data || []).forEach((c) => custMap.set(c.id, c));

  const rows = [];
  for (const dim of ["overall", "territory", "customer_type", "order_mode"]) {
    const rollup = aggregate(opps.data || [], custMap, dim);
    for (const [seg, agg] of rollup.entries()) {
      rows.push({ tenant_id: tenantId, as_of: asOf, segment_dimension: dim, segment_value: seg, ...agg });
    }
  }
  if (!rows.length) return { written: 0, as_of: asOf, tenant_id: tenantId };
  const out = await svc.from("forecast_snapshots")
    .upsert(rows, { onConflict: "tenant_id,as_of,segment_dimension,segment_value" });
  if (out.error) return { error: out.error.message, tenant_id: tenantId };
  return { written: rows.length, as_of: asOf, tenant_id: tenantId };
};

const CRON_SECRET = process.env.CRON_SECRET;

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const svc = serviceClient();
    // The cron branch runs BEFORE resolveContext, as every other nightly job
    // here does. A cron authenticates with CRON_SECRET and has no user, so
    // resolving a context first would throw on the request that most needs to
    // succeed — and there is no single tenant to compute for, which is why the
    // snapshot had to be drained per tenant rather than simply scheduled.
    const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (req.method === "POST" && !!CRON_SECRET && auth === CRON_SECRET) {
      const tenants = await svc.from("tenants").select("id");
      if (tenants.error) throw new Error("tenants: " + tenants.error.message);
      const out = [];
      for (const t of tenants.data || []) {
        // One tenant's failure must not abandon the rest: a snapshot is a
        // whole night's freshness for everybody else on the instance.
        try { out.push(await writeForecastSnapshot(svc, t.id)); }
        catch (e) { out.push({ tenant_id: t.id, error: e?.message || String(e) }); }
      }
      return json(res, 200, {
        ran_at: new Date().toISOString(),
        tenants: out.length,
        written: out.reduce((n, r) => n + (r.written || 0), 0),
        failed: out.filter((r) => r.error).length,
        results: out,
      });
    }

    const ctx = await resolveContext(req);
    const dimension = DIMENSIONS.has(req.query.dimension) ? req.query.dimension : "overall";

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const fresh = req.query.fresh === "1" || req.query.fresh === "true";
      if (!fresh) {
        // Latest snapshot for this dimension.
        const { data, error } = await svc.from("forecast_snapshots")
          .select("*")
          .eq("tenant_id", ctx.tenantId)
          .eq("segment_dimension", dimension)
          .order("as_of", { ascending: false })
          .limit(200);
        if (error) throw new Error(error.message);
        const buckets = (data || []).filter((row) => row.as_of === (data[0] && data[0].as_of));
        return json(res, 200, { dimension, as_of: buckets[0] && buckets[0].as_of, buckets, fresh: false });
      }
      // Real-time aggregation.
      const opps = await svc.from("opportunities").select("id, customer_id, stage, amount_inr, probability, close_date, order_mode").eq("tenant_id", ctx.tenantId);
      if (opps.error) throw new Error(opps.error.message);
      const cust = await svc.from("customers").select("id, customer_type, state_code").eq("tenant_id", ctx.tenantId);
      const custMap = new Map();
      (cust.data || []).forEach((c) => custMap.set(c.id, c));
      const rollup = aggregate(opps.data || [], custMap, dimension);
      const buckets = Array.from(rollup.entries()).map(([segment_value, agg]) => ({
        segment_dimension: dimension,
        segment_value,
        ...agg,
      }));
      return json(res, 200, { dimension, as_of: todayUtc(), buckets, fresh: true });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "admin");
      const r = await writeForecastSnapshot(svc, ctx.tenantId);
      if (r.error) throw new Error(r.error);
      await recordAudit(ctx, { action: "forecast_snapshot", objectType: "forecast", objectId: r.as_of, detail: "rows=" + r.written });
      return json(res, 200, { ok: true, written: r.written, asOf: r.as_of });
    }
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
