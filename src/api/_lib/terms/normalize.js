// Clause wording -> the structured value in taxonomy.js.
//
// docs/SO_TERMS_AND_HANDOFF_SCOPE.md section 3.2: "A deterministic normalizer
// derives [the value] from text where one exists. The LLM's value is only a
// hint." These are those normalizers. The terms pass (plan PR 11) runs them
// over verified clause wording; the rule comparator (plan PR 12) compares
// their output; comparePaymentTerms in quote-reconcile.js already does.
//
// Rules every normalizer follows:
//   - Pure. No I/O, no clock. The same text always gives the same value.
//   - null when the text names nothing it can read. A side with no parseable
//     value is "unknown" to a comparator, never a string compared against
//     unrelated text (section 5.1).
//   - A field the wording does not state is null, never guessed. The few
//     trade conventions applied on purpose are named where they are applied.
//
// The incoterm parser lives here and quote-reconcile.js re-exports it. It was
// written for the incoterm check (#570) and is the same code: the comparators
// sit on top of the normalizers, so the import runs one way.

import { parsePoDate } from "../parse-date.js";

// ── shared text helpers ─────────────────────────────────────────────────────

const UNITS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS = { twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SMALL = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const WORD_NUMBER = new RegExp(
  "\\b(?:(" + Object.keys(TENS).join("|") + ")(?:[\\s-]+(" + SMALL.join("|") + "))?|("
  + Object.keys(UNITS).join("|") + "))\\b",
  "gi",
);

// "thirty (30) days" and "One(1) Month" print the figure twice. Words become
// digits, then a figure repeated in brackets collapses to one, and "a week"
// becomes "1 week".
const prep = (v) => {
  let t = String(v == null ? "" : v).replace(/\s+/g, " ").trim();
  if (!t) return "";
  t = t.replace(WORD_NUMBER, (_m, tens, unit, single) => (tens
    ? String(TENS[tens.toLowerCase()] + (unit ? UNITS[unit.toLowerCase()] : 0))
    : String(UNITS[single.toLowerCase()])));
  t = t.replace(/(\d+(?:\.\d+)?)\s*\(\s*\1\s*\)/g, "$1");
  t = t.replace(/\b(?:a|an)\s+(day|week|month|year|fortnight)\b/gi, "1 $1");
  return t;
};

const UNIT_DAYS = { day: 1, week: 7, fortnight: 14, month: 30, year: 365 };
const unitOf = (u) => {
  const s = u.toLowerCase();
  if (s.startsWith("d")) return "day";
  if (s.startsWith("w")) return "week";
  if (s.startsWith("f")) return "fortnight";
  if (s.startsWith("m")) return "month";
  return "year";
};

// "4 weeks", "11-12 weeks", "8 to 10 weeks", "30 working days", "2 months".
const DURATION = /(\d+(?:\.\d+)?)(?:\s*(?:-|to|or|\/)\s*(\d+(?:\.\d+)?))?\s*(?:calendar\s+|working\s+|business\s+|clear\s+)?(days?|weeks?|wks?|fortnights?|months?|mths?|years?|yrs?)\b/i;

// { lo, hi, unit, index, end } for the first duration in t, or null.
const durationIn = (t) => {
  const m = DURATION.exec(t);
  if (!m) return null;
  const a = Number(m[1]);
  const b = m[2] != null ? Number(m[2]) : a;
  return { lo: Math.min(a, b), hi: Math.max(a, b), unit: unitOf(m[3]), index: m.index, end: m.index + m[0].length };
};
const toDays = (n, unit) => Math.round(n * UNIT_DAYS[unit]);

// A percentage: "18%", "0.5 %", "1/2%", "5 per cent".
const FRACTIONS = { "\u00bd": 0.5, "\u00bc": 0.25, "\u00be": 0.75 };
const PERCENT = /(\d+(?:\.\d+)?\s*\/\s*\d+|\d+(?:\.\d+)?|[\u00bd\u00bc\u00be])\s*(?:%|per\s*cent\b|percent\b|pct\b)/gi;
const pctValue = (s) => {
  if (FRACTIONS[s] != null) return FRACTIONS[s];
  const frac = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+)$/.exec(s);
  if (frac) return Number(frac[2]) ? Math.round((Number(frac[1]) / Number(frac[2])) * 1e4) / 1e4 : null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const percentsIn = (t) => [...t.matchAll(PERCENT)]
  .map((m) => ({ value: pctValue(m[1].replace(/\s+/g, "")), index: m.index, end: m.index + m[0].length }))
  .filter((p) => p.value != null);

// ── dates ───────────────────────────────────────────────────────────────────

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const MONTH_NAME = "(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?";
const DATE_DMY_NAMED = new RegExp("\\b(\\d{1,2})(?:st|nd|rd|th)?[\\s./,-]*" + MONTH_NAME + "[\\s./,-]*(\\d{4}|\\d{2})\\b", "i");
const DATE_MDY_NAMED = new RegExp("\\b" + MONTH_NAME + "\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b", "i");
const DATE_NUMERIC = /\b(\d{4}-\d{2}-\d{2}|\d{1,2}[/.-]\d{1,2}[/.-](?:\d{4}|\d{2}))\b/;

const isoOf = (y, m, d) => {
  const year = y < 100 ? 2000 + y : y;
  const dt = new Date(Date.UTC(year, m - 1, d));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
};

// The first date written in t: { iso: YYYY-MM-DD, before: the text in front
// of it }, or null. Numeric dates read day first (parse-date.js's default), as
// Indian documents write them.
const dateIn = (t) => {
  const at = (iso, m) => (iso ? { iso, before: t.slice(0, m.index) } : null);
  let m = DATE_DMY_NAMED.exec(t);
  if (m) return at(isoOf(Number(m[3]), MONTHS[m[2].toLowerCase().slice(0, 3)], Number(m[1])), m);
  m = DATE_MDY_NAMED.exec(t);
  if (m) return at(isoOf(Number(m[3]), MONTHS[m[1].toLowerCase().slice(0, 3)], Number(m[2])), m);
  m = DATE_NUMERIC.exec(t);
  if (m) {
    const iso = parsePoDate(m[1], { hint: "DMY" });
    return at(iso && isoOf(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)), Number(iso.slice(8, 10))), m);
  }
  return null;
};

