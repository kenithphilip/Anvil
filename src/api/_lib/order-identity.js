// Fixing an order's identity: its customer, its PO number and its PO date
// (plan PR 7, audit F8 and side defect S5).
//
// None of the three was on the PATCH allowlist, so a wrong auto-match meant
// cancel and redo, and an inbound email order created with no customer could
// never be given one. They can now be changed while the order is DRAFT or
// PENDING_REVIEW, and not after: an approved order is what the approver
// signed off.
//
// planIdentityEdit turns the request into a patch, or a refusal:
//   - the order and the target status must both be DRAFT or PENDING_REVIEW;
//   - the customer must be this tenant's (fail closed: no tenant, no change);
//   - the PO date must read as a date.
// A customer change also:
//   - re-runs the item-master map for the new customer, keeping the lines an
//     operator mapped by hand;
//   - unlinks a quote or an opportunity that belongs to another customer;
//   - records the match basis as "operator" in preflight_payload.
// orders/[id].js writes the patch, re-stamps the payload hash, re-runs the
// quote reconcile through autoReconcileOrder, and audits the change.

import { mapLinesToItemMaster } from "./item-mapper.js";
import { parsePoDate } from "./parse-date.js";
import { verifyOpportunity } from "./order-opportunity.js";

export const IDENTITY_KEYS = Object.freeze(["customer_id", "po_number", "po_date"]);
export const IDENTITY_EDIT_STATUSES = new Set(["DRAFT", "PENDING_REVIEW"]);
export const PO_NUMBER_MAX = 120;

// Line maps a person chose. A re-map for a new customer keeps them: the line
// is the same physical part whoever the buyer is.
export const OPERATOR_MAP_VIA = new Set(["manual", "llm_suggest"]);

const refuse = (status, code, message) => ({ error: { status, body: { error: { code, message } } } });

const isoDay = (v) => (v ? String(v).slice(0, 10) : null);

// A real calendar day in YYYY-MM-DD, or null.
const validDay = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ""))) return null;
  const d = new Date(s + "T00:00:00Z");
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return null;
  return s;
};

// The item-master map for a new customer. The tier that changes with the
// customer is item_customer_parts (the buyer's own part codes). Best-effort:
// a failed map keeps the lines as they are, and the save goes on.
export const remapLinesForCustomer = async (svc, tenantId, customerId, lines) => {
  if (!Array.isArray(lines) || !lines.length) return lines || [];
  try {
    const mapped = await mapLinesToItemMaster(svc, tenantId, customerId, lines);
    if (!Array.isArray(mapped) || mapped.length !== lines.length) return lines;
    return mapped.map((ln, i) => (OPERATOR_MAP_VIA.has(lines[i]?._mapped_item?.match_via) ? lines[i] : ln));
  } catch {
    return lines;
  }
};

