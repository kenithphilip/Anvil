// The approver's decisions in the SO workspace (audit F5, F9, F10):
//   - "return for fix" takes its reason in the shared in-app dialog, not
//     window.prompt, and its toast no longer claims "operator notified";
//   - approve is offered only in PENDING_REVIEW, and only to so.approve;
//   - an approved Mode B order can still be returned or cancelled;
//   - the Activity and Approval tabs show each decision's reason.
// Invented fixtures.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, waitFor, fireEvent } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";

const ORDER_ID = "ord-decide-1";
const DAY = 24 * 3600 * 1000;
const makeOrder = (over: Record<string, unknown> = {}) => ({
  id: ORDER_ID,
  status: "PENDING_REVIEW",
  po_number: "PO-DECIDE-1",
  customer_id: "cust-1",
  payload_hash: "hash-decide-1",
  result: { salesOrder: { lineItems: [{ partNumber: "DC-1", description: "bracket", qty: 2, rate: 50, uom: "NOS" }] } },
  preflight_payload: {},
  documents: [],
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  ...over,
});

let updateSpy: any;
let promptSpy: any;

const mount = async (order: Record<string, unknown>, opts: { mode?: "A" | "B"; audit?: any[]; tab?: string } = {}) => {
  window.location.hash = "#/so?id=" + ORDER_ID + (opts.tab ? "&tab=" + opts.tab : "");
  installBackend({
    orders: { get: vi.fn(async () => ({ order })), update: updateSpy },
    audit: { list: vi.fn(async () => opts.audit || []) },
    events: { list: vi.fn(async () => []) },
    cost: { breakdown: vi.fn(async () => null) },
    docai: { soProcessingMode: vi.fn(async () => ({ mode: opts.mode || "A" })), getRun: vi.fn(async () => null) },
  });
  const mod = await import("./so-workspace");
  // lib/toasts installs window.notify* when the screen's modules load, so
  // the spies go on after the import.
  (window as any).notifySuccess = vi.fn();
  (window as any).notifyError = vi.fn();
  (window as any).notifyWarn = vi.fn();
  const view = renderScreen(mod.default);
  await waitFor(() => expect(view.container.querySelector(".ws-title h1")).toBeTruthy());
  return view;
};

const headerButton = (c: HTMLElement, text: string) =>
  Array.from(c.querySelectorAll(".ws-title button")).find((b) => (b.textContent || "").trim().endsWith(text)) as HTMLButtonElement | undefined;
const approveButton = (c: HTMLElement) =>
  Array.from(c.querySelectorAll(".ws-title button")).find((b) => (b.getAttribute("title") || "").startsWith("Approve")) as HTMLButtonElement | undefined;
const dialogButton = (label: string) =>
  Array.from(document.querySelectorAll("[role='dialog'] button")).find((b) => (b.textContent || "").trim() === label) as HTMLButtonElement | undefined;
const reasonBox = () => document.querySelector("[role='dialog'] [data-testid='reason-input']") as HTMLTextAreaElement;

beforeEach(() => {
  updateSpy = vi.fn(async () => ({}));
  promptSpy = vi.fn(() => "a prompt answer");
  vi.stubGlobal("prompt", promptSpy);
  installRbac("sales_manager");
});

