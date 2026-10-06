// /api/comms/service_report_template
//
//   GET  [?customer_id=...]   the tenant's templates (+ the built-in default),
//                             and the effectively-resolved template for the
//                             given customer.
//   PUT  { customer_id?, name?, sections, include_parts? }
//                             upsert the tenant default (customer_id omitted) or
//                             a per-customer override.
//   DELETE ?id=... | ?customer_id=...
//                             remove a template (falls back to the tenant
//                             default, then the built-in).
//
// This is what makes the service report ADAPTABLE — per seller AND per their
// customers — instead of a replica of any one firm's form. See
// _lib/service-report.js for the shape and the built-in DEFAULT_TEMPLATE.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { DEFAULT_TEMPLATE, resolveTemplate } from "../_lib/service-report.js";

const VISIBILITIES = new Set(["customer", "internal"]);

// Validate + normalise a sections array. Rejects a malformed template rather
// than storing one that would render nothing or leak an unmarked field.
const normaliseSections = (sections) => {
  if (!Array.isArray(sections)) return { error: "sections must be an array" };
  const out = [];
  for (const sec of sections) {
    if (!sec || typeof sec !== "object") return { error: "each section must be an object" };
    const fields = Array.isArray(sec.fields) ? sec.fields : [];
    const nf = [];
    for (const f of fields) {
      if (!f?.key) return { error: "each field needs a key" };
      // Default to 'internal' when unspecified: a field must be EXPLICITLY
      // marked customer-facing to be sent. Fail safe, never leak by omission.
      const visibility = VISIBILITIES.has(f.visibility) ? f.visibility : "internal";
      nf.push({ key: String(f.key), label: f.label ? String(f.label) : String(f.key), visibility });
    }
    out.push({ key: sec.key ? String(sec.key) : null, title: sec.title ? String(sec.title) : null, fields: nf });
  }
  return { sections: out };
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const r = await svc.from("service_report_templates")
        .select("id, customer_id, name, sections, include_parts, is_active")
        .eq("tenant_id", ctx.tenantId);
      const templates = r.data || [];
      const customerId = req.query?.customer_id || null;
      return json(res, 200, {
        templates,
        default_template: DEFAULT_TEMPLATE,
        resolved: resolveTemplate(templates, customerId),
      });
    }

    if (req.method === "PUT") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      const norm = normaliseSections(body?.sections);
      if (norm.error) return json(res, 400, { error: { message: norm.error } });

      const customerId = body?.customer_id || null;
      const row = {
        tenant_id: ctx.tenantId,
        customer_id: customerId,
        name: body?.name ? String(body.name) : "Default",
        sections: norm.sections,
        include_parts: body?.include_parts !== false,
        is_active: true,
        updated_at: new Date().toISOString(),
      };
      // Manual upsert. The uniqueness is a PARTIAL index (one per customer, one
      // tenant-default), which supabase-js `onConflict` cannot target — and a
      // plain onConflict on (tenant_id, customer_id) would never match the
      // customer_id-NULL default row anyway (NULL is distinct in a conflict
      // target). So find-then-update/insert, matching NULL with `.is`.
      let existQ = svc.from("service_report_templates").select("id").eq("tenant_id", ctx.tenantId);
      existQ = customerId ? existQ.eq("customer_id", customerId) : existQ.is("customer_id", null);
      const existing = await existQ.maybeSingle();

      const up = existing?.data?.id
        ? await svc.from("service_report_templates").update(row)
            .eq("tenant_id", ctx.tenantId).eq("id", existing.data.id).select("*").single()
        : await svc.from("service_report_templates").insert(row).select("*").single();
      if (up.error) throw new Error(up.error.message);
      await recordAudit(ctx, {
        action: "service_report_template_saved",
        objectType: "service_report_template",
        objectId: up.data.id,
        detail: (row.customer_id ? "customer override" : "tenant default") + " · " + norm.sections.length + " section(s)",
      });
      return json(res, 200, { ok: true, template: up.data });
    }

    if (req.method === "DELETE") {
      requirePermission(ctx, "write");
      let q = svc.from("service_report_templates").delete().eq("tenant_id", ctx.tenantId);
      if (req.query?.id) q = q.eq("id", req.query.id);
      else if (req.query?.customer_id) q = q.eq("customer_id", req.query.customer_id);
      else return json(res, 400, { error: { message: "id or customer_id required" } });
      const del = await q;
      if (del.error) throw new Error(del.error.message);
      return json(res, 200, { ok: true });
    }

    res.setHeader("Allow", "GET, PUT, DELETE");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    return sendError(res, err);
  }
}
