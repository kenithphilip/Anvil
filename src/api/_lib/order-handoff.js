// The Mode B handoff: what the engineer sends the order processing team so a
// clerk can key the sales order into Tally (docs/SO_TERMS_AND_HANDOFF_SCOPE.md
// 8.2 to 8.5, docs/SO_EXECUTION_COHESION.md R-F3, decisions C-D11 and C-D12).
//
// PURE. No I/O. orders/handoff.js reads the rows and sends; this decides the
// prefill, the origin groups, the blockers and the email text, so the preview
// and the send cannot disagree.
//
// No prices in the email (decision 5). The SO PDF attachment carries them.

import { classifyOrigin, OBARA_COUNTRY as ORIGIN_COUNTRIES } from "./pending-so/part-origin.js";
import {
  poRequiredBy, committedDate, suggestedCommittedDate, lineDueDate, fmtDueDate, readDate,
} from "./order-delivery-date.js";
import { soLineQty } from "./so-line-money.js";
import { isUnresolvedBlocker } from "./blocking-findings.js";

// The shipment modes (decision 7), with the label the SO PDF prints.
export const SHIP_MODES = Object.freeze({
  ocean: "By Ocean",
  air: "By Air",
  road: "By Road",
  hand_carry_customer: "By Hand Carry (customer)",
  hand_carry_engineer: "By Hand Carry (our engineer)",
});
export const ORIGIN_GROUPS = Object.freeze(["import", "local", "unknown"]);
export const GROUP_MODES = Object.freeze({
  import: Object.freeze(["ocean", "air"]),
  local: Object.freeze(["road", "hand_carry_customer", "hand_carry_engineer"]),
  unknown: Object.freeze(Object.keys(SHIP_MODES)),
});
// An unknown group has no default: the engineer must pick.
export const DEFAULT_MODE = Object.freeze({ import: "ocean", local: "road", unknown: null });
export const GROUP_LABEL = Object.freeze({ import: "Imported", local: "Local", unknown: "Origin unknown" });

// Where a prefilled value came from, as the modal and the email say it.
export const SOURCE_LABEL = Object.freeze({
  po_header: "PO delivery date",
  po_line: "earliest PO line date",
  po_description: "a line description",
  committed: "committed by us",
  delivery_contact: "delivery contact",
  po_buyer: "PO buyer block",
  primary_contact: "customer's primary contact",
  entered: "entered by the engineer",
});

const BLOCKED_STATUSES = new Set(["CANCELLED", "DUPLICATE", "REUSED", "BLOCKED"]);
const MAX = { date: 40, name: 120, phone: 40 };

const str = (v) => (v == null ? "" : String(v).trim());
const pick = (...vals) => vals.map(str).find(Boolean) || "";
const linesOf = (order) => (Array.isArray(order?.result?.salesOrder?.lineItems) ? order.result.salesOrder.lineItems : []);

// item_master / quote source_country ("O-KOREA") -> origin and ISO country.
const BY_SOURCE_COUNTRY = new Map(Object.values(ORIGIN_COUNTRIES).map((c) => [c.source_country, c]));
const countrySignal = (signal, value) => {
  const c = BY_SOURCE_COUNTRY.get(str(value).toUpperCase());
  return c ? { signal, origin: c.iso === "IN" ? "local" : "import", country: c.iso } : null;
};

