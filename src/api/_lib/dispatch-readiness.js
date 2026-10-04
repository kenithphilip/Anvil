// Can this invoice's consignment legally and practically move?
//
// WHY THIS AND NOT UNDER-DELIVERY. #538 added an under-delivery leg — are we
// billing more than we shipped — and for this tenant's process it is vacuous:
// invoicing IS the despatch event, so nothing can be invoiced that has not left
// the store. What their Tally despatch register actually captures against an
// invoice is the DOCKET NUMBER and the E-WAY BILL DETAILS, and those are the
// two things that hold a consignment.
//
// Both failures are expensive and neither is clerical:
//
//   - Goods moving without a required e-way bill can be detained in transit and
//     carry a penalty. The buyer's goods receipt is never posted because the
//     goods never arrive, so the invoice is not disputed — it is stranded.
//   - Without a docket / LR number the buyer's stores cannot tie the
//     consignment to the invoice, so the GRN is keyed by hand or not at all.
//
// PURE. No I/O. The caller fetches; this decides. Same division as
// invoice-reconcile.js and quote-reconcile.js.
//
// THE THRESHOLD IS A SETTING, NOT A CONSTANT, AND NOT LEGAL ADVICE.
//
// The e-way bill requirement turns on consignment value, and the figure is
// jurisdictional: inter-state movement uses one threshold while intra-state
// thresholds are set per state and genuinely differ between them. Hard-coding
// one number would be wrong for most tenants and would read as a legal
// assertion this file is in no position to make. So both thresholds come from
// tenant settings, the defaults below are marked as defaults to CONFIRM, and
// when the inputs needed to decide are missing this module REFUSES rather than
// passing the line. A silent pass on a detainable consignment is the worst
// outcome available here.

import { gstinStateCode } from "./gstin.js";

// Defaults a tenant is expected to confirm against their own jurisdiction, not
// figures this module asserts are correct for anyone.
export const DEFAULT_EWAY_THRESHOLD_INR = 50000;
export const DEFAULT_EWAY_THRESHOLD_INTRASTATE_INR = 50000;

// Only GENERATED is a bill that exists in the eyes of the portal. DRAFT was
// never filed; PENDING_NIC has not been accepted; CANCELLED, REJECTED and
// EXPIRED are all worse than absent, because someone believes there is one.
export const USABLE_EWAY_STATUS = "GENERATED";
export const UNUSABLE_EWAY_STATUSES = Object.freeze([
  "DRAFT", "PENDING_NIC", "CANCELLED", "REJECTED", "EXPIRED",
]);

export const VERDICTS = Object.freeze([
  "eway_missing",        // value is over the threshold and no filed bill exists
  "eway_not_filed",      // a bill row exists but is not GENERATED
  "eway_vehicle_missing",// filed, moving by road, no vehicle recorded
  "docket_missing",      // nothing the buyer's stores can match the consignment on
  "ready",
  // Refusals, outside the worst-first run above: we could not decide.
  "threshold_unknown",   // no consignment value, so "is one required" has no answer
  "place_of_supply_unknown", // cannot tell intra- from inter-state, so no threshold applies
]);

const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const clean = (v) => (v === null || v === undefined ? "" : String(v).trim());

// Intra- or inter-state, from the two GSTINs. Returns null when either is
// absent or malformed — which is a refusal, not an assumption of either.
export const placeOfSupply = (sellerGstin, buyerGstin) => {
  const a = gstinStateCode(clean(sellerGstin));
  const b = gstinStateCode(clean(buyerGstin));
  if (!a || !b) return null;
  return a === b ? "intrastate" : "interstate";
};

// Is a bill required for this consignment, given where it is going?
//
// Returns { required, threshold, reason }. `required` is null — never false —
// when we could not decide, so a caller cannot mistake "we don't know" for
// "not needed".
export const ewayRequired = ({ invoiceValue, sellerGstin, buyerGstin, settings = {} }) => {
  const value = num(invoiceValue);
  if (value == null) {
    return { required: null, threshold: null, reason: "threshold_unknown" };
  }
  const pos = placeOfSupply(sellerGstin, buyerGstin);
  if (!pos) {
    return { required: null, threshold: null, reason: "place_of_supply_unknown" };
  }
  const threshold = pos === "intrastate"
    ? (num(settings.eway_threshold_intrastate_inr) ?? DEFAULT_EWAY_THRESHOLD_INTRASTATE_INR)
    : (num(settings.eway_threshold_inr) ?? DEFAULT_EWAY_THRESHOLD_INR);
  return { required: value >= threshold, threshold, reason: null, place_of_supply: pos, value };
};

