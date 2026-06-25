// /api/admin/quote_settings
//
//   GET   tenant's quote defaults + line-item option lists:
//           { quote_default_validity_days,
//             quote_line_units, quote_line_source_countries }
//   PATCH update any subset of those.
//
// GET is read-level (the new-quote modal + line editor read it); PATCH is
// approve-level (admins/managers change tenant config).
//
// quote_default_validity_days is the tenant fallback for new-quote validity.
// Precedence at create time: explicit value > customer default > this >
// hard-coded 30.
// quote_line_units / quote_line_source_countries are admin-defined option
// lists surfaced as dropdowns in the quote Lines editor. All stored as
// columns on tenant_settings (migrations 152 + 153).

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

// Validate an admin-defined option list (units, source countries, ...).
// Accepts an array of non-empty strings; trims, drops blanks, dedups
// (case-insensitive), caps each value + the list length. Exported for tests.
export const validateOptionList = (label, value) => {
  if (value == null) return { value: [] };
  if (!Array.isArray(value)) return { error: label + " must be an array of strings" };
  const seen = new Set();
  const out = [];
  for (const raw of value) {
    if (typeof raw !== "string") return { error: label + " values must be strings" };
    const v = raw.trim();
    if (!v) continue;
    if (v.length > 64) return { error: label + " values must be 64 characters or fewer" };
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  if (out.length > 500) return { error: label + " cannot exceed 500 entries" };
  return { value: out };
};

const asList = (v) => (Array.isArray(v) ? v : []);

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
        quote_line_units: asList(settings?.quote_line_units),
        quote_line_source_countries: asList(settings?.quote_line_source_countries),
        quote_currencies: asList(settings?.quote_currencies),
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
      if (Object.prototype.hasOwnProperty.call(body, "quote_default_validity_days")) {
        const r = validateValidityDays(body.quote_default_validity_days);
        if (r.error) errors.push(r.error); else updates.quote_default_validity_days = r.value;
      }
      if (Object.prototype.hasOwnProperty.call(body, "quote_line_units")) {
        const r = validateOptionList("quote_line_units", body.quote_line_units);
        if (r.error) errors.push(r.error); else updates.quote_line_units = r.value;
      }
      if (Object.prototype.hasOwnProperty.call(body, "quote_line_source_countries")) {
        const r = validateOptionList("quote_line_source_countries", body.quote_line_source_countries);
        if (r.error) errors.push(r.error); else updates.quote_line_source_countries = r.value;
      }
      if (Object.prototype.hasOwnProperty.call(body, "quote_currencies")) {
        const r = validateOptionList("quote_currencies", body.quote_currencies);
        if (r.error) errors.push(r.error); else updates.quote_currencies = r.value;
      }
      if (errors.length) return json(res, 400, { error: { message: errors.join("; ") } });
      if (!Object.keys(updates).length) {
        return json(res, 400, { error: { message: "no recognised keys. Allowed: quote_default_validity_days, quote_line_units, quote_line_source_countries, quote_currencies" } });
      }

      const next = await updateTenantSettings(svc, ctx.tenantId, updates);
      await recordAudit(ctx, {
        action: "quote_settings_updated",
        objectType: "tenant",
        objectId: ctx.tenantId,
        detail: Object.keys(updates).join(","),
        after: updates,
      });
      return json(res, 200, {
        ok: true,
        quote_default_validity_days: next?.quote_default_validity_days ?? null,
        quote_line_units: asList(next?.quote_line_units),
        quote_line_source_countries: asList(next?.quote_line_source_countries),
        quote_currencies: asList(next?.quote_currencies),
      });
    }

    res.setHeader("Allow", "GET, PATCH");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) { sendError(res, err); }
}
