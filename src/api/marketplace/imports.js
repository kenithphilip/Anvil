// /api/marketplace/imports
//   GET                              list the consumer tenant's imports
//   POST  /confirm  { import_id }    operator-confirm an import (drives
//                                    the promotion gate from hint mode
//                                    to skip_llm)
//   POST  /revert   { import_id, reason? }
//                                    consumer-side "stop using this
//                                    global template" kill switch
//
// RBAC: read for list; admin for confirm/revert.

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
    const url = new URL(req.url, "http://_");
    const segments = url.pathname.split("/").filter(Boolean);
    const action = segments[3];

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const r = await svc.from("template_imports").select("*")
        .eq("tenant_id", ctx.tenantId)
        .order("created_at", { ascending: false })
        .limit(200);
      if (r.error) throw new Error(r.error.message);
      return json(res, 200, { imports: r.data || [] });
    }

    if (req.method === "POST" && action === "confirm") {
      requirePermission(ctx, "admin");
      const body = await readBody(req);
      if (!body.import_id) {
        return json(res, 400, { error: { message: "import_id required" } });
      }
      const existing = await svc.from("template_imports").select("*")
        .eq("tenant_id", ctx.tenantId).eq("id", body.import_id).maybeSingle();
      if (existing.error) throw new Error(existing.error.message);
      if (!existing.data) return json(res, 404, { error: { message: "import_not_found" } });
      const upd = await svc.from("template_imports").update({
        operator_confirmed_count: (Number(existing.data.operator_confirmed_count) || 0) + 1,
      }).eq("id", body.import_id).select("*").maybeSingle();
      if (upd.error) throw new Error(upd.error.message);
      await recordAudit(ctx, {
        action: "marketplace.import.confirmed",
        objectType: "template_import",
        objectId: body.import_id,
        detail: { global_id: existing.data.global_id },
      });
      return json(res, 200, { import: upd.data });
    }

    if (req.method === "POST" && action === "revert") {
      requirePermission(ctx, "admin");
      const body = await readBody(req);
      if (!body.import_id) {
        return json(res, 400, { error: { message: "import_id required" } });
      }
      const upd = await svc.from("template_imports").update({
        reverted_at: new Date().toISOString(),
        revert_reason: body.reason || "consumer_initiated",
      }).eq("tenant_id", ctx.tenantId).eq("id", body.import_id).select("*").maybeSingle();
      if (upd.error) throw new Error(upd.error.message);
      await recordAudit(ctx, {
        action: "marketplace.import.reverted",
        objectType: "template_import",
        objectId: body.import_id,
        detail: { reason: body.reason },
      });
      return json(res, 200, { import: upd.data });
    }

    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) { sendError(res, err); }
}
