// /api/admin/llm_settings
//
//   GET   tenant's LLM-provider config for the reasoning features:
//           { llm_provider, llm_provider_overrides, features, providers }
//   PATCH update llm_provider and/or llm_provider_overrides.
//
// P2 of the app-wide LLM abstraction (migration 165). Read-level GET (the
// admin panel reads it); approve-level PATCH. Validated server-side so a
// typo can't land an unknown provider/feature.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { tenantSettings, updateTenantSettings } from "../_lib/stripe-client.js";

const PROVIDERS = new Set(["claude", "gemini"]);
// Features currently routed through callLLM (P1). Admins can override each.
const FEATURES = ["email_classifier", "anomaly_explain", "inventory_explain", "customer_health_score"];

const validateProvider = (v, field) => {
  if (v == null || v === "") return null; // clears -> fall through to env/default
  if (typeof v !== "string" || !PROVIDERS.has(v)) return field + " must be one of: claude, gemini";
  return null;
};

const validateOverrides = (v) => {
  if (v == null) return null;
  if (typeof v !== "object" || Array.isArray(v)) return "llm_provider_overrides must be an object";
  for (const [feat, prov] of Object.entries(v)) {
    if (!FEATURES.includes(feat)) return "unknown feature in llm_provider_overrides: " + feat;
    if (!PROVIDERS.has(prov)) return "llm_provider_overrides[" + feat + "] must be claude or gemini";
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
      const s = await tenantSettings(svc, ctx.tenantId);
      return json(res, 200, {
        llm_provider: s?.llm_provider || null,
        llm_provider_overrides: (s?.llm_provider_overrides && typeof s.llm_provider_overrides === "object") ? s.llm_provider_overrides : {},
        features: FEATURES,
        providers: [...PROVIDERS],
      });
    }

    if (req.method === "PATCH") {
      requirePermission(ctx, "approve");
      const body = await readBody(req);
      if (!body || typeof body !== "object") return json(res, 400, { error: { message: "body must be an object" } });
      const updates = {};
      const errors = [];
      if (Object.prototype.hasOwnProperty.call(body, "llm_provider")) {
        const err = validateProvider(body.llm_provider, "llm_provider");
        if (err) errors.push(err);
        else updates.llm_provider = body.llm_provider || null;
      }
      if (Object.prototype.hasOwnProperty.call(body, "llm_provider_overrides")) {
        const err = validateOverrides(body.llm_provider_overrides);
        if (err) errors.push(err);
        else {
          // Drop empty/blank entries so clearing a feature falls through.
          const clean = {};
          for (const [f, p] of Object.entries(body.llm_provider_overrides || {})) { if (p) clean[f] = p; }
          updates.llm_provider_overrides = clean;
        }
      }
      if (errors.length) return json(res, 400, { error: { message: errors.join("; ") } });
      if (!Object.keys(updates).length) return json(res, 400, { error: { message: "no recognised keys (llm_provider, llm_provider_overrides)" } });

      await updateTenantSettings(svc, ctx.tenantId, updates);
      await recordAudit(ctx, { action: "llm_settings_update", objectType: "tenant", objectId: ctx.tenantId, after: updates });
      return json(res, 200, { ok: true, ...updates });
    }

    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