// The origin of one line (decision 6). In order of strength:
//   1. a part-string marker ("-I", "(O/x)")
//   2. the matched source PO prefix
//   3. the quote line's source_country (quote-reconcile stamps it)
//   4. the item master's source_country
// Two strong signals that disagree make the line unknown, with both shown.
// The item master is read only when nothing stronger exists, because a BOM
// origin defaults to India in places, so its O-INDIA is weak evidence.
// shortcut: signal 2 is not read, because a source PO exists only after
// procurement; upgrade when source PO lines are joined to order lines.
export const lineOrigin = (ln) => {
  const marker = classifyOrigin({ part_no: pick(ln?.part_no, ln?.partNumber, ln?.itemCode), description: pick(ln?.description, ln?.itemName) });
  const strong = [
    marker.origin !== "unknown" ? { signal: "part_marker", origin: marker.origin, country: marker.country } : null,
    countrySignal("quote_line", ln?.source_country),
  ].filter(Boolean);
  const origins = new Set(strong.map((s) => s.origin));
  if (origins.size > 1) return { group: "unknown", country: null, signals: strong, conflict: true };
  const signals = strong.length ? strong : [countrySignal("item_master", ln?._mapped_item?.source_country)].filter(Boolean);
  if (!signals.length) return { group: "unknown", country: null, signals, conflict: false };
  const countries = new Set(signals.map((s) => s.country).filter(Boolean));
  return { group: signals[0].origin, country: countries.size === 1 ? [...countries][0] : null, signals, conflict: false };
};

// The origin groups of an order, each with its line numbers (1-based), the
// modes it may take and its default mode. A group's country is set only when
// every line in it agrees.
export const originGroups = (lines) => {
  const byGroup = new Map();
  (lines || []).forEach((ln, i) => {
    const o = lineOrigin(ln);
    if (!byGroup.has(o.group)) byGroup.set(o.group, { group: o.group, countries: new Set(), line_nos: [] });
    const g = byGroup.get(o.group);
    g.countries.add(o.country);
    g.line_nos.push(i + 1);
  });
  return ORIGIN_GROUPS.filter((k) => byGroup.has(k)).map((k) => {
    const g = byGroup.get(k);
    return {
      group: k,
      country: g.countries.size === 1 ? [...g.countries][0] : null,
      line_nos: g.line_nos,
      allowed_modes: [...GROUP_MODES[k]],
      default_mode: DEFAULT_MODE[k],
    };
  });
};

// The prefill (8.3). required_by is the PO's date (decision 8); the committed
// date is shown beside it with its own source. A blank is a required field: it
// never defaults to today. contact: the first source that names a person.
//   contact  the order's delivery contact row, or null
//   primary  the customer's primary contact row, or null
export const handoffPrefill = (order, { contact = null, primary = null } = {}) => {
  const po = poRequiredBy(order);
  let requiredBy = po.source !== "none" ? { value: po.iso || po.printed, source: po.source } : null;
  if (!requiredBy) {
    const s = suggestedCommittedDate(order);
    if (s && s.source === "po_description") requiredBy = { value: s.value, source: "po_description" };
  }
  const c = committedDate(order);
  const buyer = order?.result?.salesOrder?.customer || {};
  const candidates = [
    contact && { name: pick(contact.name, contact.contact_name), phone: pick(contact.phone, contact.mobile), source: "delivery_contact" },
    { name: pick(buyer.contact_name), phone: pick(buyer.phone), source: "po_buyer" },
    primary && { name: pick(primary.name), phone: pick(primary.phone), source: "primary_contact" },
  ].filter((x) => x && x.name);
  return {
    required_by: requiredBy,
    committed: c ? { value: c.iso || c.printed, source: "committed" } : null,
    contact: candidates[0] || null,
  };
};

const inputHas = (input, k) => !!input && typeof input === "object" && Object.prototype.hasOwnProperty.call(input, k);
const capped = (v, max) => str(v).slice(0, max);

// The fields the send uses: the engineer's input over the prefill. Input is
// untrusted: only known keys are read, each trimmed and capped. A field the
// engineer changed is labelled "entered".
export const handoffFields = (prefill, groups, input = null) => {
  const modesIn = inputHas(input, "modes") && input.modes && typeof input.modes === "object" ? input.modes : {};
  const value = (key, preValue, max) => (inputHas(input, key) ? capped(input[key], max) : str(preValue));
  const requiredBy = value("required_by", prefill.required_by?.value, MAX.date);
  const name = value("contact_name", prefill.contact?.name, MAX.name);
  const phone = value("contact_phone", prefill.contact?.phone, MAX.phone);
  const sourceOf = (v, pre, preSource) => (!v ? null : v === str(pre) ? preSource : "entered");
  return {
    required_by: requiredBy,
    required_by_source: sourceOf(requiredBy, prefill.required_by?.value, prefill.required_by?.source),
    contact_name: name,
    contact_phone: phone,
    contact_source: sourceOf(name, prefill.contact?.name, prefill.contact?.source),
    modes: Object.fromEntries(groups.map((g) => [
      g.group,
      Object.prototype.hasOwnProperty.call(modesIn, g.group) ? str(modesIn[g.group]) : (g.default_mode || ""),
    ])),
  };
};

