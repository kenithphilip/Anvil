// POST /api/email/check { id }: the onboarding check of one mailbox. Reads the
// newest sent messages and reports whether replies carry the metadata the
// verifier needs. docs/EMAIL_ACCOUNTABILITY_SCOPE.md section 8, item 1.
//
// The owner or an admin. The requests count against the mailbox's daily
// budget. Read only: Anvil changes nothing in the mailbox. Audited.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { tenantSettings } from "../_lib/stripe-client.js";
import { getAdapter } from "../_lib/mail/adapters.js";
import { newRun, MailError } from "../_lib/mail/provider.js";
import { accessTokenFor } from "../_lib/mail/connections.js";
import { replyHeaderReport } from "../_lib/email-accountability/onboarding.js";
import { loadOwnRow } from "./connections.js";

const bad = (res, status, message) => json(res, status, { error: { message } });

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    if (req.method !== "POST") return bad(res, 405, "method not allowed");
    const ctx = await resolveContext(req);
    requirePermission(ctx, "write");
    const svc = serviceClient();
    const body = (await readBody(req)) || {};
    if (!body.id) return bad(res, 400, "id required");
    if (!(await loadOwnRow(svc, ctx, body.id))) return bad(res, 404, "mailbox not found");
    const r = await svc.from("mailbox_connections").select("*").eq("tenant_id", ctx.tenantId).eq("id", body.id).maybeSingle();
    if (r.error || !r.data) return bad(res, 404, "mailbox not found");
    const conn = r.data;
    if (conn.status !== "active") return bad(res, 409, "the mailbox is " + conn.status);
    const adapter = getAdapter(conn.provider);
    const settings = await tenantSettings(svc, ctx.tenantId);
    if (!adapter?.isConfigured(settings)) return bad(res, 409, conn.provider + " app registration is not configured");

    const today = new Date().toISOString().slice(0, 10);
    const used = conn.requests_date === today ? (conn.requests_today || 0) : 0;
    const run = newRun({ budget: (conn.daily_request_budget ?? 0) - used, deadline: Date.now() + 15_000 });
    let report;
    try {
      const token = await accessTokenFor(svc, conn, settings, adapter);
      report = replyHeaderReport(conn.provider, await adapter.sampleSent(token, run, 10));
    } catch (err) {
      if (!(err instanceof MailError)) throw err;
      const msg = { auth: "the mailbox needs a new sign-in", budget: "the daily request budget is spent" }[err.code]
        || "the provider did not answer (" + err.code + ")";
      return bad(res, err.code === "auth" ? 409 : err.code === "budget" ? 429 : 502, msg);
    } finally {
      await svc.from("mailbox_connections").update({ requests_today: used + run.requests, requests_date: today, updated_at: new Date().toISOString() })
        .eq("tenant_id", ctx.tenantId).eq("id", conn.id);
    }
    await recordAudit(ctx, { action: "mailbox_reply_check", objectType: "mailbox_connection", objectId: conn.id, after: report });
    return json(res, 200, { ok: true, report, requests: run.requests });
  } catch (err) {
    return sendError(res, err);
  }
}