describe("return for fix", () => {
  it("uses the shared reason dialog, sends the trimmed reason, and tells the truth in the toast", async () => {
    const { container } = await mount(makeOrder());
    await waitFor(() => expect(headerButton(container, "return for fix")?.disabled).toBe(false));
    await act(async () => { fireEvent.click(headerButton(container, "return for fix")!); });
    expect(promptSpy).not.toHaveBeenCalled();
    expect(document.querySelector("[role='dialog']")!.textContent).toContain("Return this order for a fix?");
    expect(dialogButton("Return for fix")!.disabled).toBe(true);

    await act(async () => { fireEvent.change(reasonBox(), { target: { value: "   Rate on line 1 must be 45   " } }); });
    await act(async () => { fireEvent.click(dialogButton("Return for fix")!); });
    await waitFor(() => expect(updateSpy).toHaveBeenCalled());
    const [id, body] = updateSpy.mock.calls[0];
    expect(id).toBe(ORDER_ID);
    expect(body).toMatchObject({ status: "DRAFT", correction_reason: "Rate on line 1 must be 45", correction_requested_by: "sales_manager" });
    expect(typeof body.correction_requested_at).toBe("string");

    const [title, detail] = (window as any).notifySuccess.mock.calls[0];
    expect(title).toBe("Returned to the engineer");
    expect(detail).toBe("PO-DECIDE-1: no notification is sent. They see your reason when they open the order.");
  });

  it("is not offered after a failed Tally import, where the server refuses it", async () => {
    const { container } = await mount(makeOrder({ status: "FAILED_TALLY_IMPORT" }));
    await waitFor(() => expect(headerButton(container, "return for fix")).toBeTruthy());
    expect(headerButton(container, "return for fix")!.disabled).toBe(true);
  });
});

describe("approve", () => {
  it("is enabled in PENDING_REVIEW", async () => {
    const { container } = await mount(makeOrder());
    await waitFor(() => expect(approveButton(container)).toBeTruthy());
    expect(approveButton(container)!.disabled).toBe(false);
    expect(approveButton(container)!.getAttribute("title")).toBe("Approve order");
  });

  it.each(["DRAFT", "BLOCKED", "APPROVED", "FAILED_TALLY_IMPORT", "CANCELLED"])("is disabled in %s", async (status) => {
    const { container } = await mount(makeOrder({ status }));
    await waitFor(() => expect(approveButton(container)).toBeTruthy());
    expect(approveButton(container)!.disabled).toBe(true);
    expect(approveButton(container)!.getAttribute("title")).toBe("Approve is available while the order is pending review");
  });

  it("is not shown to a role without so.approve", async () => {
    installRbac("sales_engineer");
    const { container } = await mount(makeOrder());
    await waitFor(() => expect(headerButton(container, "return for fix")).toBeTruthy());
    expect(approveButton(container)).toBeUndefined();
  });
});

describe("an approved Mode B order whose approval has expired", () => {
  const approvedB = () => makeOrder({
    status: "APPROVED",
    approval: { payloadHash: "hash-decide-1", approvedBy: "u-1" },
    approved_at: new Date(Date.now() - 3 * DAY).toISOString(),
    approval_expires_at: new Date(Date.now() - 2 * DAY).toISOString(),
  });

  it("can be returned for a fix", async () => {
    const { container } = await mount(approvedB(), { mode: "B" });
    await waitFor(() => expect(container.querySelector("[data-testid='mode-b-state']")).toBeTruthy());
    expect(headerButton(container, "return for fix")!.disabled).toBe(false);
    await act(async () => { fireEvent.click(headerButton(container, "return for fix")!); });
    await act(async () => { fireEvent.change(reasonBox(), { target: { value: "Customer moved the delivery date" } }); });
    await act(async () => { fireEvent.click(dialogButton("Return for fix")!); });
    await waitFor(() => expect(updateSpy).toHaveBeenCalledWith(ORDER_ID, expect.objectContaining({ status: "DRAFT", correction_reason: "Customer moved the delivery date" })));
  });

  it("can be cancelled", async () => {
    const { container } = await mount(approvedB(), { mode: "B" });
    await waitFor(() => expect(container.querySelector("[data-testid='mode-b-state']")).toBeTruthy());
    const cancel = Array.from(container.querySelectorAll("button")).find((b) => b.getAttribute("title") === "Set order status to CANCELLED") as HTMLButtonElement;
    expect(cancel.disabled).toBe(false);
    await act(async () => { fireEvent.click(cancel); });
    await act(async () => { fireEvent.change(reasonBox(), { target: { value: "Customer cancelled by phone" } }); });
    await act(async () => { fireEvent.click(dialogButton("Cancel order")!); });
    await waitFor(() => expect(updateSpy).toHaveBeenCalledWith(ORDER_ID, { status: "CANCELLED", reason: "Customer cancelled by phone" }));
  });
});