// Returns { error: { status, body } } to refuse, or
// { patch, changes, customerChanged, unlinked } where `changes` holds
// { from, to } for each field that actually changes. A field sent with its
// current value is not a change.
export const planIdentityEdit = async (svc, ctx, prev, body, { now = new Date().toISOString() } = {}) => {
  if (!ctx || !ctx.tenantId) return refuse(403, "NO_TENANT", "No tenant in context");
  const target = body.status || prev.status;
  if (!IDENTITY_EDIT_STATUSES.has(prev.status) || !IDENTITY_EDIT_STATUSES.has(target)) {
    return refuse(409, "IDENTITY_LOCKED",
      "The customer, PO number and PO date can be changed only while the order is DRAFT or PENDING_REVIEW. This order is "
      + (IDENTITY_EDIT_STATUSES.has(prev.status) ? "moving to " + target : prev.status) + ".");
  }

  const patch = {};
  const changes = {};
  const unlinked = [];

  if ("customer_id" in body) {
    const next = body.customer_id == null ? "" : String(body.customer_id).trim();
    if (!next) return refuse(400, "CUSTOMER_REQUIRED", "An order needs a customer. Pick one to change it.");
    if (next !== String(prev.customer_id || "")) {
      // Tenant-scoped: an id from another tenant reads as not found.
      const c = await svc.from("customers").select("id, customer_name, country")
        .eq("tenant_id", ctx.tenantId).eq("id", next).maybeSingle();
      if (c.error) throw new Error("customers read: " + c.error.message);
      if (!c.data) return refuse(404, "CUSTOMER_NOT_FOUND", "No such customer.");
      patch.customer_id = c.data.id;
      changes.customer_id = { from: prev.customer_id || null, to: c.data.id };
      patch._country = c.data.country || null;
    }
  }

  if ("po_number" in body) {
    const raw = body.po_number;
    if (raw != null && typeof raw !== "string" && typeof raw !== "number") {
      return refuse(400, "INVALID_PO_NUMBER", "The PO number must be text.");
    }
    const next = raw == null ? null : (String(raw).trim() || null);
    if (next && next.length > PO_NUMBER_MAX) return refuse(400, "INVALID_PO_NUMBER", "The PO number is longer than " + PO_NUMBER_MAX + " characters.");
    if (next !== (prev.po_number || null)) {
      patch.po_number = next;
      changes.po_number = { from: prev.po_number || null, to: next };
    }
  }

  if ("po_date" in body) {
    const raw = body.po_date == null ? "" : String(body.po_date).trim();
    let next = null;
    if (raw) {
      next = validDay(parsePoDate(raw, { country: patch._country || null }));
      if (!next) return refuse(400, "INVALID_PO_DATE", "Could not read the PO date \"" + raw.slice(0, 40) + "\". Use YYYY-MM-DD.");
    }
    if (next !== isoDay(prev.po_date)) {
      patch.po_date = next;
      changes.po_date = { from: isoDay(prev.po_date), to: next };
    }
  }
  delete patch._country;

  const customerChanged = "customer_id" in changes;
  if (customerChanged) {
    const nextCustomer = patch.customer_id;
    // A quote and an opportunity are another customer's once the customer
    // moves. Unlink them rather than leave the order pointing at a quote or a
    // deal of a buyer it no longer belongs to. The reconcile links the new
    // customer's quote, when one priced the PO.
    if (prev.quote_id) {
      const q = await svc.from("quotes").select("id, customer_id")
        .eq("tenant_id", ctx.tenantId).eq("id", prev.quote_id).maybeSingle();
      if (q.error || !q.data || String(q.data.customer_id || "") !== String(nextCustomer)) {
        patch.quote_id = null;
        patch.quote_number = null;
        unlinked.push("quote");
      }
    }
    if (prev.opportunity_id) {
      const v = await verifyOpportunity(svc, ctx.tenantId, prev.opportunity_id, nextCustomer);
      if (!v.ok) {
        patch.opportunity_id = null;
        unlinked.push("opportunity");
      }
    }
    // The item map, for the new customer's own part codes.
    const baseResult = ("result" in body ? body.result : prev.result) || {};
    const lines = Array.isArray(baseResult?.salesOrder?.lineItems) ? baseResult.salesOrder.lineItems : [];
    if (lines.length) {
      const mapped = await remapLinesForCustomer(svc, ctx.tenantId, nextCustomer, lines);
      patch.result = { ...baseResult, salesOrder: { ...(baseResult.salesOrder || {}), lineItems: mapped } };
    }
    // How the customer was chosen: by a person, here.
    const pf = ("preflight_payload" in body ? body.preflight_payload : prev.preflight_payload) || {};
    patch.preflight_payload = {
      ...pf,
      customer_match: {
        customer_id: nextCustomer,
        basis: "operator",
        by: ctx.user ? ctx.user.id : null,
        at: now,
        previous_customer_id: prev.customer_id || null,
      },
    };
  }

  return { patch, changes, customerChanged, unlinked };
};
