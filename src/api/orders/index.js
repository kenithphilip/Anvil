import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit, recordEvent } from "../_lib/audit.js";
import { parsePoDate } from "../_lib/parse-date.js";
import { mapLinesToItemMaster } from "../_lib/item-mapper.js";
import { resolveCustomerDefaults, applyCustomerDefaults, CUSTOMER_DEFAULT_HEADER_KEYS } from "../_lib/customer-defaults.js";

const STATUS_VALUES = new Set(["DRAFT", "PENDING_REVIEW", "APPROVED", "BLOCKED", "DUPLICATE", "REUSED", "EXPORTED_TO_TALLY", "FAILED_TALLY_IMPORT", "RECONCILED", "CANCELLED"]);

const ORDER_MODES = new Set(["SPARES", "SPARES_ASSEMBLY", "PROJECT_FOR", "PROJECT_HSS", "INTERNAL"]);

// Migration 106 header columns. Only included in the INSERT row
// when the caller actually supplies a value, so a tenant whose
// PostgREST schema cache has not yet picked up the migration
// does not get a "column not found in schema cache" error on
// every order create. When body.vendor_code is undefined the row
// omits the key entirely; PostgREST skips columns that are not
// in the payload.
const MIG_106_HEADER_KEYS = [
  "vendor_code",
  "dispatch_mode",
  "registration_serial_no",
  "incoterm_code",
  "delivery_terms",
  "delivery_point_contact_id",
  "template_id",
];

