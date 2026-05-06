import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const id = req.query.id || req.url.split("/").pop();
    if (!id) return json(res, 400, { error: { message: "Document id required" } });
    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const svc = serviceClient();
      const { data, error } = await svc.from("documents").select("*").eq("tenant_id", ctx.tenantId).eq("id", id).single();
      if (error || !data) return json(res, 404, { error: { message: "Document not found" } });
      const { data: signed, error: signErr } = await svc.storage.from(data.storage_bucket).createSignedUrl(data.storage_path, 60 * 10);
      if (signErr) {
        const msg = String(signErr.message || "");
        const friendly = /not.*exist|not.*found|404/i.test(msg)
          ? "Document storage bucket `" + data.storage_bucket + "` not found in Supabase Storage. The bucket may have been renamed or deleted; ask an admin."
          : signErr.message;
        return json(res, 500, { error: { message: friendly } });
      }
      return json(res, 200, { ...data, downloadUrl: signed.signedUrl, expiresInSeconds: 600 });
    }
    if (req.method === "DELETE") {
      requirePermission(ctx, "admin");
      const svc = serviceClient();
      const { data: doc, error: docErr } = await svc.from("documents").select("storage_bucket, storage_path").eq("tenant_id", ctx.tenantId).eq("id", id).single();
      if (docErr || !doc) return json(res, 404, { error: { message: "Document not found" } });
      await svc.storage.from(doc.storage_bucket).remove([doc.storage_path]);
      const { error: delErr } = await svc.from("documents").delete().eq("tenant_id", ctx.tenantId).eq("id", id);
      if (delErr) return json(res, 500, { error: { message: delErr.message } });
      return json(res, 200, { ok: true });
    }
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
