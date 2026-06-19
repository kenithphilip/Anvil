// Connector-agnostic config/schema drift detection.
//
// Anvil pushes sales orders to each ERP through a per-tenant field map
// (`tenant_settings.<erp>_field_map`): a string->string mapping of an
// Anvil field to the ERP target field it writes to. If the ERP's schema
// changes underneath us (a field renamed, removed, or a custom field
// retired), the map silently writes to a field that no longer exists and
// the push degrades. This module diffs the tenant's expected field map
// against the live ERP field set so that drift surfaces as a finding
// instead of a silent data-loss bug.
//
// Findings mirror the shape Tally's reconciler emits
// (`_lib/tally-reconciler.js`: finding_kind / severity / expected /
// actual) so the two drift surfaces read the same way. Tally's voucher
// reconciliation is a different axis (totals / line counts / cancelled
// vouchers) and is intentionally left untouched here.
//
// Pure functions only: no I/O, no Supabase, no HTTP. Callers feed in the
// field map and a sample record (or explicit field list) pulled from a
// diagnostics probe.

// Pull the first record out of the response shapes our connector clients
// return: OData v4 (`value[]`), Fusion/REST (`items[]`), OData v2
// (`d.results[]`), a bare array, or a single object.
const firstRecord = (sample) => {
  if (sample == null) return null;
  if (Array.isArray(sample)) return sample[0] ?? null;
  if (Array.isArray(sample.value)) return sample.value[0] ?? null;
  if (Array.isArray(sample.items)) return sample.items[0] ?? null;
  if (Array.isArray(sample?.d?.results)) return sample.d.results[0] ?? null;
  if (typeof sample === "object") return sample;
  return null;
};

// Field names present in a live sample record, as a Set.
export const liveFieldSet = (sample) => {
  const rec = firstRecord(sample);
  if (!rec || typeof rec !== "object") return new Set();
  return new Set(Object.keys(rec));
};

// detectDrift(expectedMap, liveSchema)
//   expectedMap: { <anvilField>: <erpTargetField> } (string -> string).
//   liveSchema:  a Set or array of live ERP field names, OR a raw sample
//                record (passed through liveFieldSet).
// Returns an array of findings, one per mapped target that is absent from
// the live schema. Returns [] when the map is empty or the live schema is
// unknown/empty, so an unreachable ERP never produces false "missing"
// alarms.
export const detectDrift = (expectedMap, liveSchema) => {
  const fields = liveSchema instanceof Set
    ? liveSchema
    : Array.isArray(liveSchema)
      ? new Set(liveSchema)
      : liveFieldSet(liveSchema);
  if (!expectedMap || typeof expectedMap !== "object" || Array.isArray(expectedMap) || !fields.size) {
    return [];
  }
  const findings = [];
  for (const [anvilField, erpTarget] of Object.entries(expectedMap)) {
    if (typeof erpTarget !== "string" || !erpTarget) continue;
    // Dotted targets (e.g. "Header.CustomerNo") drift on their head
    // segment: if the top-level container is gone the whole path is.
    const head = erpTarget.split(".")[0];
    if (!fields.has(erpTarget) && !fields.has(head)) {
      findings.push({
        finding_kind: "mapped_field_absent",
        severity: "error",
        field: anvilField,
        expected: { target: erpTarget },
        actual: { present: false },
      });
    }
  }
  return findings;
};
