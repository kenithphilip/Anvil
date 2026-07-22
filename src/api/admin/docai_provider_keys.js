// GET  /api/admin/docai_provider_keys  -> provider list + which keys are set
// POST /api/admin/docai_provider_keys  { keys?: {<id>: "plain"|null}, provider_order? }
//
// Issue #210: the per-tenant DocAI-provider key write-path. Every provider key
// (Gemini / Mistral / Reducto / Unstructured / Docling / Marker / LlamaCloud +
// the GST registry) is encrypted with the SHARED docai_creds_iv envelope the
// adapters already read, so BYOK works uniformly. Keys are never returned or
// logged — only a boolean "is it set". Admin-only.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { tenantSettings, updateTenantSettings } from "../_lib/stripe-client.js";
import { encryptField, newIv, isSecretsConfigured } from "../_lib/secrets.js";

// Provider registry. `external` + `region` drive the residency warning in the
// UI — enabling a US/EU provider sends Indian customer POs (GSTINs, prices,
// part IP) out of the country (DPDPA exposure). `col` is the bytea column.
export const DOCAI_PROVIDERS = [
  { id: "gemini", col: "docai_gemini_api_key_enc", label: "Google Gemini", external: true, region: "US / global" },
  { id: "mistral", col: "docai_mistral_api_key_enc", label: "Mistral (OCR)", external: true, region: "EU" },
  { id: "reducto", col: "docai_reducto_api_key_enc", label: "Reducto", external: true, region: "US" },
  { id: "unstructured", col: "docai_unstructured_api_key_enc", label: "Unstructured", external: true, region: "US" },
  { id: "docling", col: "docai_docling_api_key_enc", label: "Docling (self-host)", external: false, region: "self-hosted" },
  { id: "marker", col: "docai_marker_api_key_enc", label: "Marker / Datalab", external: true, region: "US" },
  { id: "llamacloud", col: "docai_llamacloud_api_key_enc", label: "LlamaCloud / LlamaParse", external: true, region: "US / EU" },
  { id: "gst", col: "gst_provider_api_key_enc", label: "GST registry provider", external: false, region: "India" },
];
const BY_ID = new Map(DOCAI_PROVIDERS.map((p) => [p.id, p]));

// Coerce a stored IV (bytea comes back as a Buffer or a '\x…' hex string) to a
// Buffer so encryptField can reuse it — reusing the existing IV keeps any keys
// already stored under it decryptable.
const toIvBuffer = (v) => {
  if (!v) return null;
  if (Buffer.isBuffer(v)) return v;
  if (typeof v === "string" && v.startsWith("\\x")) return Buffer.from(v.slice(2), "hex");
  if (typeof v === "string") { try { return Buffer.from(v, "base64"); } catch (_e) { return null; } }
  return null;
};

// Pure: turn a { <providerId>: plaintext|null } map into the tenant_settings
// column patch (encrypt non-empty, null to clear), skipping unknown providers.
// Returns { patch, changed } — `changed` is the list of provider ids touched.
export const buildKeyUpdates = (keys, iv) => {
  const patch = {};
  const changed = [];
  for (const [id, val] of Object.entries(keys || {})) {
    const p = BY_ID.get(id);
    if (!p) continue;
    const s = val == null ? "" : String(val).trim();
    patch[p.col] = s === "" ? null : encryptField(s, iv);
    changed.push(id);
  }
  return { patch, changed };
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();

    if (req.method === "GET") {
      requirePermission(ctx, "admin");
      const settings = await tenantSettings(svc, ctx.tenantId);
      return json(res, 200, {
        secrets_configured: isSecretsConfigured(),
        provider_order: settings?.docai_provider_order || null,
        providers: DOCAI_PROVIDERS.map((p) => ({
          id: p.id, label: p.label, external: p.external, region: p.region,
          key_present: !!settings?.[p.col],
        })),
      });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "admin");
      const body = await readBody(req);
      const updates = {};
      let changedKeys = [];

      if (body?.keys && typeof body.keys === "object" && Object.keys(body.keys).length) {
        if (!isSecretsConfigured()) {
          return json(res, 400, { error: { message: "Secret storage is not configured (ANVIL_SECRETS_KEY); cannot store provider keys." } });
        }
        const settings = await tenantSettings(svc, ctx.tenantId);
        let iv = toIvBuffer(settings?.docai_creds_iv);
        if (!iv) { iv = newIv(); updates.docai_creds_iv = iv; }
        const { patch, changed } = buildKeyUpdates(body.keys, iv);
        Object.assign(updates, patch);
        changedKeys = changed;
      }

      if (Array.isArray(body?.provider_order)) {
        // Keep only recognised provider ids; order is advisory routing config.
        updates.docai_provider_order = body.provider_order.filter((id) => BY_ID.has(id));
      }

      if (!Object.keys(updates).length) {
        return json(res, 400, { error: { message: "nothing to update — pass keys and/or provider_order" } });
      }

      await updateTenantSettings(svc, ctx.tenantId, updates);
      await recordAudit(ctx, {
        action: "docai_provider_keys_saved",
        objectType: "tenant_settings",
        objectId: ctx.tenantId,
        detail: [changedKeys.length ? "keys:" + changedKeys.join(",") : null, updates.docai_provider_order ? "order" : null].filter(Boolean).join(" "),
      });

      const settings = await tenantSettings(svc, ctx.tenantId);
      return json(res, 200, {
        ok: true,
        provider_order: settings?.docai_provider_order || null,
        providers: DOCAI_PROVIDERS.map((p) => ({ id: p.id, key_present: !!settings?.[p.col] })),
      });
    }

    res.setHeader("Allow", "GET, POST");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    return sendError(res, err);
  }
}
