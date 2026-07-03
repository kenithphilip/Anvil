// Phase D tests: confidence wash + keyboard navigation.
//
// Coverage:
//   - a low-confidence pending field gets rp-conf-low; a high-conf
//     pending field gets no wash; a confirmed field drops the wash
//   - J/K move the field cursor (is-active), Y confirms it, N flags it
//   - keys are ignored while typing in the inline corrector

import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import ReviewPane, { EvidenceByField } from "./ReviewPane";

vi.mock("./PdfPagePreview", () => ({ __esModule: true, default: () => <div>pdf</div> }));

const EVIDENCE: EvidenceByField = {
  "customer.gstin": { value: "27AAACO8335K1Z5", page: 1, confidence: 0.4 },  // low
  "customer.name": { value: "Meridian Motor India Ltd", page: 1, confidence: 0.6 }, // mid
  "order.po_number": { value: "P250432265", page: 1, confidence: 0.95 }, // high
};

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
});

const rowFor = (c: HTMLElement, path: string) => c.querySelector(`[data-field-path="${path}"]`) as HTMLElement;

describe("ReviewPane Phase D — confidence wash", () => {
  it("tints a low-confidence pending row and leaves high-confidence rows clean", async () => {
    const { container } = render(<ReviewPane docId="doc-1" evidenceByField={EVIDENCE} extractionRunId="run-1" canCorrect />);
    await waitFor(() => expect(rowFor(container, "customer.gstin")).toBeTruthy());
    expect(rowFor(container, "customer.gstin").className).toMatch(/rp-conf-low/);
    expect(rowFor(container, "customer.name").className).toMatch(/rp-conf-mid/);
    expect(rowFor(container, "order.po_number").className).not.toMatch(/rp-conf-/);
  });

  it("drops the confidence wash once a field is confirmed", async () => {
    const { container, getByTitle } = render(<ReviewPane docId="doc-1" evidenceByField={EVIDENCE} extractionRunId="run-1" canCorrect />);
    await waitFor(() => expect(rowFor(container, "customer.gstin")).toBeTruthy());
    // confirm the low-conf field via its ✓ control
    const row = rowFor(container, "customer.gstin");
    fireEvent.click(row.querySelector(".rp-act-confirm") as HTMLElement);
    expect(row.className).toMatch(/rp-status-confirmed/);
    expect(row.className).not.toMatch(/rp-conf-low/);
  });
});

describe("ReviewPane Phase D — keyboard navigation", () => {
  it("J moves the cursor and Y confirms the selected field", async () => {
    const { container, getByText } = render(<ReviewPane docId="doc-1" evidenceByField={EVIDENCE} extractionRunId="run-1" canCorrect />);
    await waitFor(() => expect(rowFor(container, "customer.gstin")).toBeTruthy());
    // First field in alpha order across groups: customer.* then order.*
    fireEvent.keyDown(window, { key: "j" });
    const active1 = container.querySelector(".rp-field-row.is-active") as HTMLElement;
    expect(active1).toBeTruthy();
    const firstPath = active1.getAttribute("data-field-path");
    // Y confirms it
    fireEvent.keyDown(window, { key: "y" });
    expect(rowFor(container, firstPath!).getAttribute("data-field-status")).toBe("confirmed");
    expect(getByText(/1\/3 confirmed/)).toBeTruthy();
  });

  it("N flags the selected field", async () => {
    const { container } = render(<ReviewPane docId="doc-1" evidenceByField={EVIDENCE} extractionRunId="run-1" canCorrect />);
    await waitFor(() => expect(rowFor(container, "customer.gstin")).toBeTruthy());
    fireEvent.keyDown(window, { key: "j" });
    fireEvent.keyDown(window, { key: "n" });
    const active = container.querySelector(".rp-field-row.is-active") as HTMLElement;
    expect(active.getAttribute("data-field-status")).toBe("flagged");
  });

  it("ignores shortcuts while typing in the inline corrector", async () => {
    const { container } = render(<ReviewPane docId="doc-1" evidenceByField={EVIDENCE} extractionRunId="run-1" canCorrect />);
    await waitFor(() => expect(rowFor(container, "customer.gstin")).toBeTruthy());
    const row = rowFor(container, "customer.gstin");
    fireEvent.click(row.querySelector(".rp-act-flag") as HTMLElement); // opens editor
    const input = row.querySelector("input") as HTMLInputElement;
    // "j" typed into the input must NOT move the cursor / change selection
    fireEvent.keyDown(input, { key: "j" });
    const active = container.querySelector(".rp-field-row.is-active");
    expect(active).toBeNull(); // no field got selected by the keystroke
  });
});
