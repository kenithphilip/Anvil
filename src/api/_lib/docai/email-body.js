// Email-body extractor (Wave 2.3 / #7).
//
// Background. ~10% of customer POs (especially small B2B
// suppliers, government buyers, ad-hoc reorders) arrive as the
// email body itself, with no PDF attachment. Today the inbound-
// email pipeline writes the body to preflight_payload.text on the
// draft order and stops; the operator copies the body into the
// extraction form by hand or asks the sender to attach a proper
// PO. Both are friction.
//
// This module turns the email body into a synthetic "document"
// that the existing extraction pipeline can process:
//
//   1. Prefer body_text (Postmark / Microsoft Graph both emit a
//      plain-text rendering alongside the HTML). When body_text
//      is empty, strip the HTML into plain text.
//   2. Trim signatures, footer disclaimers, quoted reply chains.
//      Without trimming, the model sees three copies of "Best
//      regards, John" + a thread of historical replies and bleeds
//      attention from the actual line items.
//   3. Return the cleaned body. The dispatcher feeds it via
//      hints.bodyText to the existing pre_extracted_text path
//      (same path L1 PDF text and L2 OCR feed into).
//
// Heuristics, not parsing. We don't try to grok arbitrary mime
// payloads; the upstream Postmark / Microsoft Graph webhooks
// already give us body_text + body_html. We just clean what they
// hand us.

const MAX_BODY_BYTES = 100_000;       // generous cap; downstream slices to 50K anyway
const MIN_PO_LIKE_CHARS = 80;         // below this, body is probably not a PO

// Signature / footer regexes (English; multi-language land in 2.4).
// First-match-wins on each line, anchored to the start of line.
const SIGNATURE_PATTERNS = [
  /^[\s>]*--+\s*$/,                                              // standard sig delim
  /^[\s>]*-{2,}\s*Original Message\s*-{2,}/i,                    // Outlook reply marker
  /^[\s>]*From:\s.+?Sent:\s/i,                                   // Outlook quoted-from header
  /^[\s>]*On\s.+\s+wrote:\s*$/i,                                 // Gmail quote marker
  /^[\s>]*Best (regards|wishes)[,]?\s*$/i,
  /^[\s>]*Kind regards[,]?\s*$/i,
  /^[\s>]*Thanks( and| &)? (regards|kind regards)[,]?\s*$/i,
  /^[\s>]*Sent from my (iPhone|iPad|Android|mobile device)\b/i,
  /^[\s>]*This email and any attachments are confidential\b/i,
];

const QUOTE_LINE_PATTERN = /^[\s]*[>|]/;     // ">" or "|" reply quoting

// Strip a simple-ish HTML payload to text. Not a real parser: we
// remove scripts/styles, convert <br> / </p> / </div> / </tr> to
// newlines, drop every other tag, decode the small entity set.
export const htmlToText = (html) => {
  if (!html || typeof html !== "string") return "";
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");
  s = s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/h[1-6]>/gi, "\n\n");
  s = s.replace(/<[^>]+>/g, "");
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return Number.isFinite(code) ? String.fromCharCode(code) : "";
    });
  s = s.replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return s;
};

// Drop signature blocks and quoted-reply chains. Returns the body
// up to (but not including) the first signature / quote marker
// that we recognise. Conservative: if no marker fires, the body
// passes through unchanged.
export const stripSignaturesAndQuotes = (text) => {
  if (!text) return "";
  const lines = text.split(/\r?\n/);
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (SIGNATURE_PATTERNS.some((re) => re.test(line))) { cut = i; break; }
    if (QUOTE_LINE_PATTERN.test(line)) {
      // A single quoted line in the middle of a body is fine; a
      // run of 3+ consecutive quote lines is the reply chain.
      let j = i;
      while (j < lines.length && (QUOTE_LINE_PATTERN.test(lines[j]) || lines[j].trim() === "")) j++;
      if (j - i >= 3) { cut = i; break; }
    }
  }
  return lines.slice(0, cut).join("\n").trim();
};

