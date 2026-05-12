// Active-learning feedback loop (Wave 3.3 / #8).
//
// Captures every operator edit on a docai-extracted field and
// writes one row to learned_corrections. The row carries enough
// context (which run, which field, what the model said, what the
// operator changed it to, what adapter / model produced it) for:
//
//   1. Customer-hint priming (Wave 1.5) to inject "previously
//      corrected" examples into the system prompt on the next
//      extraction.
//   2. Diagnostics: chart correction rate per adapter per field
//      per customer so we know where the model is weakest.
//   3. Auto-suggesting customer_field_overrides when N
//      corrections of the same diff_kind land on the same
//      (customer, field_path) within a window.
//
// Pure I/O helper. Caller wires this into the order/quote/SO edit
// hook (the route that already diffs preflight payloads on PATCH).

const isPlainObject = (v) => v != null && typeof v === "object" && !Array.isArray(v);

// Flatten a normalized extraction object to { path: value } map
// at the field level. Lines unfold as lines[i].field.
export const flattenNormalized = (norm) => {
  const out = {};
  if (!norm || typeof norm !== "object") return out;
  if (isPlainObject(norm.customer)) {
    for (const [k, v] of Object.entries(norm.customer)) {
      out["customer." + k] = v ?? null;
    }
  }
  if (Array.isArray(norm.lines)) {
    norm.lines.forEach((line, i) => {
      if (!isPlainObject(line)) return;
      for (const [k, v] of Object.entries(line)) {
        if (k.startsWith("_")) continue;     // skip internal markers
        out["lines[" + i + "]." + k] = v ?? null;
      }
    });
  }
  if (isPlainObject(norm.totals)) {
    for (const [k, v] of Object.entries(norm.totals)) {
      out["totals." + k] = v ?? null;
    }
  }
  if (norm.classification != null) out.classification = norm.classification;
  return out;
};

const stableEqual = (a, b) => {
  // Normalize numeric / string equality + null handling.
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (typeof a === "number" || typeof b === "number") {
    const na = Number(a);
    const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) {
      return Math.abs(na - nb) < 0.005;          // <= 0.5 paise tolerance
    }
  }
  return String(a).trim() === String(b).trim();
};

// Build the diff between two normalized payloads. Returns an
// array of { field_path, model_value, operator_value, diff_kind,
// severity }.
//
// severity heuristic:
//   - severity 'high' when the model produced a non-null value
//     and the operator either nulled it out or changed a critical
//     field (gstin, customer.name, classification).
//   - 'medium' on numeric-field replaces.
//   - 'low' on minor whitespace / case shifts.
export const diffNormalized = (model, operator) => {
  const m = flattenNormalized(model);
  const o = flattenNormalized(operator);
  const allKeys = new Set([...Object.keys(m), ...Object.keys(o)]);
  const diffs = [];
  const CRITICAL = new Set(["customer.gstin", "customer.name", "customer.bill_to_address", "classification"]);
  for (const key of allKeys) {
    const mv = m[key] == null ? null : m[key];
    const ov = o[key] == null ? null : o[key];
    if (stableEqual(mv, ov)) continue;
    let diff_kind;
    if (mv == null && ov != null) diff_kind = "add";
    else if (mv != null && ov == null) diff_kind = "remove";
    else diff_kind = "replace";
    let severity = "medium";
    if (CRITICAL.has(key) || (mv != null && ov == null)) severity = "high";
    else if (typeof mv === "string" && typeof ov === "string"
      && mv.toLowerCase().replace(/\s+/g, " ").trim() === ov.toLowerCase().replace(/\s+/g, " ").trim()) {
      severity = "low";
    }
    diffs.push({
      field_path: key,
      model_value: mv,
      operator_value: ov,
      diff_kind,
      severity,
    });
  }
  return diffs;
};

// Persist a batch of diffs to learned_corrections. Idempotent
// upsert on (tenant_id, extraction_run_id, field_path).
export const recordCorrections = async (svc, ctx, opts) => {
  if (!svc) return { ok: false, error: "no_svc" };
  const { tenantId, customerId, extractionRunId, adapterUsed, selectedModel, confidenceAtExtraction, createdBy } = ctx;
  const diffs = Array.isArray(opts?.diffs) ? opts.diffs : [];
  if (!tenantId || !extractionRunId || !diffs.length) {
    return { ok: true, written: 0 };
  }
  const rows = diffs.map((d) => ({
    tenant_id: tenantId,
    customer_id: customerId || null,
    extraction_run_id: extractionRunId,
    field_path: d.field_path,
    model_value: d.model_value,
    operator_value: d.operator_value,
    diff_kind: d.diff_kind,
    severity: d.severity,
    adapter_used: adapterUsed || null,
    selected_model: selectedModel || null,
    confidence_at_extraction: Number.isFinite(Number(confidenceAtExtraction))
      ? Number(confidenceAtExtraction)
      : null,
    created_by: createdBy || null,
  }));
  try {
    const r = await svc.from("learned_corrections")
      .upsert(rows, { onConflict: "tenant_id,extraction_run_id,field_path" });
    if (r.error) return { ok: false, error: r.error.message, written: 0 };
    return { ok: true, written: rows.length };
  } catch (err) {
    return { ok: false, error: err?.message || "upsert_failed", written: 0 };
  }
};

// Aggregate "rules to suggest as customer_field_overrides".
// Returns an array of { tenant_id, customer_id, field_path,
// replacement, support_count } where N corrections of the same
// (customer, field_path, operator_value) within `windowDays`
// crossed the threshold. The dispatcher / admin UI surfaces
// these as one-click "promote to override" actions.
export const suggestOverrides = async (svc, { tenantId, customerId = null, supportThreshold = 3, windowDays = 30 }) => {
  if (!svc || !tenantId) return [];
  const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  let q = svc.from("learned_corrections")
    .select("tenant_id, customer_id, field_path, operator_value, severity, created_at")
    .eq("tenant_id", tenantId)
    .eq("diff_kind", "replace")
    .gte("created_at", cutoff);
  if (customerId) q = q.eq("customer_id", customerId);
  const r = await q;
  const rows = r?.data || [];
  // Group by (customer_id, field_path, JSON(operator_value)).
  const counts = new Map();
  for (const row of rows) {
    const key = (row.customer_id || "_") + "|" + row.field_path + "|" + JSON.stringify(row.operator_value || null);
    if (!counts.has(key)) counts.set(key, { ...row, support_count: 0 });
    counts.get(key).support_count++;
  }
  return Array.from(counts.values())
    .filter((c) => c.support_count >= supportThreshold)
    .sort((a, b) => b.support_count - a.support_count);
};

export const __test = { stableEqual, isPlainObject };
