// A deterministic read of a purchase order's HEADER from parsed markdown.
//
// WHY THIS EXISTS
//
// LlamaParse returns the document as markdown, and the llamaparse adapter read
// only its line-item table. It returned customer: null, so an order that
// LlamaParse produced had no PO number, no PO date and no buyer. The SO header
// was empty and the intake had no buyer to match a customer on, although the
// markdown printed all of it in plain labels above the table.
//
// The Gemini and Claude adapters fill these fields on normalized.customer
// (claude.js, STEP 2). This pass fills the same names, from labels only:
//
//   po_number    PO No / P.O. No / PO Number / Purchase Order No / Order No /
//                Our Ref No (on a PO the buyer issues, "our" is the buyer)
//   po_date      PO Date / Order Date / Date, read day-first, returned as ISO
//   vendor_code  VENDOR_CODE / Vendor Code / Vendor No / Supplier Code: the
//                code the buyer uses for us
//   currency     the ISO code printed beside the grand total
//   name         the buyer: a labelled Buyer / Bill To block, else the
//                letterhead (the first heading above the vendor block)
//   grand_total  the printed grand total, on normalized.totals
//   delivery_date  Delivery Date / Dely. Date / Required by / Need by, read
//                day-first, returned as ISO (the field the po_extractor@v4
//                canary asks the LLM adapters for)
//   contact_name the buyer's Contact Person / Contact Name
//   phone        Tel / Phone / Ph / Mob / Contact No beside that person, else
//                the buyer's first printed number; plus phone_digits
//
// The delivery date may be read anywhere in the header, as the PO date is. The
// contact and the phone are a PERSON and a NUMBER, so they are read only where
// they are the buyer's: the labelled buyer block, and the lines above the
// supplier block. Never at or below it, where "Kind Attn", "Contact Person"
// and "Tel" are our own. With no supplier block found, only from a labelled
// buyer block, because nothing then says whose they are.
//
// NEVER US. A PO is addressed TO its supplier, so our own name and GSTIN are
// printed on it, often as the only company block with a GSTIN. Three guards:
//   1. Anything at or below the vendor block ("To", "Vendor", "Supplier",
//      "M/s", a vendor code) is the supplier, never the buyer.
//   2. A name or GSTIN equal to the tenant's own (passed in by the caller from
//      tenant_settings) is skipped.
//   3. A GSTIN is taken only from a labelled buyer block. An unlabelled GSTIN
//      is not evidence of whose it is, so it is left alone.
// run.js also scrubs the customer block of the tenant's identity afterwards.
//
// PURE. No I/O, never throws on odd input.

import { parsePoDate } from "../parse-date.js";
import { printedDocumentTotal } from "./anomaly.js";
import { isoDayFirst, phoneOf, phoneDigits, contactNameOf } from "./po-delivery-contact.js";

const decode = (s) => String(s)
  .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
  .replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, "\"");

// Markdown with HTML tables -> lines of plain text, one per cell or line, with
// heading levels kept so the letterhead can be found. A table the caller says
// is the line-item table becomes a marker: the header is what sits above it.
const LINE_TABLE = "\u0000LINE_TABLE\u0000";
const toLines = (md, isLineItemTable) => {
  let text = String(md || "");
  if (typeof isLineItemTable === "function") {
    text = text.replace(/<table[\s\S]*?<\/table>/gi, (t) => (isLineItemTable(t) ? "\n" + LINE_TABLE + "\n" : t));
  }
  text = text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(td|th|tr|p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]*>/g, " ");
  const out = [];
  for (const raw of decode(text).split(/\r?\n/)) {
    const heading = /^\s*#{1,6}\s+/.test(raw);
    const t = raw
      .replace(/^\s*#{1,6}\s+/, "")
      .replace(/\*\*|__/g, "")
      .replace(/^\s*[-*>]\s+/, "")
      .replace(/^\s*\|+|\|+\s*$/g, "")
      .replace(/[ \t]+/g, " ")
      .trim();
    if (raw.includes(LINE_TABLE)) { out.push({ text: "", heading: false, lineTable: true }); continue; }
    if (t) out.push({ text: t, heading, lineTable: false });
  }
  return out;
};

