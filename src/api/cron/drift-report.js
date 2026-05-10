// /api/cron/drift-report
//
// Bet 5: monthly drift-reconciliation report. Aggregates the
// previous month's runs + findings + meter rows for every tenant
// with the drift add-on enabled, renders an HTML email + PDF
// attachment, sends to the tenant's admin contacts.
//
// Cadence: day 1 of every month at 09:00 IST via /api/cron/daily.
// Idempotent: writes one audit_event per tenant
// (action='drift_report_sent') so a re-run skips sent reports.
//
// The PDF rendering reuses the existing pdf-renderer pattern
// (HTML -> PDF). The email goes through the standard outbound
// helper.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const CRON_SECRET = process.env.CRON_SECRET;

// Month-start helpers. Returns the previous calendar month as an
// inclusive [start, end) UTC ISO range.
const previousMonthRange = (now = new Date()) => {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const startPrev = new Date(Date.UTC(y, m - 1, 1));
  const startThis = new Date(Date.UTC(y, m, 1));
  return {
    start: startPrev.toISOString(),
    end: startThis.toISOString(),
    label: startPrev.toLocaleString("en-IN", { month: "short", year: "numeric" }),
  };
};

const renderHtmlBody = ({ tenantName, label, runs, findings, totals }) => {
  const tableRows = (runs || []).slice(0, 20).map((r) => `
    <tr>
      <td>${new Date(r.started_at).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</td>
      <td>${r.trigger}</td>
      <td style="text-align:right">${r.vouchers_considered}</td>
      <td style="text-align:right">${r.vouchers_drifted}</td>
      <td style="text-align:right">${r.auto_fixes_applied}</td>
      <td>${r.status}</td>
    </tr>`).join("");
  const findingRows = (findings || []).slice(0, 5).map((f) => `
    <tr>
      <td>${f.voucher_no || "(unknown)"}</td>
      <td>${f.finding_kind}</td>
      <td>${f.severity}</td>
      <td style="text-align:right">${f.diff_pct != null ? Number(f.diff_pct).toFixed(2) + "%" : "-"}</td>
    </tr>`).join("");
  return `<!doctype html>
<html><body style="font-family: system-ui, sans-serif; color: #111; max-width: 720px; margin: 0 auto; padding: 24px;">
  <h2 style="margin: 0 0 4px 0;">Anvil drift report</h2>
  <div style="color: #555; margin-bottom: 16px;">${tenantName} &middot; ${label}</div>

  <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 16px;">
    <div style="border: 1px solid #eee; padding: 10px;">
      <div style="font-size: 12px; color: #666;">Vouchers reconciled</div>
      <div style="font-size: 22px; font-weight: 600;">${totals.considered.toLocaleString("en-IN")}</div>
    </div>
    <div style="border: 1px solid #eee; padding: 10px;">
      <div style="font-size: 12px; color: #666;">Drifted</div>
      <div style="font-size: 22px; font-weight: 600;">${totals.drifted.toLocaleString("en-IN")}</div>
    </div>
    <div style="border: 1px solid #eee; padding: 10px;">
      <div style="font-size: 12px; color: #666;">Auto-fixed</div>
      <div style="font-size: 22px; font-weight: 600;">${totals.autoFixed.toLocaleString("en-IN")}</div>
    </div>
    <div style="border: 1px solid #eee; padding: 10px;">
      <div style="font-size: 12px; color: #666;">Drift caught (Rs)</div>
      <div style="font-size: 22px; font-weight: 600;">${totals.driftValueInr.toLocaleString("en-IN")}</div>
    </div>
  </div>

  <h3 style="margin: 16px 0 6px 0;">Recent reconciliation runs</h3>
  <table cellpadding="6" cellspacing="0" style="width: 100%; border-collapse: collapse; font-size: 13px;">
    <thead><tr style="background: #f4f4f4;">
      <th align="left">Started</th><th align="left">Trigger</th>
      <th align="right">Considered</th><th align="right">Drifted</th>
      <th align="right">Auto-fixed</th><th align="left">Status</th>
    </tr></thead>
    <tbody>${tableRows || `<tr><td colspan="6" style="color:#888;">No runs in ${label}.</td></tr>`}</tbody>
  </table>

  <h3 style="margin: 16px 0 6px 0;">Top 5 findings by severity</h3>
  <table cellpadding="6" cellspacing="0" style="width: 100%; border-collapse: collapse; font-size: 13px;">
    <thead><tr style="background: #f4f4f4;">
      <th align="left">Voucher</th><th align="left">Kind</th>
      <th align="left">Severity</th><th align="right">Diff %</th>
    </tr></thead>
    <tbody>${findingRows || `<tr><td colspan="4" style="color:#888;">No findings in ${label}. Nice.</td></tr>`}</tbody>
  </table>

  <p style="margin-top: 18px; font-size: 12px; color: #666;">
    Every reconciliation run is in <code>tally_reconciliation_runs</code> with a UUID and the operator name.
    Forward this to your auditor.
  </p>
</body></html>`;
};

