// GET /api/orders/register
//
// The sales-order register: one row per received PO, with what Anvil did
// with it. In Mode B Anvil is the repository of every sales order received
// and analysed, while the voucher lives in the ERP. The orders list shows an
// order's stage; this shows its record.
//
// Per row: received at, channel, customer, PO number and date, value, line
// count, extraction status and confidence, the reconciliation result (line
// and terms flag counts), status, the ERP sales order if one is attached, and
// the handoff status (a "not sent" placeholder until the handoff ships).
//
// Query:
//   page (1-based, default 1), page_size (default 50, max 200)
//   from, to        received-at bounds. A date (YYYY-MM-DD) is a UTC day and
//                   `to` includes that day; a timestamp is used as given and
//                   `to` is exclusive. The screen sends local-day timestamps.
//   customer        a customer id
//   channel         upload | email | whatsapp | chat | voice | quote | portal
//   status          an order status
//   has_flags=1     only orders whose reconciliation recorded a flag
//   format=xlsx     the filtered register as a workbook (CSV if the xlsx
//                   dependency is absent), up to EXPORT_MAX rows
//
// Read-only, tenant-scoped, and gated like the orders list (read). Filters run
// in the database so the page count is true.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import {
  CHANNELS, REGISTER_SELECT, FLAGS_TEXT, applyChannelFilter, registerRow, registerAoa,
} from "../_lib/order-register.js";
import { toCsv } from "./export.js";

// The order_status enum (001_init.sql).
const STATUS_VALUES = new Set([
  "DRAFT", "PENDING_REVIEW", "APPROVED", "BLOCKED", "DUPLICATE", "REUSED",
  "EXPORTED_TO_TALLY", "FAILED_TALLY_IMPORT", "RECONCILED", "CANCELLED",
]);

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
// The export reads in chunks so no single request asks PostgREST for more
// rows than its max-rows setting returns.
const EXPORT_MAX = 2000;
const EXPORT_CHUNK = 500;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// Extraction outcomes that are not a read of the document (as
// three_way_summary.js treats them): a dedupe hit is a copy of an older run.
const NOT_A_READ = new Set(["dedupe_hit"]);

const badRequest = (message) => {
  const err = new Error(message);
  err.status = 400;
  return err;
};

// A bound as an ISO timestamp, or throws 400. `end` makes a bare date
// inclusive by moving to the start of the next day.
const parseBound = (value, end, name) => {
  if (value === undefined || value === null || value === "") return null;
  const s = String(value);
  if (DATE_ONLY.test(s)) {
    const d = new Date(s + "T00:00:00.000Z");
    if (Number.isNaN(d.getTime())) throw badRequest(name + " is not a valid date");
    if (end) d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString();
  }
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw badRequest(name + " is not a valid date");
  return new Date(t).toISOString();
};

export const parseRegisterQuery = (query = {}) => {
  const page = Math.max(1, Math.floor(Number(query.page) || 1));
  const pageSize = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(Number(query.page_size) || DEFAULT_PAGE_SIZE)));
  const from = parseBound(query.from, false, "from");
  const to = parseBound(query.to, true, "to");
  const customer = query.customer ? String(query.customer) : null;
  if (customer && !UUID_RE.test(customer)) throw badRequest("customer must be a customer id");
  const channel = query.channel ? String(query.channel) : null;
  if (channel && !CHANNELS.includes(channel)) throw badRequest("channel must be one of " + CHANNELS.join(", "));
  const status = query.status ? String(query.status) : null;
  if (status && !STATUS_VALUES.has(status)) throw badRequest("status must be one of " + [...STATUS_VALUES].join(", "));
  const hasFlags = query.has_flags === "1" || query.has_flags === "true";
  return { page, pageSize, from, to, customer, channel, status, hasFlags };
};

// The filtered, tenant-scoped query, newest first. Every caller passes the
// tenant; there is no unscoped path.
const filteredQuery = (svc, tenantId, f, { count = false } = {}) => {
  let q = svc.from("orders")
    .select(REGISTER_SELECT, count ? { count: "exact" } : undefined)
    .eq("tenant_id", tenantId);
  if (f.from) q = q.gte("created_at", f.from);
  if (f.to) q = q.lt("created_at", f.to);
  if (f.customer) q = q.eq("customer_id", f.customer);
  if (f.status) q = q.eq("status", f.status);
  if (f.channel) q = applyChannelFilter(q, f.channel);
  if (f.hasFlags) q = q.neq(FLAGS_TEXT, "[]");
  return q.order("created_at", { ascending: false }).order("id", { ascending: false });
};

// The extraction runs the intake stamped on these orders, by id.
const loadRuns = async (svc, tenantId, rows) => {
  const ids = [...new Set(rows.map((r) => r.extraction_run_id).filter((id) => id && UUID_RE.test(id)))];
  const byId = new Map();
  if (!ids.length) return byId;
  const q = await svc.from("extraction_runs")
    .select("id, status, confidence_overall")
    .eq("tenant_id", tenantId).in("id", ids);
  if (q.error) throw new Error("extraction_runs: " + q.error.message);
  for (const r of q.data || []) byId.set(r.id, r);
  return byId;
};

