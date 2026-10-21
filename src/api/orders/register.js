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
// the handoff status (a "not sent" placeholder until the handoff ships), and
// the terms check: open flags by severity, amendments requested, decided, or
// "PO terms not read" (plan PR 13).
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
//   not_handed_off=1
//                   only orders whose handoff was not sent: never tried,
//                   failed, or no mail provider
//   has_undecided_terms=1
//                   only orders with a terms flag that needs a decision and
//                   has none. 409 MIGRATION_NOT_APPLIED before migration 250.
//   include_shadow=1
//                   an admin reading a shadow-mode terms check (anyone else
//                   is refused, as GET /api/orders/terms does)
//   format=xlsx     the filtered register as a workbook (CSV if the xlsx
//                   dependency is absent), up to EXPORT_MAX rows
//
// Read-only, tenant-scoped, and gated like the orders list (read). Filters run
// in the database so the page count is true.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission, hasPermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import {
  CHANNELS, REGISTER_SELECT, FLAGS_TEXT, applyChannelFilter, registerRow, registerAoa, termsSummaryOf,
} from "../_lib/order-register.js";
import { toCsv } from "./export.js";
import { readTermsSettings } from "../_lib/terms/check.js";
import { migrationErrorBody, migrationNotApplied, termsDbError } from "../_lib/terms/errors.js";
import { historyByFlag, readDecisions } from "../_lib/terms/decisions.js";
import { needsDecision } from "../_lib/terms/compare.js";
import { SEVERITY_LEVELS } from "../_lib/terms/taxonomy.js";
import { userDisplayNames } from "../_lib/assignee.js";

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
  const hasUndecidedTerms = query.has_undecided_terms === "1" || query.has_undecided_terms === "true";
  const includeShadow = query.include_shadow === "1" || query.include_shadow === "true";
  const notHandedOff = query.not_handed_off === "1" || query.not_handed_off === "true";
  return { page, pageSize, from, to, customer, channel, status, hasFlags, hasUndecidedTerms, includeShadow, notHandedOff };
};