const addDaysIso = (iso, days) => {
  const t = Date.parse(String(iso || "").slice(0, 10) + "T00:00:00Z");
  if (!Number.isFinite(t) || days == null) return null;
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10);
};

// ── incoterm (the #570 parser, moved here unchanged) ────────────────────────

const INCOTERM_CODES = new Set([
  "EXW", "FCA", "FAS", "FOB", "CFR", "CIF", "CPT", "CIP", "DAP", "DPU", "DDP",
  // Superseded but still written on real documents.
  "DAT", "DAF", "DES", "DEQ", "DDU",
]);
const BARE_CODE = new RegExp("\\b(" + [...INCOTERM_CODES].join("|") + ")\\b", "i");

// The spelled-out forms, as quotes and POs often write them ("Ex-Works Pune",
// "C&F Chennai"). When two forms start at the same place the longer one wins,
// so "Delivered at Place Unloaded" is DPU and not DAP.
const INCOTERM_NAMES = [
  [/\bex[\s.-]*works?\b/i, "EXW"],
  [/\bfree\s+carrier\b/i, "FCA"],
  [/\bfree\s+alongside(?:\s+ship)?\b/i, "FAS"],
  [/\bfree\s+on\s+board\b/i, "FOB"],
  [/\bcost\s*(?:,|and|&)?\s*insurance\s*(?:,|and|&)\s*freight\b/i, "CIF"],
  [/\bcost\s*(?:and|&)\s*freight\b/i, "CFR"],
  [/\bc\s*(?:&|and|n)\s*f\b/i, "CFR"],
  [/\bcarriage\s*(?:and|&)?\s*insurance\s+paid(?:\s+to)?\b/i, "CIP"],
  [/\bcarriage\s+paid\s+to\b/i, "CPT"],
  [/\bdelivered\s+at\s+place\s+unloaded\b/i, "DPU"],
  [/\bdelivered\s+at\s+place\b/i, "DAP"],
  [/\bdelivered\s+duty\s+paid\b/i, "DDP"],
  [/\bdelivered\s+duty\s+unpaid\b/i, "DDU"],
  [/\bdelivered\s+at\s+terminal\b/i, "DAT"],
  [/\bfree\s+on\s+road\b/i, "FOR"],
  [/\bfree\s+house\b/i, "FH"],
];

