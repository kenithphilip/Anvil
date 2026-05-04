// /api/invoices/[id]
//
// GET    invoice detail.
// PATCH  update fields. Status transitions are gated:
//          draft  -> sent | void
//          sent   -> partial | paid | overdue | void
//          partial -> paid | void
//          overdue -> paid | partial | void
//          paid   -> (terminal)
//          void   -> (terminal)
// DELETE soft-delete (sets status=void).
//
// Approve permission required for paid/void; write permission for
// the rest.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const ALLOWED_STATUS_TRANSITIONS = {
  draft:    new Set(["sent", "void"]),
  sent:     new Set(["partial", "paid", "overdue", "void"]),
  partial:  new Set(["paid", "void"]),
  overdue:  new Set(["paid", "partial", "void"]),
  paid:     new Set([]),
  void:     new Set([]),
};

const APPROVE_TARGETS = new Set(["paid", "void"]);

const setterPatch = (patch, body, key) => {
  if (body[key] !== undefined) patch[key] = body[key];
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();
    const id = req.query?.id;
    if (!id) return json(res, 400, { error: { message: "id required" } });

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const { data, error } = await svc.from("invoices").select("*").eq("tenant_id", ctx.tenantId).eq("id", id).maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return json(res, 404, { error: { message: "Not found" } });
      // Pull the matching payment_records for this invoice.
      const pr = await svc.from("payment_records").select("*").eq("tenant_id", ctx.tenantId).eq("invoice_id", id).order("paid_at", { ascending: false });
      return json(res, 200, { invoice: data, payments: pr.data || [] });
    }

    if (req.method === "PATCH" || req.method === "DELETE") {
      const body = req.method === "DELETE" ? { status: "void" } : await readBody(req);
      const current = await svc.from("invoices").select("status").eq("tenant_id", ctx.tenantId).eq("id", id).maybeSingle();
      if (current.error) throw new Error(current.error.message);
      if (!current.data) return json(res, 404, { error: { message: "Not found" } });

      const patch = {};
      setterPatch(patch, body, "due_date");
      setterPatch(patch, body, "payment_terms");
      setterPatch(patch, body, "notes");
      setterPatch(patch, body, "line_items");
      setterPatch(patch, body, "subtotal");
      setterPatch(patch, body, "tax_total");
      setterPatch(patch, body, "grand_total");
      setterPatch(patch, body, "paid_amount");
      setterPatch(patch, body, "currency");
      setterPatch(patch, body, "stripe_payment_intent_id");
      setterPatch(patch, body, "stripe_checkout_url");
      setterPatch(patch, body, "stripe_checkout_expires_at");

      if (body.status) {
        const next = body.status;
        const allowed = ALLOWED_STATUS_TRANSITIONS[current.data.status] || new Set();
        if (!allowed.has(next)) {
          return json(res, 409, { error: { message: "Cannot transition from " + current.data.status + " to " + next } });
        }
        patch.status = next;
        if (next === "sent" && !patch.sent_at) patch.sent_at = new Date().toISOString();
        if (next === "paid" && !patch.paid_at) patch.paid_at = new Date().toISOString();
        if (next === "void" && !patch.voided_at) patch.voided_at = new Date().toISOString();
        // approve permission required for terminal moves.
        requirePermission(ctx, APPROVE_TARGETS.has(next) ? "approve" : "write");
      } else {
        requirePermission(ctx, "write");
      }

      const upd = await svc.from("invoices").update(patch).eq("tenant_id", ctx.tenantId).eq("id", id).select("*").maybeSingle();
      if (upd.error) throw new Error(upd.error.message);
      if (!upd.data) return json(res, 404, { error: { message: "Not found" } });

      await recordAudit(ctx, {
        action: "invoice_update",
        objectType: "invoice",
        objectId: id,
        after: patch,
      });
      // Specific verb when the row terminates so the meter can count
      // it as a separate billable outcome.
      if (patch.status === "sent") {
        await recordAudit(ctx, { action: "invoice_sent", objectType: "invoice", objectId: id });
      }
      if (patch.status === "paid") {
        await recordAudit(ctx, { action: "invoice_paid", objectType: "invoice", objectId: id });
      }
      if (patch.status === "void") {
        await recordAudit(ctx, { action: "invoice_voided", objectType: "invoice", objectId: id });
      }
      return json(res, 200, { invoice: upd.data });
    }

    res.setHeader("Allow", "GET, PATCH, DELETE");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
