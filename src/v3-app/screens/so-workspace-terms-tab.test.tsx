// The SO workspace's Terms tab appears when the order's terms check is
// visible to the caller: mode on, or shadow for an admin (who reads it with
// include_shadow). An engineer in shadow mode sees no tab at all.
// Invented fixtures.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";

const ORDER_ID = "ord-terms-1";
const order = {
  id: ORDER_ID, status: "DRAFT", po_number: "PO-TERMS-1", customer_id: "cust-1", customer_name: "Terms Fixture",
  result: { salesOrder: { lineItems: [{ partNumber: "TP-1", description: "part", qty: 1, rate: 10, uom: "NOS" }] } },
  preflight_payload: {}, documents: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
};

const visibleView = (shadow = false) => ({
  order_id: ORDER_ID, mode: shadow ? "shadow" : "on", shadow, visible: true,
  policy: { version: 1, decide_at_or_above: "warn" },
  check: { id: "ck1", po_terms_status: "read", po_source: "terms_pass", clause_count: 2 },
  flags: [{
    id: "f1", clause: "taxes", clause_label: "Taxes", outcome: "deviates", direction: "against_us", severity: "high",
    method: "rule", needs_decision: true, state: "undecided",
    po: { text: "Prices inclusive of all taxes", label: "from PO, page 4" },
    quote: { quote_number: "Q-9", primary: true, text: "GST extra", label: "from uploaded quote Q-9" },
    rationale: "Taxes: GST: PO inclusive, quote extra (against us).", decision: null, decisions: [], allowed: ["request_amendment", "reject_term"],
  }],
  counts: { total: 1, undecided: 1, amendment_requested: 0, decided: 0 },
});

let terms: any;

const mount = async () => {
  installBackend({
    orders: { get: vi.fn(async () => ({ order })), terms },
    audit: { list: vi.fn(async () => []) },
    events: { list: vi.fn(async () => []) },
    cost: { breakdown: vi.fn(async () => null) },
  });
  const mod = await import("./so-workspace");
  return renderScreen(mod.default);
};

beforeEach(() => {
  (window as any).notifyError = vi.fn();
  (window as any).notifySuccess = vi.fn();
  window.location.hash = "#/so?id=" + ORDER_ID;
});

describe("SO workspace: the Terms tab", () => {
  it("with the check on, shows a Terms tab with the undecided count, and the flags behind it", async () => {
    installRbac("sales_engineer");
    terms = vi.fn(async () => visibleView());
    const { findByRole, findByText, container } = await mount();
    const tab = await findByRole("tab", { name: /Terms/ });
    expect(tab.textContent).toBe("Terms1");
    expect(terms).toHaveBeenCalledWith(ORDER_ID, { includeShadow: false });
    await act(async () => { fireEvent.click(tab); });
    await findByText("Prices inclusive of all taxes");
    expect(container.textContent).toContain("from uploaded quote Q-9");
    expect(container.textContent).not.toContain("Engineers do not see these flags.");
  });

  it("in shadow mode an engineer has no Terms tab", async () => {
    installRbac("sales_engineer");
    terms = vi.fn(async () => ({ order_id: ORDER_ID, mode: "shadow", shadow: true, visible: false, hidden: true, flags: [] }));
    const { findByRole, queryByRole } = await mount();
    await findByRole("heading", { name: /PO-TERMS-1/ });
    await waitFor(() => expect(terms).toHaveBeenCalled());
    expect(queryByRole("tab", { name: /Terms/ })).toBeNull();
  });

  it("an admin reads the shadow check and sees it badged", async () => {
    installRbac("admin");
    terms = vi.fn(async (_id: string, opts: any) => (opts?.includeShadow ? visibleView(true) : { mode: "shadow", visible: false, flags: [] }));
    const { findByRole, findByText } = await mount();
    const tab = await findByRole("tab", { name: /Terms/ });
    expect(terms).toHaveBeenCalledWith(ORDER_ID, { includeShadow: true });
    await act(async () => { fireEvent.click(tab); });
    await findByText("Engineers do not see these flags.", { exact: false });
  });

  it("with the check off there is no Terms tab", async () => {
    installRbac("sales_manager");
    terms = vi.fn(async () => ({ mode: "off", visible: false, flags: [] }));
    const { findByRole, queryByRole } = await mount();
    await findByRole("heading", { name: /PO-TERMS-1/ });
    await waitFor(() => expect(terms).toHaveBeenCalled());
    expect(queryByRole("tab", { name: /Terms/ })).toBeNull();
  });
});