const orderRow = (ctx, body) => {
  const row = {
    tenant_id: ctx.tenantId,
    customer_id: body.customer_id || null,
    status: STATUS_VALUES.has(body.status) ? body.status : "DRAFT",
    po_number: body.po_number || null,
    // Audit fix May 2026: callers (so-intake auto-detect, ERP
     // adapters) may supply DD/MM/YYYY (IN/EU/UK), MM/DD/YYYY
     // (US/CA), or YYYY/MM/DD (JP/KR/CN). Postgres `date`
     // columns reject those; normalise via parsePoDate with the
     // customer's country as the locale hint so order create
     // never 500s on a locale-formatted value. body.country is
     // either set by the caller or filled in by the POST handler
     // from the customers row.
     po_date: parsePoDate(body.po_date, { country: body.country }),
    quote_number: body.quote_number || null,
    quote_date: parsePoDate(body.quote_date, { country: body.country }),
    doc_fingerprint: body.doc_fingerprint || null,
    result: body.result || {},
    preflight_payload: body.preflight_payload || {},
    api_usage: body.api_usage || {},
    cost_policy_snapshot: body.cost_policy_snapshot || {},
    token_estimate: body.token_estimate || {},
    rule_findings: body.rule_findings || [],
    anomaly_flags: body.anomaly_flags || [],
    evidence_by_field: body.evidence_by_field || {},
    line_edits: body.line_edits || [],
    approval: body.approval || null,
    payload_hash: body.payload_hash || null,
    blocker_summary: body.blocker_summary || null,
    format_change_summary: body.format_change_summary || null,
    cost_avoided_reason: body.cost_avoided_reason || null,
    // Corpus-derived columns (migration 006).
    order_mode: ORDER_MODES.has(body.order_mode) ? body.order_mode : null,
    parent_order_id: body.parent_order_id || null,
    contract_id: body.contract_id || null,
    customer_location_id: body.customer_location_id || null,
    forward_fx_rate: body.forward_fx_rate != null ? Number(body.forward_fx_rate) : null,
    forward_contract_ref: body.forward_contract_ref || null,
    internal_so_type: body.internal_so_type || null,
    project_phase: body.project_phase || null,
    lost_reason: body.lost_reason || null,
    competitor_name: body.competitor_name || null,
  };
  // Migration 106 columns: only include keys the caller provided.
  // Same logic as orders/[id].js PATCH (`if (key in body)`); kept
  // out of the base row so the INSERT never references a column
  // that PostgREST has not yet cached.
  for (const key of MIG_106_HEADER_KEYS) {
    if (key in body && body[key] !== undefined) {
      row[key] = body[key] || null;
    }
  }
  return row;
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const svc = serviceClient();
      const status = req.query.status;
      const limit = Math.max(1, Math.min(200, Number(req.query.limit || 100)));
      // Embed the related customer row under the `customer` key so the
      // SO list view (src/v3-app/screens/orders.tsx) can render
      // `o.customer?.customer_name` and `o.customer?.state_code` without
      // a second round-trip per row.
      //
      // Perf: `select(*)` returns the heavy per-order detail JSON
      // (preflight_payload = raw PO text + extraction, api_usage,
      // cost_policy_snapshot, token_estimate, ...) for EVERY row, which made
      // the list multi-MB and slow. `?slim=1` returns only the columns list
      // views need (incl. `result` for totals) and drops that detail JSON.
      // Default stays `*` so other list consumers are unaffected.
      const slim = req.query.slim === "1" || req.query.slim === "true";
      // NB: `orders` has no top-level `currency` column — currency lives in
      // result.salesOrder.currency (the SO list reads it from `result`, which
      // is selected below). Selecting `currency` here throws
      // "column orders.currency does not exist" -> "Failed to load orders".
      const SLIM_COLS = "id, status, order_mode, po_number, quote_number, approved_by, payload_hash, created_at, updated_at, customer_id, result, customer:customer_id(customer_name, state_code)";
      let query = svc.from("orders")
        .select(slim ? SLIM_COLS : "*, customer:customer_id(customer_name, state_code)")
        .eq("tenant_id", ctx.tenantId)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (status && STATUS_VALUES.has(status)) query = query.eq("status", status);
      if (req.query.po) query = query.ilike("po_number", "%" + req.query.po + "%");
      if (req.query.customer) query = query.eq("customer_id", req.query.customer);
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      return json(res, 200, { orders: data });
    }
    if (req.method === "POST") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      const svc = serviceClient();
      // Auto-fill order header fields from the customer master so operators
      // don't re-type per PO: incoterm (customers.default_incoterms), the
      // buyer's vendor code for us (customer_vendor_codes), the delivery
      // contact (primary customer_contacts), and the country locale hint used
      // by parsePoDate. Only fills a field the caller didn't already set, so an
      // explicit value or an OCR-detected value from the PO always wins.
      if (body.customer_id) {
        try {
          const defaults = await resolveCustomerDefaults(svc, ctx.tenantId, body.customer_id);
          const filled = applyCustomerDefaults(body, defaults);
          // Stamp provenance so the Header tab shows a "from customer" pill
          // (parallel to the OCR pill), stored on result.salesOrder like the
          // OCR sources are — no schema change.
          const hdrFilled = filled.filter((k) => CUSTOMER_DEFAULT_HEADER_KEYS.includes(k));
          if (hdrFilled.length) {
            const so = body.result?.salesOrder || {};
            const sources = { ...(so._header_field_sources || {}) };
            for (const k of hdrFilled) if (!sources[k]) sources[k] = "customer";
            body.result = { ...(body.result || {}), salesOrder: { ...so, _header_field_sources: sources } };
          }
        } catch (_) { /* customer-defaults are best-effort */ }
      }

      // Item alias auto-map (May 2026 audit fix). The buyer may
      // write their own part numbers; map each line back to the
      // tenant's canonical item_master row via
      // item_customer_parts -> item_master.part_no -> item_master.alias.
      // Backfills hsn / uom on the line when the buyer omitted
      // them; stamps `_mapped_item` so the recon table + Tally
      // emit + PDF know the canonical print_name / GST rate.
      if (body.customer_id && body.result?.salesOrder?.lineItems?.length) {
        try {
          const mapped = await mapLinesToItemMaster(
            svc, ctx.tenantId, body.customer_id,
            body.result.salesOrder.lineItems,
          );
          body.result = {
            ...body.result,
            salesOrder: { ...body.result.salesOrder, lineItems: mapped },
          };
        } catch (_) { /* item map is best-effort */ }
      }
      let { data, error } = await svc.from("orders").insert(orderRow(ctx, body)).select("*").single();
      // PostgREST schema-cache miss (PGRST204) or Postgres
      // column-not-found (42703) on a migration 106 column.
      // Retry once with those columns stripped so the SO intake
      // does not block on a stale schema cache. The vendor_code
      // auto-detect lands on the next PATCH via the Header tab.
      if (error && (
        error.code === "PGRST204"
        || error.code === "42703"
        || /Could not find the .* column .* schema cache/i.test(error.message || "")
        || /column .* does not exist/i.test(error.message || "")
      )) {
        const cleanRow = orderRow(ctx, body);
        for (const k of MIG_106_HEADER_KEYS) delete cleanRow[k];
        const retry = await svc.from("orders").insert(cleanRow).select("*").single();
        if (!retry.error) {
          data = retry.data;
          error = null;
          // eslint-disable-next-line no-console
          console.warn("[orders/POST] retried without migration 106 columns. Reload Supabase schema cache (NOTIFY pgrst, 'reload schema') to enable them.");
        }
      }
      if (error) throw new Error(error.message);
      await recordAudit(ctx, { action: "create_order", objectType: "order", objectId: data.id, after: data });
      await recordEvent(ctx, { caseId: data.id, eventType: "order_created", objectType: "order", objectId: data.id });

      // Auto-attach the customer's primary terms pack on order
      // creation (migration 106 + 108). If the customer has an
      // active customer_terms_pack flagged as default for this
      // tenant, copy its clauses into the order's audit_events so
      // the SO PDF can render them without the operator picking a
      // pack. Best-effort: a pre-migration-106 deployment falls
      // through silently. A pack-pick override on the Header tab
      // takes precedence.
      try {
        if (data.customer_id) {
          const packsRes = await svc.from("customer_terms_packs")
            .select("id, pack_name, version")
            .eq("tenant_id", ctx.tenantId)
            .eq("customer_id", data.customer_id)
            .eq("is_active", true)
            .order("version", { ascending: false })
            .limit(1);
          const pack = packsRes.data && packsRes.data[0];
          if (pack) {
            await recordEvent(ctx, {
              caseId: data.id,
              eventType: "terms_pack_attached",
              objectType: "order",
              objectId: data.id,
              detail: { pack_id: pack.id, pack_name: pack.pack_name, version: pack.version, source: "auto_on_create" },
            });
          }
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("[orders] auto-attach terms pack failed: " + (e?.message || e));
      }

      return json(res, 201, { order: data });
    }
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
