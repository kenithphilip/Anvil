// /api/admin/access_review
//
//   GET   returns the current snapshot of every member's role per
//         tenant — what an admin certifies on at the monthly review.
//   POST  body: { acknowledgement_text, notes? }. Captures the
//         signed acknowledgement; we sha256 the snapshot+text so the
//         row is tamper-evident.
//
// Phase 6 (C.1) SOC 2 control evidence.

import crypto from "node:crypto";
import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const snapshotMembers = async (svc, tenantId) => {
  const r = await svc.from("tenant_members")
    .select("user_id, role, status, requested_role, display_name, joined_at, last_seen_at")
    .eq("tenant_id", tenantId)
    .order("joined_at", { ascending: true });
  if (r.error) throw new Error("tenant_members read: " + r.error.message);
  return r.data || [];
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "admin");
    const svc = serviceClient();

    if (req.method === "GET") {
      const members = await snapshotMembers(svc, ctx.tenantId);
      const recent = await svc.from("access_reviews")
        .select("id, reviewed_by, reviewed_at, members, signed_hash, notes")
        .eq("tenant_id", ctx.tenantId)
        .order("reviewed_at", { ascending: false })
        .limit(12);
      return json(res, 200, {
        ok: true,
        members,
        member_count: members.length,
        recent_reviews: recent.data || [],
      });
    }

    if (req.method === "POST") {
      const body = await readBody(req);
      const ack = String(body?.acknowledgement_text || "").trim();
      if (!ack) return json(res, 400, { error: { message: "acknowledgement_text required" } });
      const members = await snapshotMembers(svc, ctx.tenantId);
      const payload = JSON.stringify({ tenant_id: ctx.tenantId, members, ack, ts: new Date().toISOString() });
      const signedHash = crypto.createHash("sha256").update(payload).digest("hex");
      const ins = await svc.from("access_reviews").insert({
        tenant_id: ctx.tenantId,
        reviewed_by: ctx.userId || null,
        members,
        acknowledgement_text: ack,
        signed_hash: signedHash,
        notes: body?.notes || null,
      }).select("id").single();
      if (ins.error) throw new Error("access_reviews insert: " + ins.error.message);
      await recordAudit(ctx, {
        action: "access_review_signed",
        objectType: "access_review",
        objectId: ins.data?.id || null,
        detail: "members=" + members.length + "::hash=" + signedHash.slice(0, 12),
      });
      return json(res, 200, {
        ok: true,
        id: ins.data?.id || null,
        signed_hash: signedHash,
        member_count: members.length,
      });
    }

    res.setHeader("Allow", "GET, POST");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    return sendError(res, err);
  }
}
