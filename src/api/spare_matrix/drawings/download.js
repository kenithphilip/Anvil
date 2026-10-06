// GET /api/spare_matrix/drawings/download?id=<gun_drawings.id>
//
// Download-controlled fetch for ONE gun drawing. Resolves the gun_drawings row
// to its uploaded file (document_id -> short-lived signed URL) or its external
// link (link_url), gated by the fine-grained `drawing.download` action so only
// design + sales roles + admin can pull the data (other roles can list that a
// drawing exists but not retrieve it — see spare_matrix/drawings/list.js, which
// also redacts the file/link for them).
//
// Distinct from the generic /api/documents/:id on purpose: gating there would
// throttle EVERY document type, not just drawings.

import { applyCors, handlePreflight, json, sendError } from "../../_lib/cors.js";
import { resolveContext, requirePermission, requireAction } from "../../_lib/auth.js";
import { serviceClient } from "../../_lib/supabase.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");          // coarse verb + anonymous hard-stop
    requireAction(ctx, "drawing.download");  // fine-grained data-download control
    const id = req.query.id;
    if (!id) return json(res, 400, { error: { message: "id required" } });
    const svc = serviceClient();

    const row = await svc.from("gun_drawings")
      .select("id, kind, document_id, link_url, original_filename")
      .eq("tenant_id", ctx.tenantId).eq("id", id).maybeSingle();
    if (row.error) throw new Error(row.error.message);
    if (!row.data) return json(res, 404, { error: { message: "Drawing not found" } });

    // External-link 3D: no stored file — hand back the link for the client to open.
    if (!row.data.document_id) {
      if (row.data.link_url) return json(res, 200, { external: true, downloadUrl: row.data.link_url, kind: row.data.kind });
      return json(res, 404, { error: { message: "This drawing has no downloadable file or link." } });
    }

    // Uploaded file: mint a short-lived signed URL (same logic as /api/documents/:id).
    const doc = await svc.from("documents").select("storage_bucket, storage_path")
      .eq("tenant_id", ctx.tenantId).eq("id", row.data.document_id).maybeSingle();
    if (doc.error) throw new Error(doc.error.message);
    if (!doc.data) return json(res, 404, { error: { message: "Drawing file not found" } });

    const { data: signed, error: signErr } = await svc.storage.from(doc.data.storage_bucket).createSignedUrl(doc.data.storage_path, 60 * 10);
    if (signErr) {
      const msg = String(signErr.message || "");
      const friendly = /not.*exist|not.*found|404/i.test(msg)
        ? "Document storage bucket `" + doc.data.storage_bucket + "` not found in Supabase Storage; ask an admin."
        : signErr.message;
      return json(res, 500, { error: { message: friendly } });
    }
    return json(res, 200, {
      downloadUrl: signed.signedUrl,
      filename: row.data.original_filename || "drawing",
      kind: row.data.kind,
      expiresInSeconds: 600,
    });
  } catch (err) {
    sendError(res, err);
  }
}
