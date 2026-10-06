// Screens that show cost data follow rbac cost.view: the approvals queue says
// "hidden" (never "0.0%" or "not costed") when the server withheld the margin,
// and the SO workspace offers its Margin cockpit only to cost roles.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";

const ROW = {
  id: "ap-1", order_id: "ord-1", status: "PENDING", approver_role: "sales_manager",
  po_number: "PO-9", customer_name: "Fixture Co", order_mode: "SPARES", line_count: 1, value_inr: 236,
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
    installBackend({ getConfig: () => ({ url: "https://api.test", tenantId: "t-1" }), getSession: () => ({ access_token: "x" }) } as any);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ approvals: rows }) })));
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