// The whole answer for one invoice about to be sent.
//
// ewayBill: the linked row or null — { status, ewb_no, vehicle_no, trans_mode }.
// docket:   the consignment / LR number, from the despatch register or the bill.
export const assessDispatchReadiness = ({
  invoiceValue, sellerGstin, buyerGstin, ewayBill = null, docket = null, settings = {},
} = {}) => {
  const req = ewayRequired({ invoiceValue, sellerGstin, buyerGstin, settings });
  const status = clean(ewayBill?.status).toUpperCase();
  const hasFiled = status === USABLE_EWAY_STATUS;
  const transMode = clean(ewayBill?.trans_mode) || "Road";
  const docketNo = clean(docket) || clean(ewayBill?.lr_number) || null;

  const findings = [];

  // The e-way leg. Refusals first, because neither of them permits a verdict
  // about the bill at all.
  if (req.required === null) {
    findings.push({
      verdict: req.reason, blocking: false, decided: false,
      detail: req.reason === "threshold_unknown"
        ? "The consignment value is not known, so whether an e-way bill is required could not be determined. Check it by hand."
        : "The seller's or buyer's GSTIN is missing or malformed, so intra- versus inter-state could not be determined and no threshold applies. Check it by hand.",
    });
  } else if (req.required && !ewayBill) {
    findings.push({
      verdict: "eway_missing", blocking: true, decided: true,
      detail: `This consignment is ${req.value} against a ${req.place_of_supply} threshold of ${req.threshold}, and no e-way bill is on file. Goods moving without one can be detained in transit, so the invoice is not disputed — it is stranded.`,
    });
  } else if (req.required && !hasFiled) {
    findings.push({
      verdict: "eway_not_filed", blocking: true, decided: true,
      // Worse than absent: someone believes there is a bill.
      detail: `An e-way bill exists for this invoice but its status is ${status || "unknown"}, not ${USABLE_EWAY_STATUS}. It has not been accepted by the portal, which is worse than none at all because it reads as done.`,
    });
  } else if (hasFiled && transMode === "Road" && !clean(ewayBill?.vehicle_no)) {
    // Not blocking the INVOICE: the bill is filed and the paperwork exists.
    // It does block the vehicle, which is the operator's problem to fix now
    // rather than at the gate.
    findings.push({
      verdict: "eway_vehicle_missing", blocking: false, decided: true,
      detail: "The e-way bill is filed for road transport with no vehicle number recorded. It cannot accompany a vehicle until one is entered.",
    });
  }

  // The docket leg. Independent of the e-way bill: a consignment under the
  // threshold still needs something the buyer's stores can match it on.
  if (!docketNo) {
    findings.push({
      verdict: "docket_missing", blocking: false, decided: true,
      detail: "No docket or LR number is recorded against this invoice. The buyer's stores match the consignment to the invoice on it; without one the goods receipt is keyed by hand or held.",
    });
  }

  const blocking = findings.filter((f) => f.blocking);
  const undecided = findings.filter((f) => !f.decided);

  return {
    findings: findings.length ? findings : [{ verdict: "ready", blocking: false, decided: true, detail: null }],
    eway: {
      required: req.required,
      threshold: req.threshold,
      place_of_supply: req.place_of_supply ?? null,
      status: status || null,
      ewb_no: clean(ewayBill?.ewb_no) || null,
      filed: hasFiled,
    },
    docket: docketNo,
    // can_dispatch, NOT can_send. The invoice can always be sent; what this
    // answers is whether the goods can lawfully move behind it.
    can_dispatch: blocking.length === 0 && undecided.length === 0,
    summary: {
      blocking: blocking.length,
      undecided: undecided.length,
      // null rather than true when nothing could be decided: a check over
      // nothing is not a pass.
      decided: findings.some((f) => f.decided) ? true : null,
    },
  };
};
