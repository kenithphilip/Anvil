// The PO's delivery date and the buyer's contact person, worded ONCE and
// imported by claude.js and gemini.js (plan PR 17, docs/SO_TERMS_AND_HANDOFF_SCOPE.md
// section 4.6).
//
// WHY ONE MODULE
//
// The order-processing handoff (plan PR 16) needs the date the customer wants
// the material and the person at the buyer to call about it. Neither main PO
// adapter read them. claude.js tells the model that a "Delivery date :..." line
// in a description cell is boilerplate (the partNumber rule (b)), gemini.js has
// no slot for a date at all, and only llamaparse.js fills lines[].delivery_date.
// That is the fifth claude/gemini drift. The multi-row block (#106), the
// unsupported-kind guard (#485) and the requisition rule (#550) each drifted
// because each adapter worded them for itself, so both prompts and both schemas
// take the rule, the slots and the gate from here.
//
// BEHIND THE CANARY
//
// The rule and the three slots reach the model only on po_extractor@v4, a
// canary row in prompt-versions.js that names PO_DELIVERY_CONTACT_FEATURE, and
// only for a tenant that switched docai_prompt_variants on (default off). With
// the switch off, both adapters send exactly the prompt and schema they sent
// before this module existed.
//
// THE NORMALIZER
//
// normalizeDeliveryContact runs on every PO result of both adapters, and
// po-header-text.js uses the same helpers for the LlamaParse header:
//   delivery_date  ISO when it parses, read day-first as Indian POs print it;
//                  otherwise kept as printed (the line-schema.js contract for
//                  lines[].delivery_date, which llamaparse.js already follows)
//   phone          kept as printed (whitespace tidied), plus phone_digits
//   contact_name   whitespace tidied; null when it holds no name
//
// PURE. No I/O, never throws on odd input.

import { parsePoDate } from "../parse-date.js";

// The name a prompt-versions.js row uses to ask for this treatment.
export const PO_DELIVERY_CONTACT_FEATURE = "po_delivery_contact";

export const PO_DELIVERY_CONTACT_RULE = [
  "DELIVERY DATE AND THE BUYER'S CONTACT PERSON (these refine the rules above; where they differ, follow these)",
  "  - customer.delivery_date: the delivery (required-by) date the PO prints ONCE for the whole order, in",
  "    the header, the PO details or the delivery terms ('Delivery Date', 'Delivery by', 'Required by',",
  "    'Need by'). Copy the date as printed (e.g. '15/11/2026', '15-Nov-2026'); do not reformat it. Null",
  "    when the PO prints no date for the whole order, or only a period ('4 weeks', 'ASAP', 'Immediate').",
  "  - lines[].delivery_date: the delivery date printed for THAT line: a 'Delivery Date' / 'Due Date' /",
  "    'Schedule' cell, the delivery row of a multi-row item block, or a 'Delivery date : ...' line inside",
  "    the Description cell. That line is NOT boilerplate for this slot: copy its date here, as printed,",
  "    and still keep raw_description verbatim. Null when the line prints none; never copy",
  "    customer.delivery_date onto a line.",
  "  - customer.contact_name: the name of the person at the BUYER to contact about this order, printed by",
  "    a 'Contact Person' / 'Contact Name' / 'Buyer Name' / 'Purchase Officer' label in the buyer's block",
  "    or the PO details (e.g. 'Mr. A. Rao'). The name only: no phone, email or designation. NEVER a",
  "    person printed in the supplier / 'To' / vendor block or after 'Kind Attn': that person is the",
  "    supplier's, i.e. ours. Null when the PO names no buyer contact; 'Authorised Signatory' is not a name.",
  "  - customer.phone: when a phone ('Tel', 'Ph', 'Mob', 'Contact No') is printed beside that contact",
  "    person, return that number, as printed; otherwise the buyer's printed phone, as before.",
].join("\n");

export const CONTACT_NAME_DESCRIPTION =
  "Name of the BUYER's contact person for this order ('Contact Person' / 'Contact Name'), the name only. "
  + "Never a person in the supplier / vendor block. Null when the PO names none.";
export const HEADER_DELIVERY_DATE_DESCRIPTION =
  "Delivery / required-by date printed ONCE for the whole order, as printed. "
  + "Null when the PO prints none, or only a period such as '4 weeks'.";
