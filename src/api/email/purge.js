// GET /api/email/purge: clear mail previews past the tenant's retention.
// docs/EMAIL_ACCOUNTABILITY_SCOPE.md 6.9. Cron only (Bearer CRON_SECRET), in
// cron/daily.js as "email/purge".

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { serviceClient } from "../_lib/supabase.js";
import { purgeContent } from "../_lib/email-accountability/retention.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  const secret = process.env.CRON_SECRET;
  const provided = (req.headers?.authorization || "").replace(/^Bearer\s+/i, "");
  if (!secret || provided !== secret) return json(res, 401, { error: { message: "email purge is cron-only" } });
  try {
    return json(res, 200, { ok: true, ...(await purgeContent(serviceClient())) });
  } catch (err) {
    return sendError(res, err);
  }
}
