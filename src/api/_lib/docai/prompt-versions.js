// Prompt versioning + A/B split (Wave 4.5 / #20).
//
// Today every extractor adapter (claude.js, gemini.js) hard-codes
// the system prompt as a const string. Changing it means a code
// commit + deploy + waiting to see whether accuracy moved on the
// next 100 runs. We have no way to:
//
//   1. Roll back if the new prompt regresses an existing
//      customer's accuracy.
//   2. A/B-split traffic so a new prompt sees 10% of runs while
//      the proven prompt handles the rest.
//   3. Track per-prompt metrics (accuracy, latency, cost) to
//      pick a winner.
//
// This module:
//
//   - A REGISTRY of named prompt versions (PO_EXTRACTOR_V1,
//     PO_EXTRACTOR_V2, ...). Each carries { name, version,
//     system, tools, status, traffic_weight }.
//   - resolvePromptVersion(name, opts) picks a version
//     deterministically: tenant pin > customer pin > active
//     A/B split (hash on tenant_id + customer_id) > default.
//   - Allocations land on extraction_runs.prompt_version so the
//     diagnostics dashboard can chart "accuracy by prompt
//     version per adapter per customer".

import { createHash } from "node:crypto";

// Stable registry. New versions are added by adding rows here;
// status='active' enables the split, status='canary' restricts to a small
// percentage, status='retired' removes it from the split (historical runs
// keep working).
//
// A row MAY carry `system` and/or `tools` to serve a genuine variant. None
// does today, so every version currently resolves to the adapter's built-in
// prompt and the split is an ATTRIBUTION label rather than an experiment:
// recording which version produced a run is what makes a later before/after
// answerable, and until a row supplies real prompt text there is nothing to
// compare. Say that out loud rather than implying an A/B is running.
//
// This header used to instruct adapters to "import getPromptVersion()". No
// such export existed — the file exported resolvePromptVersion — so nobody
// ever wired it, and extraction_runs.prompt_version (migration 124) was
// never written by anything for a year. getPromptVersion is defined below as
// the documented name.
const REGISTRY = {
  po_extractor: [
    {
      version: "v1",
      status: "active",
      traffic_weight: 0.90,
      description: "Original (May 2025) PO extractor system prompt.",
    },
    {
      version: "v2",
      status: "canary",
      traffic_weight: 0.10,
      description: "Multi-row-per-item counting discipline, ported to whichever adapter lacks it.",
      // THE HYPOTHESIS, and why it is a canary rather than a straight fix.
      //
      // The single most-cited defect family in this repo's docai history is a
      // multi-row PO shredded or dropped entirely: #106 (a 32-line 7-page PO
      // that returned 0 lines), then #272, #317, #417, #423, #286. Commit
      // 8b10493 fixed the first one with prompt text and said so — "No code
      // path changes; this is a prompt-only fix" — by adding the MULTI-ROW-PER-
      // ITEM block now at claude.js:167-200, which calls itself "the single
      // biggest cause of a shredded line count".
      //
      // That commit touched claude.js and nothing else. gemini.js never got
      // the block — grep it for MULTI-ROW or "physical rows" and you get zero
      // hits — and gemini is FIRST in DEFAULT_PROVIDER_ORDER, the default since
      // migration 208. So the fix the repo is proudest of has been living on
      // the last-resort adapter while the primary one extracts without it.
      //
      // Why canary and not just port it: it is proven for Claude, not for
      // Gemini. A prompt tuned against one model's failure mode can be inert
      // or actively harmful on another — instruction-following differs, and
      // this adds ~15 lines to a prompt that is already long. "It worked over
      // there" is a hypothesis, not a result, and this registry exists so that
      // distinction can be settled with numbers instead of asserted.
      //
      // Deliberately NOT ported: the col-2 example mapping at claude.js:189-199.
      // claude.js itself calls it "ONE example layout ONLY", it is the most
      // over-fitted part of the block, and carrying it would confound the
      // experiment with a second, different treatment.
      //
      // Read-out: empty_lines share of extraction_failure_rate, the
      // line_count_shortfall anomaly rate, and replay's line_recall_avg —
      // sliced by adapter, because the two arms are not the same treatment on
      // both (on Claude this reinforces guidance already present; on Gemini it
      // supplies guidance that is absent). Judge Gemini.
      system_append: [
        "MULTI-ROW-PER-ITEM TABLE LAYOUTS",
        "Many Indian and Korean OEM POs print ONE line item across SEVERAL physical rows — the part",
        "number and quantity on the first row, the description and UoM on the second, a specification or",
        "drawing code on the third, and so on, often closed by a horizontal rule or a blank row.",
        "",
        "All physical rows that share the same S.No / Line / Item serial — or that are visually grouped",
        "between two horizontal rules or across a page break — belong to ONE line item. Combine their",
        "cells into a SINGLE lines[] entry.",
        "",
        "Do NOT emit one lines[] entry per physical row. That multiplies the line count by 4-5x and",
        "shreds every per-unit amount. Equally, do NOT give up and return an empty lines[] because the",
        "table shape is unfamiliar: count the serials and work block by block.",
        "",
        "If the document prints 8 S.No values you must return exactly 8 lines[] entries; if it prints 32",
        "you must return exactly 32.",
        "",
        "Do not assume the part number sits in any particular column. Some formats leave the part column",
        "blank and print the part as the first line of the description cell; others print the buyer's own",
        "item code in its own column with our part embedded in the description behind a prefix. Apply the",
        "partNumber location rules given above, and still return exactly one entry per printed serial.",
      ],
    },
  ],
  supplier_ack_extractor: [
    { version: "v1", status: "active", traffic_weight: 1.0 },
  ],
  ocr_postprocess: [
    { version: "v1", status: "active", traffic_weight: 1.0 },
  ],
};

