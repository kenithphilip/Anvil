// Quote-document ingestion: an extracted quotation -> quote_lines + the
// customer-part identity flywheel + price history.
//
// WHY. Sellers who quote in Excel/PDF outside Anvil still emit, on every
// quote, the three-way mapping the order pipeline needs — our part code, the
// customer's own reference, the description — plus price, HSN and tax rate.
// That is strictly better evidence than parsing a buyer's PO prose, because it
// is OUR document with OUR codes in labelled columns.
//
// DESIGN — REDUNDANCY, NOT A WATERFALL STAGE.
//   * Nothing in the order path waits for this. A PO extracts, maps and pushes
//     with or without any quote ingested.
//   * It writes to the SAME shared store as operator confirmations and PO
//     recon (item_customer_parts), so it is one more independent way identity
//     gets learned — not a new mandatory step in front of the old ones.
//   * Every outcome is per-line and non-fatal. An unresolvable line is
//     REPORTED, never thrown: one bad row must not reject a 40-line quote.
//   * Idempotent and order-independent. Re-ingesting the same quote updates in
//     place (quotes is unique on tenant+quote_number+version); ingesting a
//     back catalogue in any order converges to the same state.
//
// MULTI-QUOTE BY CONSTRUCTION. ingestQuotes() takes an ARRAY and reports per
// quote. Materialising into the existing quotes/quote_lines tables means
// orders/reconcile_quotes.js — which already pools EVERY non-cancelled quote
// for a customer and matches PO lines across all of them — picks these up with
// no further code, including the many-quotes-to-one-PO case.
//
// ENTITY-AGNOSTIC. No column positions, brand tokens or part formats appear
// here. The extractor resolves columns by meaning; this module works on the
// normalized result.

import { upsertCustomerPart } from "./item-customer-parts.js";

const s = (v) => (v == null ? null : String(v).trim() || null);
const n = (v) => {
  if (v == null || v === "") return null;
  const x = Number(String(v).replace(/[^\d.\-]/g, ""));
  return Number.isFinite(x) ? x : null;
};

// Normalise one extracted quote line to the quote_lines column shape. Pure.
export const toQuoteLineRow = (line, index) => ({
  line_index: index,
  part_no: s(line?.partNumber ?? line?.part_no),
  customer_part_number: s(line?.customerPartNumber ?? line?.customer_part_number ?? line?.drawingNumber),
  description: s(line?.description),
  qty: n(line?.quantity ?? line?.qty),
  uom: s(line?.uom),
  hsn_sac: s(line?.hsn ?? line?.hsn_sac),
  listed_unit_price: n(line?.unitPrice ?? line?.unit_price),
  line_amount: n(line?.amount ?? line?.line_amount),
  cgst_pct: n(line?.cgst_pct),
  sgst_pct: n(line?.sgst_pct),
  igst_pct: n(line?.igst_pct),
});

// Which lines can seed the identity flywheel: we need BOTH our code (to find
// the item) and the customer's reference (the key future POs will arrive with).
// A line with only one of the two still becomes a quote_line — it just teaches
// nothing about identity.
export const mappableLines = (rows) =>
  (Array.isArray(rows) ? rows : []).filter((r) => r.part_no && r.customer_part_number);

// Resolve our part codes to item_master ids in ONE query. Exact, case-folded
// match only: a near-miss on a part code is a different SKU (a revision suffix
// is a different part), so fuzzy matching here would silently mislabel the
// customer's reference and poison every future PO that carries it.
const resolveItems = async (svc, tenantId, partNos) => {
  const map = new Map();
  const wanted = Array.from(new Set(partNos.filter(Boolean).map((p) => p.toUpperCase())));
  if (!wanted.length) return map;
  try {
    const r = await svc.from("item_master")
      .select("id, part_no")
      .eq("tenant_id", tenantId)
      .limit(5000);
    for (const row of r.data || []) {
      const key = String(row.part_no || "").trim().toUpperCase();
      if (key && wanted.includes(key)) map.set(key, row.id);
    }
  } catch (_e) { /* resolution is best-effort; unresolved lines are reported */ }
  return map;
};

