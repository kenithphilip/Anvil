// The delivery challan upload is the first caller of the challan ingest
// (#541 built it with no caller). These tests render the component, pick a
// file, and assert what it sends and what it shows.

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

const EXTRACTED = {
  classification: "delivery_note",
  delivery_note_no: "DC-0042",
  docket_no: "LR-7781",
  buyer_po_no: "4500313249",
  lines: [{ partNumber: "P-1", quantity: 2, line_ref: "1" }],
};

const upload = vi.fn(async () => ({ documentId: "doc-1" }));
const extract = vi.fn(async () => ({ normalized: EXTRACTED }));
const ingestDeliveryNote = vi.fn();

vi.mock("../lib/api", () => ({
  AnvilBackend: {
    documents: {
      upload: (...a: any[]) => (upload as any)(...a),
      extract: (...a: any[]) => (extract as any)(...a),
      ingestDeliveryNote: (...a: any[]) => (ingestDeliveryNote as any)(...a),
    },
  },
}));

import { DeliveryChallanUpload } from "./DeliveryChallanUpload";

const pick = (container: HTMLElement) => {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File(["%PDF-1.4"], "challan.pdf", { type: "application/pdf" });
  fireEvent.change(input, { target: { files: [file] } });
  return file;
};

beforeEach(() => {
  upload.mockClear();
  extract.mockClear();
  ingestDeliveryNote.mockReset();
});

describe("DeliveryChallanUpload", () => {
  it("uploads, reads the file as a delivery note, and records it against this order", async () => {
    ingestDeliveryNote.mockResolvedValue({ ok: true, written: { inserted: 1, updated: 0 }, docket_no: "LR-7781", delivery_note_no: "DC-0042", matched_on: "order chosen by operator; PO number matches" });
    const onRecorded = vi.fn();
    const { container } = render(<DeliveryChallanUpload orderId="ord-1" onRecorded={onRecorded} />);
    const file = pick(container);

    await waitFor(() => expect(ingestDeliveryNote).toHaveBeenCalledTimes(1));
    expect(upload).toHaveBeenCalledWith(file, "delivery_note", { autoScan: false });
    expect(extract).toHaveBeenCalledWith(file, { kind: "delivery_note", source_id: "doc-1", order_id: "ord-1" });
    expect(ingestDeliveryNote).toHaveBeenCalledWith("doc-1", EXTRACTED, "ord-1");
    await waitFor(() => expect(screen.getByText(/Challan DC-0042 recorded/)).toBeTruthy());
    expect(screen.getByText(/docket LR-7781/)).toBeTruthy();
    expect(onRecorded).toHaveBeenCalledTimes(1);
  });

  it("shows the mismatch reason and a link to the order the challan belongs to, and does not report success", async () => {
    ingestDeliveryNote.mockResolvedValue({
      ok: false, reason: "order_mismatch",
      detail: 'This challan cites PO "4500313249", but the chosen order is for PO "4500999999". Nothing was recorded.',
      candidates: [{ id: "ord-2", po_number: "4500313249" }],
      written: { inserted: 0, updated: 0 },
    });
    const onRecorded = vi.fn();
    const { container } = render(<DeliveryChallanUpload orderId="ord-1" onRecorded={onRecorded} />);
    pick(container);

    await waitFor(() => expect(screen.getByText("This challan belongs to a different order")).toBeTruthy());
    expect(screen.getByText(/Nothing was recorded/)).toBeTruthy();
    const open = screen.getByText("Open order for PO 4500313249");
    fireEvent.click(open);
    expect(window.location.hash).toBe("#/so?id=ord-2&tab=invoice_check");
    expect(onRecorded).not.toHaveBeenCalled();
    expect(screen.queryByText(/^Challan .* recorded$/)).toBeNull();
  });

  it("reports an unreadable challan with the extractor's reason, instead of sending an empty extract", async () => {
    extract.mockResolvedValueOnce({ normalized: null, status_reason: "no_adapter_configured" } as any);
    const { container } = render(<DeliveryChallanUpload orderId="ord-1" />);
    pick(container);
    await waitFor(() => expect(screen.getByText("Could not record the challan")).toBeTruthy());
    expect(screen.getByText(/no_adapter_configured/)).toBeTruthy();
    expect(ingestDeliveryNote).not.toHaveBeenCalled();
  });

  it("refuses a file of which only page 1 was read", async () => {
    extract.mockResolvedValueOnce({ normalized: EXTRACTED, large_pdf: true, total_pages: 44 } as any);
    const { container } = render(<DeliveryChallanUpload orderId="ord-1" />);
    pick(container);
    await waitFor(() => expect(screen.getByText(/only the first was read/)).toBeTruthy());
    expect(ingestDeliveryNote).not.toHaveBeenCalled();
  });

  it("holds a low-confidence read until the operator chooses to record it", async () => {
    extract.mockResolvedValueOnce({ normalized: EXTRACTED, status: "low_confidence", status_reason: "despatched and ordered columns unclear" } as any);
    ingestDeliveryNote.mockResolvedValue({ ok: true, written: { inserted: 1, updated: 0 }, docket_no: "LR-7781", delivery_note_no: "DC-0042" });
    const onRecorded = vi.fn();
    const { container } = render(<DeliveryChallanUpload orderId="ord-1" onRecorded={onRecorded} />);
    pick(container);
    await waitFor(() => expect(screen.getByText("Read with low confidence, not recorded yet")).toBeTruthy());
    expect(ingestDeliveryNote).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Record anyway"));
    await waitFor(() => expect(ingestDeliveryNote).toHaveBeenCalledWith("doc-1", EXTRACTED, "ord-1"));
    await waitFor(() => expect(onRecorded).toHaveBeenCalledTimes(1));
  });

  it("does not report success or refresh the check when the write failed", async () => {
    ingestDeliveryNote.mockResolvedValue({ ok: false, reason: "write_failed", detail: "1 of 1 despatch line could not be recorded: invalid date", written: { inserted: 0, updated: 0, errors: [{}] } });
    const onRecorded = vi.fn();
    const { container } = render(<DeliveryChallanUpload orderId="ord-1" onRecorded={onRecorded} />);
    pick(container);
    await waitFor(() => expect(screen.getByText("The despatch lines could not be recorded")).toBeTruthy());
    expect(screen.queryByText(/^Challan .* recorded$/)).toBeNull();
    expect(onRecorded).not.toHaveBeenCalled();
  });
});
