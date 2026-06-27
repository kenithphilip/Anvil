// /api/customers/change_requests
//
//   GET   ?status=pending        list change requests (read)
//   POST                          submit a create/update request (write)
//                                 body: { change_type, target_customer_id?, payload }
//   PATCH ?id=...                 decide (approve-level)
//                                 body: { decision: "approve"|"reject", reason? }
//
// Customer data entry with approval: write-role users submit; an approver
// (sales_manager/finance/admin) approves -> the change applies to `customers`,
// or rejects with a reason. Admins can also write the master directly via
// POST /api/customers; this queue is the governed path for everyone else.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

// Columns a request may set. Anything else in payload is ignored.
const SAFE_FIELDS = [
  "customer_name", "customer_key", "gstin", "currency", "customer_type",
  "state_code", "contact_email", "credit_limit", "payment_terms", "parent_customer_id",
];

const slugify = (s) => String(s || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

const pickSafe = (payload) => {
  const out = {};
  if (payload && typeof payload === "object") {
    for (const k of SAFE_FIELDS) if (Object.prototype.hasOwnProperty.call(payload, k) && payload[k] !== undefined) out[k] = payload[k];
  }
  return out;
};

// Upsert/update with a one-shot strip-retry if a column doesn't exist on this
// deployment (mirrors the pattern in customers/index.js).
const applyCreate = async (svc, tenantId, fields) => {
  const key = fields.customer_key || slugify(fields.customer_name);
  if (!key) throw new Error("customer_name or customer_key required");
  const row = { tenant_id: tenantId, ...fields, customer_key: key };
  let r = await svc.from("customers").upsert(row, { onConflict: "tenant_id,customer_key" }).select("id").single();
  if (r.error && (r.error.code === "42703" || /column .* does not exist/i.test(r.error.message))) {
    const m = /column "?([a-z_]+)"?/i.exec(r.error.message);
    if (m && m[1]) { delete row[m[1]]; r = await svc.from("customers").upsert(row, { onConflict: "tenant_id,customer_key" }).select("id").single(); }
  }
  if (r.error) throw new Error(r.error.message);
  return r.data.id;
};

const applyUpdate = async (svc, tenantId, customerId, fields) => {
  if (!Object.keys(fields).length) return customerId;
  let r = await svc.from("customers").update(fields).eq("tenant_id", tenantId).eq("id", customerId).select("id").single();
  if (r.error && (r.error.code === "42703" || /column .* does not exist/i.test(r.error.message))) {
    const m = /column "?([a-z_]+)"?/i.exec(r.error.message);
    if (m && m[1]) { delete fields[m[1]]; r = await svc.from("customers").update(fields).eq("tenant_id", tenantId).eq("id", customerId).select("id").single(); }
  }
  if (r.error) throw new Error(r.error.message);
  return customerId;
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();
    const id = req.query?.id || null;

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const status = req.query?.status || "pending";
      let q = svc.from("customer_change_requests").select("*").eq("tenant_id", ctx.tenantId);
      if (status && status !== "all") q = q.eq("status", status);
      const r = await q.order("created_at", { ascending: false }).limit(200);
      if (r.error) throw new Error(r.error.message);
      return json(res, 200, { requests: r.data || [] });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      const changeType = body?.change_type;
      if (!["create", "update"].includes(changeType)) return json(res, 400, { error: { message: "change_type must be create or update" } });
      const payload = pickSafe(body?.payload);
      if (!Object.keys(payload).length) return json(res, 400, { error: { message: "payload has no recognised fields" } });
      if (changeType === "create" && !payload.customer_name && !payload.customer_key) return json(res, 400, { error: { message: "create needs customer_name" } });
      if (changeType === "update" && !body?.target_customer_id) return json(res, 400, { error: { message: "update needs target_customer_id" } });
      const ins = await svc.from("customer_change_requests").insert({
        tenant_id: ctx.tenantId,
        change_type: changeType,
        target_customer_id: changeType === "update" ? body.target_customer_id : null,
        payload,
        requested_by: ctx.user?.id || null,
      }).select("*").single();
      if (ins.error) throw new Error(ins.error.message);
      await recordAudit(ctx, { action: "customer_change_requested", objectType: "customer_change_request", objectId: ins.data.id, detail: changeType, after: payload });
      return json(res, 200, { request: ins.data });
    }

    if (req.method === "PATCH") {
      requirePermission(ctx, "approve");
      if (!id) return json(res, 400, { error: { message: "id required" } });
      const body = await readBody(req);
      const decision = body?.decision;
      if (!["approve", "reject"].includes(decision)) return json(res, 400, { error: { message: "decision must be approve or reject" } });
      const cur = await svc.from("customer_change_requests").select("*").eq("tenant_id", ctx.tenantId).eq("id", id).maybeSingle();
      if (cur.error) throw new Error(cur.error.message);
      if (!cur.data) return json(res, 404, { error: { message: "request not found" } });
      if (cur.data.status !== "pending") return json(res, 409, { error: { message: "request already " + cur.data.status } });

      const patch = { status: decision === "approve" ? "approved" : "rejected", decided_by: ctx.user?.id || null, decided_at: new Date().toISOString(), decided_reason: body?.reason || null };
      if (decision === "approve") {
        const fields = pickSafe(cur.data.payload);
        patch.applied_customer_id = cur.data.change_type === "create"
          ? await applyCreate(svc, ctx.tenantId, fields)
          : await applyUpdate(svc, ctx.tenantId, cur.data.target_customer_id, fields);
      }
      const upd = await svc.from("customer_change_requests").update(patch).eq("tenant_id", ctx.tenantId).eq("id", id).select("*").single();
      if (upd.error) throw new Error(upd.error.message);
      await recordAudit(ctx, { action: "customer_change_" + patch.status, objectType: "customer_change_request", objectId: id, detail: cur.data.change_type, after: { applied_customer_id: patch.applied_customer_id || null } });
      return json(res, 200, { request: upd.data });
    }

    res.setHeader("Allow", "GET, POST, PATCH");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) { sendError(res, err); }
}
