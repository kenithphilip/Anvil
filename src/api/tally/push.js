// POST /api/tally/push
// Body: { orderId, tallyXml, voucherNo, payloadHash }
// Pushes the SO XML to a local Tally HTTP bridge with idempotency, persists the result,
// and flips order tally_status. Bridge URL comes from TALLY_BRIDGE_URL env.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit, recordEvent } from "../_lib/audit.js";

const BRIDGE_URL = process.env.TALLY_BRIDGE_URL;
const BRIDGE_TOKEN = process.env.TALLY_BRIDGE_TOKEN;

const idempotencyKey = (gstin, poNumber, payloadHash) => [String(gstin || ""), String(poNumber || ""), String(payloadHash || "")].join("|");

const extractVoucherId = (xml) => {
  const m = String(xml || "").match(/<VOUCHERID>([^<]+)<\/VOUCHERID>/i) || String(xml || "").match(/<MASTERID>([^<]+)<\/MASTERID>/i);
  return m ? m[1] : null;
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "approve");
    // Refuse early when the bridge is not configured. Previously we wrote
    // a "failed" tally_voucher_records row with the not-configured error,
    // which trained users to ignore real failures because the queue was
    // full of misconfiguration noise. The shell already exposes the
    // integration state via /api/health; the UI disables the button.
    if (!BRIDGE_URL) {
      return json(res, 409, {
        error: {
          code: "BRIDGE_NOT_CONFIGURED",
          message: "TALLY_BRIDGE_URL is not set. Configure the bridge in Vercel env, see docs/INTEGRATIONS.md.",
        },
      });
    }
    const body = await readBody(req);
    if (!body || !body.orderId || !body.tallyXml) return json(res, 400, { error: { message: "orderId and tallyXml required" } });
    const svc = serviceClient();
    const { data: order, error: orderErr } = await svc.from("orders").select("*").eq("tenant_id", ctx.tenantId).eq("id", body.orderId).single();
    if (orderErr || !order) return json(res, 404, { error: { message: "Order not found" } });
    if (!order.approval || !order.approval.payloadHash) return json(res, 409, { error: { message: "Order has no approval bound to a payload hash" } });
    const expected = order.payload_hash || order.approval.payloadHash;
    if (body.payloadHash && expected && body.payloadHash !== expected) {
      return json(res, 409, { error: { message: "Payload hash mismatch with approved order" } });
    }
    const customerGstin = (order.result && order.result.po && order.result.po.customerGstin) || order.customer_gstin || "";
    const idem = idempotencyKey(customerGstin, order.po_number || body.voucherNo, expected);

    const existing = await svc.from("tally_voucher_records").select("*").eq("tenant_id", ctx.tenantId).eq("voucher_no", body.voucherNo || ("SO:" + order.po_number)).eq("payload_hash", expected).maybeSingle();
    if (existing.data && (existing.data.status === "exported" || existing.data.status === "imported")) {
      return json(res, 200, { idempotent: true, record: existing.data });
    }

    let bridgeResponse = null;
    let bridgeError = null;
    try {
      const resp = await fetch(BRIDGE_URL, {
        method: "POST",
        headers: { "Content-Type": "text/xml", ...(BRIDGE_TOKEN ? { Authorization: "Bearer " + BRIDGE_TOKEN } : {}) },
        body: body.tallyXml,
      });
      const text = await resp.text();
      bridgeResponse = { status: resp.status, body: text.slice(0, 10000) };
      if (!resp.ok) bridgeError = "Bridge returned " + resp.status;
    } catch (err) {
      bridgeError = err.message;
    }

    const status = bridgeError ? "failed" : "exported";
    const upsert = await svc.from("tally_voucher_records").upsert({
      tenant_id: ctx.tenantId,
      order_id: order.id,
      voucher_no: body.voucherNo || ("SO:" + order.po_number),
      payload_hash: expected,
      status,
      validation: { idempotency: idem, bridge: bridgeResponse },
      tally_voucher_id: bridgeResponse && bridgeResponse.body ? extractVoucherId(bridgeResponse.body) : null,
      imported_at: status === "exported" ? new Date().toISOString() : null,
      error: bridgeError,
    }, { onConflict: "tenant_id,voucher_no,payload_hash" }).select("*").single();
    if (upsert.error) throw new Error(upsert.error.message);

    await svc.from("orders").update({ tally_status: status === "exported" ? "exported" : "failed", status: status === "exported" ? "EXPORTED_TO_TALLY" : "FAILED_TALLY_IMPORT" }).eq("tenant_id", ctx.tenantId).eq("id", order.id);
    await recordAudit(ctx, { action: "tally_push", objectType: "order", objectId: order.id, detail: status + (bridgeError ? " (" + bridgeError + ")" : ""), payloadHash: expected });
    await recordEvent(ctx, { caseId: order.id, eventType: status === "exported" ? "tally_exported" : "tally_failed", objectType: "order", objectId: order.id, detail: { bridgeError, voucher_no: upsert.data.voucher_no } });
    return json(res, 200, {
      record: upsert.data,
      tallyVoucherId: upsert.data && upsert.data.tally_voucher_id,
      status: upsert.data && upsert.data.status,
      voucherNo: upsert.data && upsert.data.voucher_no,
      error: bridgeError,
    });
  } catch (err) {
    sendError(res, err);
  }
}
