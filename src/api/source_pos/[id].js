// PATCH /api/source_pos/:id  body: { status?, acknowledged_price?, acknowledged_eta?, payload? }
// GET /api/source_pos/:id   returns the row + events history.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit, recordEvent } from "../_lib/audit.js";

const ALLOWED_STATUS = new Set(["DRAFT", "PENDING_INTERNAL_APPROVAL", "SENT_TO_SUPPLIER", "SUPPLIER_ACK", "PRICE_CHANGED", "ETA_CONFIRMED", "DELAYED", "RECEIVED", "CLOSED", "CANCELLED"]);

// Audit P7.4. Source PO status used to allow any-to-any
// transitions (e.g., DRAFT -> RECEIVED in one PATCH). Forward-
// progression with a few sideways transitions (an ack arriving
// after a price-change scenario) are the realistic paths.
// CANCELLED is allowed from any open status; CLOSED / CANCELLED
// are terminal.
const SPO_TRANSITIONS = {
  DRAFT:                     new Set(["DRAFT", "PENDING_INTERNAL_APPROVAL", "SENT_TO_SUPPLIER", "CANCELLED"]),
  PENDING_INTERNAL_APPROVAL: new Set(["PENDING_INTERNAL_APPROVAL", "SENT_TO_SUPPLIER", "DRAFT", "CANCELLED"]),
  SENT_TO_SUPPLIER:          new Set(["SENT_TO_SUPPLIER", "SUPPLIER_ACK", "PRICE_CHANGED", "DELAYED", "CANCELLED"]),
  SUPPLIER_ACK:              new Set(["SUPPLIER_ACK", "ETA_CONFIRMED", "PRICE_CHANGED", "DELAYED", "RECEIVED", "CANCELLED"]),
  PRICE_CHANGED:             new Set(["PRICE_CHANGED", "SUPPLIER_ACK", "ETA_CONFIRMED", "DELAYED", "RECEIVED", "CANCELLED"]),
  ETA_CONFIRMED:             new Set(["ETA_CONFIRMED", "DELAYED", "RECEIVED", "CANCELLED"]),
  DELAYED:                   new Set(["DELAYED", "ETA_CONFIRMED", "RECEIVED", "CANCELLED"]),
  RECEIVED:                  new Set(["RECEIVED", "CLOSED", "CANCELLED"]),
  CLOSED:                    new Set(["CLOSED"]),
  CANCELLED:                 new Set(["CANCELLED"]),
};
const isSpoTransitionAllowed = (from, to) => {
  if (!from || !to) return true;
  if (from === to) return true;
  const allowed = SPO_TRANSITIONS[from];
  return !!(allowed && allowed.has(to));
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const id = req.query.id || req.url.split("/").pop().split("?")[0];
    const svc = serviceClient();
    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const row = await svc.from("source_pos").select("*").eq("tenant_id", ctx.tenantId).eq("id", id).single();
      if (row.error) return json(res, 404, { error: { message: "Source PO not found" } });
      const events = await svc.from("source_po_events").select("*").eq("tenant_id", ctx.tenantId).eq("source_po_id", id).order("created_at");
      return json(res, 200, { sourcePo: row.data, events: events.data || [] });
    }
    if (req.method === "PATCH") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      const prev = await svc.from("source_pos").select("*").eq("tenant_id", ctx.tenantId).eq("id", id).single();
      if (prev.error || !prev.data) return json(res, 404, { error: { message: "Source PO not found" } });
      const patch = {};
      if (body.status) {
        if (!ALLOWED_STATUS.has(body.status)) return json(res, 400, { error: { message: "Invalid status" } });
        // Audit P7.4: forward-progression state machine.
        if (body.status !== prev.data.status && !isSpoTransitionAllowed(prev.data.status, body.status)) {
          return json(res, 409, {
            error: {
              code: "INVALID_SPO_TRANSITION",
              message: "Cannot move source PO from " + prev.data.status + " to " + body.status + " directly.",
              from: prev.data.status,
              to: body.status,
            },
          });
        }
        patch.status = body.status;
      }
      if (body.acknowledged_price != null) patch.acknowledged_price = Number(body.acknowledged_price);
      if (body.acknowledged_eta) patch.acknowledged_eta = body.acknowledged_eta;
      if (body.payload) patch.payload = body.payload;
      if (body.ack_payload) patch.ack_payload = body.ack_payload;
      const update = await svc.from("source_pos").update(patch).eq("tenant_id", ctx.tenantId).eq("id", id).select("*").single();
      if (update.error) throw new Error(update.error.message);
      if (body.status && body.status !== prev.data.status) {
        await svc.from("source_po_events").insert({ tenant_id: ctx.tenantId, source_po_id: id, from_status: prev.data.status, to_status: body.status, detail: body.reason || null, actor: ctx.user ? ctx.user.id : null });
      }
      await recordAudit(ctx, { action: "source_po_update", objectType: "source_po", objectId: id, before: prev.data, after: update.data });
      await recordEvent(ctx, { caseId: prev.data.order_id || id, eventType: "source_po_updated", objectType: "source_po", objectId: id, detail: patch });
      return json(res, 200, { sourcePo: update.data });
    }
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
