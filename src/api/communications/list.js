// GET /api/communications?order_id=...
//
// Lists communications (email / WhatsApp / Slack drafts and sends, and the
// rep touches logged through /api/communications/log) for an order, a source
// PO, a quote or opportunity, or a customer. Powers the ThreadDrawer's
// communications timeline and the Follow-up timeline in
// components/TouchLog.tsx. The client called
// `ObaraBackend.communications.list(orderId)` but no endpoint
// existed, so the drawer's comms panel was silently empty.
//
// Query params (every filter is ANDed, and always inside the caller's tenant):
//   ?order_id=...       filter by order_id
//   ?source_po_id=...   filter by source_po_id
//   ?object_type=...    filter by the generic subject reference (189), e.g. quote
//   ?object_id=...      filter by object_id (uuid)
//   ?customer_id=...    filter by customer_id (uuid)
//   ?versions=all       with object_type=quote + object_id: every version of
//                       that quote (same quote_number, this tenant), not only
//                       the one row. A revise inserts a NEW quotes row, so the
//                       touches and emails filed against v1 would otherwise
//                       vanish from v2's Follow-up tab.
//   ?limit=...          page size (default 100, max 500)
//
// object_type + object_id ride the partial index communications_object_idx and
// customer_id rides communications_customer_idx (both migration 189).
//
// What a row carries back is narrower than what is stored:
//   * metadata is NOT selected whole. A quote or invoice email's metadata holds
//     its share URL and portal URL; only the rep touch's next follow-up date is
//     projected out of it.
//   * body is returned for rep touches only. Every other row's body is mail the
//     system composed, and a quote or invoice email's body has the same signed
//     PDF link and customer portal accept / pay link written into its text
//     (quotes/send.js, invoices/send.js). Those links work as bearer links, and
//     this endpoint answers every read role. No screen renders those bodies:
//     ThreadDrawer shows subject, channel and status, and TouchLog shows the
//     subject.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { isUuid, TOUCH_DOCUMENT_TYPE } from "../_lib/rep-touch.js";

// The uuid-typed filters. A malformed value would reach Postgres as an invalid
// uuid literal and come back as a 500; refuse it here as a 400 instead.
const UUID_FILTERS = ["object_id", "customer_id"];

// Every version of the quote `quoteId` in this tenant, as quote ids. The quote
// itself is always included; an unknown id (or a quote with no number) widens
// to nothing more than itself.
const quoteChainIds = async (svc, tenantId, quoteId) => {
  const self = await svc.from("quotes")
    .select("id, quote_number")
    .eq("tenant_id", tenantId)
    .eq("id", quoteId)
    .maybeSingle();
  if (self.error) throw new Error(self.error.message);
  if (!self.data || !self.data.quote_number) return [quoteId];
  const chain = await svc.from("quotes")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("quote_number", self.data.quote_number);
  if (chain.error) throw new Error(chain.error.message);
  return Array.from(new Set([quoteId, ...(chain.data || []).map((r) => r.id)]));
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const query = req.query || {};
    for (const k of UUID_FILTERS) {
      if (query[k] && !isUuid(query[k])) return json(res, 400, { error: { message: k + " must be a uuid" } });
    }
    // versions is a discriminator on how object_id is read, so anything but
    // the one supported form is refused rather than ignored.
    const allVersions = query.versions != null && query.versions !== "";
    if (allVersions && (query.versions !== "all" || query.object_type !== "quote" || !query.object_id)) {
      return json(res, 400, { error: { message: "versions=all needs object_type=quote and an object_id" } });
    }
    const svc = serviceClient();
    const limit = Math.max(1, Math.min(500, Number(query.limit || 100)));

    let q = svc.from("communications")
      .select("id, order_id, source_po_id, object_type, object_id, customer_id, customer_contact_id, document_type, direction, channel, thread_id, from_addr, to_addr, cc_addrs, subject, body, status, provider, sent_at, next_followup_at:metadata->>next_followup_at, created_at, updated_at")
      .eq("tenant_id", ctx.tenantId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (query.order_id) q = q.eq("order_id", query.order_id);
    if (query.source_po_id) q = q.eq("source_po_id", query.source_po_id);
    if (query.object_type) q = q.eq("object_type", query.object_type);
    if (allVersions) q = q.in("object_id", await quoteChainIds(svc, ctx.tenantId, query.object_id));
    else if (query.object_id) q = q.eq("object_id", query.object_id);
    if (query.customer_id) q = q.eq("customer_id", query.customer_id);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    const rows = (data || []).map((r) => (r.document_type === TOUCH_DOCUMENT_TYPE ? r : { ...r, body: null }));
    return json(res, 200, { communications: rows });
  } catch (err) { sendError(res, err); }
}
