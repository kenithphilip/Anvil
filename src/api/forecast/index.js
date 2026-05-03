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

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();
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
      // Manual recompute of all dimensions and persistence to forecast_snapshots.
      requirePermission(ctx, "admin");
      const opps = await svc.from("opportunities").select("id, customer_id, stage, amount_inr, probability, close_date, order_mode").eq("tenant_id", ctx.tenantId);
      if (opps.error) throw new Error(opps.error.message);
      const cust = await svc.from("customers").select("id, customer_type, state_code").eq("tenant_id", ctx.tenantId);
      const custMap = new Map();
      (cust.data || []).forEach((c) => custMap.set(c.id, c));
      const asOf = todayUtc();
      const dims = ["overall", "territory", "customer_type", "order_mode"];
      const rows = [];
      for (const dim of dims) {
        const rollup = aggregate(opps.data || [], custMap, dim);
        for (const [seg, agg] of rollup.entries()) {
          rows.push({
            tenant_id: ctx.tenantId,
            as_of: asOf,
            segment_dimension: dim,
            segment_value: seg,
            ...agg,
          });
        }
      }
      if (!rows.length) return json(res, 200, { ok: true, written: 0, asOf });
      const out = await svc.from("forecast_snapshots").upsert(rows, { onConflict: "tenant_id,as_of,segment_dimension,segment_value" });
      if (out.error) throw new Error(out.error.message);
      await recordAudit(ctx, { action: "forecast_snapshot", objectType: "forecast", objectId: asOf, detail: "rows=" + rows.length });
      return json(res, 200, { ok: true, written: rows.length, asOf });
    }
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
