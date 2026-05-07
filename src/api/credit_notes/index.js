// /api/credit_notes
//
// Audit P7.5. CRUD for credit_notes (CREDIT and DEBIT). Each
// row references either an invoice (invoices.id) or an einvoice
// (einvoices.id) plus the customer. Lifecycle:
//
//   DRAFT -> ISSUED -> ACKNOWLEDGED
//                   -> CANCELLED
//
// GET    list (filter by invoice_id, einvoice_id, customer_id, status, kind)
// POST   create draft from invoice or einvoice
// PATCH  update fields (DRAFT only) or transition status
// DELETE soft cancel (sets status=CANCELLED)

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const VALID_STATUSES = new Set(["DRAFT", "ISSUED", "ACKNOWLEDGED", "CANCELLED"]);
const VALID_KINDS = new Set(["CREDIT", "DEBIT"]);
const VALID_REASONS = new Set([
  "price_correction", "short_shipment", "tax_correction",
  "goods_returned", "discount_applied", "rebate", "other",
]);

const ALLOWED_TRANSITIONS = {
  DRAFT:        new Set(["DRAFT", "ISSUED", "CANCELLED"]),
  ISSUED:       new Set(["ISSUED", "ACKNOWLEDGED", "CANCELLED"]),
  ACKNOWLEDGED: new Set(["ACKNOWLEDGED", "CANCELLED"]),
  CANCELLED:    new Set(["CANCELLED"]),
};
const isTransitionAllowed = (from, to) => {
  if (!from || !to) return true;
  if (from === to) return true;
  return !!(ALLOWED_TRANSITIONS[from] && ALLOWED_TRANSITIONS[from].has(to));
};

// Audit P10. Test-only exports for unit tests.
export const __test = { isTransitionAllowed, ALLOWED_TRANSITIONS };

const computeTotals = (lineItems) => {
  const items = Array.isArray(lineItems) ? lineItems : [];
  let subtotal = 0;
  let taxTotal = 0;
  for (const li of items) {
    const qty = Number(li.quantity || li.qty || 0);
    const rate = Number(li.unitPrice || li.rate || 0);
    const lineSubtotal = qty * rate;
    subtotal += lineSubtotal;
    const gstRate = Number(li.gstRate || li.gst_rate || 0);
    if (gstRate > 0 && Number.isFinite(gstRate)) {
      taxTotal += lineSubtotal * gstRate / 100;
    }
  }
  return {
    subtotal: Math.round(subtotal * 100) / 100,
    tax_total: Math.round(taxTotal * 100) / 100,
    grand_total: Math.round((subtotal + taxTotal) * 100) / 100,
  };
};

const generateNoteNumber = async (svc, tenantId, kind) => {
  const stamp = new Date().toISOString().slice(0, 7).replace("-", "");
  const prefix = kind === "DEBIT" ? "DN-" : "CN-";
  const r = await svc.from("credit_notes").select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("kind", kind)
    .like("note_number", prefix + stamp + "-%");
  const next = String((r.count || 0) + 1).padStart(4, "0");
  return prefix + stamp + "-" + next;
};