// Company-name comparison key: case, punctuation and legal suffixes do not
// make two names different (tenant-scrub.js uses the same suffix list).
const nameKey = (s) => String(s || "").toLowerCase()
  .replace(/^m\/s\.?\s*/i, "")
  .replace(/\b(pvt|private|ltd|limited|llp|inc|corp|corporation|co|company)\b\.?/g, " ")
  .replace(/[^\p{L}\p{N}]+/gu, "");

const GSTIN_IN_TEXT = /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/;

// The value printed after a label: separators (":", ".", "-", "#", at most one
// line break) then one token. Every occurrence of the label is tried, so a
// label that appears first in prose ("quote the Order No. on all invoices")
// does not hide the real one. `needDigit` rejects a word, so "PO No : Refer
// annexure" is not a PO number.
const SEP = String.raw`[ \t:.\-#]*\n?[ \t:.\-#]*`;
const valueAfter = (text, labelRe, needDigit) => {
  const re = new RegExp(labelRe.source + SEP + "([A-Za-z0-9][A-Za-z0-9/\\-_.]*)", "gi");
  for (const m of text.matchAll(re)) {
    const v = m[1].replace(/[.\-/]+$/, "");
    if (!v) continue;
    if (needDigit && !/\d/.test(v)) continue;
    return v;
  }
  return null;
};

