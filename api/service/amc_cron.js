// /api/service/amc_cron
// Daily cron that turns AMC schedule rows due in the next N days into
// service_visits rows, marking the AMC row VISIT_CREATED. Mirrors the
// pattern in api/fx/cron.js: optional CRON_SECRET, iterate all tenants.
// Wire into vercel.json crons to fire once a day.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const DAYS_AHEAD = 7;

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "GET" && req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const secret = process.env.CRON_SECRET;
    if (secret) {
      const provided = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      if (provided !== secret) return json(res, 401, { error: { message: "Cron secret mismatch" } });
    }
    const horizonDays = Math.max(1, Math.min(30, Number(req.query.days || DAYS_AHEAD)));
    const todayIso = new Date().toISOString().slice(0, 10);
    const horizonIso = new Date(Date.now() + horizonDays * 86400 * 1000).toISOString().slice(0, 10);
    const svc = serviceClient();

    const due = await svc
      .from("amc_schedules")
      .select("id, tenant_id, customer_id, customer_location_id, scheduled_date, visit_label")
      .eq("status", "SCHEDULED")
      .lte("scheduled_date", horizonIso);
    if (due.error) throw new Error(due.error.message);

    let created = 0;
    const errors = [];
    for (const row of due.data || []) {
      try {
        const visit = await svc.from("service_visits").insert({
          tenant_id: row.tenant_id,
          customer_id: row.customer_id,
          customer_location_id: row.customer_location_id || null,
          visit_date: row.scheduled_date,
          purpose: row.visit_label || "AMC preventive maintenance (auto-generated)",
          status: "PLANNED",
        }).select("id").single();
        if (visit.error) {
          errors.push({ amc_id: row.id, message: visit.error.message });
          continue;
        }
        const upd = await svc
          .from("amc_schedules")
          .update({ status: "VISIT_CREATED", generated_visit_id: visit.data.id, generated_at: new Date().toISOString() })
          .eq("id", row.id);
        if (upd.error) {
          errors.push({ amc_id: row.id, message: upd.error.message });
          continue;
        }
        await recordAudit({ tenantId: row.tenant_id, role: "system" }, {
          action: "amc_visit_auto_created",
          objectType: "amc_schedule",
          objectId: row.id,
          detail: "visit_id=" + visit.data.id,
        });
        created += 1;
      } catch (err) {
        errors.push({ amc_id: row.id, message: err.message });
      }
    }
    return json(res, 200, { ok: true, today: todayIso, horizon: horizonIso, due: (due.data || []).length, created, errors });
  } catch (err) {
    sendError(res, err);
  }
}
