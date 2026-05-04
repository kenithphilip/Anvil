import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { recordAudit } from "../_lib/audit.js";
import { serviceClient } from "../_lib/supabase.js";
import { documentsBucket } from "../_lib/storage.js";

const sanitizeName = (s) => String(s || "upload").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120);

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "write");
    const body = await readBody(req);
    if (!body || !body.filename) return json(res, 400, { error: { message: "filename required" } });
    const svc = serviceClient();
    const filename = sanitizeName(body.filename);
    const path = ctx.tenantId + "/" + Date.now() + "_" + filename;
    const bucket = documentsBucket();
    const { data: signed, error: signErr } = await svc.storage.from(bucket).createSignedUploadUrl(path);
    if (signErr) throw new Error("Signed URL error: " + signErr.message);
    const insert = await svc.from("documents").insert({
      tenant_id: ctx.tenantId,
      storage_bucket: bucket,
      storage_path: path,
      filename,
      mime_type: body.mime_type || null,
      size_bytes: body.size_bytes || null,
      sha256: body.sha256 || null,
      uploaded_by: ctx.user ? ctx.user.id : null,
      classification: body.classification || null,
      metadata: body.metadata || {},
    }).select("id").single();
    if (insert.error) throw new Error("Document record error: " + insert.error.message);
    await recordAudit(ctx, {
      action: "document_upload_intent",
      objectType: "document",
      objectId: insert.data.id,
      detail: filename + " (" + (body.size_bytes || 0) + " bytes)",
    });
    return json(res, 200, {
      documentId: insert.data.id,
      uploadUrl: signed.signedUrl,
      token: signed.token,
      path,
    });
  } catch (err) {
    sendError(res, err);
  }
}
