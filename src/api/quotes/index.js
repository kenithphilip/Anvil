// /api/quotes
//
// Quote object CRUD. Audit P6.2.
//
//   GET                                     list quotes (filter by status,
//                                           customer_id, expires_before)
//   GET ?id=...                             single quote with prior versions
//   POST                                    create new quote (DRAFT)
//   PATCH ?id=...                           update fields (DRAFT only,
//                                           except for status transitions
//                                           validated by the lifecycle map)
//   POST ?action=revise&id=...              clone a SENT/DECLINED quote
//                                           into a new DRAFT version
//   DELETE ?id=...                          soft cancel (status=CANCELLED)
//
// Lifecycle transitions are validated server-side. UI passes
// `status` directly; allowed_transitions guards against skipping
// a step.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission, hasPermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { belowFloorLines } from "../_lib/quote-margin.js";

const VALID_STATUSES = new Set([
  "DRAFT", "PENDING_INTERNAL_APPROVAL", "SENT", "ACCEPTED",
  "DECLINED", "EXPIRED", "CONVERTED", "CANCELLED",
]);

// Allowed status transitions. Any -> CANCELLED is always allowed
// (operator abort). same-state transitions are no-ops.
const ALLOWED_TRANSITIONS = {
  DRAFT:                     new Set(["DRAFT", "PENDING_INTERNAL_APPROVAL", "SENT", "CANCELLED"]),
  PENDING_INTERNAL_APPROVAL: new Set(["PENDING_INTERNAL_APPROVAL", "SENT", "DRAFT", "CANCELLED"]),
  SENT:                      new Set(["SENT", "ACCEPTED", "DECLINED", "EXPIRED", "CANCELLED"]),
  ACCEPTED:                  new Set(["ACCEPTED", "CONVERTED", "CANCELLED"]),
  DECLINED:                  new Set(["DECLINED", "CANCELLED"]),
  EXPIRED:                   new Set(["EXPIRED", "CANCELLED"]),
  CONVERTED:                 new Set(["CONVERTED"]),
  CANCELLED:                 new Set(["CANCELLED"]),
};

const isTransitionAllowed = (from, to) => {
  if (!from || !to) return true;
  if (from === to) return true;
  const allowed = ALLOWED_TRANSITIONS[from];
  return !!(allowed && allowed.has(to));
};

const computeTotals = (lineItems) => {
  const items = Array.isArray(lineItems) ? lineItems : [];
  let subtotal = 0;
  let taxTotal = 0;
  for (const li of items) {
    const qty = Number(li.quantity || li.qty || 0);
    const rate = Number(li.unitPrice || li.rate || 0);
    const lineSubtotal = qty * rate;
    subtotal += lineSubtotal;
    const gstRate = Number(li.gstRate || li.gst_rate || 0);
    if (gstRate > 0 && Number.isFinite(gstRate)) {
      taxTotal += lineSubtotal * gstRate / 100;
    }
  }
  const grandTotal = subtotal + taxTotal;
  return {
    subtotal: Math.round(subtotal * 100) / 100,
    tax_total: Math.round(taxTotal * 100) / 100,
    grand_total: Math.round(grandTotal * 100) / 100,
  };
};

const generateQuoteNumber = async (svc, tenantId) => {
  // Per-tenant counter via a simple count-of-quotes-this-month
  // approach. An RPC-backed sequence is cleaner but this works
  // until volumes warrant it.
  const stamp = new Date().toISOString().slice(0, 7).replace("-", ""); // YYYYMM
  const r = await svc.from("quotes").select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .like("quote_number", "Q-" + stamp + "-%");
  const next = String((r.count || 0) + 1).padStart(4, "0");
  return "Q-" + stamp + "-" + next;
};

const buildLifecycleTimestamps = (status, current) => {
  const out = {};
  const now = new Date().toISOString();
  if (status === "SENT" && !current.sent_at) out.sent_at = now;
  if (status === "ACCEPTED" && !current.accepted_at) out.accepted_at = now;
  if (status === "DECLINED" && !current.declined_at) out.declined_at = now;
  if (status === "CONVERTED" && !current.converted_at) out.converted_at = now;
  if (status === "CANCELLED" && !current.cancelled_at) out.cancelled_at = now;
  return out;
};