// Cheap "is this a PO-shaped email" heuristic. Looks for the kind
// of token soup a PO body usually carries: "purchase order", a
// PO number, table-ish lines with qty + price, a total. Returns
// 0..1; the caller decides the threshold.
export const poLikenessScore = (text) => {
  // Minimum length guard: below ~30 chars the regex matches are
  // accidents; we'd score "Best regards" as a near-PO. The
  // prepareEmailBody() wrapper applies its own (taller) length
  // gate around this so the cumulative threshold is consistent.
  if (!text || text.length < 30) return 0;
  let score = 0;
  const lower = text.toLowerCase();
  if (/\bpurchase\s+order\b/.test(lower)) score += 0.30;
  if (/\bpo\s*(no|number|#)\b/.test(lower)) score += 0.15;
  if (/\b(quantity|qty)\b/.test(lower)) score += 0.10;
  if (/\b(unit\s+price|rate|amount)\b/.test(lower)) score += 0.10;
  if (/\b(hsn|sac)\b/.test(lower)) score += 0.10;
  if (/\b(gst|tax|cgst|sgst|igst)\b/.test(lower)) score += 0.05;
  if (/\btotal\b/.test(lower)) score += 0.05;
  // Currency / numeric pattern: any line with a number that looks
  // like a price (1234.56) or a quantity ("5 NOS").
  if (/\b\d+(\.\d{2})\b/.test(text)) score += 0.05;
  if (/\b\d+\s*(nos|pcs|pieces|set|each|kg|m|mt|ton|lpc)\b/i.test(text)) score += 0.10;
  return Math.min(1, score);
};

// Build the cleaned body. Prefers body_text; falls back to a
// HTML-to-text conversion of body_html. Returns null when there
// is no usable signal.
//
// Output:
//   { ok, body_text, original_chars, cleaned_chars,
//     po_likeness, source: 'body_text' | 'body_html',
//     trimmed_signature: boolean }
export const prepareEmailBody = ({ body_text, body_html, opts = {} }) => {
  // Prefer body_text when it has SOME content; fall back to
  // body_html stripped to text. The PO-likeness score (below) is
  // the real gate, not the raw length.
  let source = null;
  let raw = "";
  if (typeof body_text === "string" && body_text.trim().length > 0) {
    raw = body_text;
    source = "body_text";
  } else if (typeof body_html === "string" && body_html.trim().length > 0) {
    raw = htmlToText(body_html);
    source = "body_html";
  }
  if (!raw || raw.length === 0) {
    return { ok: false, body_text: null, source: null, po_likeness: 0, reason: "no_body" };
  }
  const originalChars = raw.length;
  const cleaned = stripSignaturesAndQuotes(raw);
  const trimmedSig = cleaned.length < raw.length;
  const score = poLikenessScore(cleaned);
  const threshold = Number.isFinite(Number(opts.minPoLikeness))
    ? Number(opts.minPoLikeness)
    : 0.25;
  // Cumulative gate: a body must be long enough to plausibly be a
  // PO AND score above the threshold. "Long enough" is intentionally
  // low because some POs are tabular and terse.
  const minChars = Number.isFinite(Number(opts.minChars))
    ? Number(opts.minChars)
    : 40;
  if (cleaned.length < minChars) {
    return {
      ok: false,
      body_text: null,
      source,
      original_chars: originalChars,
      cleaned_chars: cleaned.length,
      po_likeness: score,
      trimmed_signature: trimmedSig,
      reason: "too_short",
    };
  }
  if (score < threshold) {
    return {
      ok: false,
      body_text: null,
      source,
      original_chars: originalChars,
      cleaned_chars: cleaned.length,
      po_likeness: score,
      trimmed_signature: trimmedSig,
      reason: "not_po_shaped",
    };
  }
  const finalText = cleaned.length > MAX_BODY_BYTES ? cleaned.slice(0, MAX_BODY_BYTES) : cleaned;
  return {
    ok: true,
    body_text: finalText,
    source,
    original_chars: originalChars,
    cleaned_chars: finalText.length,
    po_likeness: score,
    trimmed_signature: trimmedSig,
  };
};

export const __test = { MIN_PO_LIKE_CHARS, MAX_BODY_BYTES };
