// Batch processing for queued docs (Wave 5.1 / #22).
//
// The cron worker (/api/cron/tick -> auto_ocr.js) currently drains
// the documents queue ONE at a time. Each iteration:
//   1. SELECT one pending doc
//   2. runExtractionPipeline (3-30s)
//   3. UPDATE doc status
// At a 60-second function timeout and a 5-minute cron cadence, we
// can drain 6-12 docs per tick on the happy path; a backlog of
// 200 docs takes hours.
//
// This module:
//
//   - planBatch(queue, opts) shapes a list of pending docs into
//     batches that can run within the function budget. Heuristic:
//     small docs (<5 pages, no OCR needed) batch up to 5 at a
//     time; large docs run alone.
//   - runBatch(svc, batch, runOne) iterates the batch with a
//     soft deadline. Stops early when the deadline approaches so
//     we don't truncate mid-extraction.
//   - schedulePartialResume(svc, remaining) writes the unprocessed
//     remainder back to the queue with a "next" priority so the
//     next cron tick picks them up first.
//
// Pure orchestration: this module doesn't talk to the LLM or DB
// itself; it's the planner the cron worker uses.

const DEFAULT_BUDGET_MS = 50_000;        // Vercel 60s -> 50s soft cap
const DEFAULT_SMALL_DOC_BATCH = 5;
const DEFAULT_PER_DOC_BUDGET_MS = 8_000;

// Decide the per-doc weight class.
//   'small'  -> short text PDF / xlsx / RTF, <5 pages
//   'medium' -> 5-20 pages OR has image-only pages
//   'large'  -> >20 pages OR known OCR-heavy (scanned)
export const classifyDoc = (doc) => {
  const pages = Number(doc?.page_count || 0);
  const mime = String(doc?.mime_type || "").toLowerCase();
  const sizeKb = Math.round((Number(doc?.size_bytes || 0)) / 1024);
  if (mime.startsWith("image/")) return "medium";
  if (mime === "application/pdf") {
    if (pages >= 20) return "large";
    if (pages >= 5) return "medium";
    if (sizeKb >= 4096) return "medium";
    return "small";
  }
  // .docx / .rtf / .xlsx / .gaeb -> text path is cheap.
  if (/(spreadsheet|wordprocessing|xml|rtf|csv|excel)/.test(mime)) return "small";
  return "medium";
};

// Group docs into batches. Small docs cluster (up to N per
// batch); medium and large run alone. Returns an array of
// arrays of doc ids in run order.
export const planBatch = (queue, opts = {}) => {
  const smallSize = Number(opts.smallBatchSize || DEFAULT_SMALL_DOC_BATCH);
  const batches = [];
  let smallBuffer = [];
  for (const doc of queue) {
    const cls = classifyDoc(doc);
    if (cls === "small") {
      smallBuffer.push(doc);
      if (smallBuffer.length >= smallSize) {
        batches.push(smallBuffer);
        smallBuffer = [];
      }
    } else {
      if (smallBuffer.length) {
        batches.push(smallBuffer);
        smallBuffer = [];
      }
      batches.push([doc]);
    }
  }
  if (smallBuffer.length) batches.push(smallBuffer);
  return batches;
};

// Run a batch with a soft deadline. runOne(doc) is the caller-
// supplied async function (typically a wrapper around
// runExtractionPipeline). Returns:
//   { processed, remaining, durations_ms, errors }
export const runBatch = async (batch, runOne, opts = {}) => {
  if (!Array.isArray(batch) || !batch.length || typeof runOne !== "function") {
    return { processed: [], remaining: batch || [], durations_ms: [], errors: [] };
  }
  const budgetMs = Number(opts.budgetMs || DEFAULT_BUDGET_MS);
  const perDocBudgetMs = Number(opts.perDocBudgetMs || DEFAULT_PER_DOC_BUDGET_MS);
  const deadline = Date.now() + budgetMs;
  const processed = [];
  const errors = [];
  const durations = [];
  for (let i = 0; i < batch.length; i++) {
    const doc = batch[i];
    if (Date.now() + perDocBudgetMs > deadline) {
      return {
        processed,
        remaining: batch.slice(i),
        durations_ms: durations,
        errors,
      };
    }
    const t0 = Date.now();
    try {
      const result = await runOne(doc);
      processed.push({ doc, result });
    } catch (err) {
      errors.push({ doc, error: err?.message || String(err) });
    }
    durations.push(Date.now() - t0);
  }
  return { processed, remaining: [], durations_ms: durations, errors };
};

// Schedule the unprocessed remainder for the next cron tick by
// raising a priority flag on each remaining doc row. The doc
// table is generic so the caller passes the field name.
export const schedulePartialResume = async (svc, remaining, opts = {}) => {
  if (!svc || !Array.isArray(remaining) || !remaining.length) return { ok: true, deferred: 0 };
  const table = opts.table || "documents";
  const idField = opts.idField || "id";
  const priorityField = opts.priorityField || "auto_ocr_priority";
  const ids = remaining.map((d) => d[idField]).filter(Boolean);
  if (!ids.length) return { ok: true, deferred: 0 };
  try {
    const r = await svc.from(table)
      .update({ [priorityField]: "high", auto_ocr_deferred_at: new Date().toISOString() })
      .in(idField, ids);
    if (r.error) return { ok: false, error: r.error.message };
    return { ok: true, deferred: ids.length };
  } catch (err) {
    return { ok: false, error: err?.message || "update_failed" };
  }
};

export const __test = { DEFAULT_BUDGET_MS, DEFAULT_SMALL_DOC_BATCH };