// Ingest ONE extracted quote. Returns a report; never throws.
export const ingestQuote = async (svc, ctx, input = {}) => {
  const { quote = {}, lines = [], customerId = null, sourceDocumentId = null, ingestSource = "document" } = input;
  const report = {
    quote_number: s(quote.quote_number),
    quote_id: null,
    lines_total: Array.isArray(lines) ? lines.length : 0,
    lines_written: 0,
    mappings_learned: 0,
    unresolved: [],
    skipped: [],
    error: null,
  };
  const quoteNumber = s(quote.quote_number);
  if (!quoteNumber) {
    report.error = "quote_number missing — cannot key the quote idempotently";
    return report;
  }
  if (!ctx?.tenantId) { report.error = "tenant context missing"; return report; }

  const rows = (Array.isArray(lines) ? lines : []).map(toQuoteLineRow)
    .filter((r) => r.part_no || r.description || r.customer_part_number);

  try {
    // Upsert the quote head. Keyed on (tenant, quote_number, version) so a
    // re-ingest updates rather than duplicating.
    const version = Number(quote.version) || 1;
    const existing = await svc.from("quotes")
      .select("id")
      .eq("tenant_id", ctx.tenantId).eq("quote_number", quoteNumber).eq("version", version)
      .maybeSingle();

    const head = {
      tenant_id: ctx.tenantId,
      customer_id: customerId || null,
      quote_number: quoteNumber,
      version,
      // An ingested quotation was genuinely issued to the customer, so SENT is
      // the honest status — and reconcile_quotes.js only excludes CANCELLED,
      // so it becomes eligible for PO matching immediately.
      status: "SENT",
      currency: s(quote.currency) || "INR",
      grand_total: n(quote.grand_total),
      source_document_id: sourceDocumentId,
      ingest_source: ingestSource,
      updated_at: new Date().toISOString(),
    };
    if (quote.quote_date) head.sent_at = new Date(quote.quote_date).toISOString();

    let quoteId = existing?.data?.id || null;
    if (quoteId) {
      await svc.from("quotes").update(head).eq("tenant_id", ctx.tenantId).eq("id", quoteId);
    } else {
      const ins = await svc.from("quotes").insert(head).select("id").single();
      if (ins.error) { report.error = "quote insert: " + ins.error.message; return report; }
      quoteId = ins.data.id;
    }
    report.quote_id = quoteId;

    // Replace this quote's lines wholesale: a re-ingest of a corrected PDF
    // should not leave stale rows behind.
    if (rows.length) {
      await svc.from("quote_lines").delete().eq("tenant_id", ctx.tenantId).eq("quote_id", quoteId);
      const payload = rows.map((r) => ({ ...r, tenant_id: ctx.tenantId, quote_id: quoteId }));
      const li = await svc.from("quote_lines").insert(payload);
      if (li.error) report.error = "quote_lines insert: " + li.error.message;
      else report.lines_written = payload.length;
    }

    // Seed the identity flywheel. Only for lines carrying BOTH codes, and only
    // where our code resolves EXACTLY to an item.
    if (customerId) {
      const candidates = mappableLines(rows);
      const itemMap = await resolveItems(svc, ctx.tenantId, candidates.map((r) => r.part_no));
      for (const r of candidates) {
        const itemId = itemMap.get(r.part_no.toUpperCase());
        if (!itemId) { report.unresolved.push({ part_no: r.part_no, customer_part_number: r.customer_part_number }); continue; }
        try {
          await upsertCustomerPart(svc, {
            tenantId: ctx.tenantId,
            itemId,
            customerId,
            customerPartNumber: r.customer_part_number,
            customerPartDescription: r.description,
            createdVia: "quote_doc",
            createdBy: ctx.user?.id || null,
          });
          report.mappings_learned += 1;
        } catch (e) {
          report.skipped.push({ part_no: r.part_no, reason: String(e?.message || e).slice(0, 160) });
        }
      }
    } else {
      // Without a customer we can still keep the quote + prices; identity
      // mapping is customer-scoped by definition.
      report.skipped.push({ reason: "no customer_id — quote stored, no part mappings learned" });
    }
  } catch (e) {
    report.error = String(e?.message || e).slice(0, 300);
  }
  return report;
};

// Ingest MANY quotes. Each is independent: one failure never aborts the batch,
// which is what makes a back-catalogue import practical.
export const ingestQuotes = async (svc, ctx, quotes = []) => {
  const list = Array.isArray(quotes) ? quotes : [quotes];
  const reports = [];
  for (const q of list) reports.push(await ingestQuote(svc, ctx, q));
  return {
    quotes_total: list.length,
    quotes_ok: reports.filter((r) => !r.error).length,
    mappings_learned: reports.reduce((a, r) => a + r.mappings_learned, 0),
    lines_written: reports.reduce((a, r) => a + r.lines_written, 0),
    reports,
  };
};
