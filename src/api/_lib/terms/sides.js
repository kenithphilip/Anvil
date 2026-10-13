// The two sides of the terms check, and the baseline, as TermClause records
// (docs/SO_TERMS_AND_HANDOFF_SCOPE.md 3.2), each with its TRUE provenance
// (3.3).
//
//   PO side     the terms pass (plan PR 11) when it ran. Until then, what
//               extraction and the operator already give: the PO's payment
//               terms and the order header's incoterm and delivery terms.
//   quote side  each baseline quote: its terms snapshot when one exists, else
//               the quote's own columns, else our live template.
//   baseline    the customer master defaults. Shown beside a flag, never
//               compared as if the PO had said them.
//
// The rule (3.3): a customer-master value is never labelled "from PO".
// Grounding copies the master's payment terms into the slot the extractor
// writes the PO's terms into, and records normalized._provenance beside it
// (#582). A value with that marker is a baseline. A value with no marker that
// equals the master default is treated as a baseline too: before #582 the
// marker did not exist, and calling a master default "PO" is the one error
// this rule exists to prevent.
//
// Pure: no I/O.

import { CLAUSE_KEYS, PROVENANCES } from "./taxonomy.js";
import { normalizeClause, normalizeValidity, parseIncoterm } from "./normalize.js";
import { normalizeWording } from "./compare.js";

const has = (v) => v != null && String(v).trim() !== "";
const day = (v) => (v ? String(v).slice(0, 10) : null);
const addDays = (iso, days) => {
  const t = Date.parse(String(iso || "").slice(0, 10) + "T00:00:00Z");
  if (!Number.isFinite(t) || days == null) return null;
  return new Date(t + Number(days) * 86_400_000).toISOString().slice(0, 10);
};

const record = (clause, side, text, extra = {}) => ({
  clause,
  side,
  value: has(text) ? normalizeClause(clause, text) : null,
  text: has(text) ? String(text) : null,
  document_id: null,
  page: null,
  span: null,
  bbox_norm: null,
  verified: false,
  confidence: null,
  ...extra,
});

// ── PO side ─────────────────────────────────────────────────────────────────

const PO_PROVENANCES = new Set(["po_text", "operator_entry"]);

// The provenance markers grounding left, from wherever this order carries
// them: the extraction run's normalized._provenance (read by the caller), or
// a copy on the order's result.
export const provenanceMarkers = (order, runProvenance) => ({
  ...(order?.result?._provenance || {}),
  ...(order?.result?.salesOrder?._provenance || {}),
  ...(runProvenance && typeof runProvenance === "object" ? runProvenance : {}),
});

// What the PO side can be until the terms pass exists: the extractor's
// payment terms and the order header. Returns { clauses, baseline }.
//   clauses   PO-side records: po_text (read off the PO by extraction, not
//             verified by the terms pass) or operator_entry (typed on the
//             Header tab).
//   baseline  a payment term that came from the customer master.
export const poClausesFromExtraction = ({ order, runProvenance = null, customer = null }) => {
  const clauses = [];
  const baseline = [];
  const so = order?.result?.salesOrder || {};
  const markers = provenanceMarkers(order, runProvenance);
  const docId = order?.source_document_id || order?.preflight_payload?.source_document_id || null;

  const payText = so.customer?.payment_terms || so.payment_terms || null;
  if (has(payText)) {
    const marked = markers["customer.payment_terms"] === "customer_master";
    const master = customer?.default_payment_terms;
    const equalsMaster = !markers["customer.payment_terms"] && has(master)
      && normalizeWording(master) === normalizeWording(payText);
    if (marked || equalsMaster) {
      baseline.push(record("payment_terms", "baseline", payText, {
        provenance: "customer_master",
        source: "orders.result.salesOrder.customer.payment_terms",
        basis: marked ? "grounding_marker" : "equals_master_default",
        customer_id: customer?.id || order?.customer_id || null,
      }));
    } else {
      clauses.push(record("payment_terms", "po", payText, {
        provenance: "po_text", method: "extraction", document_id: docId,
        source: "orders.result.salesOrder.customer.payment_terms",
      }));
    }
  }

  // The incoterm: the first source that names a rule, in the reconciler's
  // order. The Header tab value is the operator's entry, labelled so.
  const incoSources = [
    [order?.incoterm_code, "operator_entry", "orders.incoterm_code"],
    [so.incoterms, "po_text", "orders.result.salesOrder.incoterms"],
    [so.incoterm_code, "po_text", "orders.result.salesOrder.incoterm_code"],
    [order?.delivery_terms, "operator_entry", "orders.delivery_terms"],
  ];
  const inco = incoSources.find(([v]) => has(v) && parseIncoterm(v).code);
  if (inco) {
    clauses.push(record("incoterm", "po", inco[0], {
      provenance: inco[1], method: inco[1] === "operator_entry" ? "operator_entry" : "extraction",
      document_id: inco[1] === "po_text" ? docId : null, source: inco[2],
    }));
  }

  // Delivery terms typed on the header are often a schedule ("within 4
  // weeks from PO"): a lead time, when the normalizer reads one.
  if (has(order?.delivery_terms) && normalizeClause("delivery_lead_time", order.delivery_terms)) {
    clauses.push(record("delivery_lead_time", "po", order.delivery_terms, {
      provenance: "operator_entry", method: "operator_entry", source: "orders.delivery_terms",
    }));
  }
  return { clauses, baseline };
};

