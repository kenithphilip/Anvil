// Phase C tests: per-field confirm/flag tri-state + correction loop.
//
// Coverage:
//   - clicking ✓ marks a field confirmed (row gets rp-status-confirmed)
//   - "mark all correct" promotes every pending field
//   - clicking ! flags + opens the inline corrector
//   - "save fix" POSTs to /api/docai/correction with the right body
//   - a 403 from the endpoint surfaces a friendly message
//   - canCorrect=false disables the save action

import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fireEvent, render, waitFor, within } from "@testing-library/react";
import ReviewPane, { EvidenceByField } from "./ReviewPane";

vi.mock("./PdfPagePreview", () => ({
  __esModule: true,
  default: () => <div data-testid="pdf-stub">pdf</div>,
}));

const EVIDENCE: EvidenceByField = {
  "customer.gstin": { value: "27AAACO8335K1Z5", page: 1, confidence: 0.95 },
  "customer.name": { value: "Meridian Motor India Ltd", page: 1, confidence: 0.7 },
  "order.po_number": { value: "P250432265", page: 1, confidence: 0.9 },
};

let fetchSpy: any;

const installBackend = () => {
  (window as any).AnvilBackend = {
    isReady: () => true,
    getConfig: () => ({ url: "https://api.test", tenantId: "t-1" }),
    getSession: () => ({ access_token: "x" }),
    setSession: () => undefined,
    documents: {
      fetch: vi.fn(async () => ({ id: "doc-1", filename: "po.pdf", mime_type: "application/pdf", downloadUrl: "https://s/po.pdf" })),
      evidence: vi.fn(async (id: string) => ({ document_id: id, rows: [] })),
    },
  };
};

beforeEach(() => {
  installBackend();
  if (!(Element.prototype as any).scrollIntoView) (Element.prototype as any).scrollIntoView = () => undefined;
  (window as any).notifySuccess = vi.fn();
  (window as any).notifyError = vi.fn();
  fetchSpy = vi.fn(async () => ({ ok: true, status: 200, text: async () => "" }));
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => { vi.unstubAllGlobals(); });

const rowFor = (container: HTMLElement, path: string) =>
  container.querySelector(`[data-field-path="${path}"]`) as HTMLElement;

describe("ReviewPane Phase C — confirm / flag / correct", () => {
  it("confirms a field and reflects it in the progress counter", async () => {
    const { container, getByText } = render(
      <ReviewPane docId="doc-1" evidenceByField={EVIDENCE} extractionRunId="run-1" canCorrect />,
    );
    await waitFor(() => expect(rowFor(container, "order.po_number")).toBeTruthy());
    const row = rowFor(container, "order.po_number");
    fireEvent.click(within(row).getByTitle(/confirm this field/i));
    expect(row.getAttribute("data-field-status")).toBe("confirmed");
    expect(getByText(/1\/3 confirmed/)).toBeTruthy();
  });

  it("'mark all correct' promotes every pending field", async () => {
    const { container, getByText, getByTitle } = render(
      <ReviewPane docId="doc-1" evidenceByField={EVIDENCE} extractionRunId="run-1" canCorrect />,
    );
    await waitFor(() => expect(rowFor(container, "order.po_number")).toBeTruthy());
    fireEvent.click(getByTitle(/mark every still-pending field/i));
    expect(getByText(/3\/3 confirmed/)).toBeTruthy();
  });

  it("flagging opens the inline editor and saving POSTs a correction", async () => {
    const { container } = render(
      <ReviewPane docId="doc-1" evidenceByField={EVIDENCE} extractionRunId="run-1" canCorrect />,
    );
    await waitFor(() => expect(rowFor(container, "customer.gstin")).toBeTruthy());
    const row = rowFor(container, "customer.gstin");
    fireEvent.click(within(row).getByTitle(/flag this field/i));
    expect(row.getAttribute("data-field-status")).toBe("flagged");
    const input = within(row).getByLabelText(/corrected value for customer.gstin/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "27AAACO8335K1ZX" } });
    fireEvent.click(within(row).getByText(/save fix/i));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toContain("/api/docai/correction");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      extraction_run_id: "run-1",
      field_path: "customer.gstin",
      original_value: "27AAACO8335K1Z5",
      corrected_value: "27AAACO8335K1ZX",
    });
    expect((window as any).notifySuccess).toHaveBeenCalled();
  });

  it("surfaces a friendly message when the correction endpoint returns 403", async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 403, text: async () => "forbidden" });
    const { container } = render(
      <ReviewPane docId="doc-1" evidenceByField={EVIDENCE} extractionRunId="run-1" canCorrect />,
    );
    await waitFor(() => expect(rowFor(container, "customer.gstin")).toBeTruthy());
    const row = rowFor(container, "customer.gstin");
    fireEvent.click(within(row).getByTitle(/flag this field/i));
    fireEvent.click(within(row).getByText(/save fix/i));
    await waitFor(() => expect((window as any).notifyError).toHaveBeenCalled());
    const [, body] = (window as any).notifyError.mock.calls[0];
    expect(body).toMatch(/sales_manager \/ finance \/ admin/);
  });

  it("disables 'save fix' when the role cannot correct", async () => {
    const { container } = render(
      <ReviewPane docId="doc-1" evidenceByField={EVIDENCE} extractionRunId="run-1" canCorrect={false} />,
    );
    await waitFor(() => expect(rowFor(container, "customer.gstin")).toBeTruthy());
    const row = rowFor(container, "customer.gstin");
    fireEvent.click(within(row).getByTitle(/flag this field/i));
    const saveBtn = within(row).getByText(/save fix/i) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);
  });
});
