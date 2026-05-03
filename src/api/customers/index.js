import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();
    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const { data: customers, error } = await svc.from("customers").select("*").eq("tenant_id", ctx.tenantId).order("updated_at", { ascending: false }).limit(500);
      if (error) throw new Error(error.message);
      const ids = customers.map((c) => c.id);
      const profiles = ids.length
        ? await svc.from("customer_format_profiles").select("*").eq("tenant_id", ctx.tenantId).in("customer_id", ids).eq("is_current", true)
        : { data: [] };
      const profileByCustomer = {};
      (profiles.data || []).forEach((p) => { profileByCustomer[p.customer_id] = p; });
      return json(res, 200, { customers, profiles: profileByCustomer });
    }
    if (req.method === "POST") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      if (!body.customer_key) return json(res, 400, { error: { message: "customer_key required" } });
      const upsert = await svc.from("customers").upsert({
        tenant_id: ctx.tenantId,
        customer_key: body.customer_key,
        customer_name: body.customer_name || "",
        gstin: body.gstin || null,
        state_code: body.state_code || null,
        default_payment_terms: body.default_payment_terms || null,
        default_incoterms: body.default_incoterms || null,
        default_quote_validity_days: body.default_quote_validity_days || null,
        notes: body.notes || null,
      }, { onConflict: "tenant_id,customer_key" }).select("*").single();
      if (upsert.error) throw new Error(upsert.error.message);
      const customer = upsert.data;
      if (body.profile) {
        const newVersion = (Number(body.profile.version || 0) || 0) + 1;
        await svc.from("customer_format_profiles").update({ is_current: false }).eq("tenant_id", ctx.tenantId).eq("customer_id", customer.id).eq("is_current", true);
        const profileInsert = await svc.from("customer_format_profiles").insert({
          tenant_id: ctx.tenantId,
          customer_id: customer.id,
          version: newVersion,
          fingerprint: body.profile.fingerprint || {},
          orders_processed: body.profile.orders_processed || 0,
          last_format_changed: !!body.profile.last_format_changed,
          format_change_summary: body.profile.format_change_summary || null,
          trusted: !!body.profile.trusted,
          learned_rules: body.profile.learned_rules || {},
          recipe: body.profile.recipe || {},
          force_llm_fallback: !!body.profile.force_llm_fallback,
          golden_examples: Array.isArray(body.profile.golden_examples) ? body.profile.golden_examples : [],
          is_current: true,
        }).select("*").single();
        if (profileInsert.error) throw new Error(profileInsert.error.message);
        await recordAudit(ctx, { action: "upsert_customer_profile", objectType: "customer", objectId: customer.id, after: { profileId: profileInsert.data.id, version: newVersion } });
        return json(res, 200, { customer, profile: profileInsert.data });
      }
      return json(res, 200, { customer });
    }
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
