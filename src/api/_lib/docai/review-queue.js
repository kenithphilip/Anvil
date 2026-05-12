// Low-confidence review queue (Wave 4.1 / #16).
//
// Captures every extraction run that needs operator eyes into a
// single pull queue. Operators triage from one screen instead of
// hunting through individual orders. Drivers:
//
//   - status = 'low_confidence' (confidence_overall below the
//     fallback threshold after validators ran)
//   - status_reason = 'empty_lines' / 'parse_failed' /
//     'non_po' / 'image_pdf_no_text'
//   - anomalies_has_blockers = true (Wave 3.1 anomaly engine
//     flagged a real accounting issue)
//   - handwriting suspected with score >= 0.75 (Wave 2.5)
//
// Severity ranking:
//   critical: anomalies_has_blockers with conflict on totals
//   high:     low_confidence on a known customer; parse_failed
//   medium:   empty_lines; non_po on an inbound email
//   low:      image_pdf_no_text (reroute to OCR retry)
//
// Pure I/O helper. Caller wires this at the end of
// runExtractionPipeline; row creation is idempotent on
// (tenant_id, extraction_run_id).

const numericOrNull = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const truncatePreview = (norm) => {
  if (!norm) return null;
  const lines = Array.isArray(norm.lines) ? norm.lines.slice(0, 5).map((l) => ({
    partNumber: l.partNumber, description: l.description,
    quantity: l.quantity, unitPrice: l.unitPrice, amount: l.amount,
  })) : [];
  return {
    classification: norm.classification || null,
    customer: norm.customer ? {
      name: norm.customer.name,
      gstin: norm.customer.gstin,
      po_number: norm.customer.po_number,
    } : null,
    line_count: Array.isArray(norm.lines) ? norm.lines.length : 0,
    lines_preview: lines,
    totals: norm.totals || null,
  };
};

// Decide whether a run merits queueing. Returns null when no
// queue entry needed; otherwise { reason, severity }.
export const classifyForQueue = (runOutcome) => {
  if (!runOutcome) return null;
  const status = runOutcome.status;
  const reason = runOutcome.statusReason;
  const confidence = numericOrNull(runOutcome.confidenceOverall);
  const anomaliesHasBlockers = !!runOutcome.anomaliesHasBlockers;

  if (anomaliesHasBlockers) {
    return { reason: "anomalies", severity: "critical" };
  }
  if (status === "failed") {
    if (reason === "parse_failed") return { reason: "parse_failed", severity: "high" };
    if (reason === "non_po") return { reason: "non_po", severity: "medium" };
    if (reason === "image_pdf_no_text") return { reason: "image_pdf_no_text", severity: "low" };
    if (reason === "empty_lines") return { reason: "empty_lines", severity: "medium" };
    return { reason: reason || "failed", severity: "high" };
  }
  if (status === "low_confidence") {
    return { reason: "low_confidence", severity: confidence != null && confidence < 0.5 ? "high" : "medium" };
  }
  if (runOutcome.handwritingDetection?.suspected && runOutcome.handwritingDetection?.score >= 0.75) {
    return { reason: "handwriting", severity: "medium" };
  }
  return null;
};

// Persist a queue row. Idempotent on (tenant, extraction_run_id).
export const enqueueReview = async (svc, ctx, runOutcome, opts = {}) => {
  if (!svc) return { ok: false, error: "no_svc" };
  const classification = classifyForQueue(runOutcome);
  if (!classification) return { ok: true, queued: false };
  const { tenantId, customerId, caseId, triggeredBy } = ctx;
  if (!tenantId || !runOutcome.runId) return { ok: false, error: "missing_ctx" };
  const row = {
    tenant_id: tenantId,
    customer_id: customerId || null,
    extraction_run_id: runOutcome.runId,
    case_id: caseId || null,
    reason: classification.reason,
    severity: classification.severity,
    triggered_by: triggeredBy || opts.triggeredBy || null,
    preview: truncatePreview(runOutcome.normalized),
    metrics: {
      confidence_overall: numericOrNull(runOutcome.confidenceOverall),
      anomaly_count: runOutcome.anomaliesSummary?.total || 0,
      anomaly_error_count: runOutcome.anomaliesSummary?.error || 0,
      adapter_used: runOutcome.adapterUsed || null,
      voter_used: !!runOutcome.voterUsed,
      handwriting_score: runOutcome.handwritingDetection?.score || null,
      languages_seen: runOutcome.languages?.scripts_seen || [],
    },
    status: "open",
  };
  try {
    const r = await svc.from("extraction_review_queue")
      .upsert(row, { onConflict: "tenant_id,extraction_run_id" });
    if (r.error) return { ok: false, error: r.error.message };
    return { ok: true, queued: true, reason: classification.reason, severity: classification.severity };
  } catch (err) {
    return { ok: false, error: err?.message || "upsert_failed" };
  }
};

// Public helper to mark an entry as in-review/resolved. Caller
// is the workspace handler when the operator opens or completes
// the review.
export const updateReviewStatus = async (svc, { tenantId, queueId, status, resolution, resolvedBy, notes }) => {
  if (!svc || !tenantId || !queueId) return { ok: false, error: "missing_args" };
  const update = {
    updated_at: new Date().toISOString(),
  };
  if (status) update.status = status;
  if (resolution !== undefined) update.resolution = resolution;
  if (resolvedBy !== undefined) update.resolved_by = resolvedBy;
  if (notes !== undefined) update.notes = notes;
  if (status === "resolved") update.resolved_at = new Date().toISOString();
  try {
    const r = await svc.from("extraction_review_queue")
      .update(update)
      .eq("tenant_id", tenantId)
      .eq("id", queueId);
    if (r.error) return { ok: false, error: r.error.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || "update_failed" };
  }
};