// The terms pass result (plan PR 11), in the shape the check stores
// (sections 4 and 9.2). Tolerant of the two spellings the design uses
// (po_terms_status or status, po_clauses or clauses). Enforced here, whatever
// the pass returns:
//   - a clause the verbatim check did not verify is dropped (3.2);
//   - a clause whose key is not in the taxonomy is dropped;
//   - a master or terms-pack value goes to the baseline, never the PO side.
const STATUSES = new Set(["read", "partial", "not_read"]);
const TEXT_SOURCES = new Set(["text_layer", "ocr_layer", "office", "email_body", "none"]);
const SEGMENTERS = new Set(["headings", "fallback"]);

export const normalizePassResult = (r) => {
  const raw = r && typeof r === "object" ? r : {};
  const statusIn = raw.po_terms_status ?? raw.status;
  const status = STATUSES.has(statusIn) ? statusIn : "not_read";
  const textSourceIn = raw.po_text_source ?? raw.text_source;
  const list = Array.isArray(raw.po_clauses) ? raw.po_clauses : Array.isArray(raw.clauses) ? raw.clauses : [];
  const clauses = [];
  const baseline = [];
  for (const c of list) {
    if (!c || typeof c !== "object" || !CLAUSE_KEYS.includes(c.clause) || c.verified === false) continue;
    const provenance = PROVENANCES.includes(c.provenance) ? c.provenance : "po_text";
    if (PO_PROVENANCES.has(provenance)) clauses.push({ ...c, side: "po", provenance });
    else if (provenance === "customer_master" || provenance === "customer_terms_pack") baseline.push({ ...c, side: "baseline", provenance });
  }
  return {
    status,
    text_source: TEXT_SOURCES.has(textSourceIn) ? textSourceIn : status === "not_read" ? "none" : null,
    clauses,
    baseline,
    segmenter: SEGMENTERS.has(raw.segmenter) ? raw.segmenter : null,
    dropped_unverified: Number.isInteger(raw.dropped_unverified) ? raw.dropped_unverified : 0,
    prompt_version: has(raw.prompt_version) ? String(raw.prompt_version) : null,
    model: has(raw.model) ? String(raw.model) : null,
    reason: has(raw.reason) ? String(raw.reason) : has(raw.not_read_reason) ? String(raw.not_read_reason) : null,
  };
};

// ── baseline ────────────────────────────────────────────────────────────────

export const customerBaseline = (customer) => {
  if (!customer) return [];
  const out = [];
  const meta = { provenance: "customer_master", customer_id: customer.id || null, basis: "customer_default" };
  if (has(customer.default_payment_terms)) {
    out.push(record("payment_terms", "baseline", customer.default_payment_terms, { ...meta, source: "customers.default_payment_terms" }));
  }
  if (has(customer.default_incoterms)) {
    out.push(record("incoterm", "baseline", customer.default_incoterms, { ...meta, source: "customers.default_incoterms" }));
  }
  return out;
};

// One baseline record per clause: the grounding-filled value first (it is
// what this order carried), then the master's defaults.
export const mergeBaseline = (...lists) => {
  const out = [];
  for (const list of lists) for (const b of list || []) if (b && !out.some((o) => o.clause === b.clause)) out.push(b);
  return out;
};

