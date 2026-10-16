// Screens that show cost data follow rbac cost.view: the approvals queue says
// "hidden" (never "0.0%" or "not costed") when the server withheld the margin,
// and the SO workspace offers its Margin cockpit only to cost roles.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";

// One order in the queue, as GET /api/admin/quote_approvals?type=queue
// returns it: the order waiting for approval, with its open threshold rows.
const ROW = {
  order_id: "ord-1", status: "PENDING_REVIEW", payload_hash: "hash-1",
  po_number: "PO-9", customer_name: "Fixture Co", order_mode: "SPARES", line_count: 1, value_inr: 236,
  thresholds: [{ id: "ap-1", approver_role: "sales_manager" }],
};

const mkOrder = (id: string) => ({
  id, status: "DRAFT", po_number: "PO-" + id, customer_id: "cust-1", customer_name: "Fixture",
  result: { salesOrder: { lineItems: [{ partNumber: "WG-1", description: "gun", qty: 1, rate: 10, uom: "NOS" }] } },
  preflight_payload: {}, documents: [],
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
});

afterEach(() => { installRbac("sales_engineer"); vi.unstubAllGlobals(); });

describe("approvals queue margin cell", () => {
  const serve = (rows: any[]) => {
    installBackend({ admin: { listApprovalQueue: vi.fn(async () => ({ orders: rows })) } });
  };

  it("says hidden when the server withheld the margin", async () => {
    installRbac("viewer");
    serve([{ ...ROW, margin_pct: null, margin_state: "hidden" }]);
    const { container } = renderScreen((await import("./approvals")).default);
    await waitFor(() => expect(container.textContent).toContain("PO-9"));
    expect(container.textContent).toContain("hidden");
    expect(container.textContent).not.toContain("not costed");
    expect(container.textContent).not.toContain("0.0%");
  });

  it("shows the margin when the server sent one", async () => {
    installRbac("sales_manager");
    serve([{ ...ROW, margin_pct: 30, margin_state: "computed" }]);
    const { container } = renderScreen((await import("./approvals")).default);
    await waitFor(() => expect(container.textContent).toContain("30.0%"));
    expect(container.textContent).not.toContain("hidden");
  });

  // A dash meant both "thin" and "never costed", in the same colour as a
  // healthy margin.
  it("says not costed, never a dash or 0.0%, when no price composition exists", async () => {
    installRbac("sales_manager");
    serve([{ ...ROW, margin_pct: null, margin_state: "not_costed" }]);
    const { container } = renderScreen((await import("./approvals")).default);
    await waitFor(() => expect(container.textContent).toContain("PO-9"));
    const cells = Array.from(container.querySelectorAll("td")).map((td) => td.textContent);
    expect(cells).toContain("not costed");
    expect(container.textContent).not.toContain("0.0%");
    // The reason chips say it too, after why the order is here.
    const chips = Array.from(container.querySelectorAll("td .chip")).map((c) => c.textContent);
    expect(chips.slice(1)).toEqual(["sales manager sign-off", "not costed"]);
  });

  it("flags a partially costed margin with its coverage", async () => {
    installRbac("sales_manager");
    serve([{ ...ROW, margin_pct: 22, margin_state: "partial", margin_lines_matched: 2, margin_lines_total: 3 }]);
    const { container } = renderScreen((await import("./approvals")).default);
    await waitFor(() => expect(container.textContent).toContain("22.0%"));
    expect(container.textContent).toContain("·2/3");
  });

  it("does not zero a negative margin, and names it first", async () => {
    // `Number(x) || 0` painted an order below cost as unremarkable.
    installRbac("sales_manager");
    serve([{ ...ROW, margin_pct: -5, margin_state: "computed" }]);
    const { container } = renderScreen((await import("./approvals")).default);
    await waitFor(() => expect(container.textContent).toContain("-5.0%"));
    const chips = Array.from(container.querySelectorAll("td .chip")).map((c) => c.textContent);
    // The mode chip, then the reasons, worst first.
    expect(chips.slice(1)).toEqual(["below cost", "sales manager sign-off"]);
  });

  it("names a thin margin, and an order with no policy row as sent for approval", async () => {
    installRbac("sales_manager");
    serve([{ ...ROW, thresholds: [], margin_pct: 6, margin_state: "computed" }]);
    const { container } = renderScreen((await import("./approvals")).default);
    await waitFor(() => expect(container.textContent).toContain("6.0%"));
    const chips = Array.from(container.querySelectorAll("td .chip")).map((c) => c.textContent);
    expect(chips.slice(1)).toEqual(["margin breach", "sent for approval"]);
  });
});

describe("SO workspace Margin cockpit", () => {
  beforeEach(() => {
    installBackend({
      orders: { get: vi.fn(async (id: string) => ({ order: mkOrder(id) })), update: vi.fn(async () => ({})) },
      audit: { list: vi.fn(async () => []) },
      events: { list: vi.fn(async () => []) },
      cost: { breakdown: vi.fn(async () => null) },
    });
    window.location.hash = "#/so?id=ord-A";
  });

  it("is not offered to a viewer", async () => {
    installRbac("viewer");
    const { container } = renderScreen((await import("./so-workspace")).default);
    await waitFor(() => expect(container.textContent).toContain("PO-ord-A"));
    expect(container.textContent).toContain("Header fields");
    expect(container.textContent).not.toContain("Margin cockpit");
  });

  it("is offered to finance", async () => {
    installRbac("finance");
    const { container } = renderScreen((await import("./so-workspace")).default);
    await waitFor(() => expect(container.textContent).toContain("Margin cockpit"));
  });
});
