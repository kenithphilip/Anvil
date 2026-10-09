// The commercial-terms clause taxonomy, and the default severity policy.
//
// docs/SO_TERMS_AND_HANDOFF_SCOPE.md section 3.1 (the clauses) and section 5.2
// (the severities). Both are DATA. The owner tunes the clause list and the
// severities (decision 1) as a tenant policy that overrides this default key
// by key (section 5.3), never by editing code paths.
//
// Pure: no I/O. Nothing here reads a document or a database.

// Severity levels, lowest first. A flag at or above the policy's
// decide_at_or_above needs a recorded decision; below it is display only.
export const SEVERITY_LEVELS = Object.freeze(["info", "warn", "high", "critical"]);

// What a comparison can conclude about one clause (section 5.2).
export const OUTCOMES = Object.freeze(["match", "deviates", "po_only", "quote_only", "unknown", "not_read"]);

// Whom a deviation hurts.
export const DIRECTIONS = Object.freeze(["against_us", "for_us", "neutral"]);

// Where a clause came from (section 3.3). A customer_master value is a
// labelled baseline, never PO wording.
export const PROVENANCES = Object.freeze([
  "po_text", "operator_entry", "customer_master", "customer_terms_pack",
  "quote_snapshot", "quote_template_live", "quote_document",
]);

// The enums inside the structured values.
export const PAYMENT_BASES = Object.freeze(["invoice", "delivery", "grn", "dispatch", "bl", "other"]);
export const PAYMENT_INSTRUMENTS = Object.freeze(["tt", "lc", "pdc", "other"]);
export const LEAD_TIME_FROM = Object.freeze(["order", "drawing_approval", "advance", "other"]);
export const PRICE_BASES = Object.freeze(["ex_works", "for_destination", "for_dispatch", "door_delivery"]);
// A freight, insurance or packing term is one of these, or a percentage,
// which is written as { pct: <number> }.
export const COST_PARTIES = Object.freeze(["buyer", "seller", "included", "extra"]);
export const GST_TREATMENTS = Object.freeze(["extra", "inclusive"]);
export const WARRANTY_FROM = Object.freeze(["dispatch", "delivery", "installation", "commissioning"]);
export const LD_PERIODS = Object.freeze(["day", "week"]);
export const ONE_SIDED_SUBTYPES = Object.freeze([
  "unlimited_liability", "consequential_damages", "indemnity", "back_to_back_payment",
  "set_off", "bank_guarantee", "retention", "ip_assignment", "audit_right", "other",
]);

// Field kinds in a value shape. An enum names its allowed values.
const num = { kind: "number" };
const str = { kind: "string" };
const bool = { kind: "boolean" };
const date = { kind: "date" };
const oneOf = (values) => ({ kind: "enum", values });
const costTerm = { kind: "cost_term", values: COST_PARTIES };

// The 13 clause keys, in the order of the table in section 3.1.
//
//   value        the structured value shape. Every field may be null: a field
//                the wording does not state is null, never guessed.
//   rule_fields  the value fields compared by code. Empty when the clause is
//                compared by an LLM judge only.
//   llm_wording  true when the wording (or part of it) goes to the LLM judge.
export const CLAUSE_TAXONOMY = Object.freeze({
  incoterm: {
    label: "Incoterm",
    value: { code: str, place: str },
    rule_fields: ["code", "place"],
    llm_wording: false,
  },
  payment_terms: {
    label: "Payment terms",
    value: { days: num, basis: oneOf(PAYMENT_BASES), advance_pct: num, instrument: oneOf(PAYMENT_INSTRUMENTS) },
    rule_fields: ["days", "basis", "advance_pct", "instrument"],
    llm_wording: false,
  },
  delivery_lead_time: {
    label: "Delivery lead time",
    value: { min_days: num, max_days: num, from: oneOf(LEAD_TIME_FROM), fixed_date: date },
    rule_fields: ["min_days", "max_days", "from", "fixed_date"],
    llm_wording: false,
  },
  price_basis: {
    label: "Price basis",
    value: { basis: oneOf(PRICE_BASES), place: str },
    rule_fields: ["basis", "place"],
    llm_wording: false,
  },
  freight_insurance: {
    label: "Freight, insurance and packing",
    value: { freight: costTerm, insurance: costTerm, packing: costTerm },
    rule_fields: ["freight", "insurance", "packing"],
    llm_wording: false,
  },
  taxes: {
    label: "Taxes",
    value: { gst: oneOf(GST_TREATMENTS), rate_pct: num },
    rule_fields: ["gst", "rate_pct"],
    llm_wording: false,
  },
  validity: {
    label: "Validity",
    value: { days: num, expires_at: date },
    rule_fields: ["days", "expires_at"],
    llm_wording: false,
  },
  warranty: {
    label: "Warranty",
    value: { months: num, from: oneOf(WARRANTY_FROM), scope: str },
    rule_fields: ["months", "from"],
    llm_wording: true,
  },
  ld_penalty: {
    label: "Liquidated damages",
    value: { rate_pct: num, per: oneOf(LD_PERIODS), cap_pct: num, excluded: bool },
    rule_fields: ["rate_pct", "per", "cap_pct", "excluded"],
    llm_wording: true,
  },
  inspection_acceptance: {
    label: "Inspection and acceptance",
    value: { stage: str, by: str, rejection_rights: str, deemed_acceptance_days: num },
    rule_fields: [],
    llm_wording: true,
  },
  cancellation: {
    label: "Cancellation",
    value: { buyer_may_cancel: bool, notice_days: num, compensation: str },
    rule_fields: [],
    llm_wording: true,
  },
  jurisdiction: {
    label: "Jurisdiction",
    value: { courts_place: str, governing_law: str, arbitration: str },
    rule_fields: [],
    llm_wording: true,
  },
  one_sided: {
    label: "One-sided clause",
    value: { subtype: oneOf(ONE_SIDED_SUBTYPES) },
    rule_fields: [],
    llm_wording: true,
  },
});

