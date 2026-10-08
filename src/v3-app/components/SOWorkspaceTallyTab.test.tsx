// The SO workspace Tally tab states the tenant's sales-order processing mode.
//
// In Mode B the push and the retry drain both refuse with a 409. The tab now
// says so up front, with the mode's label from /api/admin/so_processing_mode,
// instead of leaving the operator to find out from an error. Renders the real
// TallyTab against a stubbed client. Invented fixtures.

import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { installBackend } from "../test-utils";
import { TallyTab } from "./SOWorkspaceOrderPanels";

// The shape GET /api/admin/so_processing_mode returns (labels as in MODES).
const MODES = {
  A: { mode: "A", label: "Anvil processes sales orders" },
  B: { mode: "B", label: "Your team processes them; Anvil watches" },
};

const order = { id: "ord-1", status: "APPROVED", tally_status: null, payload_hash: "h-1" };

const mount = (soProcessingMode: any) => {
  installBackend({
    docai: { soProcessingMode },
    tally: { getOrderRecon: vi.fn(async () => ({ voucher_record: null, findings: [] })) },
  });
  return render(<TallyTab orderId="ord-1" order={order} onRefresh={() => {}} />);
};

describe("TallyTab: processing mode", () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("in Mode B says Anvil does not push, and why", async () => {
    const read = vi.fn(async () => ({ mode: "B", modes: MODES, applied: true }));
    const { container } = mount(read);
    await waitFor(() => expect(container.textContent).toContain("Mode B: Your team processes them; Anvil watches"));
    expect(container.textContent).toContain("Your team enters this sales order in Tally by hand.");
    expect(container.textContent).toContain("a push or a queued retry is refused");
    expect(container.textContent).not.toContain("Anvil pushes this sales order to Tally");
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("in Mode A says Anvil pushes the approved order", async () => {
    const { container } = mount(vi.fn(async () => ({ mode: "A", modes: MODES, applied: true })));
    await waitFor(() => expect(container.textContent).toContain("Mode A: Anvil processes sales orders"));
    expect(container.textContent).toContain("Anvil pushes this sales order to Tally as a voucher once it is approved.");
    expect(container.textContent).not.toContain("refused");
  });

  it("says the mode is unknown when it cannot be read, rather than guessing", async () => {
    const { container } = mount(vi.fn(async () => { throw new Error("HTTP 500"); }));
    await waitFor(() => expect(container.textContent).toContain("Sales-order processing mode unknown"));
    expect(container.textContent).toContain("HTTP 500");
    expect(container.textContent).not.toContain("Mode A:");
    expect(container.textContent).not.toContain("Mode B:");
  });
});
