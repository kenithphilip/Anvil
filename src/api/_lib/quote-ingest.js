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
import { isAuthoredInAnvil } from "./quote-provenance.js";

const s = (v) => (v == null ? null : String(v).trim() || null);
const n = (v) => {
  if (v == null || v === "") return null;
  const x = Number(String(v).replace(/[^\d.\-]/g, ""));
  return Number.isFinite(x) ? x : null;
};

// Normalise one extracted quote line to the quote_lines column shape. Pure.
// Two prices, two columns — both of which migration 108 already gave us.
//
// A quotation that prints a list price AND a discounted price beside it was
// collapsing to ONE number here: whatever the extractor happened to read went
// into listed_unit_price, discounted_unit_price was never written at all, and
// the reconciler then compared the PO against a price the customer never
// agreed to. Every line came back a price_mismatch, so nothing matched.
//
// The extractor now distinguishes them (claude.js QUOTE_TOOL: unitPrice is the
// governing/discounted price, listUnitPrice the pre-discount one). Mapping:
//
//   discounted_unit_price := the price the order is placed at (always set)
//   listed_unit_price     := the pre-discount price when one was printed,
//                            otherwise the same single price, so a
//                            single-price quote is unchanged from before.
//
// discount_pct is derived rather than read: a printed discount column is rarer
// than the two price columns it would explain, and deriving keeps it
// consistent with the two numbers actually stored.
// UNITS. quote_lines stores rates as FRACTIONS, not percentages:
// discount_pct is documented in migration 108 as a "fraction (0.0 to 1.0)"
// and quote_lines_with_totals computes listed_unit_price * (1.0 -
// discount_pct); the tax columns are numeric(8,6) and migration 114 CHECKs
// that their sum is <= 1.0, naming the exact failure it guards against —
// "entering 9 instead of 0.09".
//
// The extractor speaks the other language: QUOTE_TOOL's prompt asks for "tax
// RATES as percentages", so it returns 9 for 9%. Converting at this boundary
// is the whole job of these two helpers, and getting it wrong is not a
// rounding error — a discount_pct of 1.99 makes the view compute
// 1910 * (1 - 1.99) and price the line at MINUS 1890.

// Percent -> fraction, for a value the extractor states as a percentage.
const asFraction = (v) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  // numeric(8,6) holds six decimals; 9% -> 0.09, 0.25% cess -> 0.0025.
  return Math.round((n / 100) * 1e6) / 1e6;
};

// Discount as a FRACTION of the list price, matching the column's contract.
const discountFraction = (list, net) => {
  if (list == null || net == null) return null;
  const l = Number(list);
  if (!Number.isFinite(l) || l <= 0) return null;
  const d = (l - Number(net)) / l;
  if (!Number.isFinite(d) || d <= 0) return null;
  return Math.round(d * 1e6) / 1e6;
};

