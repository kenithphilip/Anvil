// GET /api/admin/lane_readiness
//
// Is the Mode B lane ready for the pilot? (docs/SO_EXECUTION_COHESION.md,
// R-M5 and plan C-8.) One read-only list of checks: the lane's flags, the
// migrations it needs, the last run of cron/tick and cron/daily, the mail
// provider, whether the handoff recipients resolve, ClamAV, the
// orders.payment_terms column (OPS-3), and how often each lane step ran in the
// last 7 days.
//
// Each check is { group, id, label, status, reason, value? }, and status is
// "ok", "warn" or "missing". A probe that fails for a reason other than a
// missing table or column reports "warn" with the error, never "ok".
//
// Admin only. Writes nothing. Every query on a tenant table filters tenant_id;
// cron_health is platform-wide and has no tenant.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { emailConfigured, emailProvider } from "../_lib/mailer.js";
import { resolveInternalRecipients } from "../_lib/internal-recipients.js";
import { probeCron } from "../health.js";

// 42703 undefined column, PGRST204 column not in the schema cache, 42P01 and
// PGRST205 the same for a table.
const MISSING_CODES = new Set(["42703", "PGRST204", "42P01", "PGRST205"]);

// The migrations the lane needs, each probed by one table and column it adds.
// shortcut: 253 is probed before its PR (C-17) merges, so it reads missing until then.
export const LANE_MIGRATIONS = Object.freeze([
  { id: "221_so_processing_mode", table: "tenant_settings", columns: "so_processing_mode", needed_for: "Mode B" },
  { id: "250_order_terms", table: "order_term_checks", columns: "id", needed_for: "the terms check" },
  { id: "251_order_handoff", table: "orders", columns: "handoff_status", needed_for: "the handoff" },
  { id: "253_notification_recipient", table: "admin_notifications", columns: "recipient_user_id", needed_for: "per-person notices (C-17)" },
]);

// The audit actions that show a lane step was used.
export const LANE_STEPS = Object.freeze([
  { action: "create_order", label: "PO to order" },
  { action: "order_reconcile_quotes", label: "Quote reconcile" },
  { action: "order_terms_checked", label: "Terms check" },
  { action: "order_term_decided", label: "Terms decision" },
  { action: "approve_order", label: "Approve" },
  { action: "so_pdf_downloaded", label: "SO PDF download" },
  { action: "order_sales_order_attached", label: "ERP SO attach" },
]);

const WINDOW_DAYS = 7;
const CRON_WORKERS = [
  { worker: "cron/tick", every: "every 5 minutes" },
  { worker: "cron/daily", every: "once a day" },
];

const check = (group, id, label, status, reason, value) =>
  ({ group, id, label, status, reason, ...(value !== undefined ? { value } : {}) });

// One probe per table and column set, run once per request.
const makeProbe = (svc, tenantId) => {
  const seen = new Map();
  return (table, columns) => {
    const key = table + ":" + columns;
    if (!seen.has(key)) {
      seen.set(key, (async () => {
        const r = await svc.from(table).select(columns).eq("tenant_id", tenantId).limit(1);
        if (!r.error) return { present: true, row: (r.data || [])[0] || null };
        if (MISSING_CODES.has(r.error.code)) return { present: false };
        return { error: String(r.error.message || r.error.code || "error") };
      })());
    }
    return seen.get(key);
  };
};

const flagChecks = async (probe) => {
  const [mode, terms, handoff] = await Promise.all([
    probe("tenant_settings", "so_processing_mode"),
    probe("tenant_settings", "terms_check_mode"),
    probe("tenant_settings", "order_handoff_enabled, order_handoff_to, order_handoff_cc"),
  ]);
  const out = [];
  const flag = (id, label, p, migration, rate) => {
    if (p.error) return out.push(check("flags", id, label, "warn", "Could not read: " + p.error));
    if (!p.present) return out.push(check("flags", id, label, "missing", "Migration " + migration + " is not applied."));
    const [status, reason, value] = rate(p.row);
    out.push(check("flags", id, label, status, reason, value));
  };
  flag("so_processing_mode", "SO processing mode", mode, "221", (row) => {
    const v = row?.so_processing_mode || "A";
    return v === "B"
      ? ["ok", "Mode B: the clerk keys the SO in the ERP and Anvil pushes nothing.", v]
      : ["warn", "Mode A: Anvil pushes to the ERP. The pilot lane is Mode B (Admin > Sales-order processing).", v];
  });
  flag("terms_check_mode", "Terms check", terms, "250", (row) => {
    const v = row?.terms_check_mode || "off";
    if (v === "on") return ["ok", "On: the check runs and engineers see it.", v];
    if (v === "shadow") return ["ok", "Shadow: the check runs and is stored, and engineers do not see it.", v];
    return ["warn", "Off: the terms check does not run.", v];
  });
  flag("order_handoff_enabled", "Order handoff", handoff, "251", (row) => (row?.order_handoff_enabled === true
    ? ["ok", "On: engineers see the handoff button.", true]
    : ["warn", "Off. C-D13 turns it on after C-18 and the shadow week.", false]));
  return { checks: out, handoff };
};

const migrationChecks = async (probe) => Promise.all(LANE_MIGRATIONS.map(async (m) => {
  const p = await probe(m.table, m.columns);
  const label = "Migration " + m.id.split("_")[0];
  if (p.error) return check("migrations", m.id, label, "warn", "Could not probe " + m.table + "." + m.columns + ": " + p.error);
  return p.present
    ? check("migrations", m.id, label, "ok", "Applied: " + m.table + "." + m.columns + " exists.")
    : check("migrations", m.id, label, "missing", "Not applied: " + m.table + "." + m.columns + " does not exist. The lane needs it for " + m.needed_for + ".");
}));

