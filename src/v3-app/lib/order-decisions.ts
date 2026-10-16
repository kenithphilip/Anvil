// The decisions a person made on an order, read from its audit rows: who
// approved it, who returned it for a fix and why, who cancelled it and why.
// PURE. The SO workspace's Approval tab renders the list.
//
// Sources (orders/[id].js PATCH writes every one):
//   approve_order                  an approval
//   manager_requested_correction   a return for fix; reason = the note
//   update_order, after CANCELLED  a cancel; reason = the cancel reason

export type OrderDecisionKind = "approved" | "returned" | "cancelled";

export interface OrderDecision {
  kind: OrderDecisionKind;
  at: string | null;
  /** The actor's role at the time, e.g. "sales_manager". */
  role: string | null;
  reason: string | null;
}

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export const orderDecisions = (auditRows: unknown): OrderDecision[] => {
  const rows = Array.isArray(auditRows) ? auditRows : [];
  const out: OrderDecision[] = [];
  for (const a of rows as any[]) {
    if (!a || typeof a !== "object") continue;
    const action = String(a.action || "");
    const from = a.before_payload?.status ?? null;
    const to = a.after_payload?.status ?? null;
    let kind: OrderDecisionKind | null = null;
    if (action === "approve_order") kind = "approved";
    else if (action === "manager_requested_correction") kind = "returned";
    else if (to === "CANCELLED" && from !== "CANCELLED") kind = "cancelled";
    if (!kind) continue;
    out.push({ kind, at: a.created_at || null, role: text(a.actor_role), reason: text(a.reason) });
  }
  // Newest first, like the Activity tab.
  out.sort((x, y) => (y.at ? Date.parse(y.at) : 0) - (x.at ? Date.parse(x.at) : 0));
  return out;
};

export const DECISION_LABEL: Record<OrderDecisionKind, string> = {
  approved: "Approved",
  returned: "Returned for fix",
  cancelled: "Cancelled",
};
