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

// Stable registry. Adapters import getPromptVersion() and use
// `.system` + `.tools` from the returned record. New versions
// added by adding rows here; status='active' enables the split,
// status='canary' restricts to a small percentage, status='retired'
// removes from the split (but historical runs keep working).
const REGISTRY = {
  po_extractor: [
    {
      version: "v1",
      status: "active",
      traffic_weight: 1.0,
      description: "Current PO extractor prompt (claude.js SYSTEM_PROMPT / gemini.js PO_SYSTEM_PROMPT). The one prompt actually shipped.",
    },
    {
      // Retired: this row never carried real prompt content — it was placeholder
      // A/B scaffolding. Kept (not deleted) so historical runs + forceVersion
      // resolve. To ship a REAL v2: add its {system, tool} to PO_PROMPT_VERSIONS
      // in claude.js + gemini.js, then flip status to 'canary' (small %) or
      // 'active' with a traffic_weight.
      version: "v2",
      status: "retired",
      traffic_weight: 0,
      description: "Placeholder (never shipped). Add content in the adapters before activating.",
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

// Public: read-only registry view for the admin diagnostics UI.
export const listPromptVersions = (promptName) => {
  if (!promptName) return REGISTRY;
  return REGISTRY[promptName] || [];
};

export const __test = { REGISTRY, totalActiveWeight, splitFraction };
