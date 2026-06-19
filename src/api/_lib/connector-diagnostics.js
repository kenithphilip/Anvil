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
export const runConnectorDiagnostics = async (fetchFn, settings, probes) => {
  const out = [];
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
    } catch (err) {
      out.push({ entity: p.entity, ok: false, status: 0, latency_ms: Date.now() - t0, rows_returned: 0, error: err.message });
    }
  }
  return {
    probes: out,
    summary: { all_ok: out.every((p) => p.ok), total: out.length, failed: out.filter((p) => !p.ok).length },
  };
};
