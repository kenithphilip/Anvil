// GET/PATCH /api/admin/seller_details
//
// The tenant's own identity: legal name, GSTIN, registered address, CIN/PAN.
//
// Migration 062 added these columns because the e-invoice handler had ONE
// tenant's seller block hardcoded, so every other tenant shipped GSTN a payload
// claiming to be someone else. The columns landed; a way to fill them in did
// not. Nothing in the app has ever written them — the only route was raw SQL
// against tenant_settings, which is not a thing you can ask a customer to do.
//
// Consequences of leaving them empty are quiet rather than loud:
//   - orders/so_pdf.js wraps the read in try/catch and renders with an EMPTY
//     seller block, so a customer-facing Sales Order goes out with no legal
//     name, GSTIN or address on it
//   - einvoice/index.js refuses to compose a payload at all
//
// Read is `read` because every operator's PDFs depend on it and seeing your own
// company's registered address is not privileged. Write is `approve`: this is
// the identity Anvil signs documents with, and a wrong GSTIN here is a
// compliance problem, not a typo.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { tenantSettings } from "../_lib/stripe-client.js";
import { recordAudit } from "../_lib/audit.js";

// Exactly the columns migration 062 added, plus cin/pan which so_pdf renders.
// An allow-list rather than a spread: a PATCH body is attacker-controlled and
// tenant_settings holds provider keys and feature flags on the same row.
export const SELLER_FIELDS = Object.freeze([
  "einvoice_seller_legal_name",
  "einvoice_seller_trade_name",
  "einvoice_seller_gstin",
  "einvoice_seller_address_line1",
  "einvoice_seller_address_line2",
  "einvoice_seller_locality",
  "einvoice_seller_pincode",
  "einvoice_seller_state_code",
  "einvoice_seller_phone",
  "einvoice_seller_email",
  "cin",
  "pan",
]);

// Deliberately light. These are transcribed off a GST certificate, and a
// validator that rejects a legitimate edge case is worse than one that lets a
// typo through — the operator can see the value they typed; they cannot see
// why a form refused it. Only shapes that are unambiguously wrong are refused.
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z][Z][0-9A-Z]$/;
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const CIN_RE = /^[LUu][0-9]{5}[A-Za-z]{2}[0-9]{4}[A-Za-z]{3}[0-9]{6}$/;
const PIN_RE = /^[1-9][0-9]{5}$/;
const STATE_RE = /^[0-9]{2}$/;

export const validateSeller = (patch) => {
  const bad = (f, why) => ({ field: f, message: why });
  const errs = [];
  const v = (k) => (patch[k] == null ? null : String(patch[k]).trim());

  if (v("einvoice_seller_gstin") && !GSTIN_RE.test(v("einvoice_seller_gstin").toUpperCase())) {
    errs.push(bad("einvoice_seller_gstin", "GSTIN must be 15 characters: 2-digit state code, PAN, entity digit, Z, checksum."));
  }
  if (v("pan") && !PAN_RE.test(v("pan").toUpperCase())) {
    errs.push(bad("pan", "PAN must be 10 characters, e.g. AAACM3025E."));
  }
  if (v("cin") && !CIN_RE.test(v("cin"))) {
    errs.push(bad("cin", "CIN must be 21 characters, e.g. L65990MH1945PLC004558."));
  }
  if (v("einvoice_seller_pincode") && !PIN_RE.test(v("einvoice_seller_pincode"))) {
    errs.push(bad("einvoice_seller_pincode", "PIN code must be 6 digits and not start with 0."));
  }
  if (v("einvoice_seller_state_code") && !STATE_RE.test(v("einvoice_seller_state_code"))) {
    errs.push(bad("einvoice_seller_state_code", "State code must be 2 digits, e.g. 27 for Maharashtra."));
  }
  // The state code is embedded in the GSTIN's first two characters. They
  // disagreeing means one of them is wrong, and GSTN will reject the payload.
  const g = v("einvoice_seller_gstin");
  const sc = v("einvoice_seller_state_code");
  if (g && sc && GSTIN_RE.test(g.toUpperCase()) && STATE_RE.test(sc) && g.slice(0, 2) !== sc) {
    errs.push(bad("einvoice_seller_state_code",
      "State code " + sc + " does not match the GSTIN, which begins " + g.slice(0, 2) + "."));
  }
  return errs;
};

// Which fields a customer-facing Sales Order PDF needs to look legitimate.
// Reported so the UI can say what is still missing rather than leaving an
// operator to discover it on a document already sent to a buyer.
export const PDF_REQUIRED = Object.freeze([
  "einvoice_seller_legal_name", "einvoice_seller_gstin",
  "einvoice_seller_address_line1", "einvoice_seller_state_code",
]);

export const missingForPdf = (row) =>
  PDF_REQUIRED.filter((f) => !String(row?.[f] ?? "").trim());

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const settings = await tenantSettings(svc, ctx.tenantId);
      const seller = {};
      for (const f of SELLER_FIELDS) seller[f] = settings?.[f] ?? null;
      return json(res, 200, { seller, missing_for_pdf: missingForPdf(seller) });
    }

    if (req.method === "PATCH") {
      requirePermission(ctx, "approve");
      const body = await readBody(req);
      if (!body || typeof body !== "object") {
        return json(res, 400, { error: { message: "body required" } });
      }
      const patch = {};
      for (const f of SELLER_FIELDS) {
        if (!Object.prototype.hasOwnProperty.call(body, f)) continue;
        const raw = body[f];
        const s = raw == null ? null : String(raw).trim();
        // Empty string clears the field rather than storing "", so a cleared
        // input and an unset column look the same to every reader.
        patch[f] = s ? s : null;
      }
      if (!Object.keys(patch).length) {
        return json(res, 400, { error: { message: "no recognised seller fields in body" } });
      }
      // Normalise the identifiers that are case-defined by their registries.
      for (const f of ["einvoice_seller_gstin", "pan"]) {
        if (patch[f]) patch[f] = patch[f].toUpperCase();
      }
      const errs = validateSeller(patch);
      if (errs.length) return json(res, 400, { error: { message: errs[0].message, fields: errs } });

      const upd = await svc.from("tenant_settings")
        .update(patch).eq("tenant_id", ctx.tenantId).select("*").maybeSingle();
      if (upd.error) throw new Error("tenant_settings update: " + upd.error.message);

      const seller = {};
      for (const f of SELLER_FIELDS) seller[f] = upd.data?.[f] ?? null;
      // Audited: this is the identity Anvil signs customer documents with.
      // The VALUES are not recorded — a GSTIN in an audit row is the tenant's
      // registered identity, and the changed field names are what a reviewer
      // actually needs.
      await recordAudit(ctx, {
        action: "seller_details_updated",
        objectType: "tenant_settings",
        objectId: ctx.tenantId,
        after: { fields: Object.keys(patch) },
      });
      return json(res, 200, { seller, missing_for_pdf: missingForPdf(seller) });
    }

    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) { sendError(res, err); }
}