// FOR and FH are Indian conventions, and the incoterm picklist offers both
// (migration 106 seeds them). "FOR" is also an English word, so the bare code
// counts only in capitals at the start of the value, which is how the picklist
// and a PO header write it ("FOR Halol Plant"). Dotted ("F.O.R.") and spelled
// out forms count anywhere.
const LOCAL_CODES = new Set(["FOR", "FH"]);
const LEADING_LABEL = /^inco\s*-?\s*terms?\s*[:-]?\s*/i;
const LEADING_LOCAL_CODE = /^(FOR|FH)\b/;
const DOTTED_CODE = /\b([A-Za-z])\.\s?([A-Za-z])\.\s?([A-Za-z])\b\.?/g;

// "FOB Busan (Incoterms 2020)": the edition is not part of the place.
const EDITION = /\(?\s*incoterms?\s*\u00ae?\s*(?:(?:19|20)\d{2})?\s*\)?/gi;

// The named place is the text after the code, up to where the next clause
// starts: "FOB Busan, 30 days net" names Busan, not "Busan 30 days net".
const placeAfter = (raw, end) => {
  let rest = raw.slice(end).replace(EDITION, " ");
  rest = rest.replace(/^[\s,:;.\-\u2013\u2014]+/, "");
  const stop = rest.search(/[,;|/()[\]\n\r]|\.(?:\s|$)|\s[-\u2013\u2014]\s/);
  if (stop >= 0) rest = rest.slice(0, stop);
  rest = rest.replace(/\s+/g, " ").trim();
  return rest || null;
};

// { code, place }. code is null when the text names no rule, and then place is
// null too: unparsed text is not a place.
export const parseIncoterm = (v) => {
  const raw = String(v == null ? "" : v).trim();
  if (!raw) return { code: null, place: null };
  const hits = [];
  const take = (m, code) => {
    if (m) hits.push({ code, index: m.index, end: m.index + m[0].length });
  };
  const bare = BARE_CODE.exec(raw);
  if (bare) take(bare, bare[1].toUpperCase());
  for (const [re, code] of INCOTERM_NAMES) take(re.exec(raw), code);
  for (const m of raw.matchAll(DOTTED_CODE)) {
    const code = (m[1] + m[2] + m[3]).toUpperCase();
    if (INCOTERM_CODES.has(code) || LOCAL_CODES.has(code)) { take(m, code); break; }
  }
  const body = raw.replace(LEADING_LABEL, "");
  const local = LEADING_LOCAL_CODE.exec(body);
  if (local) {
    const offset = raw.length - body.length;
    hits.push({ code: local[1], index: offset, end: offset + local[0].length });
  }
  if (!hits.length) return { code: null, place: null };
  hits.sort((a, b) => a.index - b.index || (b.end - b.index) - (a.end - a.index));
  return { code: hits[0].code, place: placeAfter(raw, hits[0].end) };
};

// incoterm: { code, place }, or null when the text names no rule.
export const normalizeIncoterm = (text) => {
  const p = parseIncoterm(text);
  return p.code ? { code: p.code, place: p.place } : null;
};

// ── payment terms ───────────────────────────────────────────────────────────

// The clock a credit period runs from, in the order the events happen. With
// "whichever is later" the latest named clock governs, and with "whichever is
// earlier" the earliest.
const CLOCK_ORDER = ["invoice", "dispatch", "bl", "delivery", "grn"];
// On a payment clause a bare "receipt" means receipt of the goods. "receipt of
// invoice" is the invoice clock, and paymentBasisOf rewrites it before this
// list runs.
const PAYMENT_BASIS_WORDS = [
  [/\b(?:invoice|bill\s+date|date\s+of\s+bill)\b/gi, "invoice"],
  [/\b(?:dispatch|despatch|shipment|lr\s+date)\b/gi, "dispatch"],
  [/\b(?:b\s*\/\s*l|bill\s+of\s+lading|bl\s+date|awb\s+date)\b/gi, "bl"],
  [/\bdelivery\b/gi, "delivery"],
  [/\b(?:grn|g\.r\.n\.?|mrn|srn|goods\s+receipt|receipt|acceptance\s+of\s+(?:the\s+)?(?:material|goods))\b/gi, "grn"],
];
const PROFORMA = /\b(?:pro[\s-]?forma(?:\s+invoice)?|p\.?\s?i\.?)(?=[\s,.;:)]|$)/gi;
const RECEIPT_OF_INVOICE = /\breceipt\s+of\s+(?:the\s+)?(?:invoice|bill)\b/gi;

