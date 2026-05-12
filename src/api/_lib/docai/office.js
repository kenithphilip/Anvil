// DOCX / RTF text extractor (Wave 2.2 / #6).
//
// Background. Some customers (Crystal-Reports shops, smaller
// suppliers, government-buyer offices) email POs as Word .docx
// or rich-text .rtf instead of PDF. Before this commit the
// dispatcher routed every non-PDF / non-xlsx / non-gaeb input
// through the PDF text-layer extractor, which fails immediately
// on docx/rtf bytes; the run flips to status='image_pdf_no_text'
// and the operator sees a useless error.
//
// This adapter extracts plain text from:
//   - DOCX (Office Open XML, the modern .docx zip-of-XMLs format).
//     Pulled via mammoth (dynamic optional import). On any
//     failure, a minimal zip + regex pass extracts text from
//     word/document.xml.
//   - RTF (Rich Text Format). Pure-regex stripper; no library
//     required.
//   - DOC (legacy Word .doc binary). Mammoth doesn't handle this;
//     we surface an "unsupported_legacy_doc" reason so the operator
//     gets a clear error instead of a silent failure.
//
// Output mirrors text_layer.js so run.js can treat docx/rtf text
// uniformly: { ok, status, char_count, body_text, ... }. The
// dispatcher injects body_text into hints.bodyText and the LLM
// chain proceeds via the pre_extracted_text mode.

const RTF_MIME_REGEX = /^(application\/(rtf|x-rtf)|text\/rtf)$/i;
const DOCX_MIME_REGEX = /(officedocument\.wordprocessingml|msword)/i;

export const isDocx = ({ filename, mime, bytes }) => {
  const f = String(filename || "").toLowerCase();
  if (f.endsWith(".docx") || f.endsWith(".dotx") || f.endsWith(".dotm")) return true;
  if (DOCX_MIME_REGEX.test(String(mime || ""))) {
    // .doc legacy binary shares a mime with .docx in some
    // implementations; sniff the first bytes for the PK zip
    // header. If we have bytes, the zip magic is the safest tell.
    if (bytes && bytes.length >= 4) {
      return bytes[0] === 0x50 && bytes[1] === 0x4b;
    }
    return true;
  }
  return false;
};

export const isLegacyDoc = ({ filename, bytes }) => {
  const f = String(filename || "").toLowerCase();
  if (f.endsWith(".doc")) return true;
  // Compound File Binary signature (legacy .doc, .xls, .ppt).
  if (bytes && bytes.length >= 8) {
    return bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
  }
  return false;
};

export const isRtf = ({ filename, mime, bytes }) => {
  const f = String(filename || "").toLowerCase();
  if (f.endsWith(".rtf")) return true;
  if (RTF_MIME_REGEX.test(String(mime || ""))) return true;
  // {\rtf magic.
  if (bytes && bytes.length >= 5) {
    if (bytes[0] === 0x7b && bytes[1] === 0x5c && bytes[2] === 0x72 && bytes[3] === 0x74 && bytes[4] === 0x66) {
      return true;
    }
  }
  return false;
};

const loadMammoth = async () => {
  try {
    const specifier = "mammoth";
    const mod = await import(/* @vite-ignore */ specifier);
    return mod?.default || mod;
  } catch (_e) {
    return null;
  }
};

// Tiny zip reader fallback. We use the standard zip layout:
//   - End-of-central-directory record (EOCD): last 22 bytes of
//     the archive, signature 0x06054b50.
//   - Per-file local header: signature 0x04034b50.
// We only need word/document.xml; iterate local headers, find by
// name, inflate via node:zlib if compressed.
const findDocumentXml = async (bytes) => {
  if (!bytes || bytes.length < 22) return null;
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const LOCAL_SIG = 0x04034b50;
  let i = 0;
  while (i < buf.length - 30) {
    if (buf.readUInt32LE(i) !== LOCAL_SIG) { i++; continue; }
    const compression = buf.readUInt16LE(i + 8);
    const compSize = buf.readUInt32LE(i + 18);
    const uncompSize = buf.readUInt32LE(i + 22);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = buf.slice(i + 30, i + 30 + nameLen).toString("utf8");
    const dataStart = i + 30 + nameLen + extraLen;
    if (name === "word/document.xml") {
      const compressed = buf.slice(dataStart, dataStart + compSize);
      if (compression === 0) return compressed.toString("utf8");
      if (compression === 8) {
        try {
          const { inflateRawSync } = await import("node:zlib");
          return inflateRawSync(compressed, { maxOutputLength: uncompSize + 64 }).toString("utf8");
        } catch (_e) { return null; }
      }
      return null;
    }
    i = dataStart + compSize;
  }
  return null;
};

