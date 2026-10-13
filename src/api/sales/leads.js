// /api/sales/leads
//   GET    list leads (filter by status, account)
//   POST   create
//   PATCH  update / convert
//   DELETE remove

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { resolveAssignee, userDisplayNames } from "../_lib/assignee.js";

const STATUS = new Set(["NEW","CONTACTED","QUALIFIED","CONVERTED","REJECTED","REGRETTED"]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s) => typeof s === "string" && UUID_RE.test(s);
const bad = (res, message) => json(res, 400, { error: { message } });

// The two fields that point at other rows. Both are bare FKs and the service
// role bypasses RLS, so a raw id off the body could name another tenant's
// customer (and converting the lead would then open an opportunity on it), or
// a user who is not on the team. Each is checked against THIS tenant and
// copied into `out` only when it passes. Returns an error message, or null.
// An empty value clears the field.
const checkLinks = async (svc, tenantId, body, out) => {
  if (body.account_id !== undefined) {
    if (body.account_id === null || body.account_id === "") {
      out.account_id = null;
    } else {
      const { data, error } = await svc.from("customers").select("id")
        .eq("tenant_id", tenantId).eq("id", String(body.account_id)).maybeSingle();
      // 22P02: not a uuid at all, so not a customer of anyone.
      if (error && error.code !== "22P02") throw new Error("could not verify the customer account: " + error.message);
      if (error || !data) return "account_id is not a customer of this tenant";
      out.account_id = data.id;
    }
  }
  if (body.allocated_to !== undefined) {
    if (body.allocated_to === null || body.allocated_to === "") {
      out.allocated_to = null;
    } else {
      const member = isUuid(body.allocated_to) ? await resolveAssignee(svc, tenantId, body.allocated_to) : null;
      if (!member) return "allocated_to must be an approved member of this tenant";
      out.allocated_to = member;
    }
  }
  return null;
};

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
      const leads = data || [];
      // The owner's name, so the list can say who owns a lead instead of
      // showing a user id. One auth lookup per DISTINCT owner (the size of the
      // sales team), and a failed lookup leaves that name null.
      const names = await userDisplayNames(svc, leads.map((l) => l.allocated_to));
      for (const l of leads) l.allocated_to_name = l.allocated_to ? (names.get(l.allocated_to) || null) : null;
      return json(res, 200, { leads });
    }
    if (req.method === "POST") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      if (!body.company_name) return json(res, 400, { error: { message: "company_name required" } });
      // A lead becomes CONVERTED only through the convert action, which also
      // creates its opportunity. Any other status must be one the enum has,
      // or the insert fails with a 500.
      const status = body.status || "NEW";
      if (!STATUS.has(status) || status === "CONVERTED") {
        return bad(res, "status must be one of NEW, CONTACTED, QUALIFIED, REJECTED, REGRETTED");
      }
      const links = {};
      const linkError = await checkLinks(svc, ctx.tenantId, body, links);
      if (linkError) return bad(res, linkError);
      const row = {
        tenant_id: ctx.tenantId,
        status,
        company_name: body.company_name,
        category: body.category || null,
        lead_source: body.lead_source || null,
        reliability_score: body.reliability_score || null,
        approval_status: body.approval_status || "PENDING",
        account_id: links.account_id || null,
        allocated_to: links.allocated_to || null,
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
      // Load the lead first. This is the tenant gate for the update and for
      // the convert, which writes an opportunity BEFORE it touches the lead:
      // another tenant's lead id used to open an opportunity here and then
      // fail with a 500.
      const cur = await svc.from("leads").select("id, status, company_name, account_id")
        .eq("tenant_id", ctx.tenantId).eq("id", body.id).maybeSingle();
      if (cur.error) throw new Error(cur.error.message);
      if (!cur.data) return json(res, 404, { error: { message: "Lead not found" } });
      const patch = {};
      const allowed = ["status","company_name","lead_source","category","reliability_score","approval_status","contact_name","contact_email","contact_phone","designation","product_interest","lead_type","customer_segment","region","budget_estimate","timeline","decision_maker","lost_reason","notes"];
      for (const k of allowed) if (body[k] !== undefined) patch[k] = body[k];
      if (patch.status !== undefined && !STATUS.has(patch.status)) return bad(res, "invalid status");
      if (patch.company_name !== undefined && !String(patch.company_name || "").trim()) return bad(res, "company_name cannot be empty");
      const linkError = await checkLinks(svc, ctx.tenantId, body, patch);
      if (linkError) return bad(res, linkError);
      if (body.convert_to_opportunity) {
        if (cur.data.status === "CONVERTED") return json(res, 409, { error: { message: "This lead is already converted" } });
        // The opportunity's customer is the lead's account: the one this
        // request links, else the one already on the lead.
        const customerId = patch.account_id !== undefined ? patch.account_id : cur.data.account_id;
        if (!customerId) return bad(res, "Link a customer account to this lead before converting it");
        const opp = await svc.from("opportunities").insert({
          tenant_id: ctx.tenantId,
          customer_id: customerId,
          opportunity_name: body.opportunity_name || ("From lead: " + (patch.company_name || cur.data.company_name || body.id)),
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
