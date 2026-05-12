// Layout fingerprint dedupe (Wave 3.5 / #21).
//
// Content-hash dedupe (Wave 1.3) only catches a literally
// identical re-upload. Two POs from the same customer carry
// DIFFERENT content (different line items, different PO number,
// different totals) but the same LAYOUT. The header block sits
// at the same y-coordinate, the line-items table has the same
// columns in the same order, the totals row anchors at the same
// place at the bottom.
//
// When two runs share a layout fingerprint:
//   1. The TOC profiler can skip the re-classify call (the prior
//      run's line-item-pages map is reusable).
//   2. The customer template (Phase D) is essentially guaranteed
//      to apply, so we can skip the rebuild/apply round trip and
//      go straight to the template's known fields.
//   3. The adapter that won on the prior layout (gemini vs claude
//      vs reducto) should win again; bias the dispatcher's order.
//
// Fingerprint design. We avoid hashing pixel data (expensive,
// brittle on small layout shifts). Instead we hash a TEXT-derived
// signature:
//
//   - The first 20 distinct non-numeric tokens from the
//     extracted body_text (headers, labels: "PURCHASE ORDER",
//     "INVOICE #", "BILL TO", "SHIP TO", "ITEM", "QTY", "RATE",
//     "AMOUNT", "TOTAL"...).
//   - The number of pages.
//   - The size of the bodyText in 1KB buckets (so a 4KB doc
//     fingerprints differently from a 40KB doc even when both
//     have the same header words).
//
// The hash is sha-256(JSON.stringify([tokens, pageBuckets,
// sizeBucket])). Collision-resistant for our scale; trivially
// fast.

const TOKEN_LIMIT = 20;
const STOP_WORDS = new Set([
  "a","an","the","and","or","of","for","with","to","in","by",
  "no","number","date","from","this","that","is","are","was",
]);

const sigTokens = (text) => {
  if (!text || typeof text !== "string") return [];
  const seen = new Set();
  const out = [];
  const tokens = text.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean);
  for (const t of tokens) {
    if (t.length < 3) continue;
    if (STOP_WORDS.has(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= TOKEN_LIMIT) break;
  }
  return out;
};

// Bucket the size to nearest KB.
const sizeBucket = (bytes) => Math.floor((bytes || 0) / 1024);

// Public: compute a layout-fingerprint string given body text,
// page count, and source size in bytes. Pure: no I/O.
export const computeLayoutFingerprint = async ({ bodyText, pageCount, sourceSizeBytes }) => {
  const sig = JSON.stringify([
    sigTokens(bodyText || ""),
    Number(pageCount) || 0,
    sizeBucket(sourceSizeBytes),
  ]);
  try {
    const sub = globalThis.crypto?.subtle;
    if (sub && typeof sub.digest === "function") {
      const enc = new TextEncoder().encode(sig);
      const digest = await sub.digest("SHA-256", enc);
      return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
    }
  } catch (_e) { /* fall through */ }
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(sig).digest("hex");
};

// Look up the most-recent extraction run with a matching layout
// fingerprint for the same (tenant, customer). Returns null when
// no match. Used by the dispatcher to bias adapter order toward
// whichever adapter won on the prior layout.
export const findRunByLayoutFingerprint = async (svc, { tenantId, customerId, layoutFingerprint }) => {
  if (!svc || !tenantId || !layoutFingerprint) return null;
  try {
    let q = svc.from("extraction_runs")
      .select("id, adapter_used, confidence_overall, normalized_extract, status, template_used, global_template_used, created_at")
      .eq("tenant_id", tenantId)
      .eq("layout_fingerprint", layoutFingerprint)
      .eq("status", "ok")
      .order("created_at", { ascending: false })
      .limit(1);
    q = customerId ? q.eq("customer_id", customerId) : q.is("customer_id", null);
    const r = await q.maybeSingle();
    return r?.data || null;
  } catch (_e) { return null; }
};

// Build an adapter-order bias from the prior layout run. When
// the prior adapter_used was 'voter', we don't bias (voter mode
// is opt-in and rare); otherwise prepend the prior winner.
export const adapterBiasFromPriorLayout = (priorRun) => {
  if (!priorRun?.adapter_used) return null;
  if (priorRun.adapter_used === "voter") return null;
  if (priorRun.adapter_used === "excel" || priorRun.adapter_used === "gaeb") return null;
  return [priorRun.adapter_used];
};

export const __test = { sigTokens, sizeBucket };
