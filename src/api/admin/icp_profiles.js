// /api/admin/icp_profiles
//
//   GET   -> the tenant's active ICP rubric, or the built-in default
//            ({ is_default: true }) when none is defined yet. Also returns the
//            attribute keys available to build rules against.
//   POST  -> upsert the rubric { id?, name, gate, rules, tiers, active }.
//
// The rubric is a gate + weighted rules + tier cutoffs over generic attribute
// keys (from customer_registration_fields + core customer columns). Scored by
// src/api/_lib/icp.js. Design: docs/ICP_FRAMEWORK_DESIGN.md.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { DEFAULT_ICP_PROFILE } from "../_lib/icp.js";
import { FIELD_CATALOG } from "../_lib/customer-registration.js";

// Attribute keys a rule can target: the registration catalog + a few core
// customer columns the compute layer resolves. Surfaced so the admin editor
// can offer a picker instead of free text.
const attributeKeys = () => {
  const fromCatalog = FIELD_CATALOG.map((f) => ({ key: f.key, label: f.label, category: f.category }));
  const core = [
    { key: "gstin", label: "GSTIN", category: "core" },
    { key: "state_code", label: "State code", category: "core" },
    { key: "country", label: "Country", category: "core" },
    { key: "customer_type", label: "Customer type", category: "core" },
    { key: "parent_customer_id", label: "Parent company (group)", category: "core" },
  ];
  // Derived attributes the compute layer synthesizes (P3). gstin_valid is a
  // checksum check with no external call; gst_status arrives from the Sandbox
  // fetch (#186) into the registration fields. Values are enumerated so the
  // editor can offer a value picker for equals/in rules.
  const derived = [
    { key: "gstin_present", label: "GSTIN present", category: "derived", values: ["yes", "no"] },
    { key: "gstin_valid", label: "GSTIN checksum valid", category: "derived", values: ["valid", "invalid"] },
  ];
  // De-dup by key (catalog already has customer_type/country/gstin).
  const seen = new Set(fromCatalog.map((f) => f.key));
  return [...fromCatalog, ...core.filter((c) => !seen.has(c.key)), ...derived.filter((c) => !seen.has(c.key))];
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const r = await svc.from("icp_profiles").select("*")
        .eq("tenant_id", ctx.tenantId).eq("active", true)
        .order("updated_at", { ascending: false }).limit(1).maybeSingle();
      if (r.error) throw new Error(r.error.message);
      if (r.data) return json(res, 200, { profile: r.data, is_default: false, attribute_keys: attributeKeys() });
      return json(res, 200, { profile: DEFAULT_ICP_PROFILE, is_default: true, attribute_keys: attributeKeys() });
    }

    if (req.method === "POST") {
      // Defining the ICP rubric is an admin-level config change.
      requirePermission(ctx, "admin");
      const body = await readBody(req);
      if (!body || typeof body !== "object") return json(res, 400, { error: { message: "body required" } });
      const row = {
        tenant_id: ctx.tenantId,
        name: body.name || "Default ICP",
        active: body.active !== false,
        gate: Array.isArray(body.gate) ? body.gate : [],
        rules: Array.isArray(body.rules) ? body.rules : [],
        tiers: Array.isArray(body.tiers) && body.tiers.length ? body.tiers : DEFAULT_ICP_PROFILE.tiers,
        updated_at: new Date().toISOString(),
      };
      let saved;
      if (body.id) {
        saved = await svc.from("icp_profiles").update(row)
          .eq("tenant_id", ctx.tenantId).eq("id", body.id).select("*").maybeSingle();
      } else {
        saved = await svc.from("icp_profiles").insert({ ...row, created_by: ctx.user?.id || null }).select("*").maybeSingle();
      }
      if (saved.error) throw new Error(saved.error.message);
      await recordAudit(ctx, { action: "icp_profile_upsert", objectType: "icp_profile", objectId: saved.data?.id, after: { name: row.name, rules: row.rules.length } });
      return json(res, 200, { profile: saved.data });
    }

    res.setHeader("Allow", "GET, POST");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
