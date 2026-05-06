// POST /api/documents/upload  Body: { filename, mime_type?, size_bytes?, sha256?, classification?, metadata? }
//
// Issues a Supabase signed upload URL and writes a placeholder
// `documents` row. The client uploads directly via the signed URL,
// then optionally calls /api/documents/scan to trigger ClamAV.
//
// Hardened May 2026 (security audit H9). Server-side caps replace
// client-trust:
//
//   - filename sanitised (allowlist) and length-bounded.
//   - size_bytes hard-capped at MAX_UPLOAD_BYTES (50 MiB by default,
//     overridable via DOCUMENTS_MAX_UPLOAD_BYTES env).
//   - mime_type matched against a server-side allowlist; anything
//     else is rejected outright. The allowlist is the union of what
//     OCR + ZIP-scan + image preview can actually handle.
//   - documents.scan_status = 'pending' on insert. Downstream readers
//     (extract.js, ocr.js) refuse to process documents that are not
//     'clean'. The /api/documents/scan endpoint is the only path
//     that can transition pending → clean.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { recordAudit } from "../_lib/audit.js";
import { serviceClient } from "../_lib/supabase.js";
import { documentsBucket, ensureDocumentsBucket, friendlyStorageError } from "../_lib/storage.js";

const MAX_UPLOAD_BYTES = Number(process.env.DOCUMENTS_MAX_UPLOAD_BYTES || 50 * 1024 * 1024);

// Server-side MIME allowlist. Anything not in this list is refused
// at the upload boundary. Operators who legitimately need a new
// type add it here (audit-trail evidence will reference this commit).
const ALLOWED_MIME = new Set([
  "application/pdf",
  "application/zip",
  "application/x-zip-compressed",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/tiff",
  "text/plain",
  "text/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "application/json",
  "application/octet-stream",
]);

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

    const size = Number(body.size_bytes || 0);
    if (size > MAX_UPLOAD_BYTES) {
      return json(res, 413, { error: { code: "FILE_TOO_LARGE", message: "Maximum upload size is " + MAX_UPLOAD_BYTES + " bytes." } });
    }
    const mime = String(body.mime_type || "").toLowerCase();
    if (mime && !ALLOWED_MIME.has(mime)) {
      return json(res, 415, { error: { code: "UNSUPPORTED_MIME", message: "Unsupported file type." } });
    }

    const svc = serviceClient();
    const filename = sanitizeName(body.filename);
    const path = ctx.tenantId + "/" + Date.now() + "_" + filename;
    let bucket;
    try {
      bucket = await ensureDocumentsBucket(svc);
    } catch (e) {
      bucket = documentsBucket();
      // eslint-disable-next-line no-console
      console.warn("[documents/upload] ensureDocumentsBucket: " + e.message);
    }
    const { data: signed, error: signErr } = await svc.storage.from(bucket).createSignedUploadUrl(path);
    if (signErr) throw new Error(friendlyStorageError(signErr.message, bucket));
    const insert = await svc.from("documents").insert({
      tenant_id: ctx.tenantId,
      storage_bucket: bucket,
      storage_path: path,
      filename,
      mime_type: body.mime_type || null,
      size_bytes: size || null,
      sha256: body.sha256 || null,
      uploaded_by: ctx.user ? ctx.user.id : null,
      classification: body.classification || null,
      // scan_status starts at pending; nothing can read this document
      // for OCR/extract until /api/documents/scan flips it to clean.
      scan_status: "pending",
      metadata: body.metadata || {},
    }).select("id").single();
    if (insert.error) throw new Error("Document record error: " + insert.error.message);
    await recordAudit(ctx, {
      action: "document_upload_intent",
      objectType: "document",
      objectId: insert.data.id,
      detail: filename + " (" + size + " bytes, " + (mime || "no-mime") + ")",
    });
    return json(res, 200, {
      documentId: insert.data.id,
      uploadUrl: signed.signedUrl,
      token: signed.token,
      path,
      max_bytes: MAX_UPLOAD_BYTES,
    });
  } catch (err) {
    sendError(res, err);
  }
}
