// Enqueue a Tally sales voucher for an APPROVED order (issue #22, GenOps safe
// action). The confirm handler calls this — it builds the voucher XML with the
// existing pure builders and inserts a `pending` tally_retry_queue row; the
// proven tally/retry cron does the actual bridge POST + records + idempotency.
// So no external financial HTTP happens inside the confirm handler.

import { tallyResolveCompany } from "./tally-client.js";
import { resolveSalesVoucherType } from "./tally-voucher-type.js";
import { buildSalesVoucherXml } from "./tally-build-voucher.js";

// Returns { ok:true, queued, order_id, voucher_no, voucher_type, queue_id,
// company } or { ok:false, code, message }. Never posts to Tally.
export const enqueueTallyVoucher = async (svc, ctx, { orderId, voucherType, companyId } = {}) => {
  const oid = String(orderId || "").trim();
  if (!oid) return { ok: false, code: "ORDER_REQUIRED", message: "orderId required" };

  const company = await tallyResolveCompany(svc, ctx.tenantId, companyId);
  if (!company || !company.bridge_url) {
    return { ok: false, code: "BRIDGE_NOT_CONFIGURED", message: "No Tally company with a bridge URL is configured (Admin > Tally)." };
  }
  const vType = voucherType || resolveSalesVoucherType(company);

  const orderQ = await svc.from("orders").select("*").eq("tenant_id", ctx.tenantId).eq("id", oid).maybeSingle();
  if (orderQ.error) return { ok: false, code: "ORDER_READ_FAILED", message: orderQ.error.message };
  const order = orderQ.data;
  if (!order) return { ok: false, code: "ORDER_NOT_FOUND", message: "Order not found" };
  if (!order.approval || !order.approval.payloadHash) {
    return { ok: false, code: "NOT_APPROVED", message: "Order has no approval bound to a payload hash — approve it before pushing." };
  }
  const payloadHash = order.payload_hash || order.approval.payloadHash;
  const voucherNo = "SO:" + order.po_number;

  const customerQ = order.customer_id
    ? await svc.from("customers").select("*").eq("tenant_id", ctx.tenantId).eq("id", order.customer_id).maybeSingle()
    : { data: null };
  const built = buildSalesVoucherXml({ order, company, customer: customerQ.data || null, voucherNo });

  const nowIso = new Date().toISOString();
  const ins = await svc.from("tally_retry_queue").insert({
    tenant_id: ctx.tenantId,
    company_id: company.id || null,
    order_id: order.id,
    voucher_record_id: null,
    voucher_type: vType,
    payload_xml: built.xml,
    payload_hash: payloadHash,
    attempt_count: 0,
    last_attempt_at: nowIso,
    next_attempt_at: nowIso,       // due immediately — the next drain picks it up
    last_error: null,
    status: "pending",
  }).select("id").single();
  if (ins.error) return { ok: false, code: "ENQUEUE_FAILED", message: ins.error.message };

  return { ok: true, queued: true, order_id: order.id, voucher_no: voucherNo, voucher_type: vType, queue_id: ins.data?.id || null, company: company.name };
};
