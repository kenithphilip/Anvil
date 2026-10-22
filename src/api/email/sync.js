// GET /api/email/sync: poll the connected mailboxes that are due.
// docs/EMAIL_ACCOUNTABILITY_SCOPE.md section 6.1.
//
// Cron only (Bearer CRON_SECRET). Registered in cron/tick.js ALWAYS group, so
// it runs only when an external trigger calls the 5-minute tick (Vercel Hobby
// schedules /api/cron/daily only).
//
// Per run: tenants with tenant_settings.email_accountability_enabled, at most
// MAX_MAILBOXES_PER_RUN due mailboxes, oldest due first, each claimed with a
// lease so two overlapping ticks never sync one mailbox twice. One request at
// a time. The run stops claiming 3 s before its deadline.
//
// EA-1 counts messages only (onPage is a no-op). EA-3 plugs in the engine.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { serviceClient } from "../_lib/supabase.js";
import { getAdapter } from "../_lib/mail/adapters.js";
import { syncConnection } from "../_lib/mail/sync.js";

export const MAX_MAILBOXES_PER_RUN = 8;
const RUN_BUDGET_MS = 15_000;
const LEASE_MS = 90_000;

export const runEmailSync = async (svc, { now = new Date(), deadline = Date.now() + RUN_BUDGET_MS, sleep, onPage } = {}) => {
  const tenants = await svc.from("tenant_settings") // audit-allow: cross-tenant (cron sweep)
    .select("*")
    .eq("email_accountability_enabled", true);
  if (tenants.error) throw new Error("email sync tenants: " + tenants.error.message);
  const settingsByTenant = new Map((tenants.data || []).map((s) => [s.tenant_id, s]));
  if (!settingsByTenant.size) return { tenants: 0, mailboxes: 0, results: [] };

  const nowIso = now.toISOString();
  const due = await svc.from("mailbox_connections") // audit-allow: cross-tenant (cron sweep)
    .select("*")
    .in("tenant_id", [...settingsByTenant.keys()])
    .eq("status", "active")
    .or("next_sync_at.is.null,next_sync_at.lte." + nowIso)
    .order("next_sync_at", { ascending: true, nullsFirst: true })
    .limit(MAX_MAILBOXES_PER_RUN);
  if (due.error) throw new Error("email sync mailboxes: " + due.error.message);

  const results = [];
  for (const conn of due.data || []) {
    if (Date.now() > deadline - 3_000) break;
    const adapter = getAdapter(conn.provider);
    const settings = settingsByTenant.get(conn.tenant_id);
    if (!adapter || !adapter.isConfigured(settings)) {
      results.push({ id: conn.id, ok: false, code: "not_configured" });
      continue;
    }
    const claim = await svc.from("mailbox_connections")
      .update({ sync_lease_until: new Date(Date.now() + LEASE_MS).toISOString() })
      .eq("tenant_id", conn.tenant_id)
      .eq("id", conn.id)
      .or("sync_lease_until.is.null,sync_lease_until.lt." + new Date().toISOString())
      .select("id");
    if (claim.error || !claim.data?.length) {
      results.push({ id: conn.id, ok: false, code: "leased" });
      continue;
    }
    results.push(await syncConnection(svc, conn, { adapter, settings, now, deadline, sleep, onPage }));
  }
  return { tenants: settingsByTenant.size, mailboxes: results.length, results };
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  const secret = process.env.CRON_SECRET;
  const provided = (req.headers?.authorization || "").replace(/^Bearer\s+/i, "");
  if (!secret || provided !== secret) return json(res, 401, { error: { message: "email sync is cron-only" } });
  try {
    return json(res, 200, { ok: true, ...(await runEmailSync(serviceClient())) });
  } catch (err) {
    return sendError(res, err);
  }
}