// ── quote side ──────────────────────────────────────────────────────────────

const snapshotClauses = (snap) => {
  const list = Array.isArray(snap) ? snap : Array.isArray(snap?.clauses) ? snap.clauses : [];
  return list.filter((c) => c && typeof c === "object" && CLAUSE_KEYS.includes(c.clause));
};

// Our template's typed clauses that the rule comparator reads, by column.
const TEMPLATE_CLAUSES = [
  ["payment_terms_clause", "payment_terms"],
  ["delivery_terms_clause", "delivery_lead_time"],
  ["warranty_clause", "warranty"],
  ["penalty_clause", "ld_penalty"],
  ["cancellation_clause", "cancellation"],
];

// A quote's clauses. `quote` is a quotes row; `template` the document
// template that quote renders with (our own quotes only), or null.
//
//   terms_snapshot   our quote frozen at send (plan PR 10b, quote_snapshot),
//                    or an uploaded quote's verified clauses
//                    (quote_document). It wins for every clause it holds.
//   uploaded quote   (ingest_source set) terms, incoterm, delivery_terms and
//                    validity_text as the quote extractor read them:
//                    quote_document, printed on that PDF.
//   our quote        terms and validity from the quote row, and the
//                    template's clauses, read today: quote_template_live,
//                    and not printed on the quote PDF (the renderer prints
//                    none of them; decision 12).
export const quoteClauses = (quote, { template = null } = {}) => {
  if (!quote) return [];
  const ingested = has(quote.ingest_source);
  const out = [];
  const add = (rec) => { if (rec && !out.some((o) => o.clause === rec.clause)) out.push(rec); };

  for (const c of snapshotClauses(quote.terms_snapshot)) {
    add({
      ...c,
      side: "quote",
      provenance: PROVENANCES.includes(c.provenance) ? c.provenance : ingested ? "quote_document" : "quote_snapshot",
      snapshot_at: quote.terms_snapshot_at || null,
    });
  }

  const own = ingested
    ? { provenance: "quote_document", document_id: quote.source_document_id || null, printed_on_pdf: true }
    : { provenance: "quote_template_live", printed_on_pdf: false, source_kind: "quote_record" };

  if (has(quote.terms)) add(record("payment_terms", "quote", quote.terms, { ...own, source: "quotes.terms" }));
  const inco = has(quote.incoterm) ? [quote.incoterm, "quotes.incoterm"]
    : has(quote.terms) && parseIncoterm(quote.terms).code ? [quote.terms, "quotes.terms"] : null;
  if (inco) add(record("incoterm", "quote", inco[0], { ...own, source: inco[1] }));
  if (has(quote.delivery_terms) && normalizeClause("delivery_lead_time", quote.delivery_terms)) {
    add(record("delivery_lead_time", "quote", quote.delivery_terms, { ...own, source: "quotes.delivery_terms" }));
  }

  // Validity, as a date the PO date can be read against. The quote's own
  // date is sent_at (an ingest stores the printed quote date there), else
  // the day the row was created.
  const quoteDay = day(quote.sent_at) || day(quote.created_at);
  if (ingested && has(quote.validity_text)) {
    const v = normalizeValidity(quote.validity_text, { from: quoteDay });
    if (v) add({ ...record("validity", "quote", quote.validity_text, { ...own, source: "quotes.validity_text" }), value: v });
  } else if (!ingested && (quote.expires_at || quote.validity_days != null)) {
    const days = quote.validity_days != null ? Number(quote.validity_days) : null;
    const expires = day(quote.expires_at) || addDays(quoteDay, days);
    add({
      ...record("validity", "quote", null, { ...own, source: quote.expires_at ? "quotes.expires_at" : "quotes.validity_days" }),
      value: { days, expires_at: expires },
    });
  }

  if (!ingested && template) {
    for (const [col, clause] of TEMPLATE_CLAUSES) {
      if (!has(template[col])) continue;
      add(record(clause, "quote", template[col], {
        provenance: "quote_template_live", printed_on_pdf: false, source_kind: "template",
        source: "document_templates." + col, template_id: template.id || null,
        template_updated_at: template.updated_at || null,
      }));
    }
  }
  return out;
};
