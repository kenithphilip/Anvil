// Ingest for `dispatch_lines` — the per-line despatch mirror.
//
// One normaliser + one idempotent upsert, so every source of despatch data (a
// future Tally "delivery_note" sync entity, a CSV import, a manual entry screen)
// feeds the exact same shape. This is the writer a sync entity calls; it is the
// dispatch-side twin of _lib/comms-row.js.
//
// IDEMPOTENCY. Re-syncing the same delivery note must update, not duplicate.
// The key is `source_ref` — the ERP voucher identity PLUS the line ref, one
// value per line (see migration 193 for why it is one column, not a pair).
// supabase-js `onConflict` cannot target the PARTIAL unique index that backs it,
// so the upsert is a find-then-update/insert, matching the shipped
// service_report_template pattern.

const REAL_COLUMNS = new Set([
  "tenant_id", "order_id", "shipment_id", "schedule_line_id", "line_index",
  "part_no", "description", "dispatched_qty", "uom", "dispatch_date",
  "lr_number", "carrier", "invoice_number", "invoice_date", "source_ref",
  "source_document_id", "metadata",
]);

// Importer vocabulary -> real column.
const ALIASES = {
  qty: "dispatched_qty", quantity: "dispatched_qty", despatched_qty: "dispatched_qty",
  shipped_qty: "dispatched_qty", delivered_qty: "dispatched_qty",
  part: "part_no", item: "part_no", item_code: "part_no", part_number: "part_no",
  desc: "description",
  date: "dispatch_date", despatch_date: "dispatch_date", delivery_date: "dispatch_date",
  lr: "lr_number", lr_no: "lr_number", docket: "lr_number", consignment_no: "lr_number",
  transporter: "carrier",
  invoice: "invoice_number", invoice_no: "invoice_number", bill_no: "invoice_number",
  uom_code: "uom", unit: "uom",
  line: "line_index", line_no: "line_index",
};

const toNum = (v) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
};
const toInt = (v) => {
  const n = toNum(v);
  return n == null ? null : Math.trunc(n);
};
// Keep only the date part of anything date-ish; leave malformed input as-is so it
// surfaces rather than being silently nulled.
const toDate = (v) => {
  if (!v) return null;
  const s = String(v).trim();
  const m = s.match(/^\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : s;
};

// Build a valid dispatch_lines row from any importer's vocabulary. Pure.
//
//   * aliases are mapped onto real columns;
//   * unknown keys are moved into metadata, never dropped;
//   * dispatched_qty defaults to 0 (the column is NOT NULL);
//   * source_ref is composed from (voucher_ref|delivery_note_no) + a line ref
//     when the importer did not supply it directly, so re-sync stays idempotent.
export const normalizeDispatchLine = (input = {}, ctx = {}) => {
  const out = {};
  const extra = {};

  for (const [rawKey, value] of Object.entries(input)) {
    if (value === undefined) continue;
    const key = ALIASES[rawKey] || rawKey;
    if (key === "metadata") {
      Object.assign(extra, value && typeof value === "object" ? value : { metadata: value });
      continue;
    }
    if (REAL_COLUMNS.has(key)) {
      if (out[key] === undefined || rawKey === key) out[key] = value;
    } else {
      extra[rawKey] = value;
    }
  }

  if (ctx.tenantId && out.tenant_id === undefined) out.tenant_id = ctx.tenantId;
  if (ctx.orderId && out.order_id === undefined) out.order_id = ctx.orderId;

  out.dispatched_qty = toNum(out.dispatched_qty) ?? 0;
  if (out.line_index !== undefined) out.line_index = toInt(out.line_index);
  if (out.dispatch_date !== undefined) out.dispatch_date = toDate(out.dispatch_date);
  if (out.invoice_date !== undefined) out.invoice_date = toDate(out.invoice_date);

  // Compose the idempotency key when absent. voucher_ref / delivery_note_no
  // arrive as unknown keys, so read them from the rescued `extra`.
  if (out.source_ref == null) {
    const voucher = input.source_ref || extra.voucher_ref || extra.delivery_note_no || extra.voucher_no || null;
    if (voucher) {
      const lineRef = out.line_index != null ? out.line_index
        : (out.part_no != null ? out.part_no : null);
      out.source_ref = lineRef != null ? String(voucher) + "#" + String(lineRef) : String(voucher);
    }
  }

  if (Object.keys(extra).length) out.metadata = { ...(out.metadata || {}), ...extra };
  return out;
};

export const invalidDispatchKeys = (row) =>
  Object.keys(row || {}).filter((k) => !REAL_COLUMNS.has(k));

// Idempotent upsert. Rows WITH source_ref update-or-insert on
// (tenant_id, source_ref); rows WITHOUT (ad-hoc manual entries) always insert.
// Returns { inserted, updated, errors }.
export const upsertDispatchLines = async (svc, tenantId, rows, ctx = {}) => {
  const result = { inserted: 0, updated: 0, errors: [] };
  if (!svc || !tenantId || !Array.isArray(rows)) return result;

  for (let i = 0; i < rows.length; i += 1) {
    const row = normalizeDispatchLine(rows[i], { tenantId, orderId: ctx.orderId });
    row.tenant_id = tenantId;               // never let an importer spoof the tenant
    row.updated_at = new Date().toISOString();
    try {
      if (row.source_ref) {
        const existing = await svc.from("dispatch_lines").select("id")
          .eq("tenant_id", tenantId).eq("source_ref", row.source_ref).maybeSingle();
        if (existing?.data?.id) {
          const up = await svc.from("dispatch_lines").update(row)
            .eq("tenant_id", tenantId).eq("id", existing.data.id);
          if (up.error) throw new Error(up.error.message);
          result.updated += 1;
          continue;
        }
      }
      const ins = await svc.from("dispatch_lines").insert(row);
      if (ins.error) throw new Error(ins.error.message);
      result.inserted += 1;
    } catch (err) {
      result.errors.push({ index: i, source_ref: row.source_ref || null, message: err.message || String(err) });
    }
  }
  return result;
};
