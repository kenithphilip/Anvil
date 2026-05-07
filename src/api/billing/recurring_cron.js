// /api/billing/recurring_cron
//
// Audit P7.6. Daily cron that drains due recurring_invoice_schedules
// rows: for each row with status='ACTIVE' and next_invoice_date <=
// today, materialise an invoice (via nextInvoiceNumber for atomic
// numbering), advance next_invoice_date by the cadence, increment
// invoice_count, and auto-cancel when max_invoices or end_date is
// reached.
//
// Wired from /api/cron/daily. Bearer-secret protected (CRON_SECRET).

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { nextInvoiceNumber } from "../_lib/invoicing.js";
import { advanceDate } from "./recurring.js";

const CRON_SECRET = process.env.CRON_SECRET;

const buildInvoice = (sched, invoiceNumber) => {
  const issue = new Date().toISOString().slice(0, 10);
  const due = (() => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + (sched.net_days || 30));
    return d.toISOString().slice(0, 10);
  })();
  // Default to a single line item summarising the recurring charge
  // when the operator hasn't supplied per-line breakdowns.
  const items = Array.isArray(sched.line_items) && sched.line_items.length
    ? sched.line_items
    : [{
        description: sched.description || "Recurring charge",
        quantity: 1,
        rate: Number(sched.amount),
        total: Number(sched.amount),
      }];
  const subtotal = items.reduce(
    (s, it) => s + (Number(it.total) || (Number(it.rate || 0) * Number(it.quantity || 0))),
    0,
  );
  return {
    tenant_id: sched.tenant_id,
    customer_id: sched.customer_id,
    invoice_number: invoiceNumber,
    issue_date: issue,
    due_date: due,
    currency: sched.currency || "INR",
    subtotal,
    tax_total: 0,
    grand_total: Number(sched.amount),
    payment_terms: sched.payment_terms || ("Net " + (sched.net_days || 30)),
    notes: sched.description || null,
    line_items: items,
    status: "draft",
  };
};

const processOne = async (svc, sched) => {
  const today = new Date().toISOString().slice(0, 10);
  // Re-check status / due-date inside the loop to keep the cron
  // safe against concurrent operator edits.
  if (sched.status !== "ACTIVE") return { ok: false, id: sched.id, skipped: "not_active" };
  if (sched.next_invoice_date > today) return { ok: false, id: sched.id, skipped: "not_due" };
  if (sched.end_date && sched.end_date < today) {
    await svc.from("recurring_invoice_schedules").update({
      status: "CANCELLED",
      last_attempt_at: new Date().toISOString(),
      last_error: "end_date passed",
      updated_at: new Date().toISOString(),
    }).eq("id", sched.id);
    return { ok: false, id: sched.id, skipped: "ended" };
  }
  if (sched.max_invoices && sched.invoice_count >= sched.max_invoices) {
    await svc.from("recurring_invoice_schedules").update({
      status: "CANCELLED",
      last_attempt_at: new Date().toISOString(),
      last_error: "max_invoices reached",
      updated_at: new Date().toISOString(),
    }).eq("id", sched.id);
    return { ok: false, id: sched.id, skipped: "max_reached" };
  }

  const invoiceNumber = await nextInvoiceNumber(svc, sched.tenant_id);
  const ins = await svc.from("invoices").insert(buildInvoice(sched, invoiceNumber)).select("*").single();
  if (ins.error) throw new Error(ins.error.message);

  const newCount = (sched.invoice_count || 0) + 1;
  const advanced = advanceDate(sched.next_invoice_date, sched.cadence);
  // Auto-cancel if we hit the cap or roll past the end date with
  // this advancement.
  const willCancel = (sched.max_invoices && newCount >= sched.max_invoices)
                  || (sched.end_date && advanced > sched.end_date);
  await svc.from("recurring_invoice_schedules").update({
    invoice_count: newCount,
    next_invoice_date: advanced,
    last_invoice_id: ins.data.id,
    last_invoiced_at: new Date().toISOString(),
    last_attempt_at: new Date().toISOString(),
    last_error: null,
    status: willCancel ? "CANCELLED" : "ACTIVE",
    updated_at: new Date().toISOString(),
  }).eq("id", sched.id);

  await recordAudit({ tenantId: sched.tenant_id, role: "system" }, {
    action: "recurring_invoice_generated",
    objectType: "invoice",
    objectId: ins.data.id,
    detail: "schedule=" + sched.id + " invoice=" + invoiceNumber + " seq=" + newCount,
  });

  return { ok: true, id: sched.id, invoice_id: ins.data.id, invoice_number: invoiceNumber };
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "GET" && req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!CRON_SECRET || auth !== CRON_SECRET) {
      return json(res, 401, { error: { message: "recurring_cron is cron-only" } });
    }
    const today = new Date().toISOString().slice(0, 10);
    const svc = serviceClient();
    const due = await svc.from("recurring_invoice_schedules")
      .select("id, tenant_id, customer_id, contract_id, cadence, amount, currency, start_date, next_invoice_date, end_date, invoice_count, max_invoices, description, line_items, payment_terms, net_days, status")
      .eq("status", "ACTIVE")
      .lte("next_invoice_date", today)
      .order("next_invoice_date", { ascending: true })
      .limit(200);
    if (due.error) throw new Error(due.error.message);

    const results = [];
    for (const sched of due.data || []) {
      try {
        results.push(await processOne(svc, sched));
      } catch (err) {
        await svc.from("recurring_invoice_schedules").update({
          last_attempt_at: new Date().toISOString(),
          last_error: String(err.message || err).slice(0, 400),
          updated_at: new Date().toISOString(),
        }).eq("id", sched.id);
        results.push({ ok: false, id: sched.id, error: err.message });
      }
    }
    return json(res, 200, {
      ran_at: new Date().toISOString(),
      today,
      considered: (due.data || []).length,
      generated: results.filter((r) => r.ok).length,
      skipped: results.filter((r) => r.skipped).length,
      errors: results.filter((r) => !r.ok && !r.skipped).length,
      results,
    });
  } catch (err) { sendError(res, err); }
}
