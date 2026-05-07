// Approval-threshold evaluator.
//
// Audit P2.6. Migration 006 added quote_approval_thresholds with
// min/max amount, margin_below_pct, required_for_modes, and
// approver_role. The admin CRUD at /api/admin/quote_approvals
// shipped the configuration UI. But nothing actually evaluated
// the thresholds when an order moved DRAFT -> PENDING_REVIEW.
// Operators set them up and assumed the system enforced them; it
// did not. Any approval row that existed today was created by
// hand via the same admin CRUD.
//
// This helper is called from the order transition path at
// /api/orders/[id].js when an order enters PENDING_REVIEW. It:
//
//   1. Loads active quote_approval_thresholds for the tenant.
//   2. For each threshold whose conditions match the order's
//      amount / mode / margin, creates a `quote_approvals` row
//      with status='PENDING' and the configured approver_role.
//   3. Skips thresholds that already have a matching pending row
//      for this order so re-running is idempotent.
//
// Returns the list of created rows so the caller can attach the
// count to the response payload.

const computeMarginPct = (order) => {
  // Reuse the same margin calc shape the anomaly engine uses.
  const so = order?.result?.salesOrder || {};
  const pc = order?.result?.priceComposition || {};
  const lines = Array.isArray(so.lineItems) ? so.lineItems : [];
  const compLines = Array.isArray(pc.lineItems) ? pc.lineItems : [];
  if (!lines.length || !compLines.length) return null;
  const compByPart = {};
  compLines.forEach((r) => {
    const k = String(r.partNumber || r.partNo || "").toUpperCase();
    if (k) compByPart[k] = r;
  });
  let landed = 0;
  let selling = 0;
  let matched = 0;
  for (const li of lines) {
    const k = String(li.sellerPartNo || li.tallyItemName || li.itemName || "").toUpperCase();
    const m = compByPart[k];
    const qty = Number(li.qty) || 0;
    const rate = Number(li.rate) || 0;
    selling += qty * rate;
    if (m) {
      matched += 1;
      const unit = Number(m.landedCostINR != null ? m.landedCostINR : m.unitInr) || 0;
      landed += qty * unit;
    }
  }
  if (!matched || selling <= 0) return null;
  return ((selling - landed) / selling) * 100;
};

const orderAmountInr = (order) => {
  const so = order?.result?.salesOrder || {};
  return Number(so.grandTotal) || Number(order?.amount_inr) || 0;
};

const matchesThreshold = (order, threshold) => {
  // Amount band (inclusive on min; max is exclusive when set).
  const amount = orderAmountInr(order);
  if (Number(threshold.min_amount_inr || 0) > amount) return false;
  if (threshold.max_amount_inr != null && amount > Number(threshold.max_amount_inr)) return false;
  // Order-mode allowlist: when set, the order's mode must be in the list.
  if (Array.isArray(threshold.required_for_modes) && threshold.required_for_modes.length > 0) {
    if (!order.order_mode || !threshold.required_for_modes.includes(order.order_mode)) return false;
  }
  // Margin gate: when set, only triggers when the computed margin
  // is BELOW the threshold (i.e., this approval is required for
  // low-margin orders). If margin can't be computed (no price
  // composition), be conservative and DO require approval.
  if (threshold.margin_below_pct != null) {
    const marginPct = computeMarginPct(order);
    if (marginPct != null && marginPct >= Number(threshold.margin_below_pct)) return false;
  }
  return true;
};

export const evaluateApprovalsForOrder = async (svc, tenantId, order) => {
  if (!tenantId || !order || !order.id) return { created: [] };
  const tQ = await svc.from("quote_approval_thresholds")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("active", true);
  if (tQ.error) {
    return { created: [], error: "thresholds read: " + tQ.error.message };
  }
  const thresholds = (tQ.data || []).filter((t) => matchesThreshold(order, t));
  if (!thresholds.length) return { created: [] };

  // Load existing pending approval rows for this order so we
  // don't double-insert on re-run.
  const exQ = await svc.from("quote_approvals")
    .select("approver_role, status")
    .eq("tenant_id", tenantId)
    .eq("order_id", order.id);
  const existingPendingByRole = new Set(
    (exQ.data || [])
      .filter((r) => r.status === "PENDING")
      .map((r) => r.approver_role)
  );

  const toInsert = thresholds
    .filter((t) => !existingPendingByRole.has(t.approver_role))
    .map((t) => ({
      tenant_id: tenantId,
      order_id: order.id,
      approver_role: t.approver_role,
      status: "PENDING",
      comments: "auto: threshold " + t.id.slice(0, 8),
    }));

  if (!toInsert.length) return { created: [] };
  const ins = await svc.from("quote_approvals").insert(toInsert).select("*");
  if (ins.error) return { created: [], error: "approvals insert: " + ins.error.message };
  return { created: ins.data || [] };
};
