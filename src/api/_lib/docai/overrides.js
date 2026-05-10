// Phase E: customer-field overrides + immediate feedback.
//
// EXTRACTION_PIPELINE_PLAN.md plan, Phase E. Operator corrections
// already write to extraction_corrections (029). The legacy loop
// only feeds Claude few-shot at a 50-correction threshold; that
// helps Claude but does nothing for Reducto / Azure DI / Docling
// / Marker / Unstructured / template extractions.
//
// This module:
//
//   1. Reads the active overrides for a customer + field path.
//   2. Applies them to ANY adapter's normalized output (so
//      Reducto's "M/s. Acme" becomes "Acme" the same way Claude's
//      few-shot would).
//   3. Promotes a correction to a stable override when the same
//      original_value -> corrected_value lands in 2+ runs in a
//      row. The threshold is intentionally low so the next
//      upload sees the operator's fix.
//
// Overrides apply post-dispatch (so they can fix misalignment in
// any adapter's output) but BEFORE the L5 validators run, so a
// validator sees corrected values.

const get = (obj, path) => {
  if (!obj) return null;
  const parts = path.split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return null;
    cur = cur[p];
  }
  return cur == null ? null : cur;
};

const set = (obj, path, value) => {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (cur[k] == null || typeof cur[k] !== "object") cur[k] = {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
};

// Apply all overrides for a customer to a normalized extraction.
// Returns { normalized, applied: [{field_path, before, after,
// override_id}] }.
//
// Pure: receives the override list from the caller. The caller
// fetches the list with loadOverrides() so test harnesses can
// inject fixtures.
export const applyOverrides = (normalized, overrides) => {
  if (!normalized || !Array.isArray(overrides) || overrides.length === 0) {
    return { normalized, applied: [] };
  }
  const next = JSON.parse(JSON.stringify(normalized));
  const applied = [];
  for (const o of overrides) {
    const fp = o.field_path;
    if (!fp) continue;
    const current = get(next, fp);
    let shouldApply = false;
    if (o.match_pattern == null || o.match_pattern === "") {
      // Always-apply override.
      shouldApply = true;
    } else if (current != null) {
      let re;
      try { re = new RegExp(o.match_pattern); }
      catch (_) { re = null; }
      if (re && re.test(String(current))) shouldApply = true;
    }
    if (!shouldApply) continue;
    if (current === o.replacement) continue;        // no-op
    set(next, fp, o.replacement);
    applied.push({
      field_path: fp,
      before: current,
      after: o.replacement,
      override_id: o.id,
      confidence_floor: o.confidence_floor || 0.95,
    });
  }
  return { normalized: next, applied };
};

// Load active overrides for a customer. Returns the rows directly.
export const loadOverrides = async (svc, { tenantId, customerId }) => {
  if (!tenantId || !customerId) return [];
  const r = await svc.from("customer_field_overrides")
    .select("id, field_path, match_pattern, replacement, confidence_floor")
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId);
  return (r.data || []);
};

// After applying overrides, bump applied_count + last_applied_at on
// each override row. Best-effort: failures don't break the run.
export const recordOverrideUsage = async (svc, applied) => {
  if (!applied || !applied.length) return;
  const now = new Date().toISOString();
  for (const a of applied) {
    if (!a.override_id) continue;
    try {
      const cur = await svc.from("customer_field_overrides")
        .select("applied_count")
        .eq("id", a.override_id)
        .maybeSingle();
      const next = (cur.data?.applied_count || 0) + 1;
      await svc.from("customer_field_overrides")
        .update({ applied_count: next, last_applied_at: now })
        .eq("id", a.override_id);
    } catch (_e) { /* swallow */ }
  }
};

// Promote a correction into an override when the same
// (field_path, original_value -> corrected_value) lands twice.
//
// Called from /api/docai/correction after a new correction row is
// inserted. The semantics:
//
//   - Field path + customer must match.
//   - We want the same corrected_value at least twice. The
//     match_pattern is built from the original_value (if it's a
//     string) so the override fires when the SAME garbage shows
//     up next time.
//   - Identical override (same field, same match_pattern, same
//     replacement) already exists -> skip (idempotent).
//
// Returns { promoted: bool, override_id?, reason? }.
export const promoteCorrectionIfStable = async (svc, { tenantId, customerId, fieldPath }) => {
  if (!tenantId || !customerId || !fieldPath) return { promoted: false, reason: "missing_args" };
  const r = await svc.from("extraction_corrections")
    .select("id, original_value, corrected_value, applied_at")
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .eq("field_path", fieldPath)
    .order("applied_at", { ascending: false })
    .limit(5);
  if (r.error || !r.data || r.data.length < 2) {
    return { promoted: false, reason: "not_enough_corrections" };
  }
  // Check the most recent two: if their corrected_value matches
  // (string-equal after trim), promote.
  const [a, b] = r.data;
  const av = typeof a.corrected_value === "string" ? a.corrected_value.trim() : JSON.stringify(a.corrected_value);
  const bv = typeof b.corrected_value === "string" ? b.corrected_value.trim() : JSON.stringify(b.corrected_value);
  if (!av || av !== bv) return { promoted: false, reason: "no_match_two_recent" };

  const replacement = av;
  // Build match_pattern from the original_value when it's a
  // distinguishable string. If both originals are equal, anchor
  // on that exact value.
  const ao = typeof a.original_value === "string" ? a.original_value.trim() : null;
  const bo = typeof b.original_value === "string" ? b.original_value.trim() : null;
  let matchPattern = null;
  if (ao && ao === bo) {
    // Anchor on the exact original.
    matchPattern = "^" + ao.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$";
  } else {
    // Fall back to "always-apply" override; the operator's intent
    // is "this customer's field should always be `replacement`".
    matchPattern = null;
  }

  // Idempotent: skip if an override with the same field +
  // matcher + replacement already exists.
  const existing = await svc.from("customer_field_overrides")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .eq("field_path", fieldPath)
    .eq("replacement", replacement)
    .maybeSingle();
  if (existing.data?.id) {
    return { promoted: false, reason: "already_exists", override_id: existing.data.id };
  }

  const ins = await svc.from("customer_field_overrides").insert({
    tenant_id: tenantId,
    customer_id: customerId,
    field_path: fieldPath,
    match_pattern: matchPattern,
    replacement,
    reason: "auto-promoted from 2 stable corrections",
    confidence_floor: 0.95,
    source_correction_ids: [a.id, b.id],
  }).select("id").single();
  if (ins.error) return { promoted: false, reason: "insert_failed", error: ins.error.message };
  return { promoted: true, override_id: ins.data.id };
};

export const __test__ = { applyOverrides, get, set };
