// Tests for ReviewPane (Phase A of the side-by-side review surface).
//
// Coverage focus:
//   - groupForFieldPath classifies the conventional path namespaces.
//   - Renders without crashing when docId / evidence are empty.
//   - Renders a PDF embed when the resolved document mime is PDF.
//   - Renders an <img> when the mime is an image.
//   - Renders one row per evidence entry, grouped by namespace.
//   - Stamps data-field-path on every row so the Phase B selection
//     context can hook into the existing render tree without churn.
//
// We DO NOT test the signed-URL refresh timer behaviour at the 9-min
// mark here -- that's covered by the helpers test for the existing
// documents.fetch path; this file only validates the component's
// composition + the contract it exposes to Phase B.

import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import ReviewPane, { groupForFieldPath, EvidenceByField } from "./ReviewPane";

const installBackend = (overrides: Record<string, any> = {}) => {
  (window as any).AnvilBackend = {
    isReady: () => true,
    getConfig: () => ({}),
    getSession: () => ({ access_token: "x", expires_at: Math.floor(Date.now() / 1000) + 3600 }),
    setSession: () => undefined,
    documents: {
      fetch: vi.fn(async (_id: string) => ({
        id: "doc-1",
        filename: "po.pdf",
        mime_type: "application/pdf",
        downloadUrl: "https://signed.example/po.pdf?token=abc",
        expiresInSeconds: 600,
      })),
      ...(overrides.documents || {}),
    },
    ...overrides,
  };
};

beforeEach(() => {
  installBackend();
});

describe("groupForFieldPath", () => {
  it("classifies customer / order / lines / totals / seller namespaces", () => {
    expect(groupForFieldPath("customer.gstin")).toBe("customer");
    expect(groupForFieldPath("buyer.vat_number")).toBe("customer");
    expect(groupForFieldPath("order.po_number")).toBe("order");
    expect(groupForFieldPath("header.po_date")).toBe("order");
    expect(groupForFieldPath("lines[3].partNumber")).toBe("lines");
    expect(groupForFieldPath("items.0.qty")).toBe("lines");
    expect(groupForFieldPath("totals.grand_inr")).toBe("totals");
    expect(groupForFieldPath("seller.name")).toBe("seller");
    expect(groupForFieldPath("supplier.address")).toBe("seller");
  });
  it("falls back to 'other' for unrecognised heads", () => {
    expect(groupForFieldPath("misc.thing")).toBe("other");
    expect(groupForFieldPath("")).toBe("other");
  });
});

describe("ReviewPane", () => {
  it("renders the empty-state message when no evidence is present", () => {
    const { container } = render(<ReviewPane docId={null} evidenceByField={{}} />);
    expect(container.textContent).toMatch(/No extracted fields yet/i);
  });

  it("warns when no source document is attached", () => {
    const { container } = render(<ReviewPane docId={null} evidenceByField={{}} />);
    expect(container.textContent).toMatch(/No source document attached/i);
  });

  it("renders a PDF <embed> when the document mime is application/pdf", async () => {
    const { container } = render(<ReviewPane docId="doc-1" evidenceByField={{}} />);
    await waitFor(() => {
      const embed = container.querySelector('embed[type="application/pdf"]') as HTMLEmbedElement | null;
      expect(embed).not.toBeNull();
      expect(embed!.getAttribute("src")).toMatch(/signed\.example/);
    });
  });

  it("renders an <img> when the document mime is an image", async () => {
    installBackend({
      documents: {
        fetch: vi.fn(async () => ({
          id: "doc-img", filename: "po.png", mime_type: "image/png",
          downloadUrl: "https://signed.example/po.png", expiresInSeconds: 600,
        })),
      },
    });
    const { container } = render(<ReviewPane docId="doc-img" evidenceByField={{}} />);
    await waitFor(() => {
      const img = container.querySelector("img.rp-image") as HTMLImageElement | null;
      expect(img).not.toBeNull();
      expect(img!.getAttribute("src")).toMatch(/signed\.example/);
    });
  });

  it("falls back to a download link for non-PDF, non-image mimes", async () => {
    installBackend({
      documents: {
        fetch: vi.fn(async () => ({
          id: "doc-zip", filename: "evidence.zip", mime_type: "application/zip",
          downloadUrl: "https://signed.example/evidence.zip", expiresInSeconds: 600,
        })),
      },
    });
    const { container } = render(<ReviewPane docId="doc-zip" evidenceByField={{}} />);
    await waitFor(() => {
      expect(container.textContent).toMatch(/Preview not supported/i);
      const link = container.querySelector('a[href*="evidence.zip"]') as HTMLAnchorElement | null;
      expect(link).not.toBeNull();
    });
  });

  it("renders one row per evidence entry, grouped, with data-field-path stamped", () => {
    const evidence: EvidenceByField = {
      "customer.gstin":    { value: "27AAACO8335K1Z5", page: 1, confidence: 0.92 },
      "customer.name":     { value: "Hyundai Motor India Ltd", page: 1, confidence: 0.88 },
      "order.po_number":   { value: "P250432265", page: 1, confidence: 0.99 },
      "lines[0].partNumber": { value: "GD544202503060009", page: 1, line: 1, confidence: 0.95 },
      "totals.grand_inr":  { value: 1710922.76, page: 1, confidence: 0.97 },
      "seller.name":       { value: "OBARA India Pvt Ltd", page: 1, confidence: 0.80 },
    };
    const { container } = render(<ReviewPane docId={null} evidenceByField={evidence} />);
    const rows = container.querySelectorAll("[data-field-path]");
    expect(rows.length).toBe(6);
    // Every row carries the canonical path attribute Phase B will read.
    const paths = Array.from(rows).map((r) => r.getAttribute("data-field-path")).sort();
    expect(paths).toEqual([
      "customer.gstin",
      "customer.name",
      "lines[0].partNumber",
      "order.po_number",
      "seller.name",
      "totals.grand_inr",
    ]);
    // Group attribute is also stamped so styling / selection by group
    // can be done without re-parsing the path.
    const groups = Array.from(new Set(Array.from(rows).map((r) => r.getAttribute("data-field-group")))).sort();
    expect(groups).toEqual(["customer", "lines", "order", "seller", "totals"]);
  });

  it("renders extracted values verbatim including numeric, boolean, and object inputs", () => {
    const { container } = render(<ReviewPane docId={null} evidenceByField={{
      "totals.grand_inr": { value: 1710922.76 },
      "order.is_revision": { value: true },
      "customer.address_obj": { value: { city: "Pune", state: "MH" } },
    }} />);
    expect(container.textContent).toContain("1710922.76");
    expect(container.textContent).toContain("true");
    expect(container.textContent).toContain("Pune");
  });

  it("skips null / undefined evidence entries without crashing", () => {
    const { container } = render(<ReviewPane docId={null} evidenceByField={{
      "customer.gstin": { value: "27ABCDE..." },
      "customer.dropped": null,
      "customer.absent": undefined as any,
    }} />);
    const rows = container.querySelectorAll("[data-field-path]");
    expect(rows.length).toBe(1);
    expect(rows[0].getAttribute("data-field-path")).toBe("customer.gstin");
  });

  it("renders nothing in a group when that group has no entries", () => {
    const { container } = render(<ReviewPane docId={null} evidenceByField={{
      "customer.gstin": { value: "x" },
    }} />);
    // Only the customer section header should appear; no order/lines/totals/seller headers.
    const headers = Array.from(container.querySelectorAll(".rp-field-group-label")).map((n) => n.textContent);
    expect(headers).toEqual(["Customer"]);
  });
});
