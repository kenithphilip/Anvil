// POST /api/copilot/confirm
// Body: { confirm_token, cancel?: true }
//
// The execute half of the copilot safe-action loop (PR2). A copilot
// write tool earlier created a proposal (preview + single-use
// confirm_token) and DID NOT act. Here a human with `approve` confirms:
// we atomically consume the proposal (bound to the same tenant + the
// proposing user), then execute the bound action and audit it. Replayed,
// expired, cross-tenant, or cross-user tokens are rejected. `cancel:true`
// discards a still-pending proposal.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { consumeProposal, cancelProposal, setProposalResult } from "../_lib/action-proposals.js";
import { sendCommunication } from "../_lib/comms-send.js";
import { enqueueTallyVoucher } from "../_lib/tally-enqueue.js";

// Execute a consumed proposal's bound action. Throws on failure.
const executeAction = async (svc, ctx, proposal) => {
  const action = proposal.action;
  const args = proposal.args || {};

  if (action === "create_lead") {
    if (!args.company_name) throw new Error("company_name required");
    const row = {
      tenant_id: ctx.tenantId,
      company_name: args.company_name,
      contact_name: args.contact_name || null,
      contact_email: args.contact_email || null,
      contact_phone: args.contact_phone || null,
      product_interest: args.product_interest || null,
      region: args.region || null,
      lead_source: args.lead_source || null,
      notes: args.notes || null,
      approval_status: "PENDING",
    };
    const ins = await svc.from("leads").insert(row).select("*").single();
    if (ins.error) throw new Error(ins.error.message);
    await recordAudit(ctx, { action: "lead_create", objectType: "lead", objectId: ins.data.id, after: ins.data, detail: "copilot confirm" });
    return { lead: ins.data };
  }

  if (action === "draft_and_send_comms") {
    if (!args.to_addr || !args.body) throw new Error("to_addr and body required");
    const draft = await svc.from("communications").insert({
      tenant_id: ctx.tenantId,
      order_id: args.order_id || null,
      direction: "outbound",
      channel: args.channel || "email",
      from_addr: args.from_addr || null,
      to_addr: args.to_addr,
      subject: args.subject || null,
      body: args.body,
      status: "draft",
    }).select("*").single();
    if (draft.error) throw new Error(draft.error.message);
    const sent = await sendCommunication(svc, ctx, draft.data.id);
    return {
      communication: sent.communication || draft.data,
      provider: sent.provider || "manual",
      configured: sent.configured,
      send_error: sent.error || null,
    };
  }

  if (action === "acknowledge_inventory_exception") {
    if (!args.exception_id) throw new Error("exception_id required");
    // Only an OPEN exception can be acknowledged (the .eq("status","open")
    // makes a double-ack a no-op that surfaces as an error, not a silent flip).
    const upd = await svc.from("inventory_exceptions")
      .update({ status: "acknowledged", acknowledged_by: ctx.user?.id || null, acknowledged_at: new Date().toISOString() })
      .eq("tenant_id", ctx.tenantId).eq("id", args.exception_id).eq("status", "open")
      .select("id, part_no, exception_kind, severity, status")
      .single();
    if (upd.error) throw new Error(upd.error.message);
    await recordAudit(ctx, { action: "inventory_exception_acknowledged", objectType: "inventory_exception", objectId: upd.data.id, after: upd.data, detail: "copilot confirm" });
    return { exception: upd.data };
  }

  if (action === "post_tally_voucher") {
    // Enqueue-only: build the voucher + insert a pending tally_retry_queue row.
    // The proven tally/retry cron does the actual bridge POST — no external
    // financial call happens here in the confirm handler.
    const r = await enqueueTallyVoucher(svc, ctx, { orderId: args.order_id, voucherType: args.voucher_type || null });
    if (!r.ok) throw new Error(r.code + ": " + r.message);
    await recordAudit(ctx, { action: "tally_voucher_enqueued", objectType: "order", objectId: r.order_id, detail: "copilot confirm · " + r.voucher_type + " · " + r.voucher_no });
    return r;
  }

  throw new Error("Unsupported action: " + action);
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "approve");
    const body = await readBody(req);
    if (!body?.confirm_token) return json(res, 400, { error: { message: "confirm_token required" } });
    const svc = serviceClient();
    const userId = ctx.user?.id || null;

    if (body.cancel === true) {
      const c = await cancelProposal(svc, { tenantId: ctx.tenantId, userId, confirmToken: body.confirm_token });
      return json(res, 200, { ok: true, cancelled: c.ok });
    }

    // Atomic single-use claim. Must match tenant + proposer.
    const claim = await consumeProposal(svc, { tenantId: ctx.tenantId, userId, confirmToken: body.confirm_token });
    if (!claim.ok) return json(res, claim.status, { error: { code: claim.code, message: claim.message } });

    // Consumed first (at-most-once); execute after. A failed execution
    // does NOT un-consume the token - the user re-proposes.
    try {
      const result = await executeAction(svc, ctx, claim.proposal);
      await setProposalResult(svc, { tenantId: ctx.tenantId, proposalId: claim.proposal.id, result });
      await recordAudit(ctx, {
        action: "copilot_action_executed",
        objectType: "action_proposal",
        objectId: claim.proposal.id,
        detail: claim.proposal.action,
      });
      return json(res, 200, { ok: true, action: claim.proposal.action, result });
    } catch (err) {
      const msg = err.message || String(err);
      await setProposalResult(svc, { tenantId: ctx.tenantId, proposalId: claim.proposal.id, result: { error: msg } });
      await recordAudit(ctx, {
        action: "copilot_action_failed",
        objectType: "action_proposal",
        objectId: claim.proposal.id,
        detail: claim.proposal.action + "::" + msg.slice(0, 200),
      });
      return json(res, 502, { ok: false, action: claim.proposal.action, error: { message: msg } });
    }
  } catch (err) {
    return sendError(res, err);
  }
}