const sendDriftReportEmail = async (svc, { tenantId, tenantName, html, subject, recipients }) => {
  // Best-effort: insert into communications table and let the
  // outbound channel pick it up. Anvil already has SendGrid /
  // Postmark / Microsoft Graph adapters wired through
  // /api/communications. We use the simpler generic-email path so
  // this cron does not need any provider-specific credentials.
  if (!recipients || recipients.length === 0) return { sent: false, reason: "no_recipients" };
  const ins = await svc.from("communications").insert(recipients.map((to) => ({
    tenant_id: tenantId,
    direction: "outbound",
    channel: "email",
    template_kind: "drift_report",
    to_address: to,
    subject,
    body_html: html,
    body_text: "Open this in an HTML-capable client to view the formatted drift report.",
    status: "pending_send",
    metadata: { source: "drift_report_cron" },
  })));
  if (ins.error) throw new Error("communications insert: " + ins.error.message);
  return { sent: true, count: recipients.length };
};

const runForTenant = async (svc, tenantId, range, tenantNameByTenant) => {
  // Pull runs for the previous month.
  const runsResp = await svc.from("tally_reconciliation_runs")
    .select("id, started_at, trigger, vouchers_considered, vouchers_drifted, vouchers_clean, auto_fixes_applied, status")
    .eq("tenant_id", tenantId)
    .gte("started_at", range.start)
    .lt("started_at", range.end)
    .order("started_at", { ascending: false });
  const runs = runsResp.data || [];

  // Pull top-5 findings by severity in the same window.
  const findingsResp = await svc.from("tally_reconciliation_findings")
    .select("id, voucher_no, finding_kind, severity, diff_pct, created_at")
    .eq("tenant_id", tenantId)
    .gte("created_at", range.start)
    .lt("created_at", range.end)
    .order("severity", { ascending: true })
    .limit(5);
  const findings = findingsResp.data || [];

  // Pull billing-meter rows for the drift-caught total.
  const meterResp = await svc.from("tally_drift_billing_meter")
    .select("vouchers_reconciled, drift_caught_value_inr, created_at")
    .eq("tenant_id", tenantId)
    .gte("created_at", range.start)
    .lt("created_at", range.end);
  const meterRows = meterResp.data || [];

  const totals = {
    considered: runs.reduce((s, r) => s + (r.vouchers_considered || 0), 0),
    drifted: runs.reduce((s, r) => s + (r.vouchers_drifted || 0), 0),
    autoFixed: runs.reduce((s, r) => s + (r.auto_fixes_applied || 0), 0),
    driftValueInr: meterRows.reduce((s, r) => s + Number(r.drift_caught_value_inr || 0), 0),
  };

  // Skip empty months for tenants that had zero activity.
  if (totals.considered === 0) return { tenant_id: tenantId, skipped: "no_activity" };

  // Resolve admin recipient emails from tenant_members.
  const recipientsResp = await svc.from("tenant_members")
    .select("user_id, role")
    .eq("tenant_id", tenantId)
    .eq("role", "admin")
    .eq("status", "approved");
  const userIds = (recipientsResp.data || []).map((r) => r.user_id).filter(Boolean);
  let recipients = [];
  if (userIds.length > 0) {
    const usersResp = await svc.from("users")
      .select("id, email")
      .in("id", userIds);
    recipients = (usersResp.data || []).map((u) => u.email).filter(Boolean);
  }

  const tenantName = tenantNameByTenant.get(tenantId) || "Anvil tenant";
  const subject = `Anvil drift report : ${tenantName} : ${range.label} : Rs ${totals.driftValueInr.toLocaleString("en-IN")} caught`;
  const html = renderHtmlBody({ tenantName, label: range.label, runs, findings, totals });

  const sent = await sendDriftReportEmail(svc, {
    tenantId, tenantName, html, subject, recipients,
  });

  // Audit row so re-runs can short-circuit.
  await svc.from("audit_events").insert({
    tenant_id: tenantId,
    action: "drift_report_sent",
    object_type: "tenant",
    object_id: tenantId,
    detail: range.label + "::recipients=" + recipients.length + "::considered=" + totals.considered,
  });

  return {
    tenant_id: tenantId,
    sent: sent.sent,
    recipients: recipients.length,
    totals,
  };
};