export const toQuoteLineRow = (line, index) => {
  const governing = n(line?.unitPrice ?? line?.unit_price ?? line?.discounted_unit_price);
  const list = n(line?.listUnitPrice ?? line?.list_unit_price ?? line?.listed_unit_price);
  return {
    line_index: index,
    part_no: s(line?.partNumber ?? line?.part_no),
    customer_part_number: s(line?.customerPartNumber ?? line?.customer_part_number ?? line?.drawingNumber),
    description: s(line?.description),
    qty: n(line?.quantity ?? line?.qty),
    uom: s(line?.uom),
    hsn_sac: s(line?.hsn ?? line?.hsn_sac),
    // Fall back to the governing price so a single-price quote still fills the
    // "listed" column exactly as it did before this change.
    listed_unit_price: list ?? governing,
    discounted_unit_price: governing,
    discount_pct: discountFraction(list, governing),
    line_amount: n(line?.amount ?? line?.line_amount),
    // MOQ and any per-row condition ride in remark, which migration 108
    // already provides. A quantity condition that is never captured cannot be
    // checked against the PO, and this quote format states it per row.
    remark: (() => {
      const r = s(line?.remark);
      const moq = n(line?.moq);
      if (moq == null) return r;
      const tag = "MOQ=" + moq;
      if (!r) return tag;
      return new RegExp("MOQ", "i").test(r) ? r : r + " · " + tag;
    })(),
    // Percent -> fraction. Passing 9 straight through made every GST-bearing
    // quote fail migration 114's CHECK (9 + 9 = 18 > 1.0), which — before the
    // ingest reported its errors honestly — surfaced as a quote head with
    // zero lines and a cheerful "ingested: true".
    cgst_pct: asFraction(line?.cgst_pct),
    sgst_pct: asFraction(line?.sgst_pct),
    igst_pct: asFraction(line?.igst_pct),
  };
};

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
    // Set when the number resolved to a quote this tenant AUTHORED, so nothing
    // was overwritten. Not an error and not a failure — the quote is already
    // in Anvil, in better shape than any extraction of it.
    matched_authored: false,
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

  // A HOLLOW QUOTE IS NOT AN INGEST.
  //
  // Observed in production: a real quotation attached, the extractor returned
  // line objects carrying none of part_no / description / customer_part_number,
  // every one was dropped by the filter above, and this function wrote the
  // HEAD anyway — quote number, currency, grand_total — with zero lines, and
  // reported no error. attach_quote then read "no error" as success and
  // recorded `ingested: true, lines_written: 0`.
  //
  // Two harms, both silent. The operator was told the upload worked. And the
  // reconciler pools every non-cancelled quote for the customer, so the empty
  // shell joined the pool and could never match anything — which is what
  // "0/2 matched across 0 quote(s)" in the audit log actually meant.
  //
  // Refused BEFORE any write: a head with no lines is worse than no row at
  // all, because it looks like evidence the quote was captured.
  if (!rows.length) {
    report.error = "no usable lines could be read from the document — nothing was written";
    report.lines_total = Array.isArray(lines) ? lines.length : 0;
    return report;
  }

  try {
    // Upsert the quote head. Keyed on (tenant, quote_number, version) so a
    // re-ingest updates rather than duplicating.
    const version = Number(quote.version) || 1;
    const existing = await svc.from("quotes")
      .select("id, status, ingest_source")
      .eq("tenant_id", ctx.tenantId).eq("quote_number", quoteNumber).eq("version", version)
      .maybeSingle();

    // NEVER overwrite a quote that was authored in Anvil.
    //
    // The idempotency below is keyed on (tenant, quote_number, version) and
    // REPLACES the quote's lines wholesale. That is right for re-ingesting a
    // corrected third-party PDF and catastrophic for our own: attaching the
    // quote Anvil generated would delete hand-authored quote_lines, force the
    // status back to SENT over a DRAFT or an ACCEPTED, and overwrite currency
    // and grand_total with whatever a model read off the page — and report it
    // as a clean ingest.
    //
    // Migration 188 already draws this line: ingest_source null means authored
    // in Anvil. A row that was itself ingested has no hand-authored content to
    // protect, so re-ingest proceeds for it exactly as before.
    if (existing?.data && isAuthoredInAnvil(existing.data)) {
      report.quote_id = existing.data.id;
      report.matched_authored = true;
      report.skipped.push({
        reason: "quote " + quoteNumber + " was authored in Anvil — kept as-is, nothing imported from the document",
      });
      return report;
    }

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
      // `quotes` has had terms and notes since 068; the ingest path simply
      // never wrote them, so every commercial condition on an uploaded
      // quotation was read and thrown away.
      ...(quote.terms ? { terms: s(quote.terms) } : {}),
      ...(quote.notes ? { notes: s(quote.notes) } : {}),
      // The ISSUER's own revision marker and revision date (migration 215).
      // #462 taught the extractor to read both and there was nowhere to put
      // them, so they were parsed and dropped.
      ...(quote.revision ? { revision: s(quote.revision) } : {}),
      ...(quote.revised_date ? { revised_date: String(quote.revised_date).slice(0, 10) } : {}),
      source_document_id: sourceDocumentId,
      ingest_source: ingestSource,
      updated_at: new Date().toISOString(),
    };
    if (quote.quote_date) head.sent_at = new Date(quote.quote_date).toISOString();

    // Migrations here are applied BY HAND, so a column present in the repo is
    // not present in every database — and PostgREST rejects the WHOLE write
    // over one unknown name. Without this, a tenant behind on 215 (or 188)
    // would have every quote ingest fail outright rather than lose one
    // optional field. Strip the newest columns and retry once.
    const OPTIONAL_COLS = ["revision", "revised_date", "notes", "terms"];
    const unknownColumn = (e) =>
      !!e && (e.code === "42703" || OPTIONAL_COLS.some((c) => new RegExp("\\b" + c + "\\b").test(e.message || "")));
    const withoutOptional = (h) => {
      const copy = { ...h };
      for (const c of OPTIONAL_COLS) delete copy[c];
      return copy;
    };

    let quoteId = existing?.data?.id || null;
    if (quoteId) {
      let upd = await svc.from("quotes").update(head).eq("tenant_id", ctx.tenantId).eq("id", quoteId);
      if (unknownColumn(upd.error)) {
        upd = await svc.from("quotes").update(withoutOptional(head)).eq("tenant_id", ctx.tenantId).eq("id", quoteId);
      }
      if (upd.error) { report.error = "quote update: " + upd.error.message; return report; }
    } else {
      let ins = await svc.from("quotes").insert(head).select("id").single();
      if (unknownColumn(ins.error)) {
        ins = await svc.from("quotes").insert(withoutOptional(head)).select("id").single();
      }
      if (ins.error) { report.error = "quote insert: " + ins.error.message; return report; }
      quoteId = ins.data.id;
    }
    report.quote_id = quoteId;

    // Replace this quote's lines wholesale: a re-ingest of a corrected PDF
    // should not leave stale rows behind.
    await svc.from("quote_lines").delete().eq("tenant_id", ctx.tenantId).eq("quote_id", quoteId);
    const payload = rows.map((r) => ({ ...r, tenant_id: ctx.tenantId, quote_id: quoteId }));
    const li = await svc.from("quote_lines").insert(payload);
    if (li.error) {
      // The delete above already ran, so the quote now has NO lines. Say so
      // and stop — carrying on to the identity flywheel would teach part
      // mappings from a quote whose lines were just destroyed.
      report.error = "quote_lines insert: " + li.error.message;
      return report;
    }
    report.lines_written = payload.length;

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
    quotes_matched_authored: reports.filter((r) => r.matched_authored).length,
    mappings_learned: reports.reduce((a, r) => a + r.mappings_learned, 0),
    lines_written: reports.reduce((a, r) => a + r.lines_written, 0),
    reports,
  };
};
