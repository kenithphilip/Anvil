// /api/esign/envelopes
//
// GET    -> list envelopes (admin/finance read)
// POST   -> create + send. Body: { order_id, subject?, message?, signers: [{name,email,anchor?}], pdf_base64, pdf_name? }
// PATCH  /api/esign/envelopes?id=...  -> body { void: true }
// GET    /api/esign/envelopes?id=...&download=true  -> downloads signed PDF, returns storage path

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { tenantSettings } from "../_lib/stripe-client.js";
import {
  docusignDecryptCreds, docusignIsConfigured,
  docusignCreateEnvelope, docusignFetch, docusignGetSignedPdf,
} from "../_lib/docusign-client.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();
    const id = req.query?.id || new URL(req.url, "http://x").searchParams.get("id");

    if (req.method === "GET" && !id) {
      requirePermission(ctx, "read");
      const r = await svc.from("esignature_envelopes").select("*").eq("tenant_id", ctx.tenantId)
        .order("created_at", { ascending: false }).limit(100);
      if (r.error) throw new Error(r.error.message);
      return json(res, 200, { envelopes: r.data || [] });
    }
    if (req.method === "POST") {
      requirePermission(ctx, "approve");
      const body = await readBody(req);
      if (!body?.signers?.length || !body?.pdf_base64) {
        return json(res, 400, { error: { message: "signers and pdf_base64 required" } });
      }
      const settings = docusignDecryptCreds({ ...await tenantSettings(svc, ctx.tenantId), tenant_id: ctx.tenantId });
      if (!docusignIsConfigured(settings)) {
        return json(res, 409, { error: { code: "DOCUSIGN_NOT_CONFIGURED", message: "DocuSign not configured" } });
      }
      const ins = await svc.from("esignature_envelopes").insert({
        tenant_id: ctx.tenantId,
        order_id: body.order_id || null,
        provider: "docusign",
        status: "created",
        subject: body.subject || null,
        message: body.message || null,
        signers: body.signers.map((s) => ({ name: s.name, email: s.email, status: "pending" })),
        created_by: ctx.userId || null,
      }).select("*").single();
      if (ins.error) throw new Error(ins.error.message);
      const resp = await docusignCreateEnvelope(settings, {
        pdfBase64: body.pdf_base64,
        pdfName: body.pdf_name || "document.pdf",
        subject: body.subject,
        message: body.message,
        signers: body.signers,
      });
      if (!resp.ok) {
        await svc.from("esignature_envelopes").update({
          status: "failed",
          raw: resp.body,
        }).eq("id", ins.data.id);
        return json(res, 502, { ok: false, status: resp.status, error: resp.body?.message || resp.body?.error });
      }
      const updated = await svc.from("esignature_envelopes").update({
        external_id: resp.body?.envelopeId,
        status: "sent",
        sent_at: new Date().toISOString(),
        raw: resp.body,
      }).eq("id", ins.data.id).select("*").single();
      await recordAudit(ctx, {
        action: "esign_envelope_sent",
        objectType: "esignature_envelope",
        objectId: ins.data.id,
        detail: "envelope_id=" + resp.body?.envelopeId,
      });
      return json(res, 200, { envelope: updated.data });
    }
    if (!id) return json(res, 400, { error: { message: "id required" } });

    if (req.method === "GET" && url(req).get("download") === "true") {
      requirePermission(ctx, "read");
      const env = await svc.from("esignature_envelopes").select("*").eq("tenant_id", ctx.tenantId).eq("id", id).maybeSingle();
      if (!env.data) return json(res, 404, { error: { message: "envelope not found" } });
      if (!env.data.external_id) return json(res, 409, { error: { message: "envelope not yet sent" } });
      const settings = docusignDecryptCreds({ ...await tenantSettings(svc, ctx.tenantId), tenant_id: ctx.tenantId });
      const resp = await docusignGetSignedPdf(settings, env.data.external_id);
      if (!resp.ok) return json(res, 502, { ok: false, status: resp.status });
      // The combined endpoint returns binary; our docusignFetch parsed body
      // may already have been treated as text; re-fetch raw via docusignFetch
      // upgrade is a follow-up. Return the path placeholder for now.
      return json(res, 200, { ok: true, body: resp.body });
    }

    if (req.method === "PATCH") {
      requirePermission(ctx, "approve");
      const body = await readBody(req);
      if (!body?.void) return json(res, 400, { error: { message: "only void supported" } });
      const env = await svc.from("esignature_envelopes").select("*").eq("tenant_id", ctx.tenantId).eq("id", id).maybeSingle();
      if (!env.data) return json(res, 404, { error: { message: "envelope not found" } });
      if (!env.data.external_id) {
        await svc.from("esignature_envelopes").update({ status: "voided" }).eq("id", id);
        return json(res, 200, { ok: true });
      }
      const settings = docusignDecryptCreds({ ...await tenantSettings(svc, ctx.tenantId), tenant_id: ctx.tenantId });
      const resp = await docusignFetch(settings, {
        method: "PUT",
        path: `/v2.1/accounts/${settings.docusign_account_id}/envelopes/${env.data.external_id}`,
        body: { status: "voided", voidedReason: body.voidedReason || "voided by Anvil" },
      });
      if (!resp.ok) return json(res, 502, { ok: false, status: resp.status, error: resp.body });
      await svc.from("esignature_envelopes").update({ status: "voided" }).eq("id", id);
      await recordAudit(ctx, {
        action: "esign_envelope_voided",
        objectType: "esignature_envelope",
        objectId: id,
        detail: body.voidedReason || "voided",
      });
      return json(res, 200, { ok: true });
    }
    res.setHeader("Allow", "GET, POST, PATCH");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) { sendError(res, err); }
}

const url = (req) => new URL(req.url, "http://x").searchParams;
