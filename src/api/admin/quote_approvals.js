// /api/admin/quote_approvals
//   GET ?type=thresholds|approvals  list
//   GET ?type=queue  every order waiting for approval (PENDING_REVIEW), with
//                    its open threshold rows as the reasons
//   POST upsert threshold or record approval decision
//   DELETE ?id=  remove threshold

import { orderMargin } from "../_lib/order-margin.js";
import { orderValue } from "../_lib/order-value.js";
import { orderStage } from "../_lib/order-stage.js";
import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission, hasAction } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

// The order fields the Approvals screen shows for one order: its lines, its
// value, and its margin when the caller may see cost. Shared by the threshold
// rows (type=approvals) and the order queue (type=queue), so the two cannot
// disagree about the same order.
const orderQueueFields = (ord, seesCost) => {
  const so = ord?.result?.salesOrder || null;
  const lines = Array.isArray(so?.lineItems) ? so.lineItems : [];
  const m = ord && seesCost ? orderMargin(ord) : null;
  return {
    po_number: ord?.po_number || null,
    quote_number: ord?.quote_number || null,
    order_mode: ord?.order_mode || null,
    customer_name: ord?.customer?.customer_name || null,
    gstin: ord?.customer?.gstin || null,
    state_code: ord?.customer?.state_code || null,
    line_count: lines.length,
    value_inr: orderValue(ord),
    margin_pct: m ? m.marginPct : null,
    // The approver has to be able to tell "thin margin" from "we never
    // costed this". Null margin_pct alone cannot say which, and the
    // queue coloured a missing value the same as a healthy one.
    margin_state: !seesCost ? "hidden" : m ? (m.partial ? "partial" : "computed") : "not_costed",
    margin_lines_matched: m ? m.linesMatched : null,
    margin_lines_total: !seesCost ? null : m ? m.linesTotal : (Array.isArray(lines) ? lines.length : null),
  };
};