const minutes = (seconds) => Math.round((Number(seconds) || 0) / 60);

const cronChecks = async () => {
  const cron = await probeCron();
  return CRON_WORKERS.map(({ worker, every }) => {
    if (!cron.configured) return check("cron", worker, worker, "warn", "Could not read cron_health: " + (cron.error || "error"));
    const w = (cron.workers || []).find((x) => x.worker === worker);
    if (!w) return check("cron", worker, worker, "missing", "No cron_health row: nothing has run " + worker + ".");
    const ago = "Last run " + minutes(w.age_seconds) + " min ago";
    if (w.stale) return check("cron", worker, worker, "warn", ago + ". Expected " + every + ".", w.last_run_at);
    if (w.last_status !== "ok" || w.consecutive_failures > 0) {
      return check("cron", worker, worker, "warn", ago + ", status " + w.last_status + ", " + w.consecutive_failures + " failure(s) in a row.", w.last_run_at);
    }
    return check("cron", worker, worker, "ok", ago + ", status ok.", w.last_run_at);
  });
};

const serviceChecks = async (svc, tenantId, handoff) => {
  const out = [];
  const provider = emailProvider();
  out.push(emailConfigured()
    ? check("services", "mail_provider", "Mail provider", "ok", "Provider: " + provider + ".", provider)
    : check("services", "mail_provider", "Mail provider", "missing", "No mail provider. Set EMAIL_PROVIDER, its API key and EMAIL_FROM.", null));

  const label = "Handoff recipients";
  if (handoff.error) out.push(check("services", "handoff_recipients", label, "warn", "Could not read the handoff settings: " + handoff.error));
  else if (!handoff.present) out.push(check("services", "handoff_recipients", label, "missing", "Migration 251 is not applied."));
  else {
    const row = handoff.row || {};
    const to = Array.isArray(row.order_handoff_to) ? row.order_handoff_to : [];
    const cc = Array.isArray(row.order_handoff_cc) ? row.order_handoff_cc : [];
    if (!to.length) out.push(check("services", "handoff_recipients", label, "missing", "No To recipient is set (Admin > Order handoff)."));
    else {
      try {
        // Counts only: the addresses stay on Admin > Order handoff.
        const r = await resolveInternalRecipients(svc, tenantId, { to, cc });
        const counts = { to: r.to.length, cc: r.cc.length, dropped: r.dropped.length };
        const said = counts.to + " To and " + counts.cc + " CC address(es) resolve";
        if (!counts.to) out.push(check("services", "handoff_recipients", label, "missing", "No To entry resolves to an address.", counts));
        else if (counts.dropped) out.push(check("services", "handoff_recipients", label, "warn", said + "; " + counts.dropped + " entry(ies) resolve to nobody.", counts));
        else out.push(check("services", "handoff_recipients", label, "ok", said + ".", counts));
      } catch (e) {
        out.push(check("services", "handoff_recipients", label, "warn", "Could not resolve: " + String(e?.message || e)));
      }
    }
  }

  out.push(process.env.CLAMAV_URL
    ? check("services", "clamav", "ClamAV", "ok", "CLAMAV_URL is set.")
    : check("services", "clamav", "ClamAV", "missing", "CLAMAV_URL is not set, so inbound auto-OCR never runs (OPS-2)."));
  return out;
};

const paymentTermsCheck = async (probe) => {
  const p = await probe("orders", "payment_terms");
  const label = "orders.payment_terms";
  if (p.error) return check("schema", "orders_payment_terms", label, "warn", "Could not probe: " + p.error);
  return p.present
    ? check("schema", "orders_payment_terms", label, "ok", "The column exists.")
    : check("schema", "orders_payment_terms", label, "missing", "The column does not exist, and no migration creates it. The three-way report and the order export select it (OPS-3).");
};

const usageChecks = async (svc, tenantId, now) => {
  const since = new Date(now - WINDOW_DAYS * 86400000).toISOString();
  return Promise.all(LANE_STEPS.map(async ({ action, label }) => {
    const r = await svc.from("audit_events").select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId).eq("action", action).gte("created_at", since);
    if (r.error) return check("usage", action, label, "warn", "Could not count: " + String(r.error.message || r.error.code));
    const n = r.count || 0;
    return n
      ? check("usage", action, label, "ok", n + " in the last " + WINDOW_DAYS + " days.", n)
      : check("usage", action, label, "warn", "Not used in the last " + WINDOW_DAYS + " days.", 0);
  }));
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return json(res, 405, { error: { message: "Method not allowed" } });
    }
    const ctx = await resolveContext(req);
    requirePermission(ctx, "admin");
    if (!ctx.tenantId) return json(res, 400, { error: { message: "No tenant on this session", code: "TENANT_REQUIRED" } });
    const svc = serviceClient();
    const probe = makeProbe(svc, ctx.tenantId);
    const now = Date.now();

    const flags = await flagChecks(probe);
    const groups = await Promise.all([
      migrationChecks(probe),
      cronChecks(),
      serviceChecks(svc, ctx.tenantId, flags.handoff),
      paymentTermsCheck(probe).then((c) => [c]),
      usageChecks(svc, ctx.tenantId, now),
    ]);
    const checks = [...flags.checks, ...groups.flat()];
    const summary = { ok: 0, warn: 0, missing: 0 };
    for (const c of checks) summary[c.status] += 1;
    return json(res, 200, { lane: "mode_b", window_days: WINDOW_DAYS, generated_at: new Date(now).toISOString(), summary, checks });
  } catch (err) { sendError(res, err); }
}
