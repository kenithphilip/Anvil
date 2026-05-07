// /api/eway_bills/expire
//
// Audit P7.7. Daily sweeper that flips GENERATED rows whose
// ewb_valid_upto has passed to EXPIRED. NIC's portal does this
// implicitly (no API call to "expire" exists); we mirror the state
// here so internal queries on status='GENERATED' are honest.
//
// Wired from /api/cron/daily.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const CRON_SECRET = process.env.CRON_SECRET;

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "GET" && req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!CRON_SECRET || auth !== CRON_SECRET) {
      return json(res, 401, { error: { message: "eway_bills/expire is cron-only" } });
    }
    const svc = serviceClient();
    const nowIso = new Date().toISOString();
    const due = await svc.from("eway_bills")
      .select("id, tenant_id, ewb_no, ewb_valid_upto")
      .eq("status", "GENERATED")
      .lt("ewb_valid_upto", nowIso)
      .limit(500);
    if (due.error) throw new Error(due.error.message);

    let expired = 0;
    for (const row of due.data || []) {
      const upd = await svc.from("eway_bills").update({
        status: "EXPIRED",
        updated_at: new Date().toISOString(),
      }).eq("id", row.id);
      if (!upd.error) {
        expired += 1;
        await recordAudit({ tenantId: row.tenant_id, role: "system" }, {
          action: "eway_expired",
          objectType: "eway_bill",
          objectId: row.id,
          detail: "ewb_no=" + (row.ewb_no || "?"),
        });
      }
    }
    return json(res, 200, { ran_at: nowIso, considered: (due.data || []).length, expired });
  } catch (err) { sendError(res, err); }
}
