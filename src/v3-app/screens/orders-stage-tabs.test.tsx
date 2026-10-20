// The SO list reads each order's stage (plan R-M1, C-10): its tabs are the
// stages, labelled as every screen labels them. The "Approval" tab used to
// mean APPROVED, while Home's "In approval" meant PENDING_REVIEW, and a Mode B
// order done in Tally still read "approval". Invented fixtures.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";

const row = (id: string, status: string, stage: string, next = "none") => ({
  id, status, po_number: "PO-" + id, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  result: {}, stage: { stage, next_action: next },
});

beforeEach(() => {
  installRbac("sales_engineer");
  installBackend({
    orders: {
      list: vi.fn(async () => ({ orders: [
        row("REV", "PENDING_REVIEW", "in_approval", "approve"),
        row("DONE", "APPROVED", "verified"),
        row("WAIT", "APPROVED", "approved", "send_handoff"),
      ] })),
    },
  });
});

describe("SO list tabs", () => {
  it("files each order under its stage, and hides a stage with no orders", async () => {
    renderScreen((await import("./orders")).default);
    await screen.findByText("PO-DONE");
    const tab = (label: string) => screen.queryAllByRole("tab").find((t) => (t.textContent || "").startsWith(label));
    expect(tab("In approval")).toBeTruthy();
    expect(tab("Received")).toBeUndefined();

    fireEvent.click(tab("Verified in ERP")!);
    expect(screen.getByText("PO-DONE")).toBeTruthy();
    expect(screen.queryByText("PO-WAIT")).toBeNull();
    expect(screen.queryByText("PO-REV")).toBeNull();
  });
});
