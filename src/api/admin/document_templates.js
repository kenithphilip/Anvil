// /api/admin/document_templates
//   GET    ?doc_type=...  list templates for a doc type (or all)
//   POST   upsert one template (id optional). Sets is_default
//          enforced via partial unique index so the prior default
//          is automatically demoted.
//   DELETE ?id=
//
// Tenant-scoped templates for quotations, sales orders, invoices, POs,
// etc. Replaces the prior approach of stuffing all boilerplate into
// `quotes.terms` free text. The shape is captured in migration 106.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const DOC_TYPES = new Set([
  "quotation", "sales_order", "purchase_order", "tax_invoice",
  "proforma_invoice", "credit_note", "eway_bill", "delivery_note",
]);

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      let q = svc.from("document_templates")
        .select("*")
        .eq("tenant_id", ctx.tenantId)
        .order("doc_type", { ascending: true })
        .order("is_default", { ascending: false })
        .order("version", { ascending: false });
      if (req.query.doc_type && DOC_TYPES.has(req.query.doc_type)) {
        q = q.eq("doc_type", req.query.doc_type);
      }
      const { data, error } = await q.limit(500);
      if (error) throw new Error(error.message);
      return json(res, 200, { templates: data || [] });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "admin");
      const body = await readBody(req);
      if (!body.doc_type || !DOC_TYPES.has(body.doc_type)) {
        return json(res, 400, { error: { message: "valid doc_type required" } });
      }
      if (!body.template_name) {
        return json(res, 400, { error: { message: "template_name required" } });
      }
      // Demote any other default before promoting this one.
      if (body.is_default) {
        await svc.from("document_templates")
          .update({ is_default: false })
          .eq("tenant_id", ctx.tenantId)
          .eq("doc_type", body.doc_type);
      }
      const row = {
        tenant_id: ctx.tenantId,
        doc_type: body.doc_type,
        form_code: body.form_code || null,
        template_name: body.template_name,
        version: body.version != null ? Number(body.version) : 1,
        is_active: body.is_active == null ? true : !!body.is_active,
        is_default: !!body.is_default,
        language: body.language || "en",
        header_block: body.header_block || null,
        footer_block: body.footer_block || null,
        signatory_block: body.signatory_block || null,
        standard_message: body.standard_message || null,
        warranty_clause: body.warranty_clause || null,
        penalty_clause: body.penalty_clause || null,
        cancellation_clause: body.cancellation_clause || null,
        force_majeure_clause: body.force_majeure_clause || null,
        payment_terms_clause: body.payment_terms_clause || null,
        delivery_terms_clause: body.delivery_terms_clause || null,
        other_conditions: Array.isArray(body.other_conditions) ? body.other_conditions : [],
        body_blocks: body.body_blocks && typeof body.body_blocks === "object" ? body.body_blocks : {},
      };
      const out = body.id
        ? await svc.from("document_templates").update(row).eq("tenant_id", ctx.tenantId).eq("id", body.id).select("*").single()
        : await svc.from("document_templates").insert(row).select("*").single();
      if (out.error) throw new Error(out.error.message);
      await recordAudit(ctx, { action: body.id ? "document_template_update" : "document_template_create", objectType: "document_template", objectId: out.data.id, after: out.data });
      return json(res, 200, { template: out.data });
    }

    if (req.method === "DELETE") {
      requirePermission(ctx, "admin");
      const id = req.query.id;
      if (!id) return json(res, 400, { error: { message: "id required" } });
      // Soft path: deactivate. Hard delete via ?hard=1.
      if (String(req.query.hard) === "1") {
        const { error } = await svc.from("document_templates").delete().eq("tenant_id", ctx.tenantId).eq("id", id);
        if (error) throw new Error(error.message);
        await recordAudit(ctx, { action: "document_template_hard_delete", objectType: "document_template", objectId: id });
      } else {
        const { error } = await svc.from("document_templates").update({ is_active: false }).eq("tenant_id", ctx.tenantId).eq("id", id);
        if (error) throw new Error(error.message);
        await recordAudit(ctx, { action: "document_template_disable", objectType: "document_template", objectId: id });
      }
      return json(res, 200, { ok: true });
    }

    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
