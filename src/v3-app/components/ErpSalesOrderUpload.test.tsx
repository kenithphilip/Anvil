// The ERP sales-order upload is the first caller of the attach endpoint
// (/api/orders/attach_sales_order had no screen). Without it the "PO vs ERP"
// tab said "No sales order attached" forever, and the Mode B comparison never
// had an ERP side. These tests render the component and the tab, pick a file,
// and assert what is sent and what is shown. Invented fixtures.

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

const EXTRACTED = {
  classification: "sales_order",
  voucher_no: "SO-4417",
  buyer_ref_order_no: "PO-TEST-0001",
  lines: [{ partNumber: "P-1", quantity: 2 }],
};

const upload = vi.fn(async () => ({ documentId: "doc-so-1" }));
const extract = vi.fn(async (): Promise<any> => ({ status: "ok", normalized: EXTRACTED }));
const attachSalesOrder = vi.fn();
const threeWayReport = vi.fn();

vi.mock("../lib/api", () => ({
  AnvilBackend: {
    documents: {
      upload: (...a: any[]) => (upload as any)(...a),
      extract: (...a: any[]) => (extract as any)(...a),
    },
    orders: {
      attachSalesOrder: (...a: any[]) => (attachSalesOrder as any)(...a),
      threeWayReport: (...a: any[]) => (threeWayReport as any)(...a),
    },
  },
}));

import { ErpSalesOrderUpload } from "./ErpSalesOrderUpload";
import { ThreeWayPanel } from "./ThreeWayPanel";

const pick = (container: HTMLElement) => {
  const input = container.querySelector('input[aria-label="Upload ERP sales order"]') as HTMLInputElement;
  const file = new File(["%PDF-1.4"], "erp-so.pdf", { type: "application/pdf" });
  fireEvent.change(input, { target: { files: [file] } });
  return file;
};

const ATTACHED = {
  attached: true,
  matched_via: "explicit",
  order: { id: "ord-1", po_number: "PO-TEST-0001" },
  match: { matched: true, reference: "PO-TEST-0001", overrode_reference: false },
  comparable: true,
  comparability: { comparable: true },
  document: { id: "doc-so-1", filename: "erp-so.pdf" },
  compared: false,
};

beforeEach(() => {
  upload.mockClear();
  extract.mockReset();
  extract.mockResolvedValue({ status: "ok", normalized: EXTRACTED });
  attachSalesOrder.mockReset();
  threeWayReport.mockReset();
});