export const CLAUSE_KEYS = Object.freeze(Object.keys(CLAUSE_TAXONOMY));

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const fieldOk = (spec, v) => {
  if (v == null) return true;
  switch (spec.kind) {
    case "number": return typeof v === "number" && Number.isFinite(v);
    case "string": return typeof v === "string";
    case "boolean": return typeof v === "boolean";
    case "date": return typeof v === "string" && ISO_DAY.test(v);
    case "enum": return spec.values.includes(v);
    case "cost_term":
      if (spec.values.includes(v)) return true;
      return !!v && typeof v === "object" && Object.keys(v).length === 1
        && typeof v.pct === "number" && Number.isFinite(v.pct);
    default: return false;
  }
};

// True when `value` fits the clause's shape: an object with only the shape's
// fields, each null or of its kind. null is a valid value (wording only). An
// unknown clause key never fits. The LLM's value is only a hint (section 3.2),
// so a value that does not fit is dropped, not repaired.
export const valueFitsShape = (clause, value) => {
  const def = CLAUSE_TAXONOMY[clause];
  if (!def) return false;
  if (value == null) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  for (const k of Object.keys(value)) if (!(k in def.value)) return false;
  return Object.entries(def.value).every(([k, spec]) => fieldOk(spec, value[k]));
};

// ── The default policy (section 5.2, as section 5.3's JSON) ─────────────────
//
// Per clause, the severity for each outcome:
//   deviates_against  both sides state it, they differ, and it hurts us
//   deviates_for      they differ, and it helps us or is neutral
//   po_only           the PO imposes it and the quote is silent
//   unknown           a side has text that could not be parsed or judged
//   quote_only        the quote states it and the PO is silent
// null means the outcome does not apply to that clause.
//
// Three clauses refine one outcome, exactly as the table in section 5.2 does:
//   incoterm    deviates_against_place_only  the code agrees, the place moved
//   ld_penalty  deviates_against_uncapped    uncapped, or the quote excluded LD
//               po_only_uncapped             the PO imposes an uncapped LD
//   one_sided   po_only_by_subtype           severity by the clause's subtype
//
// not_read is one order-level row, not a clause outcome.
const sev = (deviates_against, po_only, unknown, extra = {}) => ({
  deviates_against, deviates_for: "info", po_only, unknown, quote_only: "info", ...extra,
});

const deepFreeze = (o) => {
  for (const v of Object.values(o)) if (v && typeof v === "object") deepFreeze(v);
  return Object.freeze(o);
};

export const DEFAULT_TERMS_POLICY = deepFreeze({
  version: 1,
  decide_at_or_above: "warn",
  not_read: "high",
  clauses: {
    incoterm: { enabled: true, severity: sev("high", "warn", "warn", { deviates_against_place_only: "warn" }) },
    payment_terms: { enabled: true, severity: sev("high", "warn", "warn") },
    delivery_lead_time: { enabled: true, severity: sev("high", "warn", "warn") },
    price_basis: { enabled: true, severity: sev("high", "warn", "warn") },
    freight_insurance: { enabled: true, severity: sev("warn", "warn", "warn") },
    taxes: { enabled: true, severity: sev("high", "warn", "warn") },
    validity: { enabled: true, severity: sev("warn", null, "info") },
    warranty: { enabled: true, severity: sev("high", "warn", "warn") },
    ld_penalty: {
      enabled: true,
      severity: sev("high", "high", "high", { deviates_against_uncapped: "critical", po_only_uncapped: "critical" }),
    },
    inspection_acceptance: { enabled: true, severity: sev("warn", "warn", "info") },
    cancellation: { enabled: true, severity: sev("high", "high", "warn") },
    jurisdiction: { enabled: true, severity: sev("warn", "warn", "info") },
    one_sided: {
      enabled: true,
      severity: {
        deviates_against: null,
        deviates_for: null,
        po_only: "warn",
        po_only_by_subtype: {
          unlimited_liability: "critical",
          consequential_damages: "critical",
          indemnity: "high",
          back_to_back_payment: "high",
          set_off: "high",
          bank_guarantee: "high",
          retention: "high",
          ip_assignment: "high",
          audit_right: "warn",
          other: "warn",
        },
        unknown: "warn",
        quote_only: "info",
      },
    },
  },
});
