// /api/admin/quote_settings
//
//   GET   tenant's quote defaults:
//           { quote_default_validity_days }
//   PATCH update them. Body: { quote_default_validity_days: int|null }
//
// GET is read-level (the new-quote modal reads it to prefill validity);
// PATCH is approve-level (admins/managers change tenant config).
//
// quote_default_validity_days is the tenant fallback for new-quote validity.
// Precedence at create time: explicit value > customer default > this >
// hard-coded 30. Stored as a column on tenant_settings (migration 152).

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { tenantSettings, updateTenantSettings } from "../_lib/stripe-client.js";

// Validate the validity-days value. null/"" clears it (fall back to 30).
// Exported for unit tests.
export const validateValidityDays = (value) => {
  if (value == null || value === "") return { value: null };
  const n = Number(value);
  if (!Number.isFinite(n) || Math.floor(n) !== n) return { error: "quote_default_validity_days must be a whole number" };
  if (n < 1 || n > 3650) return { error: "quote_default_validity_days must be between 1 and 3650" };
  return { value: n };
};

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
        quote_default_validity_days: settings?.quote_default_validity_days ?? null,
      });
    }

    if (req.method === "PATCH") {
      requirePermission(ctx, "approve");
      const body = await readBody(req);
      if (!body || typeof body !== "object") {
        return json(res, 400, { error: { message: "body must be an object" } });
      }
      if (!Object.prototype.hasOwnProperty.call(body, "quote_default_validity_days")) {
        return json(res, 400, { error: { message: "body must include quote_default_validity_days" } });
      }
      const { value, error } = validateValidityDays(body.quote_default_validity_days);
      if (error) return json(res, 400, { error: { message: error } });

      const next = await updateTenantSettings(svc, ctx.tenantId, { quote_default_validity_days: value });
      await recordAudit(ctx, {
        action: "quote_settings_updated",
        objectType: "tenant",
        objectId: ctx.tenantId,
        detail: "quote_default_validity_days=" + (value == null ? "(cleared)" : value),
        after: { quote_default_validity_days: value },
      });
      return json(res, 200, { ok: true, quote_default_validity_days: next?.quote_default_validity_days ?? value });
    }

    res.setHeader("Allow", "GET, PATCH");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) { sendError(res, err); }
}
