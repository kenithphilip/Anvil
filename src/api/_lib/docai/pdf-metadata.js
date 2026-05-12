// PDF metadata-driven adapter bias.
//
// PDFs carry authoring metadata (/Producer, /Creator, /Title,
// /Subject, /Author, /Keywords). A PO emitted from SAP
// NetWeaver-Java reads "SAPSprint" or "SAP ECC" in /Producer
// almost always; a Word-exported PO reads "Microsoft Word"; an
// Adobe Acrobat scan reads "Adobe Acrobat <version>". The
// layout these tools emit is highly predictable, so we can bias
// the adapter chain BEFORE we read a single page of content.
//
// This module reads the metadata via pdf-lib and returns either
// an ordered list of adapter names to try first, or null when
// the metadata signals nothing useful. The dispatcher in
// src/api/_lib/docai/index.js prepends the bias to its default
// order; tenant overrides (settings.docai_provider_order) still
// win at the highest priority.
//
// Cheap probe. The PDF is already loaded once for chunking +
// profiling; reading the metadata is a constant-time operation
// on the loaded doc. We don't add a second I/O round trip.

import { PDFDocument } from "pdf-lib";

// Rule format: { match: RegExp | substring, bias: string[],
// label: string }. First match wins. label appears in the
// audit trail so an operator can see WHY a particular adapter
// was tried first.
const RULES = [
  // SAP variants. The vast majority of SAP-emitted PDFs come from
  // SAPSprint (R/3, ECC, NetWeaver). S/4HANA Fiori uses different
  // metadata but the layout is similar enough to share the bias.
  // Reducto's table-extraction wins on these vertical-block
  // formats; Claude is a strong fallback.
  { match: /SAPSprint|NetWeaver|SAP ECC|R\/3|S\/4HANA/i, bias: ["reducto", "claude"], label: "sap" },
  // Tally voucher PDFs. Tally exports use very predictable
  // layouts; the template-only path usually wins.
  { match: /TallyPrime|Tally\.ERP/i, bias: ["docling", "marker", "reducto"], label: "tally" },
  // Microsoft Office (Word / Excel). Word docs sometimes come
  // through as PDFs; their table layouts are flat and unstructured
  // and benefit from docling / marker.
  { match: /Microsoft Word|Microsoft Office Word/i, bias: ["docling", "marker", "claude"], label: "office_word" },
  { match: /Microsoft Excel|Microsoft Office Excel/i, bias: ["docling", "marker", "claude"], label: "office_excel" },
  // Adobe Acrobat scans + form fills. Acrobat-saved PDFs are
  // often image-based scans; Azure DI + Mistral OCR are the path.
  { match: /Adobe Acrobat|Acrobat Pro|Adobe PDF Library/i, bias: ["azure_di", "claude"], label: "acrobat" },
  // iText / iTextSharp. SAP and Oracle PeopleSoft both ship
  // iText-generated PDFs with strict tabular layouts that
  // reducto handles well.
  { match: /iText(Sharp)?/i, bias: ["reducto", "azure_di", "claude"], label: "itext" },
  // Crystal Reports (often older enterprise systems). Heavily
  // tabular, fixed widths; structured extractors win.
  { match: /Crystal Reports/i, bias: ["azure_di", "reducto"], label: "crystal" },
  // wkhtmltopdf (web-to-PDF conversion). Usually e-commerce or
  // SaaS-emitted POs; structured but with HTML-ish quirks.
  { match: /wkhtmltopdf|Puppeteer|Chromium/i, bias: ["docling", "marker"], label: "html_to_pdf" },
  // Hyundai-style vertical block layouts. The Hyundai PO carries
  // distinctive metadata; reducto wins consistently per pilot
  // data.
  { match: /Hyundai|HMIL/i, bias: ["reducto", "azure_di", "claude"], label: "hyundai" },
];

const toUint8 = (input) => {
  if (input == null) return null;
  if (input instanceof Uint8Array) return input;
  if (input && typeof input === "object" && "buffer" in input) {
    return new Uint8Array(input.buffer, input.byteOffset || 0, input.byteLength);
  }
  if (typeof input === "string") {
    const buf = Buffer.from(input, "base64");
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  return null;
};

const safeRead = (doc, key) => {
  try {
    if (key === "producer") return doc.getProducer?.() || null;
    if (key === "creator") return doc.getCreator?.() || null;
    if (key === "title") return doc.getTitle?.() || null;
    if (key === "subject") return doc.getSubject?.() || null;
    if (key === "author") return doc.getAuthor?.() || null;
    if (key === "keywords") return doc.getKeywords?.() || null;
    return null;
  } catch (_) { return null; }
};

// Public entry. Returns:
//   { producer, creator, title, subject, author, keywords,
//     bias_adapters: string[] | null,
//     bias_label: string | null }
//
// On parse failure or no rule match, bias_adapters + bias_label
// stay null; the dispatcher falls back to its default order.
export const readPdfBias = async (input) => {
  const bytes = toUint8(input);
  if (!bytes) {
    return { producer: null, creator: null, title: null, subject: null, author: null, keywords: null, bias_adapters: null, bias_label: null };
  }
  let doc;
  try { doc = await PDFDocument.load(bytes, { ignoreEncryption: true }); }
  catch (_e) {
    return { producer: null, creator: null, title: null, subject: null, author: null, keywords: null, bias_adapters: null, bias_label: null };
  }
  const meta = {
    producer: safeRead(doc, "producer"),
    creator: safeRead(doc, "creator"),
    title: safeRead(doc, "title"),
    subject: safeRead(doc, "subject"),
    author: safeRead(doc, "author"),
    keywords: safeRead(doc, "keywords"),
  };
  // Concatenate every text field so a single rule can match on
  // any combination ("Hyundai" might be in /Subject; "SAP" in
  // /Producer). Empty strings are fine.
  const haystack = [meta.producer, meta.creator, meta.title, meta.subject, meta.author, meta.keywords]
    .filter(Boolean).join(" | ");
  for (const r of RULES) {
    if (r.match instanceof RegExp ? r.match.test(haystack) : haystack.includes(r.match)) {
      return { ...meta, bias_adapters: r.bias, bias_label: r.label };
    }
  }
  return { ...meta, bias_adapters: null, bias_label: null };
};

// Compose a final adapter order by prepending the bias to the
// caller's default order, deduping. Bias adapters that aren't
// in the default order (e.g., a tenant who hasn't enabled
// reducto) are silently dropped so we don't try to call an
// unconfigured adapter.
export const composeOrderWithBias = (defaultOrder, biasAdapters) => {
  if (!Array.isArray(biasAdapters) || !biasAdapters.length) return defaultOrder;
  const defaultSet = new Set(defaultOrder);
  const head = biasAdapters.filter((a) => defaultSet.has(a));
  if (!head.length) return defaultOrder;
  const tail = defaultOrder.filter((a) => !head.includes(a));
  return [...head, ...tail];
};

export const __test = { RULES, composeOrderWithBias };
