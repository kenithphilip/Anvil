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
      traffic_weight: 0.70,
      description: "Original (May 2025) PO extractor system prompt.",
    },
    {
      version: "v2",
      status: "active",
      traffic_weight: 0.30,
      description: "Tighter line-item table prompts; added few-shot for SAP layouts (Bet 4 Nov 2025).",
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
  return {
    ...r,
    // True only when this row genuinely overrides the adapter's prompt.
    is_variant: !!(r.system || r.tools),
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
