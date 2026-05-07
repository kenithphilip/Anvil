// /api/billing/recurring
//
// Audit P7.6. CRUD for recurring_invoice_schedules. The cron at
// /api/billing/recurring_cron drains rows where status='ACTIVE'
// and next_invoice_date <= today; this endpoint configures them.
//
// GET    list (filter by contract_id, customer_id, status, due_before)
// POST   create
// PATCH  update fields or pause / resume / cancel
// DELETE soft cancel (sets status='CANCELLED')

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const VALID_CADENCES = new Set(["MONTHLY", "QUARTERLY", "BIANNUAL", "ANNUAL"]);
const VALID_STATUSES = new Set(["ACTIVE", "PAUSED", "CANCELLED"]);

const advance = (dateStr, cadence) => {
  const d = new Date(dateStr + "T00:00:00Z");
  if (cadence === "MONTHLY") d.setUTCMonth(d.getUTCMonth() + 1);
  else if (cadence === "QUARTERLY") d.setUTCMonth(d.getUTCMonth() + 3);
  else if (cadence === "BIANNUAL") d.setUTCMonth(d.getUTCMonth() + 6);
  else d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.toISOString().slice(0, 10);
};

export const advanceDate = advance;

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();
    const id = req.query?.id || null;

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      let q = svc.from("recurring_invoice_schedules").select("*").eq("tenant_id", ctx.tenantId);
      if (id) q = q.eq("id", id);
      if (req.query?.contract_id) q = q.eq("contract_id", req.query.contract_id);
      if (req.query?.customer_id) q = q.eq("customer_id", req.query.customer_id);
      if (req.query?.status && VALID_STATUSES.has(req.query.status)) q = q.eq("status", req.query.status);
      if (req.query?.due_before) q = q.lte("next_invoice_date", req.query.due_before);
      q = q.order("next_invoice_date", { ascending: true }).limit(500);
      const r = await q;
      if (r.error) throw new Error(r.error.message);
      if (id) {
        if (!r.data?.length) return json(res, 404, { error: { message: "schedule not found" } });
        return json(res, 200, { schedule: r.data[0] });
      }
      return json(res, 200, { schedules: r.data || [] });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      if (!body?.cadence || !VALID_CADENCES.has(body.cadence)) {
        return json(res, 400, { error: { message: "cadence required (MONTHLY|QUARTERLY|BIANNUAL|ANNUAL)" } });
      }
      if (!body?.customer_id) return json(res, 400, { error: { message: "customer_id required" } });
      if (body.amount == null || !Number.isFinite(Number(body.amount)) || Number(body.amount) <= 0) {
        return json(res, 400, { error: { message: "amount must be a positive number" } });
      }
      if (!body?.start_date) return json(res, 400, { error: { message: "start_date required" } });

      // Verify the customer (and the contract, if supplied) belong
      // to this tenant before binding.
      const cust = await svc.from("customers").select("id").eq("tenant_id", ctx.tenantId).eq("id", body.customer_id).maybeSingle();
      if (cust.error) throw new Error(cust.error.message);
      if (!cust.data) return json(res, 404, { error: { message: "customer not found" } });
      if (body.contract_id) {
        const con = await svc.from("contracts").select("id, customer_id").eq("tenant_id", ctx.tenantId).eq("id", body.contract_id).maybeSingle();
        if (con.error) throw new Error(con.error.message);
        if (!con.data) return json(res, 404, { error: { message: "contract not found" } });
        if (con.data.customer_id !== body.customer_id) {
          return json(res, 400, { error: { message: "contract belongs to a different customer" } });
        }
      }

      const ins = await svc.from("recurring_invoice_schedules").insert({
        tenant_id: ctx.tenantId,
        contract_id: body.contract_id || null,
        customer_id: body.customer_id,
        cadence: body.cadence,
        amount: Number(body.amount),
        currency: body.currency || "INR",
        start_date: body.start_date,
        next_invoice_date: body.next_invoice_date || body.start_date,
        end_date: body.end_date || null,
        max_invoices: body.max_invoices != null ? Number(body.max_invoices) : null,
        description: body.description || null,
        line_items: Array.isArray(body.line_items) ? body.line_items : [],
        payment_terms: body.payment_terms || "Net " + (body.net_days || 30),
        net_days: body.net_days || 30,
        status: "ACTIVE",
        created_by: ctx.user?.id || null,
      }).select("*").single();
      if (ins.error) throw new Error(ins.error.message);
      await recordAudit(ctx, {
        action: "recurring_invoice_create",
        objectType: "recurring_invoice_schedule",
        objectId: ins.data.id,
        detail: ins.data.cadence + " " + ins.data.amount + " " + ins.data.currency,
      });
      return json(res, 201, { schedule: ins.data });
    }

    if (!id && (req.method === "PATCH" || req.method === "DELETE")) {
      return json(res, 400, { error: { message: "id required" } });
    }

    if (req.method === "PATCH") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      const cur = await svc.from("recurring_invoice_schedules").select("*").eq("tenant_id", ctx.tenantId).eq("id", id).maybeSingle();
      if (cur.error) throw new Error(cur.error.message);
      if (!cur.data) return json(res, 404, { error: { message: "schedule not found" } });

      const patch = { updated_at: new Date().toISOString() };
      const editable = ["cadence", "amount", "currency", "next_invoice_date", "end_date",
                        "max_invoices", "description", "line_items", "payment_terms", "net_days", "status"];
      for (const k of editable) if (k in body) patch[k] = body[k];
      if (patch.cadence && !VALID_CADENCES.has(patch.cadence)) return json(res, 400, { error: { message: "invalid cadence" } });
      if (patch.status && !VALID_STATUSES.has(patch.status)) return json(res, 400, { error: { message: "invalid status" } });
      if ("amount" in patch && (!Number.isFinite(Number(patch.amount)) || Number(patch.amount) <= 0)) {
        return json(res, 400, { error: { message: "amount must be a positive number" } });
      }
      const upd = await svc.from("recurring_invoice_schedules").update(patch).eq("tenant_id", ctx.tenantId).eq("id", id).select("*").single();
      if (upd.error) throw new Error(upd.error.message);
      await recordAudit(ctx, {
        action: "recurring_invoice_update",
        objectType: "recurring_invoice_schedule",
        objectId: id,
        before: { status: cur.data.status, next_invoice_date: cur.data.next_invoice_date },
        after:  { status: upd.data.status,  next_invoice_date: upd.data.next_invoice_date },
      });
      return json(res, 200, { schedule: upd.data });
    }

    if (req.method === "DELETE") {
      requirePermission(ctx, "approve");
      const upd = await svc.from("recurring_invoice_schedules").update({
        status: "CANCELLED",
        updated_at: new Date().toISOString(),
      }).eq("tenant_id", ctx.tenantId).eq("id", id).select("*").single();
      if (upd.error) throw new Error(upd.error.message);
      await recordAudit(ctx, { action: "recurring_invoice_cancel", objectType: "recurring_invoice_schedule", objectId: id });
      return json(res, 200, { schedule: upd.data });
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) { sendError(res, err); }
}
