// POST /api/tally/push
// Body: {
//   orderId, tallyXml, voucherNo, payloadHash,
//   companyId?, voucherType?, dry_run?
// }
//
// v2 changes from v1:
//   - Resolves the active tally_companies row instead of reading
//     TALLY_BRIDGE_URL straight from env. Multi-company tenants pass
//     companyId; single-company tenants leave it off and we pick the
//     default. Env-based bridge stays as the legacy fallback.
//   - voucherType ∈ {SalesOrder, Sales, Purchase, Receipt, Payment,
//     Contra, Journal, DebitNote, CreditNote, StockJournal}; passes
//     through to tally_voucher_records.voucher_type.
//   - dry_run=true returns the rendered XML and resolved bridge URL
//     without actually POSTing, so the UI can sanity-check.
//   - Recoverable failures (5xx, 429, network) enqueue a retry row
//     in tally_retry_queue with exponential backoff.
//   - Decrypts bridge_token before sending.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit, recordEvent } from "../_lib/audit.js";
import { tallyPush, tallyResolveCompany, tallyIsRecoverable } from "../_lib/tally-client.js";

const idempotencyKey = (gstin, poNumber, payloadHash) =>
  [String(gstin || ""), String(poNumber || ""), String(payloadHash || "")].join("|");

const extractVoucherId = (xml) => {
  if (!xml) return null;
  const m = String(xml).match(/<VOUCHERID>([^<]+)<\/VOUCHERID>/i)
    || String(xml).match(/<MASTERID>([^<]+)<\/MASTERID>/i);
  return m ? m[1] : null;
};

const enqueueRetry = async (svc, ctx, company, order, body, voucherRecordId, status, errorMsg) => {
  await svc.from("tally_retry_queue").insert({
    tenant_id: ctx.tenantId,
    company_id: company?.id || null,
    order_id: order.id,
    voucher_record_id: voucherRecordId,
    voucher_type: body.voucherType || "SalesOrder",
    payload_xml: body.tallyXml,
    payload_hash: body.payloadHash || order.payload_hash || "",
    attempt_count: 1,
    last_attempt_at: new Date().toISOString(),
    next_attempt_at: new Date(Date.now() + 60_000).toISOString(),
    last_error: ((errorMsg && String(errorMsg).slice(0, 800)) || ("status=" + status)),
    status: "pending",
  });
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "approve");
    const body = await readBody(req);
    if (!body?.orderId || !body?.tallyXml) {
      return json(res, 400, { error: { message: "orderId and tallyXml required" } });
    }
    const voucherType = body.voucherType || "SalesOrder";

    const svc = serviceClient();
    const company = await tallyResolveCompany(svc, ctx.tenantId, body.companyId);
    if (!company || !company.bridge_url) {
      return json(res, 409, {
        error: {
          code: "BRIDGE_NOT_CONFIGURED",
          message: "No Tally company with a bridge URL is configured. Add one under Admin > Tally.",
        },
      });
    }

    const orderQ = await svc.from("orders").select("*").eq("tenant_id", ctx.tenantId).eq("id", body.orderId).single();
    if (orderQ.error || !orderQ.data) return json(res, 404, { error: { message: "Order not found" } });
    const order = orderQ.data;
    if (!order.approval || !order.approval.payloadHash) {
      return json(res, 409, { error: { message: "Order has no approval bound to a payload hash" } });
    }
    const expected = order.payload_hash || order.approval.payloadHash;
    if (body.payloadHash && expected && body.payloadHash !== expected) {
      return json(res, 409, { error: { message: "Payload hash mismatch with approved order" } });
    }

    if (body.dry_run) {
      return json(res, 200, {
        ok: true,
        dry_run: true,
        bridge_url: company.bridge_url,
        company: company.name,
        voucher_type: voucherType,
        payload_xml: body.tallyXml,
        payload_hash: expected,
      });
    }

    const customerGstin = (order.result?.po?.customerGstin) || order.customer_gstin || "";
    const idem = idempotencyKey(customerGstin, order.po_number || body.voucherNo, expected);

    const voucherNo = body.voucherNo || ("SO:" + order.po_number);
    const existing = await svc.from("tally_voucher_records")
      .select("*")
      .eq("tenant_id", ctx.tenantId)
      .eq("voucher_no", voucherNo)
      .eq("payload_hash", expected)
      .maybeSingle();
    if (existing.data && (existing.data.status === "exported" || existing.data.status === "imported")) {
      return json(res, 200, { idempotent: true, record: existing.data });
    }

    const pushResp = await tallyPush(company, body.tallyXml).catch((err) => ({
      ok: false, status: 0, body: err?.message || String(err), latency_ms: 0,
    }));
    const ok = pushResp.ok;
    const bridgeError = ok ? null : (
      typeof pushResp.body === "string" ? pushResp.body.slice(0, 800)
      : "status=" + pushResp.status
    );
    const status = ok ? "exported" : "failed";

    const upsert = await svc.from("tally_voucher_records").upsert({
      tenant_id: ctx.tenantId,
      order_id: order.id,
      company_id: company.id || null,
      voucher_type: voucherType,
      voucher_no: voucherNo,
      voucher_date: new Date().toISOString().slice(0, 10),
      external_voucher_no: ok && pushResp.body ? extractVoucherId(pushResp.body) : null,
      payload_hash: expected,
      status,
      validation: { idempotency: idem, bridge: { status: pushResp.status, latency_ms: pushResp.latency_ms } },
      tally_voucher_id: ok && pushResp.body ? extractVoucherId(pushResp.body) : null,
      imported_at: ok ? new Date().toISOString() : null,
      last_attempt_at: new Date().toISOString(),
      attempt_count: 1,
      error: bridgeError,
    }, { onConflict: "tenant_id,voucher_no,payload_hash" }).select("*").single();
    if (upsert.error) throw new Error(upsert.error.message);

    await svc.from("orders").update({
      tally_status: ok ? "exported" : "failed",
      status: ok ? "EXPORTED_TO_TALLY" : "FAILED_TALLY_IMPORT",
    }).eq("tenant_id", ctx.tenantId).eq("id", order.id);

    await recordAudit(ctx, {
      action: ok ? "tally_push" : "tally_push_failed",
      objectType: "order",
      objectId: order.id,
      detail: voucherType + "::" + status + (bridgeError ? " (" + bridgeError.slice(0, 120) + ")" : ""),
      payloadHash: expected,
    });
    await recordEvent(ctx, {
      caseId: order.id,
      eventType: ok ? "tally_exported" : "tally_failed",
      objectType: "order",
      objectId: order.id,
      detail: { voucherType, voucherNo, bridgeError },
    });

    if (!ok && tallyIsRecoverable(pushResp.status)) {
      await enqueueRetry(svc, ctx, company, order, body, upsert.data.id, pushResp.status, bridgeError);
    }

    return json(res, ok ? 200 : 502, {
      ok,
      record: upsert.data,
      tallyVoucherId: upsert.data.tally_voucher_id,
      status: upsert.data.status,
      voucherNo: upsert.data.voucher_no,
      queued_for_retry: !ok && tallyIsRecoverable(pushResp.status),
      error: bridgeError,
    });
  } catch (err) {
    sendError(res, err);
  }
}
