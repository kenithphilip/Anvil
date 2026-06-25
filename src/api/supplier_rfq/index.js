// /api/supplier_rfq
//
// GET                       list rfqs (recent)
// GET    ?id=...            full rfq with lines, invitations, quotes
// POST                      create rfq from BOM
//   body: { source_order_id?, due_at?, notes?,
//           lines: [{ line_no, item_id?, part_number?, description?,
//                     quantity, uom?, target_price? }] }
// PATCH  ?id=...            { status, notes }
// DELETE ?id=...

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const nextRfqNumber = async (svc, tenantId) => {
  const r = await svc.from("supplier_rfqs").select("rfq_number")
    .eq("tenant_id", tenantId).not("rfq_number", "is", null)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  const last = r.data?.rfq_number || "RFQ-0000";
  const num = Number(String(last).replace(/[^\d]/g, "") || 0) + 1;
  return "RFQ-" + String(num).padStart(4, "0");
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();
    const id = req.query?.id || new URL(req.url, "http://x").searchParams.get("id");

    if (req.method === "GET" && !id) {
      requirePermission(ctx, "read");
      const sourceQuoteId = req.query?.source_quote_id || new URL(req.url, "http://x").searchParams.get("source_quote_id");
      let q = svc.from("supplier_rfqs").select("*").eq("tenant_id", ctx.tenantId);
      if (sourceQuoteId) q = q.eq("source_quote_id", sourceQuoteId);
      const r = await q.order("created_at", { ascending: false }).limit(100);
      if (r.error) throw new Error(r.error.message);
      return json(res, 200, { rfqs: r.data || [] });
    }

    if (req.method === "GET" && id) {
      requirePermission(ctx, "read");
      const [rfq, lines, invitations, quotes] = await Promise.all([
        svc.from("supplier_rfqs").select("*").eq("tenant_id", ctx.tenantId).eq("id", id).maybeSingle(),
        svc.from("supplier_rfq_lines").select("*").eq("tenant_id", ctx.tenantId).eq("rfq_id", id).order("line_no"),
        svc.from("supplier_rfq_invitations").select("*").eq("tenant_id", ctx.tenantId).eq("rfq_id", id),
        svc.from("supplier_quotes").select("*").eq("tenant_id", ctx.tenantId).eq("rfq_id", id),
      ]);
      if (rfq.error) throw new Error(rfq.error.message);
      if (!rfq.data) return json(res, 404, { error: { message: "rfq not found" } });
      // Per-vendor customer reference codes for this RFQ's end customer, so
      // the UI can show/edit the special-rate code each vendor knows the
      // customer by. Plus the customer name for display.
      let customerRefs = [];
      let customerName = null;
      if (rfq.data.customer_id) {
        const [refsQ, custQ] = await Promise.all([
          svc.from("vendor_customer_refs").select("vendor_id, customer_ref")
            .eq("tenant_id", ctx.tenantId).eq("customer_id", rfq.data.customer_id),
          svc.from("customers").select("customer_name").eq("tenant_id", ctx.tenantId).eq("id", rfq.data.customer_id).maybeSingle(),
        ]);
        customerRefs = refsQ.data || [];
        customerName = custQ.data?.customer_name || null;
      }
      return json(res, 200, {
        rfq: rfq.data,
        lines: lines.data || [],
        invitations: invitations.data || [],
        quotes: quotes.data || [],
        customer_refs: customerRefs,
        customer_name: customerName,
      });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "approve");
      const body = await readBody(req);
      if (!Array.isArray(body?.lines) || !body.lines.length) {
        return json(res, 400, { error: { message: "lines required" } });
      }
      const rfqNumber = await nextRfqNumber(svc, ctx.tenantId);
      // End customer the RFQ is priced for: explicit, else derived from the
      // linked quote (so customer-referenced vendor rates apply).
      let customerId = body.customer_id || null;
      if (!customerId && body.source_quote_id) {
        const q = await svc.from("quotes").select("customer_id")
          .eq("tenant_id", ctx.tenantId).eq("id", body.source_quote_id).maybeSingle();
        if (!q.error && q.data) customerId = q.data.customer_id || null;
      }
      const ins = await svc.from("supplier_rfqs").insert({
        tenant_id: ctx.tenantId,
        source_order_id: body.source_order_id || null,
        source_quote_id: body.source_quote_id || null,
        customer_id: customerId,
        customer_ref: body.customer_ref || null,
        rfq_number: rfqNumber,
        due_at: body.due_at || null,
        notes: body.notes || null,
        created_by: ctx.user?.id || null,
      }).select("*").single();
      if (ins.error) throw new Error(ins.error.message);
      const linesIns = await svc.from("supplier_rfq_lines").insert(body.lines.map((li, idx) => ({
        tenant_id: ctx.tenantId,
        rfq_id: ins.data.id,
        line_no: li.line_no != null ? li.line_no : (idx + 1),
        item_id: li.item_id || null,
        part_number: li.part_number || null,
        description: li.description || null,
        quantity: li.quantity || null,
        uom: li.uom || null,
        spec: li.spec || null,
        target_price: li.target_price || null,
      })));
      if (linesIns.error) throw new Error(linesIns.error.message);
      await recordAudit(ctx, {
        action: "supplier_rfq_created",
        objectType: "supplier_rfq",
        objectId: ins.data.id,
        detail: rfqNumber + "::" + body.lines.length + " lines",
      });
      return json(res, 200, { rfq: ins.data });
    }

    if (!id) return json(res, 400, { error: { message: "id required" } });

    if (req.method === "PATCH") {
      requirePermission(ctx, "approve");
      const body = await readBody(req);
      const patch = {};
      if (body.status) patch.status = body.status;
      if (body.notes !== undefined) patch.notes = body.notes;
      if (body.due_at !== undefined) patch.due_at = body.due_at;
      if (body.customer_id !== undefined) patch.customer_id = body.customer_id || null;
      if (body.customer_ref !== undefined) patch.customer_ref = body.customer_ref || null;
      const upd = await svc.from("supplier_rfqs").update(patch)
        .eq("tenant_id", ctx.tenantId).eq("id", id).select("*").single();
      if (upd.error) throw new Error(upd.error.message);
      await recordAudit(ctx, {
        action: "supplier_rfq_updated",
        objectType: "supplier_rfq",
        objectId: id,
        detail: Object.keys(patch).join(","),
      });
      return json(res, 200, { rfq: upd.data });
    }

    if (req.method === "DELETE") {
      requirePermission(ctx, "admin");
      await svc.from("supplier_rfqs").delete().eq("tenant_id", ctx.tenantId).eq("id", id);
      await recordAudit(ctx, {
        action: "supplier_rfq_deleted",
        objectType: "supplier_rfq",
        objectId: id,
        detail: "deleted",
      });
      return json(res, 200, { ok: true });
    }
    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) { sendError(res, err); }
}