export const LINE_DELIVERY_DATE_DESCRIPTION =
  "Delivery date printed for THIS line (a delivery cell, or a 'Delivery date : ...' line in the description), "
  + "as printed. Null when the line prints none; never copied from customer.delivery_date.";

// The three slots, one definition for both schemas. Nullable strings, like
// requisition_no: a structured-output model fills a declared slot or leaves it
// null, and never emits one the schema does not declare.
export const PO_DELIVERY_CONTACT_SLOTS = Object.freeze({
  customer: Object.freeze({
    contact_name: Object.freeze({ type: ["string", "null"], description: CONTACT_NAME_DESCRIPTION }),
    delivery_date: Object.freeze({ type: ["string", "null"], description: HEADER_DELIVERY_DATE_DESCRIPTION }),
  }),
  line: Object.freeze({
    delivery_date: Object.freeze({ type: ["string", "null"], description: LINE_DELIVERY_DATE_DESCRIPTION }),
  }),
});

// A copy of a PO JSON schema (claude's TOOL_DEFINITION.input_schema, or
// gemini's PO_SCHEMA) with the three slots added. The input is not changed, so
// the base schema both adapters send with the canary off stays as it was.
export const withDeliveryContactSlots = (schema) => {
  const props = schema.properties;
  const customer = props.customer;
  const lines = props.lines;
  return {
    ...schema,
    properties: {
      ...props,
      customer: { ...customer, properties: { ...customer.properties, ...PO_DELIVERY_CONTACT_SLOTS.customer } },
      lines: {
        ...lines,
        items: { ...lines.items, properties: { ...lines.items.properties, ...PO_DELIVERY_CONTACT_SLOTS.line } },
      },
    },
  };
};

// Does this run ask for the delivery date and contact? Only when the resolved
// variant (hints.promptVariant, which run.js passes only for a tenant that
// opted in) names the feature, and only for the prompt the variant belongs to.
// promptName is the caller's promptNameForKind(expectedKind), so a
// po_extractor variant never reaches a quote or packing-list run.
export const deliveryContactRequested = (variant, promptName) => !!variant
  && Array.isArray(variant.features)
  && variant.features.includes(PO_DELIVERY_CONTACT_FEATURE)
  && !!variant.name
  && variant.name === promptName;

// ---------------------------------------------------------------------------
// Normalizer

const tidy = (raw) => {
  if (raw == null || typeof raw === "object" || typeof raw === "boolean") return null;
  const s = String(raw).replace(/\s+/g, " ").trim();
  return s || null;
};

// "Not stated" written out. Null, so a blank stays a required field downstream.
const PLACEHOLDER = /^(?:n\.?\s*a\.?|n\/a|nil|none|tba|tbd|-+|\.+)$/i;

const MONTHS = ["january", "february", "march", "april", "may", "june", "july",
  "august", "september", "october", "november", "december"];
const monthOf = (word) => {
  const w = String(word || "").toLowerCase();
  if (w.length < 3) return 0;
  return MONTHS.findIndex((m) => m.startsWith(w)) + 1;
};
const yearOf = (y) => (y.length === 2 ? 2000 + Number(y) : Number(y));
const pad2 = (n) => String(n).padStart(2, "0");
const ymd = (y, m, d) => {
  if (!y || !m || !d) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return y + "-" + pad2(m) + "-" + pad2(d);
};

const ISO_LEAD = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/;
const NUMERIC = /^(?:\d{4}[/.\-]\d{1,2}[/.\-]\d{1,2}|\d{1,2}[/.\-]\d{1,2}[/.\-](?:\d{2}|\d{4}))$/;
// '15 Nov 2026', '15-Nov-26', '15th November, 2026'
const DAY_MONTH_YEAR = /^(\d{1,2})(?:st|nd|rd|th)?[\s\-./,]*([A-Za-z]{3,9})\.?[\s\-./,]*(\d{4}|\d{2})$/;
// 'Nov 15, 2026', 'November 15th 2026'
const MONTH_DAY_YEAR = /^([A-Za-z]{3,9})\.?[\s\-./]*(\d{1,2})(?:st|nd|rd|th)?[\s,\-./]*(\d{4}|\d{2})$/;

