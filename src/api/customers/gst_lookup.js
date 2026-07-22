// POST /api/customers/gst_lookup   { gstin }
//
// Customer creation by GSTIN (issue #186, P1). Returns everything derivable
// from the GSTIN itself with NO external call — format + checksum validity, the
// state code + name (which drives CGST/SGST vs IGST downstream, so a wrong one
// is expensive), and the embedded PAN — plus, when a GST provider is wired, the
// registry block (legal / trade name, address, status). Default-deny on the
// registry half: the structural fields still return so the form can prefill.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { tenantSettings } from "../_lib/stripe-client.js";
import { validateGstin, gstinStateCode, STATE_CODES } from "../_lib/gstin.js";
import { lookupGstinRegistry } from "../_lib/gst-provider.js";

// Everything derivable from the GSTIN itself, no API. Pure + exported for tests.
// Verification is monotone: format ⊇ state ⊇ checksum (validateGstin fails at
// the first broken level), so a well-formed-but-checksum-wrong GSTIN still
// surfaces its state + PAN for the operator.
export const deriveGstinFields = (input) => {
  const raw = String(input == null ? "" : input).trim().toUpperCase();
  const v = validateGstin(raw);
  const verification = {
    format: v.ok || v.code !== "INVALID_GSTIN_SHAPE",
    state: v.ok || (v.code !== "INVALID_GSTIN_SHAPE" && v.code !== "INVALID_GSTIN_STATE"),
    checksum: v.ok,
  };
  const stateCode = gstinStateCode(raw);
  return {
    gstin: v.ok ? v.normalized : raw,
    valid: v.ok,
    verification,
    validation_message: v.ok ? null : v.message,
    state_code: stateCode,
    state_name: stateCode ? (STATE_CODES[stateCode] || null) : null,
    pan: verification.format ? raw.slice(2, 12) : null,
  };
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const body = await readBody(req);
    const raw = String(body?.gstin || "").trim();
    if (!raw) return json(res, 400, { error: { message: "gstin required" } });

    // ── Structural validation + derivation (no API) ──────────────────
    const result = { ...deriveGstinFields(raw), registry: null, registry_status: "skipped" };

    // ── Registry half (pluggable provider; default-deny) ─────────────
    // Only worth a lookup when the GSTIN is structurally sound.
    if (result.valid) {
      const svc = serviceClient();
      const settings = await tenantSettings(svc, ctx.tenantId);
      const reg = await lookupGstinRegistry(result.gstin, settings);
      if (reg.ok) { result.registry = reg.data; result.registry_status = "ok"; }
      else { result.registry_status = reg.reason || "not_configured"; }
    }

    return json(res, 200, result);
  } catch (err) {
    return sendError(res, err);
  }
}
