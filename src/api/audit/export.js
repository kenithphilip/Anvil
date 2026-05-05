// GET /api/audit/export
//
// Time-bounded JSONL dump of `audit_events` for the calling tenant,
// signed with HMAC-SHA256 using `AUDIT_EXPORT_HMAC_SECRET` so the
// auditor can verify the file wasn't tampered with after export.
// Phase 6 (C.1) SOC 2 control evidence.
//
// Query params:
//   from   ISO timestamp inclusive
//   to     ISO timestamp exclusive (defaults to now)
//   types  comma-separated audit verbs to filter (optional)
//   limit  max rows (defaults 50000, hard ceiling 200000)
//
// Output: application/x-ndjson, one JSON line per audit row, plus
// a final line `{"meta":{...,"hmac":"<sig>"}}` carrying the HMAC
// over the concatenated row payload.

import crypto from "node:crypto";
import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";

const HMAC_KEY = process.env.AUDIT_EXPORT_HMAC_SECRET || "";

const HARD_LIMIT = 200_000;
const DEFAULT_LIMIT = 50_000;

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "admin");

    if (!HMAC_KEY) {
      return json(res, 500, { error: {
        code: "AUDIT_EXPORT_NOT_CONFIGURED",
        message: "AUDIT_EXPORT_HMAC_SECRET env var is not set; refusing to export unsigned audit data.",
      } });
    }

    const url = new URL(req.url || "/", "http://x");
    const fromTs = url.searchParams.get("from");
    const toTs = url.searchParams.get("to") || new Date().toISOString();
    const types = (url.searchParams.get("types") || "").split(",").map((s) => s.trim()).filter(Boolean);
    const limit = Math.min(HARD_LIMIT, Number(url.searchParams.get("limit")) || DEFAULT_LIMIT);

    const svc = serviceClient();
    let q = svc.from("audit_events").select("*")
      .eq("tenant_id", ctx.tenantId)
      .order("ts", { ascending: true })
      .limit(limit);
    if (fromTs) q = q.gte("ts", fromTs);
    if (toTs) q = q.lt("ts", toTs);
    if (types.length) q = q.in("action", types);

    const result = await q;
    if (result.error) throw new Error("audit_events read: " + result.error.message);
    const rows = result.data || [];

    // Compose ndjson + trailing meta record. We hash the
    // concatenated row payload (canonical JSON.stringify) so the
    // file as a stream is verifiable.
    const hmac = crypto.createHmac("sha256", HMAC_KEY);
    const lines = [];
    for (const row of rows) {
      const line = JSON.stringify(row);
      hmac.update(line);
      hmac.update("\n");
      lines.push(line);
    }
    const meta = {
      meta: {
        tenant_id: ctx.tenantId,
        exported_by: ctx.userId || null,
        exported_at: new Date().toISOString(),
        from_ts: fromTs || null,
        to_ts: toTs,
        types: types.length ? types : null,
        rows: rows.length,
        truncated: rows.length === limit,
        hmac: hmac.digest("hex"),
      },
    };
    lines.push(JSON.stringify(meta));

    // Log the export run for SOC 2 evidence (who pulled what).
    await svc.from("audit_export_runs").insert({
      tenant_id: ctx.tenantId,
      exported_by: ctx.userId || null,
      from_ts: fromTs || null,
      to_ts: toTs,
      type_filters: types.length ? types : null,
      rows_exported: rows.length,
      signed_hash: meta.meta.hmac,
    });

    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="audit-${ctx.tenantId.slice(0, 8)}-${Date.now()}.ndjson"`);
    res.statusCode = 200;
    res.end(lines.join("\n") + "\n");
  } catch (err) {
    return sendError(res, err);
  }
}