// A printed date as ISO YYYY-MM-DD, read day-first, or null.
//
// Numeric forms go to parse-date.js with the DMY hint, as llamaparse.js and
// po-header-text.js read them, so all three paths agree; a form that cannot be
// day-first (10/25/2026) still decodes there. Month names are read here, by
// arithmetic: parsePoDate hands them to new Date(), which reads local time and
// returns the day before on a server east of UTC.
export const isoDayFirst = (raw) => {
  const s = tidy(raw);
  if (!s) return null;
  const iso = s.match(ISO_LEAD);
  if (iso) return ymd(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  if (NUMERIC.test(s)) return parsePoDate(s, { hint: "DMY" });
  let m = s.match(DAY_MONTH_YEAR);
  if (m) return ymd(yearOf(m[3]), monthOf(m[2]), Number(m[1]));
  m = s.match(MONTH_DAY_YEAR);
  if (m) return ymd(yearOf(m[3]), monthOf(m[1]), Number(m[2]));
  return null;
};

// A delivery date as stored: ISO when it parses, else the printed text, else
// null. Kept as printed rather than dropped, so "4 weeks" stays visible to the
// person who has to turn it into a date.
export const deliveryDateOf = (raw) => {
  const s = tidy(raw);
  if (!s || PLACEHOLDER.test(s)) return null;
  return isoDayFirst(s) || s;
};

// A phone as printed, whitespace tidied. Null when it holds no digit at all.
export const phoneOf = (raw) => {
  const s = tidy(raw);
  if (!s || PLACEHOLDER.test(s) || !/\d/.test(s)) return null;
  return s;
};

// The digits of the FIRST number printed, for matching and dialling. Two
// numbers ("020-2712 3456 / 98200 12345") are not run together; an extension
// is dropped. Null unless 6 to 15 digits (E.164 allows 15).
const PHONE_SPLIT = /\s*(?:[/,;|]|\bor\b)\s*/i;
const EXTENSION = /\s*(?:ext(?:n)?\.?|extension|x)\s*\d+\s*$/i;
export const phoneDigits = (raw) => {
  const s = phoneOf(raw);
  if (!s) return null;
  const first = s.split(PHONE_SPLIT)
    .map((part) => part.replace(EXTENSION, ""))
    .find((part) => part.replace(/\D/g, "").length >= 6);
  if (!first) return null;
  const d = first.replace(/\D/g, "");
  return d.length <= 15 ? d : null;
};

// A person's name, whitespace tidied and stripped of edge punctuation. Null
// when it holds no letter.
export const contactNameOf = (raw) => {
  const s = tidy(raw);
  if (!s || PLACEHOLDER.test(s)) return null;
  const name = s.replace(/^[\s,;:\-]+|[\s,;:\-]+$/g, "");
  return /\p{L}/u.test(name) ? name : null;
};

// Normalize a PO result's customer block and lines. Returns a new object; the
// input is not changed.
//
// slots: true when this run asked the model for the three slots (the v4 arm).
// Then each slot is always present, null when the PO printed none, so a reader
// can tell "read, and the PO had none" (null) from "not asked" (absent). With
// slots false a field is normalized only when it is already there.
export const normalizeDeliveryContact = (normalized, { slots = false } = {}) => {
  if (!normalized || typeof normalized !== "object") return normalized;
  const out = { ...normalized };
  const c = normalized.customer;
  if (c && typeof c === "object" && !Array.isArray(c)) {
    const customer = { ...c };
    if (slots || "contact_name" in c) customer.contact_name = contactNameOf(c.contact_name);
    if (slots || "delivery_date" in c) customer.delivery_date = deliveryDateOf(c.delivery_date);
    if ("phone" in c) {
      customer.phone = phoneOf(c.phone);
      customer.phone_digits = phoneDigits(customer.phone);
    }
    out.customer = customer;
  }
  if (Array.isArray(normalized.lines)) {
    out.lines = normalized.lines.map((line) => {
      if (!line || typeof line !== "object") return line;
      if (!slots && !("delivery_date" in line)) return line;
      return { ...line, delivery_date: deliveryDateOf(line.delivery_date) };
    });
  }
  return out;
};