const paymentBasisOf = (t) => {
  // Text that names a clock but is not one: "against proforma invoice" is an
  // advance, and "receipt of invoice" is the invoice clock, not a goods
  // receipt.
  const scrubbed = t.replace(PROFORMA, (m) => " ".repeat(m.length))
    .replace(RECEIPT_OF_INVOICE, (m) => "invoice" + " ".repeat(m.length - 7));
  const hits = [];
  for (const [re, basis] of PAYMENT_BASIS_WORDS) {
    for (const m of scrubbed.matchAll(re)) hits.push({ basis, index: m.index });
  }
  if (!hits.length) return null;
  const distinct = [...new Set(hits.map((h) => h.basis))];
  if (distinct.length > 1 && /\bwhichever\s+is\s+(?:later|last)\b/i.test(t)) {
    return distinct.sort((a, b) => CLOCK_ORDER.indexOf(b) - CLOCK_ORDER.indexOf(a))[0];
  }
  if (distinct.length > 1 && /\bwhichever\s+is\s+(?:earlier|first|sooner)\b/i.test(t)) {
    return distinct.sort((a, b) => CLOCK_ORDER.indexOf(a) - CLOCK_ORDER.indexOf(b))[0];
  }
  hits.sort((a, b) => a.index - b.index);
  return hits[0].basis;
};

const INSTRUMENTS = [
  [/\bpdc\b|\bpost[\s-]*dated\s+cheques?\b/i, "pdc"],
  [/\bl\s*\/\s*c\b|\blc\b|\bletter\s+of\s+credit\b/i, "lc"],
  [/\bt\s*\/\s*t\b|\btt\b|\btelegraphic\b|\bwire\s+transfer\b|\brtgs\b|\bneft\b|\bimps\b|\bbank\s+transfer\b/i, "tt"],
  [/\bcheques?\b|\bdemand\s+draft\b|\bd\s*\/\s*d\b/i, "other"],
];

// Paid on the event itself, with no credit period after it.
const ON_EVENT = /\b(?:against|on|upon|at\s+the\s+time\s+of|cash\s+on)\s+(?:the\s+)?(?:delivery|dispatch|despatch|receipt|grn|documents?)\b|\bat\s+sight\b|\bimmediate(?:ly)?\b|\bcod\b/i;
// Paid before the goods move: an advance in all but name.
const BEFORE_DISPATCH = /\b(?:before|prior\s+to)\s+(?:dispatch|despatch|shipment|delivery)\b/i;
const ADVANCE_PCT_BEFORE = /(\d+(?:\.\d+)?)\s*%\s*(?:of\s+(?:the\s+)?(?:po|order|total|basic)\s+value\s+)?(?:as\s+|in\s+)?(?:advance|adv\b)/i;
const ADVANCE_PCT_AFTER = /\badvance\s*(?:payment\s*)?(?:of|:|-|@)?\s*(\d+(?:\.\d+)?)\s*%/i;
const PCT_WITH_ORDER = /(\d+(?:\.\d+)?)\s*%\s*(?:along\s+)?with\s+(?:the\s+)?(?:po|p\.o\.|order)\b/i;
const FULL_ADVANCE = /\badvance\b|\bagainst\s+(?:the\s+)?(?:pro[\s-]?forma|p\.?\s?i\b)/i;