// The ERP sales orders attached to these orders (role 'sales_order', the
// attach_sales_order link) and the voucher number each one read as.
// order_documents has no tenant_id, so it is read only for order ids that
// came from this tenant's own query.
const loadErp = async (svc, tenantId, orderIds) => {
  const byOrder = new Map();
  if (!orderIds.length) return byOrder;
  const links = await svc.from("order_documents")
    .select("order_id, document_id")
    .eq("role", "sales_order").in("order_id", orderIds);
  if (links.error) throw new Error("order_documents: " + links.error.message);
  const ordersByDoc = new Map();
  for (const l of links.data || []) {
    if (!byOrder.has(l.order_id)) byOrder.set(l.order_id, { voucher_no: null });
    if (!ordersByDoc.has(l.document_id)) ordersByDoc.set(l.document_id, []);
    ordersByDoc.get(l.document_id).push(l.order_id);
  }
  const docIds = [...ordersByDoc.keys()];
  if (!docIds.length) return byOrder;
  // Newest first: a re-issued sales order supersedes the one before it.
  const runs = await svc.from("extraction_runs")
    .select("source_id, voucher_no:normalized_extract->>voucher_no, finished_at, status_reason")
    .eq("tenant_id", tenantId).eq("extraction_kind", "sales_order")
    .in("source_id", docIds)
    .order("finished_at", { ascending: false, nullsFirst: false });
  if (runs.error) throw new Error("extraction_runs: " + runs.error.message);
  for (const r of runs.data || []) {
    if (NOT_A_READ.has(r.status_reason) || !r.voucher_no) continue;
    for (const orderId of ordersByDoc.get(r.source_id) || []) {
      const erp = byOrder.get(orderId);
      if (erp && !erp.voucher_no) erp.voucher_no = r.voucher_no;
    }
  }
  return byOrder;
};

const buildRows = async (svc, tenantId, raw) => {
  const [runs, erp] = await Promise.all([
    loadRuns(svc, tenantId, raw),
    loadErp(svc, tenantId, raw.map((r) => r.id)),
  ]);
  return raw.map((r) => registerRow(r, {
    run: r.extraction_run_id ? runs.get(r.extraction_run_id) || null : null,
    erp: erp.get(r.id) || null,
  }));
};

const sendWorkbook = async (res, aoa, stamp) => {
  let xlsxMod = null;
  try {
    const spec = "xlsx";
    const m = await import(/* @vite-ignore */ spec);
    xlsxMod = m.default || m;
  } catch { xlsxMod = null; }
  const base = "SO_register_" + stamp;
  if (!xlsxMod || !xlsxMod.utils) {
    // toCsv neutralises a leading formula character in every string cell.
    const csv = toCsv(aoa);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="' + base + '.csv"');
    res.setHeader("Content-Length", Buffer.byteLength(csv));
    res.statusCode = 200;
    return res.end(csv);
  }
  const ws = xlsxMod.utils.aoa_to_sheet(aoa);
  const wb = xlsxMod.utils.book_new();
  xlsxMod.utils.book_append_sheet(wb, ws, "SO register");
  const raw = xlsxMod.write(wb, { type: "buffer", bookType: "xlsx" });
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", 'attachment; filename="' + base + '.xlsx"');
  res.setHeader("Content-Length", buf.length);
  res.statusCode = 200;
  return res.end(buf);
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return json(res, 405, { error: { message: "Method not allowed" } });
    }
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    // Fail closed: without a tenant there is nothing this caller may see.
    if (!ctx || !ctx.tenantId) return json(res, 403, { error: { message: "No tenant in context" } });
    const f = parseRegisterQuery(req.query || {});
    const svc = serviceClient();

    if (req.query?.format === "xlsx") {
      const raw = [];
      for (let offset = 0; offset < EXPORT_MAX; offset += EXPORT_CHUNK) {
        const q = await filteredQuery(svc, ctx.tenantId, f).range(offset, Math.min(offset + EXPORT_CHUNK, EXPORT_MAX) - 1);
        if (q.error) throw new Error("orders: " + q.error.message);
        const chunk = q.data || [];
        raw.push(...chunk);
        if (chunk.length < EXPORT_CHUNK) break;
      }
      const rows = await buildRows(svc, ctx.tenantId, raw);
      const aoa = registerAoa(rows);
      if (raw.length >= EXPORT_MAX) aoa.push(["Stopped at " + EXPORT_MAX + " rows. Narrow the filters to export the rest."]);
      await recordAudit(ctx, { action: "so_register_exported", objectType: "order", detail: "rows=" + rows.length });
      return await sendWorkbook(res, aoa, new Date().toISOString().slice(0, 10));
    }

    const offset = (f.page - 1) * f.pageSize;
    const q = await filteredQuery(svc, ctx.tenantId, f, { count: true }).range(offset, offset + f.pageSize - 1);
    if (q.error) throw new Error("orders: " + q.error.message);
    const raw = q.data || [];
    const rows = await buildRows(svc, ctx.tenantId, raw);
    const total = typeof q.count === "number" ? q.count : null;
    return json(res, 200, {
      rows,
      page: f.page,
      page_size: f.pageSize,
      total,
      has_more: total != null ? offset + raw.length < total : raw.length === f.pageSize,
      channels: CHANNELS,
    });
  } catch (err) { sendError(res, err); }
}
