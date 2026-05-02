// /api/sales/leads
//   GET    list leads (filter by status, account)
//   POST   create
//   PATCH  update / convert
//   DELETE remove

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const STATUS = new Set(["NEW","CONTACTED","QUALIFIED","CONVERTED","REJECTED","REGRETTED"]);

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();
    if (req.method === "GET") {
      requirePermission(ctx, "read");
      let q = svc.from("leads").select("*").eq("tenant_id", ctx.tenantId).order("created_at", { ascending: false }).limit(500);
      if (req.query.status && STATUS.has(req.query.status)) q = q.eq("status", req.query.status);
      if (req.query.account_id) q = q.eq("account_id", req.query.account_id);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return json(res, 200, { leads: data || [] });
    }
    if (req.method === "POST") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      if (!body.company_name) return json(res, 400, { error: { message: "company_name required" } });
      const row = {
        tenant_id: ctx.tenantId,
        company_name: body.company_name,
        category: body.category || null,
        lead_source: body.lead_source || null,
        reliability_score: body.reliability_score || null,
        approval_status: body.approval_status || "PENDING",
        account_id: body.account_id || null,
        contact_name: body.contact_name || null,
        contact_email: body.contact_email || null,
        contact_phone: body.contact_phone || null,
        designation: body.designation || null,
        product_interest: body.product_interest || null,
        lead_type: body.lead_type || null,
        customer_segment: body.customer_segment || null,
        region: body.region || null,
        budget_estimate: body.budget_estimate || null,
        timeline: body.timeline || null,
        decision_maker: !!body.decision_maker,
        notes: body.notes || null,
      };
      const { data, error } = await svc.from("leads").insert(row).select("*").single();
      if (error) throw new Error(error.message);
      await recordAudit(ctx, { action: "lead_create", objectType: "lead", objectId: data.id, after: data });
      return json(res, 201, { lead: data });
    }
    if (req.method === "PATCH") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      if (!body.id) return json(res, 400, { error: { message: "id required" } });
      const patch = {};
      const allowed = ["status","category","reliability_score","approval_status","contact_name","contact_email","contact_phone","designation","product_interest","lead_type","customer_segment","region","budget_estimate","timeline","decision_maker","lost_reason","notes","allocated_to"];
      for (const k of allowed) if (body[k] !== undefined) patch[k] = body[k];
      if (body.convert_to_opportunity) {
        const opp = await svc.from("opportunities").insert({
          tenant_id: ctx.tenantId,
          customer_id: body.account_id,
          opportunity_name: body.opportunity_name || ("From lead: " + (body.company_name || body.id)),
          stage: "QUALIFICATION",
          related_lead_id: body.id,
          owner_id: ctx.user ? ctx.user.id : null,
        }).select("*").single();
        if (opp.error) throw new Error(opp.error.message);
        patch.status = "CONVERTED";
        patch.converted_at = new Date().toISOString();
        patch.converted_opportunity_id = opp.data.id;
      }
      const { data, error } = await svc.from("leads").update(patch).eq("tenant_id", ctx.tenantId).eq("id", body.id).select("*").single();
      if (error) throw new Error(error.message);
      await recordAudit(ctx, { action: "lead_update", objectType: "lead", objectId: body.id, after: patch });
      return json(res, 200, { lead: data });
    }
    if (req.method === "DELETE") {
      requirePermission(ctx, "admin");
      const id = req.query.id;
      if (!id) return json(res, 400, { error: { message: "id required" } });
      const { error } = await svc.from("leads").delete().eq("tenant_id", ctx.tenantId).eq("id", id);
      if (error) throw new Error(error.message);
      await recordAudit(ctx, { action: "lead_delete", objectType: "lead", objectId: id });
      return json(res, 200, { ok: true });
    }
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
