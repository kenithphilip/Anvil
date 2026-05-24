// /api/admin/pricing_profiles
//
//   GET                 list profiles visible to the tenant (global
//                       defaults + the tenant's own), each with its
//                       ordered components. Tenant rows shadow a global
//                       row of the same code.
//   POST                upsert a tenant profile + its components
//                       (full replace of the component list).
//   DELETE ?id=...      remove a tenant profile (global rows protected).
//
// Backs the configurable price-composition engine (lib/pricing.ts).
// Global rows (tenant_id null) ship the canonical profiles from
// migration 135; a tenant clones one and customises into its own row.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const KINDS = new Set([
  "fx_convert", "per_unit", "per_weight", "per_volume",
  "pct_of", "fixed", "margin_markup", "discount",
]);

const num = (v) => (v == null || v === "" ? null : Number(v));

const buildComponent = (tenantId, profileId, raw, idx) => {
  const kind = String(raw.kind || "");
  return {
    tenant_id: tenantId,
    profile_id: profileId,
    seq: raw.seq != null ? Number(raw.seq) : idx + 1,
    code: raw.code,
    label: raw.label || raw.code,
    kind: KINDS.has(kind) ? kind : "fixed",
    base_ref: raw.base_ref || null,
    rate: num(raw.rate),
    amount: num(raw.amount),
    currency: raw.currency === "supplier" ? "supplier" : "base",
    use_loaded_rate: !!raw.use_loaded_rate,
    enabled: raw.enabled !== false,
    visibility: raw.visibility === "customer" ? "customer" : "internal",
  };
};

const attachComponents = async (svc, profiles) => {
  const ids = profiles.map((p) => p.id);
  if (!ids.length) return profiles.map((p) => ({ ...p, components: [] }));
  const { data, error } = await svc.from("pricing_components")
    .select("*").in("profile_id", ids).order("seq", { ascending: true });
  if (error) throw new Error(error.message);
  const byProfile = {};
  for (const c of data || []) (byProfile[c.profile_id] = byProfile[c.profile_id] || []).push(c);
  return profiles.map((p) => ({ ...p, components: byProfile[p.id] || [] }));
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const globals = await svc.from("pricing_profiles").select("*")
        .is("tenant_id", null).eq("is_active", true).order("sort_order", { ascending: true });
      if (globals.error) throw new Error(globals.error.message);
      const own = await svc.from("pricing_profiles").select("*")
        .eq("tenant_id", ctx.tenantId).order("sort_order", { ascending: true });
      if (own.error) throw new Error(own.error.message);
      // Tenant rows shadow a global of the same code.
      const ownCodes = new Set((own.data || []).map((p) => p.code));
      const merged = [...(own.data || []), ...(globals.data || []).filter((p) => !ownCodes.has(p.code))];
      const withComps = await attachComponents(svc, merged);
      return json(res, 200, { profiles: withComps });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "admin");
      const body = await readBody(req);
      if (!body?.code) return json(res, 400, { error: { message: "code required" } });
      const profileRow = {
        tenant_id: ctx.tenantId,
        code: String(body.code),
        label: body.label || String(body.code),
        base_currency: body.base_currency || "INR",
        margin_floor_pct: body.margin_floor_pct != null ? Number(body.margin_floor_pct) : 0.05,
        fx_stale_days: body.fx_stale_days != null ? Number(body.fx_stale_days) : 30,
        is_active: body.is_active !== false,
        sort_order: body.sort_order != null ? Number(body.sort_order) : 100,
        updated_at: new Date().toISOString(),
      };
      // Manual upsert: the (tenant_id, code) unique index is partial, so
      // PostgREST onConflict cannot target it.
      const existing = await svc.from("pricing_profiles").select("id")
        .eq("tenant_id", ctx.tenantId).eq("code", profileRow.code).maybeSingle();
      if (existing.error) throw new Error(existing.error.message);
      let profileId = existing.data?.id;
      if (profileId) {
        const upd = await svc.from("pricing_profiles").update(profileRow)
          .eq("tenant_id", ctx.tenantId).eq("id", profileId).select("*").single();
        if (upd.error) throw new Error(upd.error.message);
      } else {
        const ins = await svc.from("pricing_profiles").insert(profileRow).select("*").single();
        if (ins.error) throw new Error(ins.error.message);
        profileId = ins.data.id;
      }

      // Replace the component list wholesale.
      const comps = Array.isArray(body.components) ? body.components : [];
      const del = await svc.from("pricing_components").delete().eq("profile_id", profileId).eq("tenant_id", ctx.tenantId);
      if (del.error) throw new Error(del.error.message);
      if (comps.length) {
        const rows = comps.filter((c) => c?.code).map((c, i) => buildComponent(ctx.tenantId, profileId, c, i));
        const insC = await svc.from("pricing_components").insert(rows);
        if (insC.error) throw new Error(insC.error.message);
      }

      await recordAudit(ctx, { action: "pricing_profile_upsert", objectType: "pricing_profile", objectId: profileId, after: { code: profileRow.code, components: comps.length } });
      const fresh = await svc.from("pricing_profiles").select("*").eq("id", profileId).single();
      const [withComps] = await attachComponents(svc, [fresh.data]);
      return json(res, 200, { profile: withComps });
    }

    if (req.method === "DELETE") {
      requirePermission(ctx, "admin");
      const id = req.query?.id;
      if (!id) return json(res, 400, { error: { message: "id required" } });
      // Only tenant-owned rows; global defaults are protected.
      const cur = await svc.from("pricing_profiles").select("id, tenant_id")
        .eq("tenant_id", ctx.tenantId).eq("id", id).maybeSingle();
      if (!cur.data) return json(res, 404, { error: { message: "Profile not found" } });
      const del = await svc.from("pricing_profiles").delete().eq("tenant_id", ctx.tenantId).eq("id", id);
      if (del.error) throw new Error(del.error.message);
      await recordAudit(ctx, { action: "pricing_profile_delete", objectType: "pricing_profile", objectId: id });
      return json(res, 200, { ok: true });
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) { sendError(res, err); }
}
