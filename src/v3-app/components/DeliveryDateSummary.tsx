import React from "react";
import { Card, Chip, KV } from "../lib/primitives";
import {
  orderDeliveryDate, poRequiredBy, committedDate, suggestedCommittedDate, fmtDueDate, DUE_SOURCE_LABEL,
} from "../../api/_lib/order-delivery-date.js";

// ============================================================
// ANVIL v3: the order's delivery date with its source (plan PR 10)
// One date, and where it came from: the PO line, the PO header, committed by
// us, or none. The PO's date and ours are shown apart, and the suggestion for
// ours is a suggestion only: nothing here sets the committed date (owner
// decision 7 is open). Read path: src/api/_lib/order-delivery-date.js.
// ============================================================

// "30-Oct-26 · from the PO header", or "none".
export const deliveryDateText = (order: any): string => {
  const d = orderDeliveryDate(order);
  if (d.source === "none") return "none";
  return fmtDueDate(d) + " · " + (DUE_SOURCE_LABEL[d.source] || d.source);
};

export const DeliveryDateSummary: React.FC<{ order: any; onOpenHeader?: () => void }> = ({ order, onOpenHeader }) => {
  const shown = orderDeliveryDate(order);
  const po = poRequiredBy(order);
  const committed = committedDate(order);
  const suggestion = committed ? null : suggestedCommittedDate(order);
  return (
    <div data-testid="delivery-date-summary">
      <Card title="Delivery date" eyebrow="the PO's date and ours"
            right={<Chip k={shown.source === "none" ? "ghost" : "info"}>{DUE_SOURCE_LABEL[shown.source] || shown.source}</Chip>}>
        <KV rows={[
          ["Delivery date", shown.source === "none" ? "none" : fmtDueDate(shown) + " (" + (DUE_SOURCE_LABEL[shown.source] || shown.source) + ")"],
          ["PO asks for", po.source === "none" ? "the PO states no date" : fmtDueDate(po) + " (" + DUE_SOURCE_LABEL[po.source] + ")"],
          ["Committed by us", committed ? fmtDueDate(committed) : "not set"],
          ...(suggestion ? [["Suggested commitment", fmtDueDate({ iso: suggestion.value }) + " (" + (DUE_SOURCE_LABEL[suggestion.source] || suggestion.source) + ", " + suggestion.confidence + " confidence)"] as [string, string]] : []),
        ]} />
        {suggestion && onOpenHeader && (
          <div className="mono-sm" style={{ marginTop: 6, color: "var(--ink-3)" }}>
            A suggestion only.{" "}
            <button type="button" className="link-btn" onClick={onOpenHeader}
                    style={{ background: "none", border: "none", padding: 0, color: "var(--ink)", cursor: "pointer", textDecoration: "underline", font: "inherit" }}>
              Set the committed date on the Header fields tab
            </button>
          </div>
        )}
      </Card>
    </div>
  );
};

export default DeliveryDateSummary;
