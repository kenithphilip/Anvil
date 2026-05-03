// GET /api/fx/rates?as_of=YYYY-MM-DD&from=USD&to=INR
//   -> returns the closest persisted rate or fetches from provider when missing
// POST /api/fx/rates  body: { as_of?, from?, to_list? }
//   -> refreshes rates for the given date and persists them.
// Uses Frankfurter (https://www.frankfurter.app) by default. No API key required.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const PROVIDER_URL = process.env.FX_PROVIDER_URL || "https://api.frankfurter.app";
const DEFAULT_TARGETS = ["INR", "CNY", "JPY", "KRW", "USD"];

const isoDate = (d) => {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
};

const fetchProviderRates = async (asOf, fromCcy, targets) => {
  const params = new URLSearchParams({ from: fromCcy, to: targets.filter((t) => t !== fromCcy).join(",") });
  const url = PROVIDER_URL.replace(/\/$/, "") + "/" + asOf + "?" + params.toString();
  const resp = await fetch(url, { headers: { Accept: "application/json" } });
  if (!resp.ok) throw new Error("FX provider " + resp.status + " for " + url);
  const data = await resp.json();
  const rates = data.rates || {};
  const list = Object.entries(rates).map(([to, rate]) => ({ to, rate: Number(rate) || 0 }));
  list.push({ to: fromCcy, rate: 1 });
  return { date: data.date || asOf, base: data.base || fromCcy, rates: list };
};

const upsertRates = async (svc, tenantId, fromCcy, targets, asOf) => {
  const result = await fetchProviderRates(asOf, fromCcy, targets);
  const rows = result.rates.map((entry) => ({
    tenant_id: tenantId,
    from_ccy: fromCcy,
    to_ccy: entry.to,
    rate: entry.rate,
    as_of: result.date,
    source: PROVIDER_URL.includes("frankfurter") ? "frankfurter" : "external",
  }));
  if (!rows.length) return [];
  const { error } = await svc.from("fx_rates").upsert(rows, { onConflict: "tenant_id,from_ccy,to_ccy,as_of" });
  if (error) throw new Error("FX upsert: " + error.message);
  return rows;
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();
    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const fromCcy = String(req.query.from || "USD").toUpperCase();
      const toCcy = String(req.query.to || "INR").toUpperCase();
      const asOf = isoDate(req.query.as_of) || isoDate(new Date());
      if (!asOf) return json(res, 400, { error: { message: "as_of must be a valid date" } });
      const { data, error } = await svc.from("fx_rates")
        .select("*")
        .eq("tenant_id", ctx.tenantId)
        .eq("from_ccy", fromCcy)
        .eq("to_ccy", toCcy)
        .lte("as_of", asOf)
        .order("as_of", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (data) return json(res, 200, { rate: data, fresh: false });
      // No row yet, fetch from provider on the fly.
      try {
        const inserted = await upsertRates(svc, ctx.tenantId, fromCcy, [toCcy], asOf);
        const match = inserted.find((r) => r.to_ccy === toCcy);
        if (!match) return json(res, 404, { error: { message: "Rate not available for " + fromCcy + "/" + toCcy + " on " + asOf } });
        await recordAudit(ctx, { action: "fx_rate_fetch", objectType: "fx", objectId: fromCcy + "/" + toCcy, detail: "as_of=" + asOf + " rate=" + match.rate });
        return json(res, 200, { rate: { ...match, as_of: asOf }, fresh: true });
      } catch (fetchErr) {
        return json(res, 502, { error: { message: "FX lookup failed: " + fetchErr.message } });
      }
    }
    if (req.method === "POST") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      const fromCcy = String(body.from || "USD").toUpperCase();
      const targets = (body.to_list && body.to_list.length ? body.to_list : DEFAULT_TARGETS).map((t) => String(t).toUpperCase());
      const asOf = isoDate(body.as_of) || isoDate(new Date());
      if (!asOf) return json(res, 400, { error: { message: "as_of must be a valid date" } });
      const inserted = await upsertRates(svc, ctx.tenantId, fromCcy, targets, asOf);
      await recordAudit(ctx, { action: "fx_rate_refresh", objectType: "fx", objectId: fromCcy, detail: "as_of=" + asOf + " count=" + inserted.length });
      return json(res, 200, { ok: true, count: inserted.length, rates: inserted });
    }
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