// Strip XML tags + collapse whitespace + un-escape entities.
// Returns a plain-text rendition of word/document.xml. Tables come
// out cell-by-cell, paragraph by paragraph, which is what the LLM
// chain wants.
export const docxXmlToText = (xml) => {
  if (!xml) return "";
  // Replace <w:tab/> with tab, <w:br/> with newline, <w:p ...> end
  // with paragraph break.
  let s = xml
    .replace(/<w:tab\s*\/>/g, "\t")
    .replace(/<w:br\s*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<\/w:tr>/g, "\n");
  // Strip everything else.
  s = s.replace(/<[^>]+>/g, "");
  // Decode the small XML entity set.
  s = s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
  // Collapse runs of 3+ blank lines.
  s = s.replace(/\n{3,}/g, "\n\n").trim();
  return s;
};

// Public DOCX path. Mammoth is preferred (handles styles, lists,
// hyperlinks) but the fallback covers the no-install case.
export const extractDocxText = async (bytes) => {
  if (!bytes || !bytes.length) return { ok: false, body_text: null, extractor: null, error: "no_bytes" };
  const mammoth = await loadMammoth();
  if (mammoth?.extractRawText) {
    try {
      const out = await mammoth.extractRawText({ buffer: Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes) });
      const text = (out?.value || "").trim();
      if (text.length) return { ok: true, body_text: text, extractor: "mammoth", error: null };
    } catch (err) {
      // Fall through to the zip-regex fallback below; we keep
      // the error so the audit trail records why mammoth failed.
      return await extractDocxTextFallback(bytes, err?.message || "mammoth_failed");
    }
  }
  return await extractDocxTextFallback(bytes, "mammoth_unavailable");
};

const extractDocxTextFallback = async (bytes, reason) => {
  const xml = await findDocumentXml(bytes);
  if (!xml) {
    return {
      ok: false, body_text: null,
      extractor: "docx_zip_fallback", error: reason + " | no document.xml",
    };
  }
  const text = docxXmlToText(xml);
  if (!text.length) {
    return {
      ok: false, body_text: null,
      extractor: "docx_zip_fallback", error: reason + " | empty_text",
    };
  }
  return { ok: true, body_text: text, extractor: "docx_zip_fallback", error: null };
};