// payment_terms: { days, basis, advance_pct, instrument }, or null.
//
//   days         the credit period after the basis. 0 when payment is due on
//                the event ("against delivery", "at sight", "immediate").
//   basis        the clock (taxonomy PAYMENT_BASES).
//   advance_pct  the share paid before dispatch.
//   instrument   how it is paid, only when the text says (tt, lc, pdc, other).
//
// Two trade conventions are applied, and only these two:
//   - a credit period with no stated clock runs from the invoice ("Net 45",
//     "30 days credit"), except under a letter of credit, whose clock is the
//     bill of lading or the documents and is left null unless stated;
//   - terms that name a credit period or a clock and no advance have no
//     advance (advance_pct 0).
export const normalizePaymentTerms = (raw) => {
  const t = prep(raw);
  if (!t) return null;

  let instrument = null;
  for (const [re, code] of INSTRUMENTS) if (re.test(t)) { instrument = code; break; }

  let advance = null;
  const pctAdvance = ADVANCE_PCT_BEFORE.exec(t) || ADVANCE_PCT_AFTER.exec(t) || PCT_WITH_ORDER.exec(t);
  if (pctAdvance) advance = Number(pctAdvance[1]);
  else if (FULL_ADVANCE.test(t) || BEFORE_DISPATCH.test(t)) advance = 100;

  let days = null;
  const net = /\bnet\s*(\d{1,3})\b/i.exec(t);
  const dur = durationIn(t);
  if (dur && dur.unit !== "year") days = toDays(dur.lo, dur.unit);
  else if (net) days = Number(net[1]);
  else if (ON_EVENT.test(t)) days = 0;

  let basis = paymentBasisOf(t);
  // "100% advance" names no balance at all, so no clock either.
  if (advance === 100 && days == null) basis = null;

  if (days == null && basis == null && advance == null && instrument == null) return null;
  if (days != null && basis == null && instrument !== "lc") basis = "invoice";
  if (advance == null && (days != null || basis != null)) advance = 0;
  return { days, basis, advance_pct: advance, instrument };
};

// ── delivery lead time ──────────────────────────────────────────────────────

const FROM_DRAWING = /\bdrawings?\b[^.;]*\bapprov|\bapprov\w*\s+(?:of\s+)?(?:the\s+)?drawings?\b|\bgad\s+approval\b/i;
const FROM_ADVANCE = /\badvance\b|\breceipt\s+of\s+(?:the\s+)?payment\b|\bdown[\s-]*payment\b/i;
const FROM_ORDER = /\b(?:po|p\.o\.?|purchase\s+order|order|aro|loi|letter\s+of\s+intent)\b/i;
const FROM_OTHER = /\b(?:from|after)\b/i;
const EX_STOCK = /\bex[\s-]*stock\b|\bfrom\s+stock\b|\bready\s+stock\b|\bimmediate(?:ly)?\b/i;
const AT_MOST = /\b(?:within|max(?:imum)?|not\s+later\s+than|no\s+later\s+than|up\s*to|upto)\b/i;
// A date beside a period is a delivery date only when the text says so. In
// "4 weeks from PO dated 12.09.2026" the date is the order's, not a deadline.
const BY_DATE = /\b(?:by|before|latest|later\s+than|on|date)\s*[:-]?\s*$/i;

// delivery_lead_time: { min_days, max_days, from, fixed_date }, or null.
//
// "within 4 weeks" states a ceiling only, so min_days is null. A range
// ("11-12 weeks") gives both ends. When several milestones are named the
// later one governs: drawing approval and the advance both come after the
// order.
export const normalizeLeadTime = (raw) => {
  const t = prep(raw);
  if (!t) return null;
  let minDays = null;
  let maxDays = null;
  const dur = durationIn(t);
  if (dur) {
    const lo = toDays(dur.lo, dur.unit);
    const hi = toDays(dur.hi, dur.unit);
    const ceilingOnly = AT_MOST.test(t.slice(0, dur.index)) && dur.lo === dur.hi;
    minDays = ceilingOnly ? null : lo;
    maxDays = hi;
  } else if (EX_STOCK.test(t)) {
    minDays = 0;
    maxDays = 0;
  }
  const d = dateIn(t);
  const fixedDate = d && (!dur || BY_DATE.test(d.before)) ? d.iso : null;
  if (minDays == null && maxDays == null && !fixedDate) return null;
  let from = null;
  if (FROM_DRAWING.test(t)) from = "drawing_approval";
  else if (FROM_ADVANCE.test(t)) from = "advance";
  else if (FROM_ORDER.test(t)) from = "order";
  else if (dur && FROM_OTHER.test(t.slice(dur.end))) from = "other";
  return { min_days: minDays, max_days: maxDays, from, fixed_date: fixedDate };
};

// ── price basis ─────────────────────────────────────────────────────────────