// Preference order: the most specific label first. Whitespace inside a label
// is [ \t], never a line break, so a title line cannot join the line below it.
const PO_NUMBER_LABELS = [
  /\b(?:p\.?[ \t]*o\.?|purchase[ \t]*order)[ \t]*(?:no\b\.?|number|num\b|#)/,
  /(?<!(?:sales|work|your)[ \t]*)\border[ \t]*(?:no\b\.?|number|#)/,
  /\bour[ \t]*ref(?:erence)?\.?[ \t]*(?:no\b\.?|number|#)?/,
];
const DATE_VALUE = String.raw`(\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}|\d{4}[/.\-]\d{1,2}[/.\-]\d{1,2}|\d{1,2}[ \t\-]+[A-Za-z]{3,9}[ \t\-,]+\d{2,4})`;
const PO_DATE_LABELS = [
  /\b(?:p\.?[ \t]*o\.?|purchase[ \t]*order|order)[ \t]*date/,
  /(?<!(?:delivery|due|need[ \t]*by|quotation|quote|ref|invoice|amendment|amd|valid(?:ity)?|expiry|ship(?:ment)?|dispatch|schedule)\.?[ \t]*)\bdate\b/,
];
const VENDOR_CODE_LABEL = /\b(?:vendor|supplier)[ \t_]*(?:code|no\b\.?|number|id)/;
// Where the supplier's block starts. Nothing at or below it is the buyer.
const VENDOR_BLOCK = /^(?:to\b|vendor\b|supplier\b|m\/s\b)|\b(?:vendor|supplier)[\s_]*(?:code|no\b|name|address)/i;
const BUYER_LABEL = /^(?:buyer|purchaser|bill(?:ed)?\s*to|invoice\s*to|sold\s*to)\b\s*(?:name)?\s*[:\-.]?\s*(.*)$/i;
// A heading that names the document, not a company.
const DOC_TITLE = /\b(?:purchase\s*order|p\.?\s*o\.?|order|contract|scheduling\s*agreement|amendment|annexure|terms|page)\b/i;
const ISO_CCY = /\b(INR|USD|EUR|GBP|JPY|KRW|CNY|SGD|AUD|AED)\b/;

// Day-first, as Indian and most non-US POs print it; returned as ISO so no
// later reader has to guess the order again.
const dateFrom = (text) => {
  for (const label of PO_DATE_LABELS) {
    for (const m of text.matchAll(new RegExp(label.source + SEP + DATE_VALUE, "gi"))) {
      const iso = parsePoDate(m[1], { hint: "DMY" });
      if (iso) return iso;
    }
  }
  return null;
};

// The order's delivery date. A label followed by no date ("Delivery Date :
// within 4 weeks") is passed over for the next one; nothing that is not a date
// is returned.
const DELIVERY_DATE_LABELS = [
  /\b(?:delivery|del[yv]\.?)[ \t]*(?:date|dt\b\.?)/,
  /\b(?:required|reqd\.?|need)[ \t]*by(?:[ \t]*date)?/,
];
const deliveryDateFrom = (text) => {
  for (const label of DELIVERY_DATE_LABELS) {
    for (const m of text.matchAll(new RegExp(label.source + SEP + DATE_VALUE, "gi"))) {
      const iso = isoDayFirst(m[1]);
      if (iso) return iso;
    }
  }
  return null;
};

// The buyer's contact person. The value is a name on the label's line: it
// stops at a digit, a colon or a comma, and at the next label on the same line
// ("A. Rao Tel : ..."). A designation or a company name is not a person, so a
// value that is one of our own names is skipped.
const CONTACT_LABEL = /\bcontact[ \t]*(?:person|name)\b/;
const NAME_VALUE = String.raw`((?:(?:mr|mrs|ms|miss|dr|shri|smt|sri)\.?[ \t]+)?\p{L}[\p{L}.' \t\-]{1,60})`;
const NEXT_LABEL = /\b(?:tel(?:ephone)?|ph(?:one)?|mob(?:ile)?|cell|e-?mail|fax|desig(?:nation)?|dept|department|contact|ext(?:n)?)\b.*$/i;
// A phone label, then the number: digits with the separators a phone is
// printed with, and "/" for a second number ("020-2712 3456 / 57").
const PHONE_LABEL = /\b(?:tel(?:ephone)?|ph(?:one)?|mob(?:ile)?|cell|contact[ \t]*(?:no\b|number))\.?(?:[ \t]*(?:no\b\.?|number|#))?/;
const PHONE_VALUE = String.raw`(\+?\(?\d[\d \t().\-/]{4,}\d)`;
const phoneAfter = (text, isOwnPhone) => {
  for (const m of text.matchAll(new RegExp(PHONE_LABEL.source + SEP + PHONE_VALUE, "gi"))) {
    const printed = phoneOf(m[1]);
    const digits = phoneDigits(printed);
    if (!digits || isOwnPhone(digits)) continue;
    return printed;
  }
  return null;
};

// Read the header. opts:
//   ownNames         the tenant's own company names (never the buyer)
//   ownGstins        the tenant's own GSTINs (never the buyer's)
//   ownPhones        the tenant's own phone numbers (never the buyer's)
//   isLineItemTable  (html) => bool, so the header is read above the table
// Returns { customer, totals, fields } with customer null when nothing was
// found; `fields` lists what was filled, for the run's diagnostics.
export const readPoHeader = (md, opts = {}) => {
  const ownNames = (opts.ownNames || []).map(nameKey).filter((k) => k.length >= 3);
  const ownGstins = new Set((opts.ownGstins || []).map((g) => String(g || "").trim().toUpperCase()).filter(Boolean));
  const isOwnName = (s) => {
    const k = nameKey(s);
    return !!k && ownNames.some((o) => k === o || (o.length >= 6 && k.includes(o)));
  };
  // The last 10 digits, so a country code printed or not is the same number
  // (tenant-scrub.js compares the same way).
  const ownPhones = (opts.ownPhones || []).map((p) => String(p || "").replace(/\D+/g, "").slice(-10)).filter((d) => d.length >= 6);
  const isOwnPhone = (digits) => ownPhones.includes(String(digits).slice(-10));
  const lines = toLines(md, opts.isLineItemTable);
  const tableAt = lines.findIndex((l) => l.lineTable);
  const head = tableAt >= 0 ? lines.slice(0, tableAt) : lines;
  // Labels are read across the header region first; when the document puts
  // them below the table instead, across everything.
  const scan = (fn) => fn(head.map((l) => l.text).join("\n")) ?? (tableAt >= 0 ? fn(lines.map((l) => l.text).join("\n")) : null);

  const customer = {};
  const fields = [];
  const set = (k, v) => { if (v != null && v !== "") { customer[k] = v; fields.push(k); } };

  set("po_number", scan((t) => { for (const re of PO_NUMBER_LABELS) { const v = valueAfter(t, re, true); if (v) return v; } return null; }));
  set("po_date", scan(dateFrom));
  set("vendor_code", scan((t) => valueAfter(t, VENDOR_CODE_LABEL, false)));
  set("currency", scan((t) => {
    const m = t.match(new RegExp(String.raw`total[^\n]{0,40}?` + ISO_CCY.source, "i"))
      || t.match(new RegExp(String.raw`\bcurrency\b[\s:.\-]*` + ISO_CCY.source, "i"));
    return m ? m[1].toUpperCase() : null;
  }));

  // The buyer. A labelled block wins; the letterhead is the fallback.
  const vendorAt = head.findIndex((l) => VENDOR_BLOCK.test(l.text));
  const above = vendorAt >= 0 ? head.slice(0, vendorAt) : head;
  let name = null;
  let source = null;
  let billTo = null;
  let buyerBlock = [];
  let gstin = null;
  for (let i = 0; i < head.length && !name; i++) {
    const m = head[i].text.match(BUYER_LABEL);
    if (!m) continue;
    const block = [];
    if (m[1] && m[1].trim()) block.push(m[1].trim());
    for (let j = i + 1; j < head.length && block.length < 6; j++) {
      if (BUYER_LABEL.test(head[j].text) || VENDOR_BLOCK.test(head[j].text) || head[j].heading) break;
      block.push(head[j].text);
    }
    const candidate = block.find((b) => /\p{L}{3}/u.test(b) && !/:/.test(b));
    if (!candidate || isOwnName(candidate)) continue;
    name = candidate;
    source = "buyer_block";
    billTo = block.join("\n");
    buyerBlock = block;
    const g = block.join(" ").toUpperCase().match(GSTIN_IN_TEXT);
    if (g && !ownGstins.has(g[0])) gstin = g[0];
  }
  if (!name) {
    const letterhead = above.find((l) => l.heading
      && /\p{L}{3}/u.test(l.text)
      && !/:/.test(l.text)
      && !DOC_TITLE.test(l.text)
      && !isOwnName(l.text));
    if (letterhead) { name = letterhead.text; source = "letterhead"; }
  }
  if (name) {
    set("name", name.replace(/^m\/s\.?\s*/i, "").trim());
    customer._name_source = source;
  }
  if (billTo) set("bill_to_address", billTo);
  if (gstin) set("gstin", gstin);

  // The order's delivery date: anywhere in the header, as the PO date.
  set("delivery_date", scan(deliveryDateFrom));

  // The buyer's contact person and phone: the labelled buyer block, then the
  // lines above the supplier block. Nothing at or below the supplier block.
  const party = [...buyerBlock, ...(vendorAt >= 0 ? above.map((l) => l.text) : [])].join("\n");
  let contact = null;
  let phone = null;
  for (const m of party.matchAll(new RegExp(CONTACT_LABEL.source + SEP + NAME_VALUE, "giu"))) {
    const person = contactNameOf(m[1].replace(NEXT_LABEL, ""));
    if (!person || isOwnName(person)) continue;
    contact = person;
    // A number printed with the person: the label's line and the next three,
    // which is where a table row's cells land once they are one per line.
    phone = phoneAfter(party.slice(m.index).split("\n").slice(0, 4).join("\n"), isOwnPhone);
    break;
  }
  if (!phone) phone = phoneAfter(party, isOwnPhone);
  set("contact_name", contact);
  if (phone) {
    set("phone", phone);
    customer.phone_digits = phoneDigits(phone);
  }

  const allText = lines.map((l) => l.text).join("\n");
  const grand = printedDocumentTotal(allText);
  const totals = grand != null ? { grand_total: grand } : null;
  if (totals) fields.push("grand_total");

  return {
    customer: fields.some((f) => f !== "grand_total") ? { ...customer, _source: "header_text" } : null,
    totals,
    fields,
  };
};

export const __test = { toLines, nameKey, valueAfter, dateFrom, deliveryDateFrom, phoneAfter };
