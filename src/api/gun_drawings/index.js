// /api/gun_drawings
//
// Gun assembly drawings (PDF / DWG / STEP) attached to a gun by gun_no, so the
// spare matrix can show the drawing while spares are identified on the gun. The
// file is uploaded + scanned through the documents pipeline first
// (ObaraBackend.documents.upload -> documentId); this endpoint links that
// scanned document to the gun, lists a gun's drawings with fresh signed
// download URLs, and unlinks.
//
//   GET    ?gun_no=<no>                    -> drawings for a gun (+ signed urls)
//   POST   { gun_no, document_id, format?, label?, is_primary? }  -> link
//   DELETE ?id=<id>                        -> unlink (document itself is kept)

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { inferDrawingFormat, DRAWING_FORMATS } from "../_lib/gun-drawings.js";

const SIGNED_TTL = 3600; // 1h

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const gunNo = req.query?.gun_no;
      if (!gunNo) return json(res, 400, { error: { message: "gun_no required" } });
      const { data, error } = await svc.from("gun_drawings")
        .select("id, gun_no, format, label, is_primary, created_at, document_id, documents(storage_bucket, storage_path, filename, mime_type, scan_status, size_bytes)")
        .eq("tenant_id", ctx.tenantId).eq("gun_no", gunNo)
        .order("is_primary", { ascending: false }).order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      const drawings = [];
      for (const row of (data || [])) {
        const doc = row.documents || {};
        let download_url = null;
        if (doc.storage_bucket && doc.storage_path) {
          const signed = await svc.storage.from(doc.storage_bucket).createSignedUrl(doc.storage_path, SIGNED_TTL);
          if (!signed.error) download_url = signed.data?.signedUrl || null;
        }
        drawings.push({
          id: row.id, gun_no: row.gun_no, format: row.format, label: row.label,
          is_primary: row.is_primary, created_at: row.created_at, document_id: row.document_id,
          filename: doc.filename || null, mime_type: doc.mime_type || null,
          size_bytes: doc.size_bytes || null, scan_status: doc.scan_status || null,
          download_url,
        });
      }
      return json(res, 200, { gun_no: gunNo, drawings });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      const gunNo = body?.gun_no;
      const documentId = body?.document_id;
      if (!gunNo || !documentId) return json(res, 400, { error: { message: "gun_no and document_id required" } });

      // The document must exist in this tenant (it was uploaded via the
      // documents pipeline, which also scans it).
      const doc = await svc.from("documents")
        .select("id, filename, mime_type, scan_status")
        .eq("tenant_id", ctx.tenantId).eq("id", documentId).maybeSingle();
      if (doc.error) throw new Error(doc.error.message);
      if (!doc.data) return json(res, 404, { error: { message: "Document not found" } });
      if (doc.data.scan_status && doc.data.scan_status !== "clean") {
        return json(res, 409, { error: { message: "Document is not virus-scanned clean yet (" + doc.data.scan_status + ")" } });
      }

      let format = body.format && DRAWING_FORMATS.has(String(body.format)) ? body.format : null;
      if (!format) format = inferDrawingFormat(doc.data.filename, doc.data.mime_type);

      // If this is being marked primary, demote any existing primary for the gun.
      if (body.is_primary) {
        await svc.from("gun_drawings").update({ is_primary: false })
          .eq("tenant_id", ctx.tenantId).eq("gun_no", gunNo);
      }

      const ins = await svc.from("gun_drawings").upsert({
        tenant_id: ctx.tenantId,
        gun_no: gunNo,
        document_id: documentId,
        format,
        label: body.label || null,
        is_primary: !!body.is_primary,
        uploaded_by: ctx.user?.id || null,
      }, { onConflict: "tenant_id,document_id" }).select("id").maybeSingle();
      if (ins.error) throw new Error(ins.error.message);

      await recordAudit(ctx, {
        action: "gun_drawing_link",
        objectType: "gun_drawing",
        objectId: ins.data?.id || documentId,
        detail: gunNo + " :: " + format + (body.label ? " (" + body.label + ")" : ""),
      });
      return json(res, 200, { id: ins.data?.id, gun_no: gunNo, document_id: documentId, format });
    }

    if (req.method === "DELETE") {
      requirePermission(ctx, "write");
      const id = req.query?.id;
      if (!id) return json(res, 400, { error: { message: "id required" } });
      const { error } = await svc.from("gun_drawings")
        .delete().eq("tenant_id", ctx.tenantId).eq("id", id);
      if (error) throw new Error(error.message);
      await recordAudit(ctx, { action: "gun_drawing_unlink", objectType: "gun_drawing", objectId: id });
      return json(res, 200, { ok: true });
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
