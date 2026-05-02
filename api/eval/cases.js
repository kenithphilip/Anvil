// CRUD for eval_cases (the golden test catalogue).

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();
    if (req.method === "GET") {
      requirePermission(ctx, "read");
      let q = svc.from("eval_cases").select("*").eq("tenant_id", ctx.tenantId).order("suite").limit(500);
      if (req.query.suite) q = q.eq("suite", req.query.suite);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return json(res, 200, { cases: data });
    }
    if (req.method === "POST") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      if (!body || !body.suite || !body.case_id) return json(res, 400, { error: { message: "suite and case_id required" } });
      const upsert = await svc.from("eval_cases").upsert({
        tenant_id: ctx.tenantId,
        suite: body.suite,
        case_id: body.case_id,
        description: body.description || null,
        documents: body.documents || [],
        expected: body.expected || {},
        enabled: body.enabled !== false,
      }, { onConflict: "tenant_id,suite,case_id" }).select("*").single();
      if (upsert.error) throw new Error(upsert.error.message);
      await recordAudit(ctx, { action: "eval_case_upsert", objectType: "eval_case", objectId: upsert.data.id, detail: body.suite + "/" + body.case_id });
      return json(res, 200, { case: upsert.data });
    }
    if (req.method === "DELETE") {
      requirePermission(ctx, "admin");
      const id = req.query.id;
      if (!id) return json(res, 400, { error: { message: "id required" } });
      const { error } = await svc.from("eval_cases").delete().eq("tenant_id", ctx.tenantId).eq("id", id);
      if (error) throw new Error(error.message);
      return json(res, 200, { ok: true });
    }
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
