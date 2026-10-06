// /api/service/amc_cron
// Daily cron that turns AMC schedule rows due in the next N days into
// service_visits rows, marking the AMC row VISIT_CREATED. Mirrors the
// pattern in api/fx/cron.js: required CRON_SECRET, iterate all tenants.
// Runs once a day from /api/cron/daily.
//
// Auth: like fx/cron.js (Audit H8 + H10), it refuses to run when
// CRON_SECRET is not configured. It used to check the secret only when
// one was set, which left the endpoint open to anyone. /api/cron/daily,
// its only scheduled caller, already refuses without the secret, so
// this changes nothing for the scheduled run.
//
// Contract gate: a visit is minted only while its contract is in force.
// contracts.status (migration 006) is ACTIVE, PENDING_RENEWAL (still
// running, renewal pending), EXPIRED or TERMINATED. The first two are in
// force until end_date. A row whose contract is EXPIRED or TERMINATED,
// has passed its end_date, or ends before the visit date, is skipped
// and left SCHEDULED, so a renewal that moves end_date picks it up on
// the next run.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { timingSafeEqual } from "../_lib/sanitize.js";

const DAYS_AHEAD = 7;
const IN_FORCE_STATUSES = new Set(["ACTIVE", "PENDING_RENEWAL"]);

// Why a due row may not become a visit, or null when it may.
const contractSkipReason = (contract, scheduledDate, todayIso) => {
  if (!contract) return "contract_missing";
  if (!IN_FORCE_STATUSES.has(contract.status)) return "contract_" + String(contract.status || "unknown").toLowerCase();
  if (contract.end_date && (contract.end_date < todayIso || contract.end_date < scheduledDate)) return "contract_ended";
  return null;
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "GET" && req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
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
    const horizonDays = Math.max(1, Math.min(30, Number(req.query.days || DAYS_AHEAD)));
    const todayIso = new Date().toISOString().slice(0, 10);
    const horizonIso = new Date(Date.now() + horizonDays * 86400 * 1000).toISOString().slice(0, 10);
    const svc = serviceClient();

    const due = await svc
      .from("amc_schedules")
      .select("id, tenant_id, customer_id, customer_location_id, scheduled_date, visit_label, contract_id, contract:contract_id(status, end_date)")
      .eq("status", "SCHEDULED")
      .lte("scheduled_date", horizonIso);
    if (due.error) throw new Error(due.error.message);

    let created = 0;
    const errors = [];
    const skipped = [];
    for (const row of due.data || []) {
      const skip = contractSkipReason(row.contract, row.scheduled_date, todayIso);
      if (skip) {
        skipped.push({ amc_id: row.id, contract_id: row.contract_id, reason: skip });
        continue;
      }
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
    return json(res, 200, { ok: true, today: todayIso, horizon: horizonIso, due: (due.data || []).length, created, skipped, errors });
  } catch (err) {
    sendError(res, err);
  }
}