// The queue: every order waiting for a decision. It used to list
// quote_approvals rows only, and those exist only when a threshold matches,
// so an order sent for approval with no threshold match never appeared, and
// the approver had to find it in the Register.
export const QUEUE_LIMIT = 200;

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();
    const type = req.query.type || "thresholds";
    if (type === "thresholds") {
      if (req.method === "GET") {
        requirePermission(ctx, "read");
        const { data, error } = await svc.from("quote_approval_thresholds").select("*").eq("tenant_id", ctx.tenantId).order("min_amount_inr");
        if (error) throw new Error(error.message);
        return json(res, 200, { thresholds: data || [] });
      }
      if (req.method === "POST") {
        requirePermission(ctx, "admin");
        const body = await readBody(req);
        const row = {
          tenant_id: ctx.tenantId,
          approver_role: body.approver_role,
          min_amount_inr: Number(body.min_amount_inr) || 0,
          max_amount_inr: body.max_amount_inr != null ? Number(body.max_amount_inr) : null,
          required_for_modes: body.required_for_modes || null,
          margin_below_pct: body.margin_below_pct != null ? Number(body.margin_below_pct) : null,
          active: body.active !== false,
        };
        const ins = body.id
          ? await svc.from("quote_approval_thresholds").update(row).eq("tenant_id", ctx.tenantId).eq("id", body.id).select("*").single()
          : await svc.from("quote_approval_thresholds").insert(row).select("*").single();
        if (ins.error) throw new Error(ins.error.message);
        await recordAudit(ctx, { action: "approval_threshold_upsert", objectType: "approval_threshold", objectId: ins.data.id });
        return json(res, 200, { threshold: ins.data });
      }
      if (req.method === "DELETE") {
        requirePermission(ctx, "admin");
        const id = req.query.id;
        if (!id) return json(res, 400, { error: { message: "id required" } });
        const { error } = await svc.from("quote_approval_thresholds").delete().eq("tenant_id", ctx.tenantId).eq("id", id);
        if (error) throw new Error(error.message);
        return json(res, 200, { ok: true });
      }
    }
    if (type === "approvals") {
      if (req.method === "GET") {
        requirePermission(ctx, "read");
        // The Approvals queue UI (src/v3-app/screens/approvals.tsx)
        // renders po_number, customer_name, order_mode, value_inr,
        // margin_pct and a line-item count per row -- but NONE of
        // those columns exist on quote_approvals (migration 006 only
        // carries id, order_id, approver_role, status, comments,
        // decided_at). With a bare select("*") every column rendered
        // "—". Embed the related order (and through it the customer)
        // so we can flatten the fields the UI reads. The
        // quote_approvals.order_id FK -> orders(id) and
        // orders.customer_id -> customers(id) let PostgREST resolve
        // the nested embed automatically.
        let q = svc.from("quote_approvals")
          .select("*, order:order_id(po_number, quote_number, order_mode, result, created_at, customer:customer_id(customer_name, gstin, state_code))")
          .eq("tenant_id", ctx.tenantId)
          .order("created_at", { ascending: false })
          .limit(500);
        if (req.query.order_id) q = q.eq("order_id", req.query.order_id);
        const { data, error } = await q;
        if (error) throw new Error(error.message);
        // Flatten the embed into the top-level shape the UI already
        // expects (a.po_number, a.customer_name, ...) so no client
        // change is needed beyond adding the Line-items column.
        // value_inr / margin_pct are derived from the order's result JSONB.
        //
        // margin USED to read `so.marginPct ?? so.margin_pct`, with a comment
        // explaining that the field name "drifts between camel and snake
        // across older orders". It does not drift — nothing writes either
        // spelling, so this column was blank on every row ever rendered.
        // The real source is result.priceComposition, which
        // _lib/approval-evaluator.js already walks correctly when it decides
        // whether the order needs approval at all. Both now share
        // _lib/order-margin.js.
        // Margin is cost data. A role without cost.view still sees the queue
        // (value, lines, customer) but not the margin, and "hidden" tells the
        // screen not to show the row as "not costed".
        const seesCost = hasAction(ctx, "cost.view");
        const approvals = (data || []).map((row) => {
          const { order: ord, ...rest } = row;
          return { ...rest, ...orderQueueFields(ord || null, seesCost) };
        });
        return json(res, 200, { approvals });
      }
      if (req.method === "POST") {
        const body = await readBody(req);
        // A decision (an existing row, or a new row born decided) is an
        // approver's act. It needed only "write", so an engineer could
        // approve or reject through the API what the screen hid from them.
        // Opening a PENDING request stays a write.
        const isDecision = !!body.id || (body.status != null && body.status !== "PENDING");
        requirePermission(ctx, isDecision ? "approve" : "write");
        if (!body.order_id || !body.approver_role) return json(res, 400, { error: { message: "order_id and approver_role required" } });
        if (body.id) {
          const patch = { status: body.status || "PENDING", comments: body.comments || null, decided_at: new Date().toISOString(), approver_user: ctx.user ? ctx.user.id : null };
          const { data, error } = await svc.from("quote_approvals").update(patch).eq("tenant_id", ctx.tenantId).eq("id", body.id).select("*").single();
          if (error) throw new Error(error.message);
          await recordAudit(ctx, { action: "approval_decision", objectType: "quote_approval", objectId: body.id, after: patch });
          return json(res, 200, { approval: data });
        }
        const ins = await svc.from("quote_approvals").insert({
          tenant_id: ctx.tenantId,
          order_id: body.order_id,
          approver_role: body.approver_role,
          status: body.status || "PENDING",
          comments: body.comments || null,
        }).select("*").single();
        if (ins.error) throw new Error(ins.error.message);
        await recordAudit(ctx, { action: "approval_request", objectType: "quote_approval", objectId: ins.data.id });
        return json(res, 200, { approval: ins.data });
      }
    }
    if (type === "queue") {
      if (req.method !== "GET") return json(res, 405, { error: { message: "Method not allowed" } });
      requirePermission(ctx, "read");
      // Fail closed: without a tenant there is no queue to show.
      if (!ctx.tenantId) return json(res, 403, { error: { message: "No tenant in context" } });
      const oq = await svc.from("orders")
        .select("id, status, po_number, quote_number, order_mode, payload_hash, result, created_at, updated_at, customer_id, customer:customer_id(customer_name, gstin, state_code)")
        .eq("tenant_id", ctx.tenantId)
        .eq("status", "PENDING_REVIEW")
        .order("updated_at", { ascending: true })
        .limit(QUEUE_LIMIT);
      if (oq.error) throw new Error(oq.error.message);
      const orders = oq.data || [];
      // The threshold rows still open on these orders: the policy reasons.
      const byOrder = new Map();
      if (orders.length) {
        const aq = await svc.from("quote_approvals")
          .select("id, order_id, approver_role, status, comments, created_at")
          .eq("tenant_id", ctx.tenantId)
          .eq("status", "PENDING")
          .in("order_id", orders.map((o) => o.id));
        if (aq.error) throw new Error(aq.error.message);
        for (const r of aq.data || []) {
          if (!byOrder.has(r.order_id)) byOrder.set(r.order_id, []);
          byOrder.get(r.order_id).push(r);
        }
      }
      const seesCost = hasAction(ctx, "cost.view");
      // Every queue order is PENDING_REVIEW, and that stage needs neither the
      // mode nor the ERP SO, so neither is read. The holder is the open
      // threshold's role when there is one.
      const queue = orders.map((ord) => ({
        order_id: ord.id,
        status: ord.status,
        payload_hash: ord.payload_hash || null,
        created_at: ord.created_at || null,
        updated_at: ord.updated_at || null,
        ...orderQueueFields(ord, seesCost),
        thresholds: byOrder.get(ord.id) || [],
        stage: orderStage(ord, { approver_role: byOrder.get(ord.id)?.[0]?.approver_role || null }),
      }));
      return json(res, 200, { orders: queue, limit: QUEUE_LIMIT });
    }
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
