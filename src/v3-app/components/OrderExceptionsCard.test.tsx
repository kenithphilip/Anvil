// The "Needs decision" card (plan PR 9): one list, read-only, each row linked
// to where it is resolved. Rendered from the builder's own output, the same
// object GET /api/orders/exceptions returns. Invented fixtures.

import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { OrderExceptionsCard, FIRST_ROWS } from "./OrderExceptionsCard";
import { buildOrderExceptions } from "../../api/_lib/order-exceptions.js";

const clean = buildOrderExceptions({
  order: {
    id: "o-clean", status: "DRAFT", customer_id: "c1",
    preflight_payload: { last_validated_at: "2026-10-10T00:00:00Z" },
    result: { salesOrder: { customer: { name: "Card Buyer" }, lineItems: [{ partNumber: "A", qty: 1, rate: 1 }] }, quoteReconciliation: { flags: [] } },
  },
  customer: { customer_name: "Card Buyer" },
}) as any;

const messyOrder = () => {
  const lines: any[] = [];
  const flags: any[] = [];
  for (let i = 0; i < 12; i++) {
    lines.push({ partNumber: "M-" + i, qty: 2, rate: 10, _match: { verdict: "unmatched", part_no: "M-" + i } });
    flags.push({ part_no: "M-" + i, verdict: "unmatched" });
  }
  return {
    id: "o-messy", status: "DRAFT", customer_id: "c1",
    preflight_payload: { last_validated_at: "2026-10-10T00:00:00Z" },
    rule_findings: [
      { code: "custom_hold", blocks: true, severity: "ERROR", detail: "Held." },
      { code: "old_hold", blocks: true, resolved: true, resolution_note: "Fine." },
    ],
    result: {
      salesOrder: { customer: { name: "Card Buyer" }, lineItems: lines },
      quoteReconciliation: { flags, payment_terms: { verdict: "mismatch", po_terms: "90 days", quote_terms: "30 days" }, quoted_not_ordered: [{ part_no: "Q-9" }] },
    },
  };
};
const messy = buildOrderExceptions({ order: messyOrder(), customer: { customer_name: "Card Buyer" } }) as any;

describe("OrderExceptionsCard", () => {
  it("a clean order: Nothing needs a decision", () => {
    const { getByTestId, queryAllByTestId, container } = render(<OrderExceptionsCard result={clean} onAction={() => {}} />);
    expect(getByTestId("exceptions-clean").textContent).toBe("Nothing needs a decision");
    expect(queryAllByTestId("exception-row")).toHaveLength(0);
    expect(container.textContent).toContain("clean");
  });

  it("a messy order: the rows, the blocking count, the first ten, then all", () => {
    const { getAllByTestId, container, getByText } = render(<OrderExceptionsCard result={messy} onAction={() => {}} />);
    expect(container.textContent).toContain("Needs decision (" + messy.rows.length + ")");
    expect(container.textContent).toContain("1 blocking");
    const shown = getAllByTestId("exception-row").filter((el) => !el.closest("details"));
    expect(shown).toHaveLength(FIRST_ROWS);
    expect(shown[0].getAttribute("data-type")).toBe("blocking_finding");
    expect(shown[0].textContent).toContain("blocks approval");
    expect(container.textContent).toContain("Payment terms differ from the quote");
    fireEvent.click(getByText("Show all " + messy.rows.length));
    expect(getAllByTestId("exception-row").filter((el) => !el.closest("details"))).toHaveLength(messy.rows.length);
    // Information and decided rows are kept, not dropped.
    expect(container.textContent).toContain("For information (1)");
    expect(container.textContent).toContain("Decided (1)");
    expect(container.textContent).toContain("Resolved: Fine.");
  });

  it("a row's link hands its action to the screen; a control that cannot run is disabled with the reason", () => {
    const onAction = vi.fn();
    const result = { ...messy, rows: messy.rows.filter((r: any) => r.type === "line_unmatched").slice(0, 1) };
    const { getByText, rerender } = render(<OrderExceptionsCard result={result} onAction={onAction} />);
    fireEvent.click(getByText("Map to canonical on line 1 in the line grid"));
    expect(onAction).toHaveBeenCalledWith({ tab: "recon", target: "lines[0]", label: "Map to canonical on line 1 in the line grid" }, result.rows[0]);
    rerender(<OrderExceptionsCard result={result} onAction={onAction} disabledReason={() => "Needs write permission"} />);
    const btn = getByText("Map to canonical on line 1 in the line grid") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toBe("Needs write permission");
  });
});