const PRICE_LABEL = /^(?:price\s+basis|prices?|rates?)\s*(?:are|is|:|-)?\s*/i;
const DOOR = /\bdoor[\s-]*(?:to[\s-]*door\s+)?delivery\b|\bdoor[\s-]*step\b|\bdelivered\s+(?:to|at)\s+(?:your|the\s+buyer'?s?|buyer'?s?)\b/i;
const EX_WORKS = /\bex[\s.-]*(?:works?|factory|godown|warehouse)\b|\bEXW\b/i;
const FOR_CODE = /\bF\.\s?O\.\s?R\.?|\bFOR\b|\b[Ff]ree\s+[Oo]n\s+[Rr]oad\b/;
const FOR_DISPATCH = /\b(?:dispatch|despatch|source|origin|our\s+(?:works|factory|plant|premises|godown)|seller'?s?\s+(?:works|premises)|supplier'?s?\s+(?:works|premises))\b/i;
// A generic word after the code says which end, and is not a place.
const GENERIC_PLACE_LEAD = /^(?:destination|site|(?:your|our|buyer'?s?|seller'?s?)\s+(?:works|factory|plant|premises|site|stores?|godown|warehouse)|(?:dispatch|despatch)(?:\s+point)?|source|origin)\b[\s,:-]*/i;

const placeFrom = (t, end) => {
  const p = placeAfter(t, end);
  if (!p) return null;
  const rest = p.replace(GENERIC_PLACE_LEAD, "").trim();
  return rest || null;
};

// price_basis: { basis, place }, or null.
//   "Ex-Works Pune"        ex_works, Pune
//   "FOR destination"      for_destination, no place
//   "F.O.R. Chakan"        for_destination, Chakan (FOR a named place is
//                          delivered to it, unless the text says dispatch)
//   "FOR dispatch point"   for_dispatch
//   "Door delivery"        door_delivery
export const normalizePriceBasis = (raw) => {
  const t = prep(raw).replace(PRICE_LABEL, "");
  if (!t) return null;
  if (DOOR.test(t)) return { basis: "door_delivery", place: null };
  const ex = EX_WORKS.exec(t);
  if (ex) return { basis: "ex_works", place: placeFrom(t, ex.index + ex[0].length) };
  const fr = FOR_CODE.exec(t);
  if (fr) {
    const after = t.slice(fr.index + fr[0].length);
    return {
      basis: FOR_DISPATCH.test(after) ? "for_dispatch" : "for_destination",
      place: placeFrom(t, fr.index + fr[0].length),
    };
  }
  return null;
};

// ── freight, insurance and packing ──────────────────────────────────────────

