// CM P3b: hard push-block on unresolved blocking findings.
//
// A blocking finding MUST be resolved before an order can be APPROVED or pushed
// to any ERP. The P3 line-count shortfall (extraction anomaly, severity 'error')
// is the first: a "6 of 190 lines" PO must never ship silently.
//
// The blocker lives on orders.rule_findings (jsonb) so it TRAVELS WITH THE ORDER
// — robust even when the order↔extraction_run link is missing (manual/offline
// orders) — and every gate reads the same predicate here so they can't drift.
//
// Because stated_line_count is MODEL-REPORTED (it can hallucinate "190" on a
// genuinely 6-line PO), a blocker is never a dead end: an operator with the
// 'approve' permission can resolve it explicitly (audit-logged), OR re-extract
// and resolve the stale finding. No order is ever permanently trapped.

// Extraction anomalies (extraction_runs.anomalies[].code) that hard-block.
export const BLOCKING_ANOMALY_CODES = new Set(["line_count_shortfall"]);

// A rule_findings entry that must block, and hasn't been resolved. Deliberately
// narrow: only findings explicitly stamped blocks:true (the projected extraction
// blockers) or a known blocking code — NOT every ERROR/high advisory finding —
// so P3b blocks exactly the shortfall and can't over-trap on legacy findings.
export const isUnresolvedBlocker = (f) => {
  if (!f || typeof f !== "object" || f.resolved === true) return false;
  return f.blocks === true || BLOCKING_ANOMALY_CODES.has(f.code) || BLOCKING_ANOMALY_CODES.has(f.rule_id);
};

export const firstUnresolvedBlocker = (ruleFindings) =>
  (Array.isArray(ruleFindings) ? ruleFindings : []).find(isUnresolvedBlocker) || null;

export const hasUnresolvedBlocker = (ruleFindings) => !!firstUnresolvedBlocker(ruleFindings);

// Project blocking extraction anomalies (from extraction_runs.anomalies) into
// canonical rule_findings entries the gates understand. Only error-severity
// blocking codes become findings; advisory anomalies are ignored.
export const projectAnomaliesToFindings = (anomalies) => {
  const out = [];
  for (const a of (Array.isArray(anomalies) ? anomalies : [])) {
    if (!a || !BLOCKING_ANOMALY_CODES.has(a.code)) continue;
    out.push({
      code: a.code,
      rule_id: a.code,
      severity: "ERROR",
      blocks: true,
      resolved: false,
      source: "extraction",
      line_index: null,
      detail: a.detail || (a.code + ": extraction is incomplete"),
      actual: a.actual != null ? a.actual : null,
      expected: a.expected != null ? a.expected : null,
      suggested_fix: "Re-extract the document, or resolve if the declared line count is wrong.",
    });
  }
  return out;
};

// When a PATCH replaces rule_findings wholesale (e.g. the operator "Run
// validation" step), carry forward any prior UNRESOLVED extraction blocker not
// present by code in the incoming array — so a routine validation run can't
// silently drop the push-block. Clearing a blocker requires the explicit
// resolve action (which stamps resolved:true), never an incidental overwrite.
export const mergeBlockersForward = (incoming, prior) => {
  const next = Array.isArray(incoming) ? incoming.slice() : [];
  const codes = new Set(next.map((f) => f && (f.code || f.rule_id)).filter(Boolean));
  for (const p of (Array.isArray(prior) ? prior : [])) {
    if (isUnresolvedBlocker(p) && p.source === "extraction" && !codes.has(p.code)) next.push(p);
  }
  return next;
};

// Mark the first unresolved finding matching `code` as resolved. Returns
// { findings, resolved } — resolved=false when no such finding existed.
export const resolveFinding = (ruleFindings, code, { by = null, note = null, at = null } = {}) => {
  let resolved = false;
  const findings = (Array.isArray(ruleFindings) ? ruleFindings : []).map((f) => {
    if (!resolved && f && (f.code === code || f.rule_id === code) && f.resolved !== true) {
      resolved = true;
      return { ...f, resolved: true, resolved_by: by, resolved_at: at, resolution_note: note };
    }
    return f;
  });
  return { findings, resolved };
};
