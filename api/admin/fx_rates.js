// /api/admin/fx_rates
//   GET    ?from=&to=&days=N  list recent rates for current tenant
//   POST   trigger a refresh for { asOf?, base?, targets? } and persist tenant rows
//
// This bypasses the cron and lets an admin pull a specific historical date on demand.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const PROVIDER_URL = process.env.FX_PROVIDER_URL || "https://api.frankfurter.app";
const DEFAULT_TARGETS = ["INR", "CNY", "JPY", "KRW", "USD", "EUR"];

const fetchRates = async (asOf, fromCcy, targets) => {
  const params = new URLSearchParams({ from: fromCcy, to: targets.filter((t) => t !== fromCcy).join(",") });
  const url = PROVIDER_URL.replace(/\/$/, "") + "/" + asOf + "?" + params.toString();
  const resp = await fetch(url, { headers: { Accept: "application/json" } });
  if (!resp.ok) throw new Error("Provider " + resp.status);
  const data = await resp.json();
  return { date: data.date || asOf, base: data.base || fromCcy, rates: data.rates || {} };
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();
    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const days = Math.max(1, Math.min(365, Number(req.query.days || 90)));
      const since = new Date(Date.now() - days * 86400 * 1000).toISOString().slice(0, 10);
      let q = svc.from("fx_rates").select("*").eq("tenant_id", ctx.tenantId).gte("as_of", since).order("as_of", { ascending: false }).limit(5000);
      if (req.query.from) q = q.eq("from_ccy", String(req.query.from).toUpperCase());
      if (req.query.to) q = q.eq("to_ccy", String(req.query.to).toUpperCase());
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return json(res, 200, { rates: data || [] });
    }
    if (req.method === "POST") {
      requirePermission(ctx, "admin");
      const body = await readBody(req);
      const asOf = body.asOf || new Date(Date.now() - 86400 * 1000).toISOString().slice(0, 10);
      const targets = Array.isArray(body.targets) && body.targets.length ? body.targets.map((t) => String(t).toUpperCase()) : DEFAULT_TARGETS;
      const bases = Array.isArray(body.bases) && body.bases.length ? body.bases.map((t) => String(t).toUpperCase()) : DEFAULT_TARGETS;
      let inserted = 0;
      for (const fromCcy of bases) {
        try {
          const r = await fetchRates(asOf, fromCcy, targets);
          const rows = Object.entries(r.rates).map(([to, rate]) => ({
            tenant_id: ctx.tenantId,
            from_ccy: fromCcy,
            to_ccy: to,
            rate: Number(rate) || 0,
            as_of: r.date,
            source: PROVIDER_URL.includes("frankfurter") ? "frankfurter" : "external",
          }));
          rows.push({ tenant_id: ctx.tenantId, from_ccy: fromCcy, to_ccy: fromCcy, rate: 1, as_of: r.date, source: "self" });
          if (!rows.length) continue;
          const { error } = await svc.from("fx_rates").upsert(rows, { onConflict: "tenant_id,from_ccy,to_ccy,as_of" });
          if (!error) inserted += rows.length;
        } catch (e) {
          // continue best-effort
          continue;
        }
      }
      await recordAudit(ctx, { action: "fx_manual_refresh", objectType: "fx", objectId: asOf, detail: "rows=" + inserted });
      return json(res, 200, { ok: true, asOf, rows: inserted });
    }
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