const lifecycleStamps = (status, current) => {
  const out = {};
  const now = new Date().toISOString();
  if (status === "ISSUED" && !current.issued_at) out.issued_at = now;
  if (status === "ACKNOWLEDGED" && !current.acknowledged_at) out.acknowledged_at = now;
  if (status === "CANCELLED" && !current.cancelled_at) out.cancelled_at = now;
  return out;
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();
    const id = req.query?.id || null;

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      let q = svc.from("credit_notes").select("*").eq("tenant_id", ctx.tenantId);
      if (id) q = q.eq("id", id);
      if (req.query?.invoice_id) q = q.eq("invoice_id", req.query.invoice_id);
      if (req.query?.einvoice_id) q = q.eq("einvoice_id", req.query.einvoice_id);
      if (req.query?.customer_id) q = q.eq("customer_id", req.query.customer_id);
      if (req.query?.status && VALID_STATUSES.has(req.query.status)) q = q.eq("status", req.query.status);
      if (req.query?.kind && VALID_KINDS.has(req.query.kind)) q = q.eq("kind", req.query.kind);
      q = q.order("created_at", { ascending: false }).limit(500);
      const r = await q;
      if (r.error) throw new Error(r.error.message);
      if (id) {
        if (!r.data?.length) return json(res, 404, { error: { message: "credit_note not found" } });
        return json(res, 200, { credit_note: r.data[0] });
      }
      return json(res, 200, { credit_notes: r.data || [] });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      if (!body?.kind || !VALID_KINDS.has(body.kind)) return json(res, 400, { error: { message: "kind required (CREDIT or DEBIT)" } });
      if (!body?.reason || !VALID_REASONS.has(body.reason)) return json(res, 400, { error: { message: "reason required" } });
      if (!body?.invoice_id && !body?.einvoice_id) return json(res, 400, { error: { message: "invoice_id or einvoice_id required" } });

      // Resolve customer_id from the source invoice when not
      // supplied; verify the invoice belongs to this tenant.
      let customerId = body.customer_id || null;
      if (body.invoice_id) {
        const inv = await svc.from("invoices").select("customer_id").eq("tenant_id", ctx.tenantId).eq("id", body.invoice_id).maybeSingle();
        if (inv.error) throw new Error(inv.error.message);
        if (!inv.data) return json(res, 404, { error: { message: "invoice not found" } });
        if (!customerId) customerId = inv.data.customer_id;
      }
      if (body.einvoice_id) {
        const ei = await svc.from("einvoices").select("customer_id").eq("tenant_id", ctx.tenantId).eq("id", body.einvoice_id).maybeSingle();
        if (ei.error) throw new Error(ei.error.message);
        if (!ei.data) return json(res, 404, { error: { message: "einvoice not found" } });
        if (!customerId) customerId = ei.data.customer_id;
      }

      const lineItems = Array.isArray(body.line_items) ? body.line_items : [];
      const totals = computeTotals(lineItems);
      const noteNumber = body.note_number || await generateNoteNumber(svc, ctx.tenantId, body.kind);
      const ins = await svc.from("credit_notes").insert({
        tenant_id: ctx.tenantId,
        invoice_id: body.invoice_id || null,
        einvoice_id: body.einvoice_id || null,
        customer_id: customerId,
        kind: body.kind,
        status: "DRAFT",
        note_number: noteNumber,
        note_date: body.note_date || new Date().toISOString().slice(0, 10),
        reason: body.reason,
        reason_text: body.reason_text || null,
        currency: body.currency || "INR",
        ...totals,
        line_items: lineItems,
        created_by: ctx.user?.id || null,
      }).select("*").single();
      if (ins.error) throw new Error(ins.error.message);
      await recordAudit(ctx, {
        action: "credit_note_create",
        objectType: "credit_note",
        objectId: ins.data.id,
        detail: ins.data.kind + " " + ins.data.note_number + " :: " + (totals.grand_total || 0) + " " + (body.currency || "INR"),
      });
      return json(res, 201, { credit_note: ins.data });
    }

    if (!id && (req.method === "PATCH" || req.method === "DELETE")) {
      return json(res, 400, { error: { message: "id required" } });
    }

    if (req.method === "PATCH") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      const cur = await svc.from("credit_notes").select("*").eq("tenant_id", ctx.tenantId).eq("id", id).maybeSingle();
      if (cur.error) throw new Error(cur.error.message);
      if (!cur.data) return json(res, 404, { error: { message: "credit_note not found" } });

      if (body.status && !VALID_STATUSES.has(body.status)) return json(res, 400, { error: { message: "invalid status" } });
      if (body.status && body.status !== cur.data.status && !isTransitionAllowed(cur.data.status, body.status)) {
        return json(res, 409, {
          error: {
            code: "INVALID_CN_TRANSITION",
            message: "Cannot move " + cur.data.kind + " note from " + cur.data.status + " to " + body.status,
            from: cur.data.status,
            to: body.status,
          },
        });
      }
      const editFields = ["reason", "reason_text", "line_items", "currency", "note_date"];
      const editing = editFields.some((k) => k in body);
      if (editing && cur.data.status !== "DRAFT") {
        return json(res, 409, { error: { message: "Field edits are only allowed on DRAFT credit notes." } });
      }
      const patch = { updated_at: new Date().toISOString() };
      for (const k of editFields) if (k in body) patch[k] = body[k];
      if ("line_items" in patch) Object.assign(patch, computeTotals(patch.line_items));
      if (body.status && body.status !== cur.data.status) {
        patch.status = body.status;
        Object.assign(patch, lifecycleStamps(body.status, cur.data));
      }
      if ("reason" in patch && !VALID_REASONS.has(patch.reason)) {
        return json(res, 400, { error: { message: "invalid reason" } });
      }
      const upd = await svc.from("credit_notes").update(patch).eq("tenant_id", ctx.tenantId).eq("id", id).select("*").single();
      if (upd.error) throw new Error(upd.error.message);
      await recordAudit(ctx, {
        action: body.status && body.status !== cur.data.status
          ? "credit_note_status_" + body.status.toLowerCase()
          : "credit_note_update",
        objectType: "credit_note",
        objectId: id,
        before: { status: cur.data.status },
        after: { status: upd.data.status },
      });
      return json(res, 200, { credit_note: upd.data });
    }

    if (req.method === "DELETE") {
      requirePermission(ctx, "approve");
      const cur = await svc.from("credit_notes").select("status").eq("tenant_id", ctx.tenantId).eq("id", id).maybeSingle();
      if (!cur.data) return json(res, 404, { error: { message: "credit_note not found" } });
      const upd = await svc.from("credit_notes").update({
        status: "CANCELLED",
        cancelled_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("tenant_id", ctx.tenantId).eq("id", id).select("*").single();
      if (upd.error) throw new Error(upd.error.message);
      await recordAudit(ctx, { action: "credit_note_cancel", objectType: "credit_note", objectId: id });
      return json(res, 200, { credit_note: upd.data });
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) { sendError(res, err); }
}
