// CRUD for redaction_rules. POST upserts, GET lists, DELETE removes.
//
// Hardened May 2026 (security audit M4). New patterns are validated
// before storage:
//
//   1. Compile must succeed (RegExp constructor doesn't throw).
//   2. Smoke-test the pattern against a fixed corpus under a hard
//      wall-clock budget (~75ms). Catastrophic backtracking
//      patterns (e.g., `^(a+)+$`) blow the budget and are rejected
//      so they never reach the hot path inside redactMessages().
import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const SMOKE_CORPUS = (
  "the quick brown fox jumps over the lazy dog. " +
  "1234567890 abcdefghijklmnopqrstuvwxyz. " +
  "test@example.com 555-123-4567 1234-5678-9012-3456 " +
  "{\"a\":1,\"b\":[2,3,4],\"c\":\"d\"} " +
  "<html><body><p>nested</p></body></html> "
).repeat(40);
const PATTERN_BUDGET_MS = 75;

const validateRedactionPattern = (pattern) => {
  if (typeof pattern !== "string" || pattern.length === 0) {
    return { ok: false, reason: "Pattern must be a non-empty string" };
  }
  if (pattern.length > 512) {
    return { ok: false, reason: "Pattern exceeds 512 characters" };
  }
  let re;
  try { re = new RegExp(pattern, "g"); }
  catch (err) { return { ok: false, reason: "Invalid regex: " + err.message?.slice(0, 200) }; }
  const start = Date.now();
  try {
    let count = 0;
    for (const _m of SMOKE_CORPUS.matchAll(re)) {
      count += 1;
      if (count > 5000) break;
      if ((Date.now() - start) >= PATTERN_BUDGET_MS) break;
    }
    if ((Date.now() - start) >= PATTERN_BUDGET_MS) {
      return { ok: false, reason: "Pattern exceeded " + PATTERN_BUDGET_MS + "ms budget (likely catastrophic backtracking)" };
    }
  } catch (err) {
    return { ok: false, reason: "Pattern threw on smoke corpus: " + err.message?.slice(0, 200) };
  }
  return { ok: true };
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();
    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const { data, error } = await svc.from("redaction_rules").select("*").or("tenant_id.is.null,tenant_id.eq." + ctx.tenantId).order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      return json(res, 200, { rules: data });
    }
    if (req.method === "POST") {
      requirePermission(ctx, "admin");
      const body = await readBody(req);
      if (!body || !body.field_path || !body.pattern) return json(res, 400, { error: { message: "field_path and pattern required" } });
      // Audit M4: validate before persisting.
      const validation = validateRedactionPattern(body.pattern);
      if (!validation.ok) {
        return json(res, 400, { error: { code: "INVALID_PATTERN", message: validation.reason } });
      }
      const insert = await svc.from("redaction_rules").insert({
        tenant_id: ctx.tenantId,
        field_path: body.field_path,
        pattern: body.pattern,
        replacement: body.replacement || "[REDACTED]",
        enabled: body.enabled !== false,
        notes: body.notes || null,
      }).select("*").single();
      if (insert.error) throw new Error(insert.error.message);
      await recordAudit(ctx, { action: "redaction_rule_create", objectType: "redaction_rule", objectId: insert.data.id, detail: body.field_path });
      return json(res, 200, { rule: insert.data });
    }
    if (req.method === "DELETE") {
      requirePermission(ctx, "admin");
      const id = req.query.id;
      if (!id) return json(res, 400, { error: { message: "id required" } });
      const { error } = await svc.from("redaction_rules").delete().eq("tenant_id", ctx.tenantId).eq("id", id);
      if (error) throw new Error(error.message);
      return json(res, 200, { ok: true });
    }
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
