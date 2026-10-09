// Smoke test for screens/so-intake.tsx, plus the order-create handoff for the
// per-line purchase requisition (PR) number. Hand-edited: the generator's
// template covers only the first block.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";

beforeEach(() => {
  installBackend();
  installRbac("admin");
  // jsdom's confirm/alert/prompt are no-ops by default; stub them so
  // accidental click handlers can't pop dialogs during a smoke render.
  vi.stubGlobal("confirm", () => true);
  vi.stubGlobal("alert", () => undefined);
  vi.stubGlobal("prompt", () => null);
});

describe("SoIntake", () => {
  it("renders without throwing", async () => {
    const mod = await import("./so-intake");
    const Screen = mod.default;
    expect(typeof Screen).toBe("function");
    const { container } = renderScreen(Screen);
    expect(container).toBeTruthy();
    // Wait one tick so any useEffect-triggered fetches resolve.
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML.length).toBeGreaterThan(0);
  });
});

// The extractor now reads the buyer's requisition number per line. Intake
// keeps the extracted lines whole, so the value reaches the order without a
// mapping step of its own; this pins that it does, and that it arrives with
// the OCR marker the workspace's "PR no." column renders.
describe("SoIntake order create carries per-line requisition numbers", () => {
  const CUSTOMER = { id: "cust-fx", customer_name: "Fixture Buyer", gstin: "27AABCF1234E1Z5" };

  it("posts lineItems[].requisition_no from the extraction, stamped ocr", async () => {
    const create = vi.fn(async (_body: any) => ({ order: { id: "ord-new-1" } }));
    const reconcileQuotes = vi.fn(async (_id: string, _opts?: any) => ({ summary: null }));
    installBackend({
      health: async () => ({ integrations: [] }),
      customers: {
        list: async () => ({ customers: [CUSTOMER] }),
        listLocations: async () => ({ locations: [] }),
      },
      documents: {
        upload: async () => ({ documentId: "doc-1", scan: { status: "clean" } }),
        extract: async () => ({
          run_id: "run-1",
          adapter_used: "gemini",
          confidence_overall: 0.95,
          normalized: {
            customer: { name: "Fixture Buyer", gstin: CUSTOMER.gstin, requisition_no: "1000343964" },
            lines: [
              { partNumber: "PN-1", description: "Head assy", quantity: 2, unitPrice: 100, requisition_no: "1000343964" },
              { partNumber: "PN-2", description: "Shank", quantity: 1, unitPrice: 50, requisition_no: "1000344102" },
            ],
          },
        }),
      },
      orders: { create, reconcileQuotes },
    });
    (window as any).notifySuccess = vi.fn();
    (window as any).notifyError = vi.fn();
    (window as any).notifyWarn = vi.fn();
    (window as any).notifyLive = vi.fn();

    const { container } = renderScreen((await import("./so-intake")).default);
    await new Promise((r) => setTimeout(r, 0));
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput).not.toBeNull();
    Object.defineProperty(fileInput, "files", {
      value: [new File(["%PDF-1.4 fake"], "po.pdf", { type: "application/pdf" })],
    });
    fireEvent.change(fileInput);

    // The GSTIN matches, so the customer is auto-selected and continue can create.
    await waitFor(() => {
      const sel = container.querySelector("#so-intake-customer") as HTMLSelectElement | null;
      expect(sel?.value).toBe(CUSTOMER.id);
    }, { timeout: 2000 });

    const cont = Array.from(container.querySelectorAll("button"))
      .find((b) => /^\s*continue/i.test(b.textContent || "")) as HTMLButtonElement;
    expect(cont).toBeTruthy();
    fireEvent.click(cont);

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1), { timeout: 2000 });
    const body = create.mock.calls[0][0];
    const items = body.result.salesOrder.lineItems;
    expect(items.map((l: any) => l.requisition_no)).toEqual(["1000343964", "1000344102"]);
    expect(items[0]._field_sources.requisition_no).toBe("ocr");
    expect(items[1]._field_sources.requisition_no).toBe("ocr");
    // The header slot rides along on the extracted customer block, which is
    // what the workspace's "Customer from PO header" panel reads.
    expect(body.result.salesOrder.customer.requisition_no).toBe("1000343964");
    // The server reconciles on create, so the intake asks only if the lines
    // changed since, and gets that run back rather than running it again.
    await waitFor(() => expect(reconcileQuotes).toHaveBeenCalledWith("ord-new-1", { if_changed: true }), { timeout: 2000 });
  });
});