describe("ErpSalesOrderUpload", () => {
  it("uploads, reads the file as a sales order, and attaches it to this order", async () => {
    attachSalesOrder.mockResolvedValue(ATTACHED);
    const onAttached = vi.fn();
    const { container } = render(<ErpSalesOrderUpload orderId="ord-1" onAttached={onAttached} />);
    const file = pick(container);

    await waitFor(() => expect(attachSalesOrder).toHaveBeenCalledTimes(1));
    expect(upload).toHaveBeenCalledWith(file, "sales_order", { autoScan: false });
    expect(extract).toHaveBeenCalledWith(file, { kind: "sales_order", source_id: "doc-so-1", order_id: "ord-1" });
    // The order id is passed, so the attach does not depend on the reference reading.
    expect(attachSalesOrder).toHaveBeenCalledWith("doc-so-1", EXTRACTED, "ord-1");
    await waitFor(() => expect(screen.getByText("Sales order SO-4417 attached")).toBeTruthy());
    expect(onAttached).toHaveBeenCalledTimes(1);
  });

  it("says so when the document names a different PO", async () => {
    attachSalesOrder.mockResolvedValue({
      ...ATTACHED,
      match: { matched: true, reference: "PO-TEST-0999", overrode_reference: true },
    });
    const { container } = render(<ErpSalesOrderUpload orderId="ord-1" />);
    pick(container);
    await waitFor(() => expect(screen.getByText(/It names PO PO-TEST-0999, not this order's PO/)).toBeTruthy());
  });

  it("says when an attached sales order cannot be compared, in the endpoint's words", async () => {
    attachSalesOrder.mockResolvedValue({
      ...ATTACHED,
      comparable: false,
      comparability: { comparable: false, reason: "no_lines", detail: "No line items could be read, so there is nothing to compare line by line." },
    });
    const { container } = render(<ErpSalesOrderUpload orderId="ord-1" />);
    pick(container);
    await waitFor(() => expect(screen.getByText(/It cannot be compared\. No line items could be read/)).toBeTruthy());
  });

  it("does not attach a document that was not read as a sales order", async () => {
    extract.mockResolvedValueOnce({ status: "ok", normalized: { ...EXTRACTED, classification: "non_sales_order", lines: [] } });
    const onAttached = vi.fn();
    const { container } = render(<ErpSalesOrderUpload orderId="ord-1" onAttached={onAttached} />);
    pick(container);
    await waitFor(() => expect(screen.getByText("Could not attach the sales order")).toBeTruthy());
    expect(screen.getByText(/was not read as a sales order, so nothing was attached/)).toBeTruthy();
    expect(attachSalesOrder).not.toHaveBeenCalled();
    expect(onAttached).not.toHaveBeenCalled();
  });

  it("reports an unreadable file with the extractor's reason", async () => {
    extract.mockResolvedValueOnce({ status: "failed", normalized: null, status_reason: "no_adapter_configured" });
    const { container } = render(<ErpSalesOrderUpload orderId="ord-1" />);
    pick(container);
    await waitFor(() => expect(screen.getByText(/no_adapter_configured/)).toBeTruthy());
    expect(attachSalesOrder).not.toHaveBeenCalled();
  });

  it("does not attach a large file of which only the first page was read", async () => {
    extract.mockResolvedValueOnce({ status: "ok", normalized: EXTRACTED, large_pdf: true, total_pages: 31 });
    const { container } = render(<ErpSalesOrderUpload orderId="ord-1" />);
    pick(container);
    await waitFor(() => expect(screen.getByText(/runs to 31 pages and only the first was read, so nothing was attached/)).toBeTruthy());
    expect(attachSalesOrder).not.toHaveBeenCalled();
  });

  it("holds a low-confidence read until the operator confirms it", async () => {
    attachSalesOrder.mockResolvedValue(ATTACHED);
    extract.mockResolvedValueOnce({ status: "low_confidence", status_reason: "few fields read", normalized: EXTRACTED });
    const { container } = render(<ErpSalesOrderUpload orderId="ord-1" />);
    pick(container);
    await waitFor(() => expect(screen.getByText("Read with low confidence, not attached yet")).toBeTruthy());
    expect(attachSalesOrder).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Attach anyway"));
    await waitFor(() => expect(attachSalesOrder).toHaveBeenCalledWith("doc-so-1", EXTRACTED, "ord-1"));
  });

  it("shows the server's error when the attach is refused", async () => {
    attachSalesOrder.mockRejectedValue(new Error("This database has not had migration 222 applied, so a document cannot be linked with role 'sales_order'."));
    const { container } = render(<ErpSalesOrderUpload orderId="ord-1" />);
    pick(container);
    await waitFor(() => expect(screen.getByText(/migration 222/)).toBeTruthy());
    expect(screen.queryByText(/attached$/)).toBeNull();
  });
});

describe("the PO vs ERP tab", () => {
  it("offers the upload when nothing is attached, then renders the comparison once it is", async () => {
    attachSalesOrder.mockResolvedValue(ATTACHED);
    threeWayReport
      .mockResolvedValueOnce({
        available: false, reason: "no_sales_order_attached",
        detail: "No sales order has been attached to this order, so there is nothing to compare against.",
      })
      .mockResolvedValue({
        available: true,
        po_number: "PO-TEST-0001",
        erp_document: { voucher_no: "SO-4417" },
        header: [{ key: "payment_terms", verdict: "anvil_correct", truth: "30 days", anvil: "30 days", tally: "45 days" }],
        lines: [],
        erp_only: [],
        missing_from_erp: 0,
        both_deviated: [],
        score: { decidable: 1, undecidable: 0, anvil_error_rate: 0, process_deviation_rate: 1 },
      });

    const { container } = render(<ThreeWayPanel orderId="ord-1" />);
    await waitFor(() => expect(screen.getByText("No sales order attached")).toBeTruthy());
    expect(threeWayReport).toHaveBeenCalledWith("ord-1");

    pick(container);
    await waitFor(() => expect(attachSalesOrder).toHaveBeenCalledWith("doc-so-1", EXTRACTED, "ord-1"));

    // The report is rebuilt against the attached sales order.
    await waitFor(() => expect(screen.getByText("ERP differs")).toBeTruthy());
    expect(threeWayReport).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("ERP voucher SO-4417");
    expect(container.textContent).toContain("45 days");
    // The upload's own outcome stays on screen across the reload.
    expect(screen.getByText("Sales order SO-4417 attached")).toBeTruthy();
    expect(screen.queryByText("No sales order attached")).toBeNull();
  });
});