const totalActiveWeight = (rows) => rows
  .filter((r) => r.status === "active" || r.status === "canary")
  .reduce((s, r) => s + Number(r.traffic_weight || 0), 0);

// Hash a (tenant, customer) tuple to a stable 0..1 number so the
// A/B split is deterministic per customer (no flicker between
// runs).
const splitFraction = (tenantId, customerId) => {
  const h = createHash("sha256").update(String(tenantId || "") + "|" + String(customerId || "")).digest();
  // First 4 bytes -> uint32 -> normalise to [0, 1).
  const v = h.readUInt32BE(0);
  return v / 2 ** 32;
};

// Public: pick a prompt version for a given (promptName, tenantId,
// customerId, opts). opts can carry:
//   forceVersion: 'v2' to bypass the split (test runs, eval set)
//   pin: a tenant-level pinned version (settings.docai_prompt_pins[name])
//
// Returns { name, version, status, registry_entry } or null when
// the prompt name is unknown.
export const resolvePromptVersion = (promptName, opts = {}) => {
  const rows = REGISTRY[promptName];
  if (!Array.isArray(rows) || !rows.length) return null;
  if (opts.forceVersion) {
    const hit = rows.find((r) => r.version === opts.forceVersion);
    if (hit) return { name: promptName, ...hit, source: "force" };
  }
  if (opts.pin) {
    const hit = rows.find((r) => r.version === opts.pin && r.status !== "retired");
    if (hit) return { name: promptName, ...hit, source: "tenant_pin" };
  }
  // A/B split over active + canary rows.
  const active = rows.filter((r) => r.status === "active" || r.status === "canary");
  if (!active.length) {
    // No active rows; fall back to first defined.
    return { name: promptName, ...rows[0], source: "fallback" };
  }
  const total = totalActiveWeight(active);
  if (total <= 0) {
    return { name: promptName, ...active[0], source: "no_weights" };
  }
  const f = splitFraction(opts.tenantId, opts.customerId);
  let acc = 0;
  for (const row of active) {
    acc += Number(row.traffic_weight || 0) / total;
    if (f <= acc) return { name: promptName, ...row, source: "ab_split" };
  }
  // Floating-point edge case: fall through to last active.
  return { name: promptName, ...active[active.length - 1], source: "ab_split_tail" };
};

// The name this file's own header always told callers to use.
//
// Thin wrapper over resolvePromptVersion that also reports whether the chosen
// version actually supplies prompt text. A caller must be able to tell "we
// are running variant v2" from "we labelled this v2 and ran the default".
export const getPromptVersion = (promptName, opts = {}) => {
  const r = resolvePromptVersion(promptName, opts);
  if (!r) return null;
  // Does this ROW carry prompt text at all?
  const hasText = !!(r.system || r.tools || (Array.isArray(r.system_append) && r.system_append.length));
  // Did THIS RUN actually use it? Two different questions, and conflating them
  // is how a comparison ends up measuring nothing: with variants disabled, a
  // v2-labelled run executes the identical base prompt, so charting "v1 vs v2"
  // would be charting noise against itself. Variants are opt-in — the caller
  // must pass allowVariants — so a run is only marked a variant when the
  // tenant switched the experiment on AND the row has something to say.
  const applied = hasText && opts.allowVariants === true;
  return {
    ...r,
    has_variant_text: hasText,
    // True only when this run genuinely ran something other than the default.
    is_variant: applied,
    // Only handed out when applied, so a caller cannot inject a variant it was
    // not authorised to run by reading the row off the result.
    system_append: applied && Array.isArray(r.system_append) ? r.system_append : null,
  };
};

// Which registry prompt serves which extraction kind.
//
// Kinds absent here have no registry entry, so their runs record a null
// version rather than a fabricated one — a made-up label is worse than none,
// because it would make a comparison look attributable when it is not.
export const PROMPT_NAME_BY_KIND = Object.freeze({
  po: "po_extractor",
  rfq: "po_extractor",
  generic: "po_extractor",
  supplier_ack: "supplier_ack_extractor",
});

export const promptNameForKind = (kind) => PROMPT_NAME_BY_KIND[kind] || null;

// Public: read-only registry view for the admin diagnostics UI.
export const listPromptVersions = (promptName) => {
  if (!promptName) return REGISTRY;
  return REGISTRY[promptName] || [];
};

export const __test = { REGISTRY, totalActiveWeight, splitFraction };
