// GET /api/email/sweep: reminders and escalation for open email actions.
// docs/EMAIL_ACCOUNTABILITY_SCOPE.md 6.7.
//
// Cron only (Bearer CRON_SECRET). In the tick ALWAYS group as "email/sweep"
// and in cron/daily as "email/sweep_daily", the backstop. Only tenants with
// the module on and email_actions_mode 'create'. Idempotent through the
// email_action_notices ledger.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { serviceClient } from "../_lib/supabase.js";
import { runSweep } from "../_lib/email-accountability/escalation.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  const secret = process.env.CRON_SECRET;
  const provided = (req.headers?.authorization || "").replace(/^Bearer\s+/i, "");
  if (!secret || provided !== secret) return json(res, 401, { error: { message: "email sweep is cron-only" } });
  try {
    return json(res, 200, { ok: true, ...(await runSweep(serviceClient())) });
  } catch (err) {
    return sendError(res, err);
  }
}