const AUDIT = [
  {
    id: "a3", action: "update_order", object_type: "order", actor_role: "sales_manager",
    created_at: "2026-10-12T10:00:00Z",
    before_payload: { status: "PENDING_REVIEW" }, after_payload: { status: "CANCELLED" },
    reason: "Customer withdrew the PO",
  },
  {
    id: "a2", action: "manager_requested_correction", object_type: "order", actor_role: "finance",
    created_at: "2026-10-11T10:00:00Z",
    before_payload: { status: "PENDING_REVIEW" }, after_payload: { status: "DRAFT" },
    reason: "Wrong ship-to address",
  },
  {
    id: "a1", action: "approve_order", object_type: "order", actor_role: "sales_manager",
    created_at: "2026-10-10T10:00:00Z",
    before_payload: { status: "PENDING_REVIEW" }, after_payload: { status: "APPROVED" },
  },
];

describe("the reasons are shown", () => {
  it("on the Activity tab, as plain text with the status change", async () => {
    const { container } = await mount(makeOrder({ status: "CANCELLED" }), { audit: AUDIT, tab: "activity" });
    await waitFor(() => expect(container.querySelectorAll("[data-testid='activity-reason']").length).toBe(2));
    const reasons = Array.from(container.querySelectorAll("[data-testid='activity-reason']")).map((n) => n.textContent);
    expect(reasons).toEqual([" · reason: Customer withdrew the PO", " · reason: Wrong ship-to address"]);
    const stream = container.querySelector(".stream")!;
    expect(stream.textContent).toContain("update_order · order · PENDING_REVIEW to CANCELLED");
    expect(stream.textContent).toContain("manager_requested_correction · order · PENDING_REVIEW to DRAFT");
    // The markup is real elements now, not "<b>" printed as text.
    expect(stream.textContent).not.toContain("<b>");
    expect(stream.querySelectorAll("b").length).toBeGreaterThanOrEqual(3);
  });

  it("on the Approval tab, as a decision history", async () => {
    const { container } = await mount(makeOrder({ status: "CANCELLED" }), { audit: AUDIT, tab: "approval" });
    await waitFor(() => expect(container.querySelector("[data-testid='decision-history']")).toBeTruthy());
    const rows = Array.from(container.querySelectorAll("[data-testid='decision-history'] tbody tr"))
      .map((tr) => Array.from(tr.querySelectorAll("td")).slice(1).map((td) => td.textContent));
    expect(rows).toEqual([
      ["Cancelled", "sales manager", "Customer withdrew the PO"],
      ["Returned for fix", "finance", "Wrong ship-to address"],
      ["Approved", "sales manager", "none given"],
    ]);
  });

  it("names who approved an approved order, and the pending text names the right place", async () => {
    const approved = makeOrder({
      status: "APPROVED",
      approval: { payloadHash: "hash-decide-1", approvedBy: "u-1" },
      approved_at: "2026-10-10T10:00:00Z",
      approval_expires_at: "2026-10-11T10:00:00Z",
    });
    const { container } = await mount(approved, { audit: [AUDIT[2]], tab: "approval" });
    await waitFor(() => expect(container.querySelector("[data-testid='decision-history']")).toBeTruthy());
    const card = container.querySelector("[data-testid='decision-history']")!.parentElement!;
    expect(card.textContent).toContain("Approved by");
    expect(card.textContent).toContain("sales manager");
    expect(card.textContent).toContain("hash-decide-1");
  });

  it("says where approval happens while the order is pending review", async () => {
    const { container } = await mount(makeOrder(), { tab: "approval" });
    await waitFor(() => expect(container.querySelector("[data-testid='approval-status-text']")).toBeTruthy());
    expect(container.querySelector("[data-testid='approval-status-text']")!.textContent)
      .toBe("Not approved yet. A sales manager, finance or admin approves it on this screen with the approve button.");
  });
});