const buildExpiry = (validityDays) => {
  const d = Number(validityDays || 30);
  if (!Number.isFinite(d) || d <= 0) return null;
  return new Date(Date.now() + d * 86400 * 1000).toISOString();
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();
    const id = req.query?.id || null;
    const action = req.query?.action || null;

    if (req.method === "GET" && id) {
      requirePermission(ctx, "read");
      const r = await svc.from("quotes").select("*")
        .eq("tenant_id", ctx.tenantId).eq("id", id).maybeSingle();
      if (r.error) throw new Error(r.error.message);
      if (!r.data) return json(res, 404, { error: { message: "Quote not found" } });
      // Pull prior versions in the same chain.
      const versions = await svc.from("quotes").select("id, version, status, created_at, sent_at, accepted_at")
        .eq("tenant_id", ctx.tenantId)
        .eq("quote_number", r.data.quote_number)
        .order("version", { ascending: false });
      return json(res, 200, { quote: r.data, versions: versions.data || [] });
    }

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const status = req.query?.status;
      const customerId = req.query?.customer_id;
      const expiresBefore = req.query?.expires_before;
      let q = svc.from("quotes").select("*").eq("tenant_id", ctx.tenantId);
      if (status && VALID_STATUSES.has(status)) q = q.eq("status", status);
      if (customerId) q = q.eq("customer_id", customerId);
      if (expiresBefore) q = q.lte("expires_at", expiresBefore);
      q = q.order("created_at", { ascending: false }).limit(500);
      const r = await q;
      if (r.error) throw new Error(r.error.message);
      const rows = r.data || [];
      // Attach customer_name so the quotes list can display the
      // customer instead of "—". Two-query map (rather than a
      // PostgREST embed) so we don't depend on the relationship being
      // in the schema cache. Best-effort: if the lookup fails the
      // list still renders.
      const custIds = [...new Set(rows.map((x) => x.customer_id).filter(Boolean))];
      if (custIds.length) {
        const cust = await svc.from("customers")
          .select("id, customer_name")
          .eq("tenant_id", ctx.tenantId)
          .in("id", custIds);
        if (!cust.error && Array.isArray(cust.data)) {
          const nameById = new Map(cust.data.map((c) => [c.id, c.customer_name]));
          for (const x of rows) {
            if (x.customer_id && nameById.has(x.customer_id)) {
              x.customer = { customer_name: nameById.get(x.customer_id) };
            }
          }
        }
      }
      return json(res, 200, { quotes: rows });
    }

    if (req.method === "POST" && action === "revise" && id) {
      requirePermission(ctx, "write");
      const src = await svc.from("quotes").select("*")
        .eq("tenant_id", ctx.tenantId).eq("id", id).maybeSingle();
      if (src.error) throw new Error(src.error.message);
      if (!src.data) return json(res, 404, { error: { message: "Source quote not found" } });
      // The source must be at a stable lifecycle point. DRAFT
      // edits in place; SENT / DECLINED produce a new version.
      if (!["SENT", "DECLINED", "EXPIRED"].includes(src.data.status)) {
        return json(res, 409, { error: { message: "Cannot revise a quote in status " + src.data.status } });
      }
      const next = {
        tenant_id: ctx.tenantId,
        customer_id: src.data.customer_id,
        customer_contact_id: src.data.customer_contact_id,
        opportunity_id: src.data.opportunity_id,
        quote_number: src.data.quote_number,
        version: (src.data.version || 1) + 1,
        prior_version_id: src.data.id,
        status: "DRAFT",
        currency: src.data.currency,
        validity_days: src.data.validity_days,
        terms: src.data.terms,
        notes: src.data.notes,
        line_items: src.data.line_items,
        created_by: ctx.user?.id || null,
      };
      const ins = await svc.from("quotes").insert(next).select("*").single();
      if (ins.error) throw new Error(ins.error.message);
      await recordAudit(ctx, {
        action: "quote_revise",
        objectType: "quote",
        objectId: ins.data.id,
        detail: src.data.quote_number + " v" + ins.data.version + " from " + src.data.id,
      });
      return json(res, 200, { quote: ins.data });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      if (!body?.customer_id) return json(res, 400, { error: { message: "customer_id required" } });

      // Fall back currency + validity_days from the customer's defaults
      // when the caller omitted them. Track which fields were filled
      // automatically and from where, so the audit trail is explicit
      // (operator-set values still win; only nulls/missing get filled).
      const autoFilled = {};
      let customer = null;
      if (body.currency == null || body.currency === "" || body.validity_days == null) {
        const c = await svc.from("customers")
          .select("currency, default_quote_validity_days")
          .eq("tenant_id", ctx.tenantId)
          .eq("id", body.customer_id)
          .maybeSingle();
        if (!c.error) customer = c.data;
      }
      let currency = body.currency;
      if (!currency && customer && customer.currency) {
        currency = customer.currency;
        autoFilled.currency = "customer.currency";
      }
      if (!currency) currency = "INR";
      let validityDays;
      if (body.validity_days != null) {
        validityDays = Number(body.validity_days);
      } else if (customer && customer.default_quote_validity_days != null) {
        validityDays = Number(customer.default_quote_validity_days);
        autoFilled.validity_days = "customer.default_quote_validity_days";
      } else {
        validityDays = 30;
      }

      // your_ref carries the buyer's PO/RFQ reference. When the quote is
      // created from a linked opportunity, walk opportunity -> lead and
      // adopt the lead's reference (the original buyer inquiry id).
      // Best-effort: a missing or unfetchable hop simply leaves your_ref
      // null for the operator to fill manually in the drawer.
      let yourRef = body.your_ref || null;
      if (!yourRef && body.opportunity_id) {
        try {
          const opp = await svc.from("opportunities")
            .select("related_lead_id")
            .eq("tenant_id", ctx.tenantId)
            .eq("id", body.opportunity_id)
            .maybeSingle();
          const leadId = opp && opp.data && opp.data.related_lead_id;
          if (leadId) {
            const lead = await svc.from("leads")
              .select("reference")
              .eq("tenant_id", ctx.tenantId)
              .eq("id", leadId)
              .maybeSingle();
            if (lead && lead.data && lead.data.reference) {
              yourRef = lead.data.reference;
              autoFilled.your_ref = "opportunity.lead.reference";
            }
          }
        } catch { /* best-effort: leave your_ref null */ }
      }

      const lineItems = Array.isArray(body.line_items) ? body.line_items : [];
      const totals = computeTotals(lineItems);
      const quoteNumber = body.quote_number || await generateQuoteNumber(svc, ctx.tenantId);
      const insertPayload = {
        tenant_id: ctx.tenantId,
        customer_id: body.customer_id,
        customer_contact_id: body.customer_contact_id || null,
        opportunity_id: body.opportunity_id || null,
        quote_number: quoteNumber,
        version: 1,
        status: "DRAFT",
        currency,
        ...totals,
        validity_days: validityDays,
        expires_at: null,                             // set on SEND, not on draft create
        terms: body.terms || null,
        notes: body.notes || null,
        your_ref: yourRef,
        line_items: lineItems,
        // Field provenance (migration 138): record auto-fill sources so
        // the drawer can show "from customer" / "from opportunity" pills
        // and the trail is queryable without parsing audit_events.
        field_sources: autoFilled,
        created_by: ctx.user?.id || null,
      };
      let ins = await svc.from("quotes").insert(insertPayload).select("*").single();
      // Pre-138 deployments lack field_sources; strip and retry once.
      if (ins.error && (ins.error.code === "42703" || /field_sources/i.test(ins.error.message))) {
        delete insertPayload.field_sources;
        ins = await svc.from("quotes").insert(insertPayload).select("*").single();
      }
      if (ins.error) throw new Error(ins.error.message);
      await recordAudit(ctx, {
        action: "quote_create",
        objectType: "quote",
        objectId: ins.data.id,
        detail: quoteNumber + " :: " + (totals.grand_total || 0) + " " + currency,
      });
      if (Object.keys(autoFilled).length) {
        await recordAudit(ctx, {
          action: "quote_auto_populate",
          objectType: "quote",
          objectId: ins.data.id,
          after: { auto_filled: autoFilled },
        });
      }
      return json(res, 201, { quote: ins.data });
    }

    if (req.method === "PATCH" && id) {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      const cur = await svc.from("quotes").select("*").eq("tenant_id", ctx.tenantId).eq("id", id).maybeSingle();
      if (cur.error) throw new Error(cur.error.message);
      if (!cur.data) return json(res, 404, { error: { message: "Quote not found" } });

      // Status transition validation.
      if (body.status && !VALID_STATUSES.has(body.status)) {
        return json(res, 400, { error: { message: "invalid status" } });
      }
      if (body.status && body.status !== cur.data.status && !isTransitionAllowed(cur.data.status, body.status)) {
        return json(res, 409, {
          error: {
            code: "INVALID_QUOTE_TRANSITION",
            message: "Cannot move quote from " + cur.data.status + " to " + body.status,
            from: cur.data.status,
            to: body.status,
          },
        });
      }
      // Field edits are only allowed on DRAFT. Status transitions are
      // independent. The 106-era header fields (your_ref,
      // attention_contact, template_id, fx_snapshot, conversion_factor)
      // were silently dropped pre-138 because they were missing from
      // this list; restore them so the drawer's Save header actually
      // persists what it sends.
      const editFields = [
        "terms", "notes", "line_items", "validity_days", "currency", "customer_contact_id",
        "your_ref", "attention_contact", "template_id", "fx_snapshot", "conversion_factor",
      ];
      const editing = editFields.some((k) => k in body);
      if (editing && cur.data.status !== "DRAFT") {
        return json(res, 409, { error: { message: "Field edits are only allowed on DRAFT quotes; use revise to clone." } });
      }

      // Margin-floor guard: a quote with any line below its profile's
      // floor cannot transition to SENT unless the actor can approve.
      // The floor is read from the authoritative price composition.
      let floorOverride = false;
      if (body.status === "SENT" && cur.data.status !== "SENT") {
        const below = await belowFloorLines(svc, ctx.tenantId, id);
        if (below.length) {
          if (!hasPermission(ctx, "approve")) {
            return json(res, 409, {
              error: {
                code: "MARGIN_FLOOR_BLOCK",
                message: below.length + " line(s) below the margin floor; needs sales_manager / finance / admin approval.",
                below,
              },
            });
          }
          floorOverride = true; // approver is overriding; recorded in the audit below
        }
      }

      const patch = { updated_at: new Date().toISOString() };
      // Track which editFields the operator actually changed (vs. just
      // re-sending the same value). Stamp each change as
      // operator_override in field_sources so the trail explains
      // why a quote diverged from its auto-filled defaults.
      const overrideSources = {};
      for (const k of editFields) {
        if (k in body) {
          patch[k] = body[k];
          if (body[k] !== cur.data[k]) overrideSources[k] = "operator_override";
        }
      }
      if ("line_items" in patch) Object.assign(patch, computeTotals(patch.line_items));
      if (body.status && body.status !== cur.data.status) {
        patch.status = body.status;
        Object.assign(patch, buildLifecycleTimestamps(body.status, cur.data));
        // Compute expires_at on SENT if not already set.
        if (body.status === "SENT" && !cur.data.expires_at) {
          patch.expires_at = buildExpiry(cur.data.validity_days);
        }
      }
      if (body.declined_reason && cur.data.status === "DECLINED") patch.declined_reason = body.declined_reason;
      if (Object.keys(overrideSources).length) {
        patch.field_sources = { ...(cur.data.field_sources || {}), ...overrideSources };
      }

      let upd = await svc.from("quotes").update(patch).eq("tenant_id", ctx.tenantId).eq("id", id).select("*").single();
      // Pre-138 deployments lack field_sources; strip and retry once.
      if (upd.error && (upd.error.code === "42703" || /field_sources/i.test(upd.error.message))) {
        delete patch.field_sources;
        upd = await svc.from("quotes").update(patch).eq("tenant_id", ctx.tenantId).eq("id", id).select("*").single();
      }
      if (upd.error) throw new Error(upd.error.message);
      await recordAudit(ctx, {
        action: body.status && body.status !== cur.data.status
          ? "quote_status_" + body.status.toLowerCase()
          : "quote_update",
        objectType: "quote",
        objectId: id,
        before: { status: cur.data.status },
        after: { status: upd.data.status, margin_floor_override: floorOverride || undefined },
      });
      if (floorOverride) {
        await recordAudit(ctx, { action: "quote_margin_override", objectType: "quote", objectId: id, detail: "approver sent a quote with line(s) below the margin floor" });
      }
      return json(res, 200, { quote: upd.data });
    }

    if (req.method === "DELETE" && id) {
      // Soft cancel rather than hard delete; the quote_number +
      // version uniqueness means hard-deleting and re-inserting at
      // the same number+version would also need careful audit.
      requirePermission(ctx, "approve");
      const cur = await svc.from("quotes").select("status").eq("tenant_id", ctx.tenantId).eq("id", id).maybeSingle();
      if (!cur.data) return json(res, 404, { error: { message: "Quote not found" } });
      if (cur.data.status === "CONVERTED") {
        return json(res, 409, { error: { message: "Cannot cancel a quote that has been converted to an order." } });
      }
      const upd = await svc.from("quotes").update({
        status: "CANCELLED",
        cancelled_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("tenant_id", ctx.tenantId).eq("id", id).select("*").single();
      if (upd.error) throw new Error(upd.error.message);
      await recordAudit(ctx, { action: "quote_cancel", objectType: "quote", objectId: id });
      return json(res, 200, { quote: upd.data });
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) { sendError(res, err); }
}
