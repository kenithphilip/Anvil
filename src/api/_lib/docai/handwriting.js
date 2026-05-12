// Handwriting detection + routing (Wave 2.5 / #4).
//
// Some POs (Tamil-Nadu shop counters, small Kerala suppliers,
// ad-hoc reorders from B2B retail) arrive as a phone photo of a
// handwritten note. Printed-text OCR engines (Mistral OCR, Azure
// Read API standard mode) consistently miss-read cursive: a
// "5" reads as "S", "0" reads as "O", and entire words become
// nonsense. The result is a 12-character body_text that fails
// the L1 usable-text threshold and falls through to the LLM with
// no useful input.
//
// Two-stage approach:
//
//   1. DETECTION. After L2 OCR completes, scan the per-page
//      block confidences. Low average confidence (< 0.55), high
//      variance, and a non-trivial bbox count signal handwriting
//      OR a damaged scan. A separate signal is the ratio of
//      "garbled" tokens to plausible ones in the OCR output;
//      garbled here means a long run of non-word characters.
//
//   2. ROUTING. When detection fires, we mark the run with
//      handwriting_suspected=true and the recon UI surfaces a
//      "Re-OCR with handwriting engine" affordance. The actual
//      handwriting engine call (Azure Read API in handwritten
//      mode, or Google Document AI's handwritten-text option,
//      or Anthropic claude-3.5-sonnet vision in `read aloud`
//      mode) is a tenant-configurable adapter via
//      settings.docai_handwriting_provider.
//
// This wave ships the detection + the routing scaffold. The
// dedicated handwriting adapter call is gated behind a tenant
// flag; without it we still surface the signal to the operator
// who can manually re-route the document.

const LOW_CONFIDENCE_THRESHOLD = 0.55;
const MIN_BBOX_COUNT = 6;                      // below this, signal is noise
const GARBLED_TOKEN_RATIO_THRESHOLD = 0.40;

// Per-page confidence stats: mean, stddev, count. Returns null
// when no block carries a confidence number.
export const pageConfidenceStats = (pageBreakdown) => {
  if (!Array.isArray(pageBreakdown) || !pageBreakdown.length) return null;
  const vals = pageBreakdown
    // Filter out null + undefined BEFORE Number() because
    // Number(null) === 0 which would silently inflate the sample.
    .filter((p) => p && p.confidence != null)
    .map((p) => Number(p.confidence))
    .filter((v) => Number.isFinite(v));
  if (!vals.length) return null;
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length;
  return { mean, stddev: Math.sqrt(variance), count: vals.length };
};

// Count word-like tokens vs garbled non-word runs. Garbled = a
// token with 3+ consecutive non-letter, non-digit, non-space
// characters; OCR cursive failure mode usually emits sequences
// like "x{|j!" or "qwprtv" mixing of letters that no word has.
const isGarbledToken = (tok) => {
  if (!tok || tok.length < 3) return false;
  let nonWord = 0;
  for (const ch of tok) {
    if (!/[\p{L}\p{N}\s\-_.,/']/u.test(ch)) nonWord++;
  }
  return nonWord / tok.length >= 0.50;
};

export const garbledTokenRatio = (text) => {
  if (!text || typeof text !== "string") return 0;
  const tokens = text.split(/\s+/).filter((t) => t.length >= 3);
  if (!tokens.length) return 0;
  let bad = 0;
  for (const t of tokens) {
    if (isGarbledToken(t)) bad++;
  }
  return bad / tokens.length;
};

// Public: does the OCR output look like handwriting?
//
// Returns:
//   {
//     suspected: bool,
//     score: 0..1,
//     signals: { mean_confidence, stddev_confidence, bbox_count,
//                garbled_token_ratio }
//   }
//
// Signals carry through to the audit trail. The dispatcher / UI
// can read them directly to render a tooltip explaining why we
// flagged the run.
export const detectHandwriting = (ocrLayer) => {
  if (!ocrLayer) {
    return { suspected: false, score: 0, signals: null };
  }
  const conf = pageConfidenceStats(ocrLayer.page_breakdown);
  const bboxCount = Number(ocrLayer.bbox_count || 0);
  const garbled = garbledTokenRatio(ocrLayer.body_text || "");
  // Score: weight the confidence signal hardest; back it up with
  // garbled-token signal so a scan that the upstream engine
  // confidently mis-reads still surfaces. The piecewise map is
  // tuned so:
  //   - mean conf < 0.40 + non-trivial bbox count -> full 0.6
  //   - mean conf between 0.40 and 0.55 -> scaled 0..0.6
  //   - mean conf >= 0.55 -> 0 (clean scan)
  // Garbled-token ratio above 0.4 contributes up to another 0.4.
  let score = 0;
  if (conf && conf.mean < LOW_CONFIDENCE_THRESHOLD && bboxCount >= MIN_BBOX_COUNT) {
    if (conf.mean <= 0.40) {
      score += 0.6;
    } else {
      score += 0.6 * (LOW_CONFIDENCE_THRESHOLD - conf.mean) / (LOW_CONFIDENCE_THRESHOLD - 0.40);
    }
  }
  if (garbled >= GARBLED_TOKEN_RATIO_THRESHOLD) {
    score += 0.4 * (garbled - GARBLED_TOKEN_RATIO_THRESHOLD) / (1 - GARBLED_TOKEN_RATIO_THRESHOLD);
  }
  score = Math.max(0, Math.min(1, score));
  const suspected = score >= 0.45;
  return {
    suspected,
    score,
    signals: {
      mean_confidence: conf?.mean ?? null,
      stddev_confidence: conf?.stddev ?? null,
      bbox_count: bboxCount,
      garbled_token_ratio: garbled,
    },
  };
};

// Public routing decision. Given the detection output + tenant
// settings, return:
//   { action: 'none' | 'reocr_handwriting' | 'escalate_to_human',
//     provider: string | null, reason: string }
//
// Decision tree:
//   - score < 0.45 -> action 'none', no change.
//   - score 0.45-0.75 -> action 'reocr_handwriting' if a provider
//     is configured; else 'escalate_to_human'.
//   - score >= 0.75 -> action 'escalate_to_human' always (the
//     scan is too poor for any automated path to recover).
export const planHandwritingRoute = (detection, settings) => {
  if (!detection?.suspected) {
    return { action: "none", provider: null, reason: "not_handwritten" };
  }
  const provider = settings?.docai_handwriting_provider || null;
  if (detection.score >= 0.75) {
    return { action: "escalate_to_human", provider, reason: "score_too_high_for_auto" };
  }
  if (provider) {
    return { action: "reocr_handwriting", provider, reason: "auto_reroute" };
  }
  return { action: "escalate_to_human", provider: null, reason: "no_provider_configured" };
};

export const __test = {
  LOW_CONFIDENCE_THRESHOLD,
  MIN_BBOX_COUNT,
  GARBLED_TOKEN_RATIO_THRESHOLD,
  isGarbledToken,
};
