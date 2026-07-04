// Template-anchor provenance tests: a field whose evidence carries
// source="template" renders the dotted "anchored" stripe + badge;
// an LLM-sourced field renders the solid stripe with no badge.

import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import ReviewPane, { EvidenceByField } from "./ReviewPane";

vi.mock("./PdfPagePreview", () => ({ __esModule: true, default: () => <div>pdf</div> }));

const EVIDENCE: EvidenceByField = {
  "customer.gstin": { value: "27AAACX0001A1ZA", confidence: 0.95, source: "template" },
  "customer.name": { value: "Meridian Motor India Ltd", confidence: 0.8, source: "llm" },
};

beforeEach(() => {
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
  if (!(Element.prototype as any).scrollIntoView) (Element.prototype as any).scrollIntoView = () => undefined;
});

const rowFor = (c: HTMLElement, p: string) => c.querySelector(`[data-field-path="${p}"]`) as HTMLElement;

describe("ReviewPane — template-anchor stripe", () => {
  it("marks a template-sourced field with the anchored stripe + badge", async () => {
    const { container } = render(<ReviewPane docId="doc-1" evidenceByField={EVIDENCE} extractionRunId="run-1" canCorrect />);
    await waitFor(() => expect(rowFor(container, "customer.gstin")).toBeTruthy());
    const tplRow = rowFor(container, "customer.gstin");
    expect(tplRow.querySelector(".rp-field-stripe-anchored")).toBeTruthy();
    expect(tplRow.querySelector(".rp-anchor-badge")).toBeTruthy();
  });

  it("leaves an LLM-sourced field with the plain solid stripe (no badge)", async () => {
    const { container } = render(<ReviewPane docId="doc-1" evidenceByField={EVIDENCE} extractionRunId="run-1" canCorrect />);
    await waitFor(() => expect(rowFor(container, "customer.name")).toBeTruthy());
    const llmRow = rowFor(container, "customer.name");
    expect(llmRow.querySelector(".rp-field-stripe-anchored")).toBeNull();
    expect(llmRow.querySelector(".rp-anchor-badge")).toBeNull();
  });
});
