// Tally Push in Mode B. The server refuses every push in Mode B
// (tally/push.js returns 409), so the screen says why push is off, offers no
// push button and drops the push-queue wording. While the mode loads, the
// push button is disabled. Mode A is unchanged: each queued order has a push
// button that calls tally.push. Renders the real screen against a stubbed
// client. Invented fixtures.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";

// The shape GET /api/admin/so_processing_mode returns (labels as in MODES).
const MODES = {
  A: { mode: "A", label: "Anvil processes sales orders" },
  B: { mode: "B", label: "Your team processes them; Anvil watches" },
};

const QUEUED = [{
  id: "ord-1", status: "APPROVED", po_number: "PO-T-001",
  customer: { customer_name: "Test Customer One" },
  approval: { payloadHash: "hash-1" }, payload_hash: "hash-1",
  result: { salesOrder: { grandTotal: 1000 } },
  created_at: "2026-10-01T09:00:00Z", updated_at: "2026-10-01T09:00:00Z",
}];

const mount = async (soProcessingMode: any, queued: any[] = QUEUED) => {
  const push = vi.fn(async () => ({ ok: true }));
  installBackend({
    orders: { list: vi.fn(async (q: any) => ({ orders: q?.status === "APPROVED" ? queued : [] })) },
    docai: { soProcessingMode },
    // The bridge is configured, so in Mode A the push button is enabled.
    health: vi.fn(async () => ({ integrations: [{ id: "tally", configured: true }] })),
    tally: { push },
  });
  const mod = await import("./tally-push");
  return { ...renderScreen(mod.default), push };
};

const pushButtons = (c: HTMLElement) => Array.from(c.querySelectorAll("button"))
  .filter((b) => /^push\b/i.test((b.textContent || "").trim()));

beforeEach(() => {
  installRbac("admin");
});

describe("Tally Push: Mode B", () => {
  it("says why push is off and offers no push button", async () => {
    const read = vi.fn(async () => ({ mode: "B", modes: MODES, applied: true }));
    const { container, push } = await mount(read);
    await waitFor(() => expect(container.textContent).toContain("Push is off in Mode B: Your team processes them; Anvil watches"));
    expect(container.textContent).toContain("Your team enters these sales orders in Tally by hand, and Anvil checks them against the PO.");
    expect(container.textContent).toContain("Anvil does not push vouchers in Mode B");
    // The approved order is still listed, without a push button.
    await waitFor(() => expect(container.textContent).toContain("PO-T-001"));
    expect(pushButtons(container)).toHaveLength(0);
    // The push-only banners do not contradict the reason.
    expect(container.textContent).not.toContain("Push permission required");
    expect(container.textContent).not.toContain("Tally bridge not configured");
    expect(push).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalled();
  });

  it("describes approved orders, not a push queue", async () => {
    const { container } = await mount(vi.fn(async () => ({ mode: "B", modes: MODES, applied: true })));
    await waitFor(() => expect(container.textContent).toContain("Push is off in Mode B"));
    await waitFor(() => expect(container.textContent).toContain("PO-T-001"));
    const text = container.textContent || "";
    expect(text).toContain("Approved orders");
    expect(text).toContain("approved · keyed in Tally by hand");
    expect(text).not.toContain("Push queue");
    expect(text).not.toContain("awaiting Tally");
    // The push counters do not apply in Mode B.
    expect(text).not.toContain("Pushed today");
    expect(text).not.toContain("needs retry");
    expect(text).not.toContain("re-hash + push");
    expect(container.querySelectorAll(".kpi.live")).toHaveLength(0);
  });

  it("says there are no approved orders when the list is empty", async () => {
    const { container } = await mount(vi.fn(async () => ({ mode: "B", modes: MODES, applied: true })), []);
    await waitFor(() => expect(container.textContent).toContain("No approved orders."));
    expect(container.textContent).not.toContain("Nothing waiting to push.");
  });
});

describe("Tally Push: while the mode loads", () => {
  it("renders the push button disabled, so a quick click cannot push", async () => {
    // The mode read never answers, as on a slow network after the list loads.
    const { container, push } = await mount(vi.fn(() => new Promise(() => {})));
    await waitFor(() => expect(container.textContent).toContain("PO-T-001"));
    const btns = pushButtons(container);
    expect(btns).toHaveLength(1);
    expect(btns[0].hasAttribute("disabled")).toBe(true);
    fireEvent.click(btns[0]);
    await new Promise((r) => setTimeout(r, 0));
    expect(push).not.toHaveBeenCalled();
  });
});

describe("Tally Push: Mode A", () => {
  it("is unchanged: the queued order has an enabled push button that pushes it", async () => {
    const { container, push } = await mount(vi.fn(async () => ({ mode: "A", modes: MODES, applied: true })));
    await waitFor(() => expect(container.textContent).toContain("PO-T-001"));
    await waitFor(() => {
      const btns = pushButtons(container);
      expect(btns).toHaveLength(1);
      expect(btns[0].hasAttribute("disabled")).toBe(false);
    });
    expect(container.textContent).not.toContain("Push is off in Mode B");
    fireEvent.click(pushButtons(container)[0]);
    await waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    expect((push.mock.calls[0] as any[])[0]).toMatchObject({ orderId: "ord-1", payloadHash: "hash-1" });
  });

  it("behaves as Mode A when the mode cannot be read, as the server does", async () => {
    const { container, push } = await mount(vi.fn(async () => { throw new Error("HTTP 500"); }));
    await waitFor(() => expect(container.textContent).toContain("PO-T-001"));
    await waitFor(() => {
      const btns = pushButtons(container);
      expect(btns).toHaveLength(1);
      expect(btns[0].hasAttribute("disabled")).toBe(false);
    });
    expect(container.textContent).not.toContain("Push is off in Mode B");
    fireEvent.click(pushButtons(container)[0]);
    await waitFor(() => expect(push).toHaveBeenCalledTimes(1));
  });
});
