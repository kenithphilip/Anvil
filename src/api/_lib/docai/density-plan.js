// Shared "should this document be row-windowed, and into how many windows"
// decision, so the SYNC path, the BACKGROUND-eligibility check and the job
// WORKER all answer it the same way (Phase 3b).
//
// The worker never persists the window text. Like the page chunker -- which
// re-materialises each chunk's bytes per tick rather than storing them
// ("we re-materialise bytes on each tick rather than persisting them") --
// planRowWindows is PURE over the same text layer, so tick N can re-derive
// exactly the same window N. That is what makes row windows viable in a
// stateless serverless worker with no new storage.

import { planRowWindows, shouldRowChunk } from "./text-row-chunker.js";
import { isDensityKind } from "./density-chunk.js";

// How many row windows a SYNCHRONOUS run can be expected to finish. Windows run
// sequentially at the generation tier inside one function invocation, so past a
// handful the run deadline, not the model, is the binding constraint -- that is
// the document that belongs in the background.
// Deliberately small. The sync walk gets RUN_BUDGET_MS minus the fallback
// reserve (~30s) of SEQUENTIAL generation-tier calls, so a budget set to what
// we WISH fit creates a dead zone: a document just under it stays sync, cannot
// finish, is not adopted (incomplete), and -- because it was never flagged
// large -- is never enqueued either. Better to send a borderline document to
// the background, where finishing is not in doubt.
export const SYNC_WINDOW_BUDGET = Math.max(
  1, Number(process.env.DOCAI_SYNC_WINDOW_BUDGET) || 3,
);

// Plan row windows for a document, or explain why not.
//
//   { eligible, reason, plan, windowCount, itemCount, needsBackground }
//
// `needsBackground` is the Phase 3b signal: the document IS row-chunkable but
// has more windows than a sync run should attempt, so the caller should enqueue
// a background job instead of starting a walk it cannot finish.
export const planDensityChunking = ({ kind, bodyText, settings, minItems } = {}) => {
  const none = (reason) => ({ eligible: false, reason, plan: null, windowCount: 0, itemCount: 0, needsBackground: false });
  if (!settings?.docai_density_chunk_enabled) return none("flag_off");
  if (!isDensityKind(kind)) return none("kind_not_eligible");
  if (!bodyText || typeof bodyText !== "string") return none("no_body_text");
  if (!shouldRowChunk(bodyText, { minItems })) return none("not_dense_enough");
  const plan = planRowWindows(bodyText);
  if (!plan.tableFound) return none("no_table");
  if (plan.windows.length < 2) return none("single_window");
  return {
    eligible: true,
    reason: "row_chunkable",
    plan,
    windowCount: plan.windows.length,
    itemCount: plan.itemCount,
    needsBackground: plan.windows.length > SYNC_WINDOW_BUDGET,
  };
};

export const __consts__ = { SYNC_WINDOW_BUDGET };
