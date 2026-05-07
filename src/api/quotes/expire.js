// GET or POST /api/quotes/expire
//
// Cron-only via Bearer CRON_SECRET (drains every daily tick),
// plus an admin-triggered manual run. Flips quotes where:
//
//   status IN ('SENT', 'PENDING_INTERNAL_APPROVAL')
//   AND expires_at < now()
//
// to status='EXPIRED'. Audit P6.5. The quotes lifecycle had no
// EXPIRED transition fired automatically; an operator who sent a
// quote, then forgot, would have it sit indefinitely with the
// portal-accept link still active. The expiry cron + the daily
// expiring_quote_nudge agent handler (Phase 6.9) close the loop.
//
// Wired into /api/cron/daily so it runs once a day.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const CRON_SECRET = process.env.CRON_SECRET;
const BATCH_SIZE = 200;

const drainOnce = async (svc) => {
  const nowIso = new Date().toISOString();
  const candidates = await svc.from("quotes")
    .select("id, tenant_id, quote_number, version, status, expires_at, customer_id")
    .in("status", ["SENT", "PENDING_INTERNAL_APPROVAL"])
    .lte("expires_at", nowIso)
    .limit(BATCH_SIZE);
  if (candidates.error) throw new Error("quotes select: " + candidates.error.message);

  const expired = [];
  const errors = [];
  for (const q of candidates.data || []) {
    const upd = await svc.from("quotes").update({
      status: "EXPIRED",
      updated_at: nowIso,
    }).eq("id", q.id).select("id").maybeSingle();
    if (upd.error) {
      errors.push({ id: q.id, error: upd.error.message });
      continue;
    }
    expired.push({ id: q.id, quote_number: q.quote_number, version: q.version });
    // Best-effort audit; failure here doesn't block the rest.
    await svc.from("audit_events").insert({
      tenant_id: q.tenant_id,
      action: "quote_expired",
      object_type: "quote",
      object_id: q.id,
      detail: q.quote_number + " v" + q.version + " expires_at=" + q.expires_at,
    });
  }
  return { ran_at: nowIso, considered: (candidates.data || []).length, expired, errors };
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const isCron = !!CRON_SECRET && auth === CRON_SECRET;
    const svc = serviceClient();
    if (isCron) {
      const out = await drainOnce(svc);
      return json(res, 200, out);
    }
    if (req.method !== "POST" && req.method !== "GET") {
      res.setHeader("Allow", "POST, GET");
      return json(res, 405, { error: { message: "Method not allowed" } });
    }
    const ctx = await resolveContext(req);
    requirePermission(ctx, "approve");
    const out = await drainOnce(svc);
    await recordAudit(ctx, {
      action: "quote_expire_drain",
      objectType: "tenant",
      objectId: ctx.tenantId,
      detail: "expired=" + out.expired.length + " errors=" + out.errors.length,
    });
    return json(res, 200, out);
  } catch (err) { sendError(res, err); }
}