const COST_ITEMS = [
  ["freight", /\b(?:freight|transport(?:ation)?|carriage|cartage)\b/i],
  ["insurance", /\binsurance\b/i],
  ["packing", /\b(?:packing|packaging|forwarding)\b|\bp\s*(?:&|and)\s*f\b/i],
];
// Phrases end at a semicolon, a line break, a full stop before a capital (so
// "incl. freight" stays one phrase), or a comma before the next item.
const COST_SENTENCE = /[;\n]|\.(?=\s+[A-Z]|$)/;
const COST_SPLIT = /,\s*(?=(?:and\s+)?(?:freight|insurance|transit|packing|packaging|forwarding|transport|p\s*(?:&|and)\s*f\b))/i;
const COST_VERDICTS = [
  [/\b(?:excluding|exclusive|excl\.?|extra|additional|at\s+actuals?|charged\s+(?:separately|extra)|to\s+be\s+charged|over\s+and\s+above|plus)\b/i, "extra"],
  [/\b(?:including|inclusive|incl\.?|included)\b/i, "included"],
  [/\bto\s+pay\b|\b(?:your|buyer'?s?|purchaser'?s?|customer'?s?)\s+(?:account|scope|end|cost)\b|\bby\s+(?:you|the\s+buyer|buyer|purchaser|customer)\b|\bborne\s+by\s+(?:you|the\s+buyer|buyer|purchaser)\b/i, "buyer"],
  [/\b(?:prepaid|paid)\b|\b(?:our|seller'?s?|supplier'?s?)\s+(?:account|scope|cost)\b|\bby\s+us\b|\bborne\s+by\s+(?:us|the\s+seller|seller|supplier)\b/i, "seller"],
];

const costVerdictOf = (seg) => {
  const pct = percentsIn(seg)[0];
  if (pct) return { pct: pct.value };
  for (const [re, v] of COST_VERDICTS) if (re.test(seg)) return v;
  return null;
};

// freight_insurance: { freight, insurance, packing }, or null. Each is buyer,
// seller, included, extra or { pct }. One verdict covers every item named in
// the same phrase: "Freight & insurance extra" makes both extra.
export const normalizeFreightInsurance = (raw) => {
  const t = prep(raw);
  if (!t) return null;
  const out = { freight: null, insurance: null, packing: null };
  for (const seg of t.split(COST_SENTENCE).flatMap((s) => s.split(COST_SPLIT))) {
    if (!seg || !seg.trim()) continue;
    const named = COST_ITEMS.filter(([, re]) => re.test(seg)).map(([k]) => k);
    if (!named.length) continue;
    const verdict = costVerdictOf(seg);
    if (verdict == null) continue;
    for (const k of named) if (out[k] == null) out[k] = verdict;
  }
  return out.freight == null && out.insurance == null && out.packing == null ? null : out;
};

// ── taxes ───────────────────────────────────────────────────────────────────

const TAX_WORD = /\b(?:gst|igst|cgst|sgst|ugst|taxe?s?|duties|vat)\b/i;
const TAX_INCLUSIVE = /\b(?:inclusive\s+of|including|incl\.?|inclusive|included)\b[^.;]*?\b(?:gst|taxe?s?|duties)\b|\b(?:gst|taxe?s?)\s+(?:is\s+|are\s+)?(?:inclusive|included)\b/i;
const TAX_EXTRA = /\b(?:exclusive\s+of|excluding|excl\.?|plus)\s*(?:all\s+)?(?:applicable\s+)?(?:gst|igst|taxe?s?|duties)\b|\+\s*(?:gst|igst|taxes)\b|\b(?:gst|igst|cgst|sgst|taxe?s?|duties)\b[^.;]*?\b(?:extra|additional|as\s+applicable|as\s+per\s+(?:actuals?|applicable)|at\s+actuals?|will\s+be\s+charged|charged\s+(?:extra|separately)|over\s+and\s+above)\b/i;

// taxes: { gst, rate_pct }, or null when the text names no tax. gst is extra
// or inclusive; "GST as applicable" is extra, which is how it is meant. A
// split CGST + SGST rate is summed.
export const normalizeTaxes = (raw) => {
  const t = prep(raw);
  if (!t || !TAX_WORD.test(t)) return null;
  let gst = null;
  if (TAX_EXTRA.test(t)) gst = "extra";
  else if (TAX_INCLUSIVE.test(t)) gst = "inclusive";
  let rate = null;
  const cgst = /\bcgst\b[^%\d]*(\d+(?:\.\d+)?)\s*%/i.exec(t);
  const sgst = /\b[su]gst\b[^%\d]*(\d+(?:\.\d+)?)\s*%/i.exec(t);
  if (cgst && sgst) rate = Number(cgst[1]) + Number(sgst[1]);
  else {
    const p = percentsIn(t)[0];
    if (p) rate = p.value;
  }
  if (gst == null && rate == null) return null;
  return { gst, rate_pct: rate };
};

// ── validity ────────────────────────────────────────────────────────────────

const VALID_TILL = /\b(?:till|until|upto|up\s+to|through|expir\w*|before|by|validity)\s*(?:on\s+)?(?:the\s+)?(?:date\s+)?[:-]?\s*$/i;
const VALID_FROM = /\b(?:from|dated|of)\s*(?:the\s+)?(?:date\s+)?[:-]?\s*$/i;

// validity: { days, expires_at }, or null.
//   "valid till 31.12.2026"     the printed date is the expiry
//   "30 days from 01.09.2026"   the printed date is the start
//   "30 days" and opts.from     opts.from (the quote date, YYYY-MM-DD) is
//                               the start
export const normalizeValidity = (raw, opts = {}) => {
  const t = prep(raw);
  if (!t) return null;
  const dur = durationIn(t);
  const days = dur ? toDays(dur.lo, dur.unit) : null;
  const d = dateIn(t);
  if (days == null && !d) return null;
  let expires = null;
  if (d && (!dur || VALID_TILL.test(d.before))) expires = d.iso;
  else if (d && days != null && VALID_FROM.test(d.before)) expires = addDaysIso(d.iso, days);
  else if (days != null && opts.from) expires = addDaysIso(opts.from, days);
  return { days, expires_at: expires };
};

// ── warranty months ─────────────────────────────────────────────────────────

const WARRANTY_FROM_WORDS = [
  [/\b(?:dispatch|despatch|shipment|invoice)\b/i, "dispatch"],
  [/\b(?:delivery|supply|receipt)\b/i, "delivery"],
  [/\b(?:installation|erection)\b/i, "installation"],
  [/\b(?:commissioning|start[\s-]?up|put\s+(?:in)?to\s+use)\b/i, "commissioning"],
];
const NO_WARRANTY = /\bno\s+warranty\b|\bwarranty\s*[:-]?\s*(?:nil|none|not\s+applicable|n\.?\s?a\.?)(?=[\s.;,]|$)|\bwithout\s+(?:any\s+)?warranty\b/i;

const firstFromAfter = (t, start, words) => {
  let best = null;
  for (const [re, code] of words) {
    const g = new RegExp(re.source, "gi");
    for (const m of t.matchAll(g)) {
      if (m.index < start) continue;
      if (!best || m.index < best.index) best = { code, index: m.index };
      break;
    }
  }
  return best ? best.code : null;
};

// warranty: { months, from, scope }, or null. The months and the start are
// rule fields; scope is wording for the LLM judge and is always null here.
// With two periods ("12 months from commissioning or 18 months from
// dispatch, whichever is earlier") the first stated period is read.
export const normalizeWarranty = (raw) => {
  const t = prep(raw);
  if (!t) return null;
  if (NO_WARRANTY.test(t)) return { months: 0, from: null, scope: null };
  const dur = durationIn(t);
  if (!dur) return null;
  const months = dur.unit === "year" ? dur.lo * 12
    : dur.unit === "month" ? dur.lo
      : Math.round(toDays(dur.lo, dur.unit) / 30);
  return { months, from: firstFromAfter(t, dur.end, WARRANTY_FROM_WORDS), scope: null };
};

// ── liquidated damages ──────────────────────────────────────────────────────

const LD_PER = /(?:\bper|\beach|\bevery|\b1|\/)\s*(?:completed\s+|full\s+)?(day|week)\b|\b(daily|weekly)\b/i;
const LD_CAP = /\b(?:max(?:imum)?|cap(?:ped)?|ceiling|limited\s+to|limit\s+of|subject\s+to|not\s+(?:to\s+)?exceed(?:ing)?|up\s*to|upto)\b/i;
const LD_EXCLUDED = /\b(?:not\s+applicable|n\.?\s?a\.?|nil|none|not\s+acceptable|excluded|(?:shall|will|does)\s+not\s+apply)(?=[\s.;,)]|$)|\bno\s+(?:ld|l\.d\.|liquidated|penalty)\b/i;

// ld_penalty: { rate_pct, per, cap_pct, excluded }, or null. The first
// percentage is the rate; a later one preceded by a cap word is the cap. A
// rate with no cap stays cap_pct null, which is an uncapped LD.
export const normalizeLdPenalty = (raw) => {
  const t = prep(raw);
  if (!t) return null;
  const pcts = percentsIn(t);
  if (!pcts.length) {
    return LD_EXCLUDED.test(t) ? { rate_pct: null, per: null, cap_pct: null, excluded: true } : null;
  }
  const rate = pcts[0];
  const perM = LD_PER.exec(t.slice(rate.end));
  const perWord = perM ? (perM[1] || perM[2]).toLowerCase() : null;
  const per = perWord === "daily" ? "day" : perWord === "weekly" ? "week" : perWord;
  let cap = null;
  for (const p of pcts.slice(1)) {
    if (LD_CAP.test(t.slice(Math.max(rate.end, p.index - 40), p.index))) { cap = p.value; break; }
  }
  return { rate_pct: rate.value, per, cap_pct: cap, excluded: false };
};

// ── by clause key ───────────────────────────────────────────────────────────

// The clauses a deterministic normalizer reads. The rest (inspection,
// cancellation, jurisdiction, one-sided clauses) are wording for the LLM
// judge, and normalizeClause returns null for them.
export const NORMALIZERS = Object.freeze({
  incoterm: normalizeIncoterm,
  payment_terms: normalizePaymentTerms,
  delivery_lead_time: normalizeLeadTime,
  price_basis: normalizePriceBasis,
  freight_insurance: normalizeFreightInsurance,
  taxes: normalizeTaxes,
  validity: normalizeValidity,
  warranty: normalizeWarranty,
  ld_penalty: normalizeLdPenalty,
});

export const normalizeClause = (clause, text, opts) => {
  const fn = NORMALIZERS[clause];
  return fn ? fn(text, opts) : null;
};
