// GET /api/fx/cron
// Scheduled by vercel.json. Iterates every tenant and refreshes FX rates for the previous business day.
// No auth required when invoked by Vercel cron, but we accept an optional CRON_SECRET header
// to restrict manual triggering.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { timingSafeEqual } from "../_lib/sanitize.js";
import { safeFetch } from "../_lib/safe-fetch.js";

const PROVIDER_URL = process.env.FX_PROVIDER_URL || "https://api.frankfurter.app";
const DEFAULT_TARGETS = ["INR", "CNY", "JPY", "KRW", "USD"];

const isoYesterday = () => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

const fetchRates = async (asOf, fromCcy, targets) => {
  const params = new URLSearchParams({ from: fromCcy, to: targets.filter((t) => t !== fromCcy).join(",") });
  const url = PROVIDER_URL.replace(/\/$/, "") + "/" + asOf + "?" + params.toString();
  const resp = await safeFetch(url, { headers: { Accept: "application/json" } });
  if (!resp.ok) throw new Error("Provider " + resp.status);
  const data = await resp.json();
  return { date: data.date || asOf, base: data.base || fromCcy, rates: data.rates || {} };
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "GET" && req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    // Audit H8 + H10 (May 2026): refuse to run when CRON_SECRET is
    // not configured (previously the secret check was conditional
    // on the env var being set, which let an attacker hit this
    // endpoint unauthenticated and trigger external FX provider
    // calls + DB writes for arbitrary tenants). Compare with
    // crypto.timingSafeEqual to remove the string-comparison timing
    // oracle.
    const secret = process.env.CRON_SECRET;
    if (!secret) {
      return json(res, 503, {
        error: { code: "CRON_SECRET_MISSING", message: "CRON_SECRET must be configured to invoke this endpoint." },
      });
    }
    const provided = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!timingSafeEqual(provided, secret)) {
      return json(res, 401, { error: { message: "Cron secret mismatch" } });
    }
    const svc = serviceClient();
    const asOf = (req.query && req.query.as_of) || isoYesterday();
    const tenants = await svc.from("tenants").select("id");
    if (tenants.error) throw new Error(tenants.error.message);
    const tenantIds = (tenants.data || []).map((t) => t.id);
    let total = 0;
    for (const fromCcy of DEFAULT_TARGETS) {
      const result = await fetchRates(asOf, fromCcy, DEFAULT_TARGETS);
      const baseRows = Object.entries(result.rates).map(([to, rate]) => ({ to, rate: Number(rate) || 0 }));
      baseRows.push({ to: fromCcy, rate: 1 });
      for (const tenantId of tenantIds) {
        const rows = baseRows.map((entry) => ({
          tenant_id: tenantId,
          from_ccy: fromCcy,
          to_ccy: entry.to,
          rate: entry.rate,
          as_of: result.date,
          source: PROVIDER_URL.includes("frankfurter") ? "frankfurter" : "external",
        }));
        if (!rows.length) continue;
        const { error } = await svc.from("fx_rates").upsert(rows, { onConflict: "tenant_id,from_ccy,to_ccy,as_of" });
        if (error) console.warn("[fx-cron] upsert failed for tenant", tenantId, error.message);
        else total += rows.length;
      }
    }
    if (tenantIds.length) {
      // Audit one row per tenant so each tenant's audit log shows the cron run, not just the first.
      for (const tid of tenantIds) {
        try {
          await recordAudit({ tenantId: tid, role: "system" }, {
            action: "fx_cron_run",
            objectType: "fx",
            objectId: asOf,
            detail: "rows=" + total + " for tenant=" + tid,
          });
        } catch (e) { console.warn("[fx-cron] audit failed for tenant", tid, e.message); }
      }
    }
    return json(res, 200, { ok: true, tenants: tenantIds.length, rows: total, asOf });
  } catch (err) {
    sendError(res, err);
  }
}
