// Which opportunity a sales order was raised for.
//
// orders.opportunity_id (migration 204) is what win/loss and the shipment
// tracker read. Only 204's one-time backfill ever wrote it: a quote converted
// to an order, a PO reconciled against quotes, and a quote attached to a PO
// all left it null. This module is the one place that writes it.
//
// The rules:
//   - Tenant first. No tenant, no query. The opportunity must be this
//     tenant's, because the FK alone accepts any tenant's id.
//   - Same customer. An opportunity for another customer is refused.
//   - Never overwrite. The write is conditional on opportunity_id IS NULL, so
//     a link an operator already made stands.
//   - Exactly one. The linked quotes must imply exactly one opportunity. Two
//     or more is ambiguous: nothing is written, and the reason is recorded.
//   - Never throws. A link is attribution. The order write it follows has
//     already committed, and a failed link must not undo or fail it.

import { recordAudit } from "./audit.js";

export const LINKED = "order_opportunity_link";
export const SKIPPED = "order_opportunity_link_skipped";

const uniq = (ids) => [...new Set((ids || []).filter(Boolean).map(String))];

// Is this opportunity this tenant's, and this customer's?
// Returns { ok: true, opportunity } or { ok: false, reason, error? }.
// reason is one of: no_tenant, no_customer, not_found, customer_mismatch,
// lookup_failed. Every opportunity has a customer, so a caller with none
// cannot show the two agree, and is refused.
export const verifyOpportunity = async (svc, tenantId, opportunityId, customerId) => {
  if (!tenantId) return { ok: false, reason: "no_tenant" };
  if (!opportunityId) return { ok: false, reason: "not_found" };
  if (!customerId) return { ok: false, reason: "no_customer" };
  try {
    const r = await svc.from("opportunities")
      .select("id, customer_id, stage, opportunity_name")
      .eq("tenant_id", tenantId).eq("id", opportunityId)
      .maybeSingle();
    if (r.error) return { ok: false, reason: "lookup_failed", error: r.error.message };
    if (!r.data) return { ok: false, reason: "not_found" };
    if (String(r.data.customer_id || "") !== String(customerId)) {
      return { ok: false, reason: "customer_mismatch", opportunity: r.data };
    }
    return { ok: true, opportunity: r.data };
  } catch (err) {
    return { ok: false, reason: "lookup_failed", error: err?.message || String(err) };
  }
};

// Record why a link was not written, on the order's audit trail.
export const recordLinkSkipped = async (ctx, orderId, source, reason, after) => {
  try {
    await recordAudit(ctx, {
      action: SKIPPED, objectType: "order", objectId: orderId, reason,
      detail: "opportunity not linked (" + source + "): " + reason,
      after: { source, ...(after || {}) },
    });
  } catch { /* recordAudit logs its own failure */ }
};

// Write the order's opportunity from the quotes now linked to it.
//
// source names the caller ("reconcile", "attach_quote") for the audit trail.
// Returns { status, ... }:
//   linked          written now
//   already_linked  the order already had one; nothing was changed
//   none            the quotes imply no opportunity
//   ambiguous       they imply more than one; candidates lists them
//   refused         the one they imply is not this tenant's or customer's
//   not_found       no such order in this tenant
//   skipped         no tenant
//   failed          a database error; error says which
export const linkOrderOpportunityFromQuotes = async (svc, ctx, orderId, quoteIds, opts = {}) => {
  const source = opts.source || "unknown";
  if (!ctx || !ctx.tenantId) return { status: "skipped", reason: "no_tenant" };
  const ids = uniq(quoteIds);
  if (!orderId || !ids.length) return { status: "none" };
  try {
    const orderQ = await svc.from("orders")
      .select("id, customer_id, opportunity_id")
      .eq("tenant_id", ctx.tenantId).eq("id", orderId).maybeSingle();
    if (orderQ.error) throw new Error("orders read: " + orderQ.error.message);
    if (!orderQ.data) return { status: "not_found" };
    const order = orderQ.data;
    if (order.opportunity_id) return { status: "already_linked", opportunity_id: order.opportunity_id };

    const quotesQ = await svc.from("quotes")
      .select("id, opportunity_id")
      .eq("tenant_id", ctx.tenantId).in("id", ids);
    if (quotesQ.error) throw new Error("quotes read: " + quotesQ.error.message);
    const candidates = uniq((quotesQ.data || []).map((q) => q.opportunity_id));
    if (!candidates.length) return { status: "none" };
    if (candidates.length > 1) {
      await recordLinkSkipped(ctx, orderId, source, "ambiguous", { candidates, quote_ids: ids });
      return { status: "ambiguous", candidates };
    }

    const opportunityId = candidates[0];
    const chk = await verifyOpportunity(svc, ctx.tenantId, opportunityId, order.customer_id);
    if (!chk.ok) {
      await recordLinkSkipped(ctx, orderId, source, chk.reason, { opportunity_id: opportunityId, quote_ids: ids });
      return { status: "refused", reason: chk.reason, opportunity_id: opportunityId };
    }

    // IS NULL in the write itself, so a link made between the read above and
    // this write is not overwritten either.
    const upd = await svc.from("orders")
      .update({ opportunity_id: opportunityId })
      .eq("tenant_id", ctx.tenantId).eq("id", orderId)
      .is("opportunity_id", null)
      .select("id");
    if (upd.error) throw new Error("orders update: " + upd.error.message);
    if (!Array.isArray(upd.data) || upd.data.length === 0) return { status: "already_linked" };

    await recordAudit(ctx, {
      action: LINKED, objectType: "order", objectId: orderId,
      detail: "opportunity " + opportunityId + " linked from quotes (" + source + ")",
      after: { opportunity_id: opportunityId, source, quote_ids: ids },
    });
    return { status: "linked", opportunity_id: opportunityId };
  } catch (err) {
    const msg = err?.message || String(err);
    console.warn("[order-opportunity] " + source + " link failed for order " + orderId + ": " + msg);
    return { status: "failed", error: msg };
  }
};