// The dispatch plan the send writes: [{ group, country, mode, line_nos }].
export const dispatchPlan = (groups, fields) => groups.map((g) => ({
  group: g.group, country: g.country, mode: fields.modes[g.group] || null, line_nos: g.line_nos,
}));

// Why the order cannot be handed off yet. Each is { code, message }.
//   undecidedCritical  current terms flags at critical with no decision
//                      (decision 3 blocks on these only)
//   recipients         resolveInternalRecipients' result
export const handoffBlockers = ({ order, groups, fields, undecidedCritical = [], recipients = null }) => {
  const out = [];
  const add = (code, message) => out.push({ code, message });
  if (BLOCKED_STATUSES.has(order?.status)) add("order_status", "The order is " + order.status + ". Such an order is not handed off.");
  if (!linesOf(order).length) add("no_lines", "The order has no lines.");
  const finding = (Array.isArray(order?.rule_findings) ? order.rule_findings : []).find(isUnresolvedBlocker);
  if (finding) add("blocking_finding", "Unresolved blocking finding (" + (finding.code || finding.rule_id) + "): " + (finding.detail || "resolve it first."));
  if (!fields.required_by) add("required_by_missing", "Enter the material required date.");
  if (!fields.contact_name) add("contact_missing", "Enter the contact name.");
  for (const g of groups) {
    const mode = fields.modes[g.group];
    if (!mode) add("mode_missing", "Choose a shipment mode for the " + GROUP_LABEL[g.group].toLowerCase() + " lines.");
    else if (!GROUP_MODES[g.group].includes(mode)) add("mode_invalid", SHIP_MODES[mode] ? SHIP_MODES[mode] + " is not a mode for " + GROUP_LABEL[g.group].toLowerCase() + " lines." : "Unknown shipment mode: " + mode + ".");
  }
  if (undecidedCritical.length) {
    add("terms_undecided", undecidedCritical.length + " critical terms flag" + (undecidedCritical.length === 1 ? " needs" : "s need") + " a decision first: "
      + undecidedCritical.map((f) => f.clause_label || f.clause).join(", ") + ".");
  }
  if (recipients && !recipients.to.length) add("no_recipient", "No To recipient resolves. An admin sets them on Admin > Order handoff.");
  return out;
};

// True when a sent handoff no longer matches the order: the order's
// payload_hash moved since the send (the same rule as order-stage.js, C-9).
// A sent handoff with no stored hash asks for a re-send too.
export const handoffChanged = (order) => order?.handoff_status === "sent"
  && (order?.handoff_payload?.payload_hash || null) !== (order?.payload_hash || null);

// The handoff state an order row shows: the workspace chip and the register
// column. A row never handed off is { status: "not_sent" }.
export const handoffState = (row, sentByName = null) => {
  if (!row?.handoff_status) return { status: "not_sent" };
  return {
    status: row.handoff_status,
    sent_at: row.handoff_sent_at || null,
    sent_by: row.handoff_sent_by || null,
    sent_by_name: sentByName,
    changed_since: handoffChanged(row),
  };
};

const DECISION_TEXT = {
  accept: "accepted",
  reject_term: "rejected, customer to be told",
  not_a_deviation: "not a deviation",
  request_amendment: "amendment requested",
};

