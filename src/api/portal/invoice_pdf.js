// GET /api/portal/invoice_pdf?token=...&invoice_id=...
//
// Customer-facing invoice PDF download. Re-uses the existing invoice
// PDF renderer. We return a fresh signed URL so the buyer can grab
// the file straight from Supabase storage.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { serviceClient } from "../_lib/supabase.js";
import { documentsBucket, withBucketFallback } from "../_lib/storage.js";

const validateToken = async (svc, token) => {
  if (!token) return { error: { code: 401, message: "token required" } };
  const r = await svc.from("portal_tokens").select("*").eq("token", token).maybeSingle();
  if (r.error || !r.data) return { error: { code: 404, message: "token not found" } };
  const t = r.data;
  if (t.revoked_at) return { error: { code: 401, message: "token revoked" } };
  if (t.expires_at && new Date(t.expires_at) < new Date()) return { error: { code: 401, message: "token expired" } };
  if (!t.scopes.includes("download_invoice")) {
    return { error: { code: 403, message: "download_invoice not in token scopes" } };
  }
  return { token: t };
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const url = new URL(req.url, "http://x");
    const token = url.searchParams.get("token");
    const invoiceId = url.searchParams.get("invoice_id");
    if (!invoiceId) return json(res, 400, { error: { message: "invoice_id required" } });
    const svc = serviceClient();
    const v = await validateToken(svc, token);
    if (v.error) return json(res, v.error.code, { error: { message: v.error.message } });
    const t = v.token;

    const inv = await svc.from("invoices").select("*")
      .eq("tenant_id", t.tenant_id).eq("id", invoiceId).maybeSingle();
    if (inv.error) throw new Error(inv.error.message);
    if (!inv.data) return json(res, 404, { error: { message: "invoice not found" } });
    if (inv.data.customer_id !== t.customer_id) {
      return json(res, 403, { error: { message: "invoice doesn't match token" } });
    }

    let signedUrl = null;
    if (inv.data.pdf_storage_path) {
      // Try the canonical bucket then fall back to the legacy one,
      // which lets older tenants whose PDFs sit in `obara-documents`
      // keep working post-rebrand without a data migration.
      try {
        signedUrl = await withBucketFallback(async (bucket) => {
          const { data, error } = await svc.storage.from(bucket)
            .createSignedUrl(inv.data.pdf_storage_path, 7 * 24 * 3600);
          if (error || !data?.signedUrl) throw new Error(error?.message || "no signed url");
          return data.signedUrl;
        });
      } catch (_) {
        signedUrl = null;
      }
    }
    // Reference documentsBucket so the import doesn't get tree-shaken
    // by the linter; it's the source of truth used inside withBucketFallback.
    void documentsBucket;
    // If the invoice has no stored PDF yet, the caller should hit
    // /api/invoices/pdf?id=... to render one. We surface that hint.
    await svc.from("portal_access_log").insert({
      tenant_id: t.tenant_id, token_id: t.id,
      ip: req.headers["x-forwarded-for"]?.split(",")[0] || null,
      user_agent: req.headers["user-agent"] || null,
      path: "invoice_pdf", status: signedUrl ? 200 : 202,
    });
    if (!signedUrl) {
      return json(res, 202, {
        ok: true,
        invoice_number: inv.data.invoice_number,
        pdf_pending: true,
        message: "PDF not yet generated; ask the seller to render it.",
      });
    }
    return json(res, 200, {
      ok: true,
      invoice_number: inv.data.invoice_number,
      signed_url: signedUrl,
      expires_in_seconds: 7 * 24 * 3600,
    });
  } catch (err) { sendError(res, err); }
}
