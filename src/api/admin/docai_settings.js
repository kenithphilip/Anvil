// /api/admin/docai_settings
//
//   GET   tenant's current docai-related settings:
//           docai_provider_order, docai_daily_limits,
//           docai_anthropic_model, docai_gemini_model.
//   PATCH update one or more of those fields.
//
// Admin-only (approve permission). All four fields are validated
// server-side because the operator is editing them via UI; we
// don't want a typo to land an invalid adapter name in
// docai_provider_order and silently kill extraction.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { tenantSettings, updateTenantSettings } from "../_lib/stripe-client.js";

const KNOWN_ADAPTERS = new Set([
  "gemini", "claude", "reducto", "azure_di", "unstructured",
  "docling", "marker", "excel", "gaeb",
]);

// Anthropic model names we let the UI pick. The list isn't a
// hard whitelist on the env-var path (an operator can set any
// model via env), but for tenant_settings overrides we constrain
// to the family Anthropic publicly serves so a typo can't land a
// 4xx forever.
const ANTHROPIC_MODEL_PATTERN = /^claude-(haiku|sonnet|opus)-/;
const GEMINI_MODEL_PATTERN = /^gemini-/;

const validateProviderOrder = (value) => {
  if (!Array.isArray(value)) return "docai_provider_order must be an array";
  if (value.length === 0) return "docai_provider_order cannot be empty";
  for (const a of value) {
    if (typeof a !== "string" || !KNOWN_ADAPTERS.has(a)) {
      return "unknown adapter in docai_provider_order: " + a;
    }
  }
  // De-dupe
  const seen = new Set();
  for (const a of value) {
    if (seen.has(a)) return "duplicate adapter in docai_provider_order: " + a;
    seen.add(a);
  }
  return null;
};

const validateDailyLimits = (value) => {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    return "docai_daily_limits must be an object {adapter: int}";
  }
  for (const [k, v] of Object.entries(value)) {
    if (!KNOWN_ADAPTERS.has(k)) return "unknown adapter in docai_daily_limits: " + k;
    if (!Number.isFinite(Number(v)) || Number(v) < 0 || Math.floor(Number(v)) !== Number(v)) {
      return "docai_daily_limits[" + k + "] must be a non-negative integer";
    }
  }
  return null;
};

const validateAnthropicModel = (value) => {
  if (value == null || value === "") return null;
  if (typeof value !== "string") return "docai_anthropic_model must be a string";
  if (!ANTHROPIC_MODEL_PATTERN.test(value)) {
    return "docai_anthropic_model must match /^claude-(haiku|sonnet|opus)-/";
  }
  return null;
};

const validateGeminiModel = (value) => {
  if (value == null || value === "") return null;
  if (typeof value !== "string") return "docai_gemini_model must be a string";
  if (!GEMINI_MODEL_PATTERN.test(value)) {
    return "docai_gemini_model must start with 'gemini-'";
  }
  return null;
};

const SAFE_KEYS = [
  "docai_provider_order",
  "docai_daily_limits",
  "docai_anthropic_model",
  "docai_gemini_model",
];

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const settings = await tenantSettings(svc, ctx.tenantId);
      return json(res, 200, {
        docai_provider_order: settings?.docai_provider_order || null,
        docai_daily_limits: settings?.docai_daily_limits || null,
        docai_anthropic_model: settings?.docai_anthropic_model || null,
        docai_gemini_model: settings?.docai_gemini_model || null,
      });
    }

    if (req.method === "PATCH") {
      requirePermission(ctx, "approve");
      const body = await readBody(req);
      if (!body || typeof body !== "object") {
        return json(res, 400, { error: { message: "body must be an object" } });
      }

      const updates = {};
      const errors = [];

      if (Object.prototype.hasOwnProperty.call(body, "docai_provider_order")) {
        const err = validateProviderOrder(body.docai_provider_order);
        if (err) errors.push(err);
        else updates.docai_provider_order = body.docai_provider_order;
      }
      if (Object.prototype.hasOwnProperty.call(body, "docai_daily_limits")) {
        const err = validateDailyLimits(body.docai_daily_limits);
        if (err) errors.push(err);
        else updates.docai_daily_limits = body.docai_daily_limits;
      }
      if (Object.prototype.hasOwnProperty.call(body, "docai_anthropic_model")) {
        const err = validateAnthropicModel(body.docai_anthropic_model);
        if (err) errors.push(err);
        else updates.docai_anthropic_model = body.docai_anthropic_model || null;
      }
      if (Object.prototype.hasOwnProperty.call(body, "docai_gemini_model")) {
        const err = validateGeminiModel(body.docai_gemini_model);
        if (err) errors.push(err);
        else updates.docai_gemini_model = body.docai_gemini_model || null;
      }

      if (errors.length) {
        return json(res, 400, { error: { message: errors.join("; ") } });
      }
      if (!Object.keys(updates).length) {
        return json(res, 400, {
          error: { message: "no recognised keys in body. Allowed: " + SAFE_KEYS.join(", ") },
        });
      }

      const next = await updateTenantSettings(svc, ctx.tenantId, updates);
      await recordAudit(ctx, {
        action: "docai_settings_updated",
        objectType: "tenant",
        objectId: ctx.tenantId,
        detail: Object.keys(updates).join(","),
        after: updates,
      });
      // Echo back the four cost-relevant fields so the UI can
      // refresh without a follow-up GET.
      return json(res, 200, {
        ok: true,
        updated: Object.keys(updates),
        docai_provider_order: next?.docai_provider_order || null,
        docai_daily_limits: next?.docai_daily_limits || null,
        docai_anthropic_model: next?.docai_anthropic_model || null,
        docai_gemini_model: next?.docai_gemini_model || null,
      });
    }

    res.setHeader("Allow", "GET, PATCH");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) { sendError(res, err); }
}
