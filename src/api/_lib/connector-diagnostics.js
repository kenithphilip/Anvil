// Shared probe runner for connector diagnostics endpoints.
//
// The seven full connectors each hand-roll a probe loop in their
// diagnostics.js (see sap/diagnostics.js, p21/diagnostics.js). This
// helper captures that loop once so the lite connectors report an
// identical shape without nine copies. Each connector keeps its own
// thin diagnostics.js that declares the probe list and passes its
// client's fetch fn; a probe's `args` object is handed verbatim to
// that fetch fn, so connectors that key reads on `path`, `resource`,
// or `entity` all work unchanged.

import { detectDrift, liveFieldSet } from "./connector-drift.js";

// Best-effort row count across the response shapes our clients return
// (OData v4 `value`, Fusion/REST `items`, OData v2 `d.results`, or a
// bare array). Diagnostics is read-only; this is informational only.
const rowsOf = (body) => {
  if (Array.isArray(body)) return body.length;
  if (Array.isArray(body?.value)) return body.value.length;
  if (Array.isArray(body?.items)) return body.items.length;
  if (Array.isArray(body?.d?.results)) return body.d.results.length;
  return body == null ? 0 : 1;
};

// probes: [{ entity, args }] where args is the fetch options object
// (e.g. { method: "GET", path: "customers", query: { limit: 1 } }).
//
// opts.drift, when present, runs a config/schema drift check after the
// probes complete:
//   { fieldMap, schemaEntity } where fieldMap is the tenant's
//   <erp>_field_map and schemaEntity is the probe entity whose live
//   sample record carries the field map's target schema (typically the
//   sales-order entity). A null schemaEntity means the connector has no
//   readable target schema, so drift is reported unavailable rather than
//   diffed against the wrong entity (which would yield false positives).
export const runConnectorDiagnostics = async (fetchFn, settings, probes, opts = {}) => {
  const out = [];
  const samples = {};
  for (const p of probes) {
    const t0 = Date.now();
    try {
      const r = await fetchFn(settings, p.args);
      out.push({
        entity: p.entity, ok: r.ok, status: r.status,
        latency_ms: Date.now() - t0,
        rows_returned: r.ok ? rowsOf(r.body) : 0,
        error: r.ok ? null : (r.body?.error?.message || r.body?.error || r.body?.message || r.body?.raw || null),
      });
      if (r.ok && r.body != null) samples[p.entity] = r.body;
    } catch (err) {
      out.push({ entity: p.entity, ok: false, status: 0, latency_ms: Date.now() - t0, rows_returned: 0, error: err.message });
    }
  }
  const result = {
    probes: out,
    summary: { all_ok: out.every((p) => p.ok), total: out.length, failed: out.filter((p) => !p.ok).length },
  };
  if (opts.drift) {
    const { fieldMap, schemaEntity } = opts.drift;
    if (!schemaEntity) {
      result.drift = { available: false, reason: "no readable target schema for this connector", findings: [] };
    } else if (samples[schemaEntity] == null) {
      result.drift = { available: false, reason: "schema probe '" + schemaEntity + "' returned no sample", findings: [] };
    } else {
      const fields = liveFieldSet(samples[schemaEntity]);
      result.drift = {
        available: true,
        entity: schemaEntity,
        live_field_count: fields.size,
        findings: detectDrift(fieldMap || {}, fields),
      };
    }
  }
  return result;
};