// The terms lines of the email. terms: { mode, flags } from the terms view,
// or null. Clause names and decisions only: no wording, which can carry a
// price.
const termsLines = (terms) => {
  if (!terms || terms.mode !== "on") return ["  The terms check is not on for this tenant."];
  if (!terms.checked) return ["  The terms check has not run on this order."];
  const shown = (terms.flags || []).filter((f) => f.needs_decision || f.decision);
  const out = shown.map((f) => "  " + (f.clause_label || f.clause) + ": " + (f.decision ? DECISION_TEXT[f.decision.decision] || f.decision.decision : "undecided"));
  const open = shown.filter((f) => !f.decision).length;
  out.push("  Open flags: " + (open ? open : "none"));
  return out;
};

const fmtDate = (v) => fmtDueDate(readDate(v)) || str(v);

// The email (decision 5). Subject: "SO entry: PO <no> / <customer> / <n> lines".
//   appUrl      PUBLIC_APP_URL, or "" (the link line then names the order id)
//   replyToEngineer  true when replies go to the engineer, false when they go
//                    to the tenant's Anvil inbound address
export const handoffEmail = ({
  order, customerName, groups, fields, prefill, terms, schedules = [], attachments = [],
  engineerName = "", appUrl = "", replyToEngineer = true,
}) => {
  const lines = linesOf(order);
  const poNo = str(order?.po_number) || "(no number)";
  const customer = str(customerName) || "(no customer)";
  const groupOf = new Map();
  for (const g of groups) for (const n of g.line_nos) groupOf.set(n, g.group);
  const modeText = (group) => SHIP_MODES[fields.modes[group]] || "not chosen";
  const base = str(appUrl).replace(/\/+$/, "");
  const sourceText = (s) => (s ? "   (source: " + (SOURCE_LABEL[s] || s) + ")" : "");
  const who = str(engineerName) || "the engineer";

  const body = [
    "Order processing team,",
    "",
    "Please enter this sales order in Tally.",
    "",
    "PO:          " + poNo + (order?.po_date ? " dated " + fmtDate(order.po_date) : ""),
    "Customer:    " + customer,
    base ? "Anvil order: " + base + "/#/so?id=" + order.id : "Anvil order id: " + order.id,
    "",
    "Inputs for the ERP",
    "  Material required date: " + fmtDate(fields.required_by) + sourceText(fields.required_by_source),
    ...(prefill?.committed ? ["  Committed date:         " + fmtDate(prefill.committed.value) + sourceText("committed")] : []),
    "  Contact:                " + [fields.contact_name, fields.contact_phone].filter(Boolean).join(", ") + sourceText(fields.contact_source),
    "  Shipment mode:",
    ...groups.map((g) => "    " + GROUP_LABEL[g.group] + " lines (" + g.line_nos.length + "): " + modeText(g.group)),
    "",
    "Lines",
    ...lines.map((ln, i) => {
      const group = groupOf.get(i + 1) || "unknown";
      return "  " + (i + 1) + ". " + [
        pick(ln.part_no, ln.partNumber, ln.itemCode) || "(no part number)",
        "customer part " + (pick(ln.customer_part_number, ln.customerItemCode, ln.cust_part_no) || "none"),
        soLineQty(ln) + " " + (pick(ln.uom, ln.unit) || "No."),
        "due " + (fmtDueDate(lineDueDate(order, i, schedules)) || "not stated"),
        GROUP_LABEL[group],
        modeText(group),
      ].join(" | ");
    }),
    "",
    "Terms decisions",
    ...termsLines(terms),
    "",
    "Attached: " + (attachments.length ? attachments.map((a) => a.label).join(", ") : "nothing") + ".",
    "",
    replyToEngineer
      ? "Sent from Anvil by " + who + ". Reply to this email to reach them."
      : "Sent from Anvil by " + who + ". Reply to all: the reply reaches the order in Anvil, and " + who + " is in CC.",
  ].join("\n");

  return {
    subject: "SO entry: PO " + poNo + " / " + customer + " / " + lines.length + " line" + (lines.length === 1 ? "" : "s"),
    body,
  };
};