// RTF stripper. RTF is a stream of control words ("\par", "\b0",
// "\rtf1"), groups in braces, and literal text. We strip control
// words, drop the {\fontTbl ...} and {\colortbl ...} groups, decode
// \uXXXX unicode escapes, and emit \par as newline.
export const stripRtf = (rtf) => {
  if (!rtf) return "";
  const src = typeof rtf === "string" ? rtf : Buffer.isBuffer(rtf) ? rtf.toString("latin1") : "";
  if (!src.length) return "";
  // 1. Strip header groups that carry no document text.
  let s = src.replace(/\{\\fonttbl[\s\S]*?\}/gi, "");
  s = s.replace(/\{\\colortbl[\s\S]*?\}/gi, "");
  s = s.replace(/\{\\stylesheet[\s\S]*?\}/gi, "");
  s = s.replace(/\{\\\*\\generator[\s\S]*?\}/gi, "");
  s = s.replace(/\{\\info[\s\S]*?\}/gi, "");
  s = s.replace(/\{\\\*\\latentstyles[\s\S]*?\}/gi, "");
  // 2. Decode \uXXXX unicode escapes; the next character after \uN
  //    is the "fallback" byte which we drop.
  s = s.replace(/\\u(-?\d+)\??\s?\.?/g, (_, n) => {
    let code = Number(n);
    if (!Number.isFinite(code)) return "";
    if (code < 0) code += 65536;
    try { return String.fromCharCode(code); } catch (_e) { return ""; }
  });
  // 3. Decode \'XX hex escapes (latin-1 bytes).
  s = s.replace(/\\'([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  // 4. Common escapes -> punctuation.
  s = s
    .replace(/\\par[d]?\b/gi, "\n")
    .replace(/\\line\b/gi, "\n")
    .replace(/\\tab\b/gi, "\t")
    .replace(/\\\*/g, "")
    .replace(/\\~/g, " ")
    .replace(/\\_/g, "-")
    .replace(/\\-/g, "-");
  // 5. Drop remaining control words including their numeric param.
  s = s.replace(/\\[A-Za-z]+-?\d*\s?/g, "");
  // 6. Unescape literal {, }, \ characters.
  s = s.replace(/\\\\/g, "\\").replace(/\\\{/g, "{").replace(/\\\}/g, "}");
  // 7. Drop remaining braces.
  s = s.replace(/[{}]/g, "");
  // 8. Collapse whitespace.
  s = s.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
  return s;
};

export const extractRtfText = async (bytes) => {
  if (!bytes || !bytes.length) return { ok: false, body_text: null, extractor: null, error: "no_bytes" };
  try {
    const text = stripRtf(bytes);
    if (!text.length) {
      return { ok: false, body_text: null, extractor: "rtf_strip", error: "empty_text" };
    }
    return { ok: true, body_text: text, extractor: "rtf_strip", error: null };
  } catch (err) {
    return { ok: false, body_text: null, extractor: "rtf_strip", error: err?.message || "rtf_failed" };
  }
};

// Single public entry that picks the parser based on the source
// shape. Returns the same envelope as text_layer.js so run.js can
// route uniformly.
//
//   { ok, status: 'has_text' | 'extract_failed',
//     page_count: 1 (docx/rtf have no page concept here),
//     char_count, body_text, page_breakdown: [],
//     extractor, extractor_version, latency_ms, error,
//     kind: 'docx' | 'rtf' | 'legacy_doc' }
export const extractOfficeText = async ({ bytes, filename, mime }) => {
  const t0 = Date.now();
  const probe = { bytes, filename, mime };
  if (isLegacyDoc(probe)) {
    return {
      ok: false,
      status: "extract_failed",
      page_count: 0,
      char_count: 0,
      body_text: null,
      page_breakdown: [],
      extractor: "legacy_doc",
      extractor_version: null,
      latency_ms: Date.now() - t0,
      error: "unsupported_legacy_doc",
      kind: "legacy_doc",
    };
  }
  if (isDocx(probe)) {
    const r = await extractDocxText(bytes);
    const charCount = r.body_text?.length || 0;
    return {
      ok: r.ok,
      status: r.ok ? "has_text" : "extract_failed",
      page_count: r.ok ? 1 : 0,
      char_count: charCount,
      body_text: r.body_text,
      page_breakdown: r.ok ? [{ page: 1, chars: charCount, has_text: true }] : [],
      extractor: r.extractor,
      extractor_version: null,
      latency_ms: Date.now() - t0,
      error: r.error,
      kind: "docx",
    };
  }
  if (isRtf(probe)) {
    const r = await extractRtfText(bytes);
    const charCount = r.body_text?.length || 0;
    return {
      ok: r.ok,
      status: r.ok ? "has_text" : "extract_failed",
      page_count: r.ok ? 1 : 0,
      char_count: charCount,
      body_text: r.body_text,
      page_breakdown: r.ok ? [{ page: 1, chars: charCount, has_text: true }] : [],
      extractor: r.extractor,
      extractor_version: null,
      latency_ms: Date.now() - t0,
      error: r.error,
      kind: "rtf",
    };
  }
  return {
    ok: false,
    status: "extract_failed",
    page_count: 0,
    char_count: 0,
    body_text: null,
    page_breakdown: [],
    extractor: "office_router",
    extractor_version: null,
    latency_ms: Date.now() - t0,
    error: "not_office",
    kind: null,
  };
};

export const __test = { findDocumentXml };