// The filtered, tenant-scoped query, newest first. Every caller passes the
// tenant; there is no unscoped path.
const filteredQuery = (svc, tenantId, f, { count = false, cols = REGISTER_SELECT } = {}) => {
  let q = svc.from("orders")
    .select(cols, count ? { count: "exact" } : undefined)
    .eq("tenant_id", tenantId);
  if (f.from) q = q.gte("created_at", f.from);
  if (f.to) q = q.lt("created_at", f.to);
  if (f.customer) q = q.eq("customer_id", f.customer);
  if (f.status) q = q.eq("status", f.status);
  if (f.channel) q = applyChannelFilter(q, f.channel);
  if (f.hasFlags) q = q.neq(FLAGS_TEXT, "[]");
  // shortcut: a sent handoff whose order changed since is not matched here
  // (it compares a jsonb key with a column); upgrade with a generated column
  // if the filter must find those too. The column shows them.
  if (f.notHandedOff) q = q.or("handoff_status.is.null,handoff_status.neq.sent");
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

// ── the terms check (plan PR 13) ────────────────────────────────────────────

const CHUNK = 200;
const FLAG_PAGE = 1000;

const chunks = (list, n = CHUNK) => {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
};

// Whether this caller sees the terms column. Off shows nothing; shadow shows
// it only to an admin who asks; a database without migration 250 shows
// nothing and the register still works.
const termsAccess = async (svc, ctx, includeShadow) => {
  try {
    const s = await readTermsSettings(svc, ctx.tenantId);
    return { ...s, applied: true, visible: s.mode === "on" || (s.mode === "shadow" && includeShadow) };
  } catch (err) {
    if (err && err.code === "MIGRATION_NOT_APPLIED") return { mode: null, policy: null, applied: false, visible: false };
    throw err;
  }
};

// order id -> the terms summary of its current check.
const loadTerms = async (svc, tenantId, orderIds, terms) => {
  const byOrder = new Map();
  if (!terms.visible || !orderIds.length) return byOrder;
  const latest = new Map();
  for (const part of chunks(orderIds)) {
    const q = await svc.from("order_term_checks").select("id, order_id, po_terms_status, created_at")
      .eq("tenant_id", tenantId).in("order_id", part).is("superseded_at", null);
    if (q.error) throw termsDbError("order_term_checks", q.error);
    for (const c of q.data || []) {
      const prev = latest.get(c.order_id);
      if (!prev || String(c.created_at || "") > String(prev.created_at || "")) latest.set(c.order_id, c);
    }
  }
  const checkIds = [...latest.values()].map((c) => c.id);
  const flags = [];
  for (const part of chunks(checkIds)) {
    const q = await svc.from("order_term_flags").select("id, check_id, order_id, clause, severity, outcome")
      .eq("tenant_id", tenantId).in("check_id", part);
    if (q.error) throw termsDbError("order_term_flags", q.error);
    flags.push(...(q.data || []));
  }
  const history = historyByFlag(await readDecisions(svc, tenantId, flags.map((f) => f.id)));
  const shadow = terms.mode === "shadow";
  for (const orderId of orderIds) {
    const check = latest.get(orderId) || null;
    byOrder.set(orderId, termsSummaryOf({
      check, flags: check ? flags.filter((f) => f.check_id === check.id) : [], history, policy: terms.policy, shadow,
    }));
  }
  return byOrder;
};

// The orders with at least one current flag that needs a decision and has
// none. Read in pages, so no single request asks for more rows than
// PostgREST returns.
const undecidedOrderIds = async (svc, tenantId, policy) => {
  const levels = SEVERITY_LEVELS.filter((s) => needsDecision(policy, s));
  const flags = [];
  for (let offset = 0; ; offset += FLAG_PAGE) {
    const q = await svc.from("order_term_flags").select("id, order_id")
      .eq("tenant_id", tenantId).is("superseded_at", null).in("severity", levels)
      .order("id", { ascending: true }).range(offset, offset + FLAG_PAGE - 1);
    if (q.error) throw termsDbError("order_term_flags", q.error);
    const page = q.data || [];
    flags.push(...page);
    if (page.length < FLAG_PAGE) break;
  }
  const decided = new Set((await readDecisions(svc, tenantId, flags.map((f) => f.id))).map((d) => d.flag_id));
  return [...new Set(flags.filter((f) => !decided.has(f.id)).map((f) => f.order_id))];
};

// The register filtered to those orders. The other filters still run in the
// database; the order ids are matched in chunks, so the count stays true:
// every match is found, sorted newest first, and then paged.
const undecidedHits = async (svc, tenantId, f, ids) => {
  const hits = [];
  for (const part of chunks(ids)) {
    const q = await filteredQuery(svc, tenantId, f, { cols: "id, created_at" }).in("id", part);
    if (q.error) throw new Error("orders: " + q.error.message);
    hits.push(...(q.data || []));
  }
  hits.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")) || String(b.id).localeCompare(String(a.id)));
  return hits;
};

const readRowsById = async (svc, tenantId, ids) => {
  const byId = new Map();
  for (const part of chunks(ids)) {
    const q = await svc.from("orders").select(REGISTER_SELECT).eq("tenant_id", tenantId).in("id", part);
    if (q.error) throw new Error("orders: " + q.error.message);
    for (const r of q.data || []) byId.set(r.id, r);
  }
  return ids.map((id) => byId.get(id)).filter(Boolean);
};

const buildRows = async (svc, tenantId, raw, terms) => {
  const [runs, erp, termsByOrder, senders] = await Promise.all([
    loadRuns(svc, tenantId, raw),
    loadErp(svc, tenantId, raw.map((r) => r.id)),
    loadTerms(svc, tenantId, raw.map((r) => r.id), terms),
    // Who sent each handoff: one lookup per distinct sender on the page.
    userDisplayNames(svc, raw.map((r) => r.handoff_sent_by)),
  ]);
  return raw.map((r) => registerRow(r, {
    run: r.extraction_run_id ? runs.get(r.extraction_run_id) || null : null,
    erp: erp.get(r.id) || null,
    terms: termsByOrder.get(r.id) || null,
    sentByName: senders.get(r.handoff_sent_by) || null,
  }));
};

const termsMeta = (terms) => ({ mode: terms.mode, visible: terms.visible, applied: terms.applied, shadow: terms.mode === "shadow" && terms.visible });

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
    if (f.includeShadow && !hasPermission(ctx, "admin")) {
      return json(res, 403, { error: { code: "SHADOW_ADMIN_ONLY", message: "Only an admin may read a shadow-mode terms check." } });
    }
    const svc = serviceClient();
    const terms = await termsAccess(svc, ctx, f.includeShadow);
    if (f.hasUndecidedTerms && !terms.applied) throw migrationNotApplied();
    // With the terms check off, or hidden from this caller, no order has an
    // undecided flag it may see: the filter matches nothing.
    const undecided = f.hasUndecidedTerms
      ? (terms.visible ? await undecidedOrderIds(svc, ctx.tenantId, terms.policy) : [])
      : null;

    if (req.query?.format === "xlsx") {
      let raw = [];
      if (undecided) {
        const hits = await undecidedHits(svc, ctx.tenantId, f, undecided);
        raw = await readRowsById(svc, ctx.tenantId, hits.slice(0, EXPORT_MAX).map((h) => h.id));
      } else {
        for (let offset = 0; offset < EXPORT_MAX; offset += EXPORT_CHUNK) {
          const q = await filteredQuery(svc, ctx.tenantId, f).range(offset, Math.min(offset + EXPORT_CHUNK, EXPORT_MAX) - 1);
          if (q.error) throw new Error("orders: " + q.error.message);
          const chunk = q.data || [];
          raw.push(...chunk);
          if (chunk.length < EXPORT_CHUNK) break;
        }
      }
      const rows = await buildRows(svc, ctx.tenantId, raw, terms);
      const aoa = registerAoa(rows);
      if (raw.length >= EXPORT_MAX) aoa.push(["Stopped at " + EXPORT_MAX + " rows. Narrow the filters to export the rest."]);
      await recordAudit(ctx, { action: "so_register_exported", objectType: "order", detail: "rows=" + rows.length });
      return await sendWorkbook(res, aoa, new Date().toISOString().slice(0, 10));
    }

    const offset = (f.page - 1) * f.pageSize;
    let raw;
    let total;
    if (undecided) {
      const hits = await undecidedHits(svc, ctx.tenantId, f, undecided);
      total = hits.length;
      raw = await readRowsById(svc, ctx.tenantId, hits.slice(offset, offset + f.pageSize).map((h) => h.id));
    } else {
      const q = await filteredQuery(svc, ctx.tenantId, f, { count: true }).range(offset, offset + f.pageSize - 1);
      if (q.error) throw new Error("orders: " + q.error.message);
      raw = q.data || [];
      total = typeof q.count === "number" ? q.count : null;
    }
    const rows = await buildRows(svc, ctx.tenantId, raw, terms);
    return json(res, 200, {
      rows,
      page: f.page,
      page_size: f.pageSize,
      total,
      has_more: total != null ? offset + raw.length < total : raw.length === f.pageSize,
      channels: CHANNELS,
      terms: termsMeta(terms),
    });
  } catch (err) {
    if (err && err.code === "MIGRATION_NOT_APPLIED") return json(res, 409, migrationErrorBody(err));
    sendError(res, err);
  }
}