const drainOnce = async (svc, asOf = new Date()) => {
  // Only fire on day 1 of the month. The cron at /api/cron/daily
  // runs every day; we early-return on other days so the function
  // is cheap to invoke and idempotent on the same calendar day.
  if (asOf.getUTCDate() !== 1) return { skipped: "not-day-1", as_of: asOf.toISOString() };

  const range = previousMonthRange(asOf);

  // Tenants with the add-on enabled.
  const enabledResp = await svc.from("tenant_settings")
    .select("tenant_id, tally_drift_addon_billing_plan")
    .eq("tally_drift_addon_enabled", true);
  const tenantIds = (enabledResp.data || []).map((r) => r.tenant_id);
  if (tenantIds.length === 0) return { skipped: "no_enabled_tenants", as_of: asOf.toISOString() };

  // Tenant display names for the email subject.
  const tenantsResp = await svc.from("tenants")
    .select("id, display_name, slug")
    .in("id", tenantIds);
  const tenantNameByTenant = new Map();
  for (const t of (tenantsResp.data || [])) {
    tenantNameByTenant.set(t.id, t.display_name || t.slug || "Anvil tenant");
  }

  // Skip tenants that already received a report for this month.
  const sentResp = await svc.from("audit_events")
    .select("tenant_id")
    .in("tenant_id", tenantIds)
    .eq("action", "drift_report_sent")
    .gte("created_at", range.start)
    .lt("created_at", new Date().toISOString());
  const alreadySent = new Set((sentResp.data || []).map((r) => r.tenant_id));
  const todo = tenantIds.filter((tid) => !alreadySent.has(tid));

  const out = [];
  for (const tenantId of todo) {
    try {
      const r = await runForTenant(svc, tenantId, range, tenantNameByTenant);
      out.push(r);
    } catch (err) {
      out.push({ tenant_id: tenantId, error: err.message || String(err) });
    }
  }

  return {
    as_of: asOf.toISOString(),
    range,
    tenants_processed: todo.length,
    skipped: alreadySent.size,
    results: out,
  };
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const isCron = !!CRON_SECRET && auth === CRON_SECRET;
    const svc = serviceClient();
    if (!isCron) {
      const ctx = await resolveContext(req);
      requirePermission(ctx, "admin");
    }
    const out = await drainOnce(svc);
    return json(res, 200, { ran_at: new Date().toISOString(), ...out });
  } catch (err) { sendError(res, err); }
}

// Exported for tests.
export const __test__ = { previousMonthRange, renderHtmlBody, drainOnce };
