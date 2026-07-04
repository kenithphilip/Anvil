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
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import ReviewPane, { groupForFieldPath, EvidenceByField } from "./ReviewPane";

// Phase B: PdfPagePreview is loaded via React.lazy in ReviewPane.
// jsdom cannot run pdfjs-dist's real worker, so we mock the lazy
// chunk to a thin stub that surfaces the props it received via
// data-attributes. The stub is async to mirror the real lazy()
// loader path: render needs to await the Suspense resolution.
vi.mock("./PdfPagePreview", () => ({
  __esModule: true,
  default: (props: any) => (
    <div
      data-testid="pdf-page-preview-stub"
      data-url={props.url}
      data-filename={props.filename || ""}
      data-evidence-count={(props.evidenceRows || []).length}
    >
      pdf-stub
    </div>
  ),
}));

const installBackend = (overrides: Record<string, any> = {}) => {
  // Pull `documents` out of overrides so the top-level spread can't
  // clobber the merged object below. Without this split, calling
  // `installBackend({ documents: { evidence: fn } })` would drop the
  // default `documents.fetch` stub and every PDF preview test would
  // collapse to the "No source document attached" empty state.
  const { documents: documentsOverride, ...restOverrides } = overrides;
  (window as any).AnvilBackend = {
    isReady: () => true,
    getConfig: () => ({}),
    getSession: () => ({ access_token: "x", expires_at: Math.floor(Date.now() / 1000) + 3600 }),
    setSession: () => undefined,
    ...restOverrides,
    documents: {
      fetch: vi.fn(async (_id: string) => ({
        id: "doc-1",
        filename: "po.pdf",
        mime_type: "application/pdf",
        downloadUrl: "https://signed.example/po.pdf?token=abc",
        expiresInSeconds: 600,
      })),
      // Phase B: ReviewPane now also fetches bbox evidence rows so
      // the PDF overlay can paint them. Default to empty so tests that
      // don't care about overlays don't have to stub it.
      evidence: vi.fn(async (_id: string) => ({ document_id: _id, page_count: 1, mime_type: "application/pdf", rows: [] })),
      ...(documentsOverride || {}),
    },
  };
};

beforeEach(() => {
  installBackend();
  // jsdom does not implement Element.scrollIntoView; the Phase B
  // field row triggers it when the selectedField changes (so the
  // operator's row scrolls into view when they click a bbox on the
  // PDF). Stub it so the test doesn't throw.
  if (!(Element.prototype as any).scrollIntoView) {
    (Element.prototype as any).scrollIntoView = () => undefined;
  }
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

  it("routes PDF mime to the PdfPagePreview lazy chunk (Phase B)", async () => {
    const { container } = render(<ReviewPane docId="doc-1" evidenceByField={{}} />);
    await waitFor(() => {
      const stub = container.querySelector('[data-testid="pdf-page-preview-stub"]') as HTMLElement | null;
      expect(stub).not.toBeNull();
      expect(stub!.getAttribute("data-url")).toMatch(/signed\.example/);
      expect(stub!.getAttribute("data-filename")).toBe("po.pdf");
    });
    // Native <embed> must NOT render alongside the lazy chunk.
    expect(container.querySelector('embed[type="application/pdf"]')).toBeNull();
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
      "customer.gstin":    { value: "27AAACX0001A1ZA", page: 1, confidence: 0.92 },
      "customer.name":     { value: "Meridian Motor India Ltd", page: 1, confidence: 0.88 },
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

describe("ReviewPane — Phase B selection wiring", () => {
  it("toggles .is-active on the row when the operator hovers it", () => {
    const { container } = render(<ReviewPane docId={null} evidenceByField={{
      "customer.gstin": { value: "27ABC" },
      "order.po_number": { value: "P1" },
    }} />);
    const gstinRow = container.querySelector('[data-field-path="customer.gstin"]') as HTMLElement;
    expect(gstinRow.className).not.toMatch(/is-active/);
    fireEvent.mouseEnter(gstinRow);
    expect(gstinRow.className).toMatch(/is-active/);
    fireEvent.mouseLeave(gstinRow);
    expect(gstinRow.className).not.toMatch(/is-active/);
  });

  it("keeps .is-active on click and clears on second click (toggle)", () => {
    const { container } = render(<ReviewPane docId={null} evidenceByField={{
      "customer.gstin": { value: "27ABC" },
    }} />);
    const row = container.querySelector('[data-field-path="customer.gstin"]') as HTMLElement;
    fireEvent.click(row);
    expect(row.className).toMatch(/is-active/);
    fireEvent.mouseLeave(row);
    // Still active because it's the selectedField, not just hovered.
    expect(row.className).toMatch(/is-active/);
    fireEvent.click(row);
    expect(row.className).not.toMatch(/is-active/);
  });

  it("isolates selection state per ReviewPane instance (provider scope)", () => {
    // Two ReviewPanes side-by-side must not share selection because
    // each one wraps its own provider.
    const evidence: EvidenceByField = { "customer.gstin": { value: "v" } };
    const { container } = render(
      <>
        <div data-testid="pane-a"><ReviewPane docId={null} evidenceByField={evidence} /></div>
        <div data-testid="pane-b"><ReviewPane docId={null} evidenceByField={evidence} /></div>
      </>
    );
    const rowA = container.querySelector('[data-testid="pane-a"] [data-field-path="customer.gstin"]') as HTMLElement;
    const rowB = container.querySelector('[data-testid="pane-b"] [data-field-path="customer.gstin"]') as HTMLElement;
    fireEvent.mouseEnter(rowA);
    expect(rowA.className).toMatch(/is-active/);
    expect(rowB.className).not.toMatch(/is-active/);
  });

  it("fetches /api/documents/<id>/evidence and forwards bbox count to the PDF stub", async () => {
    const evidenceSpy = vi.fn(async () => ({
      document_id: "doc-1", page_count: 1, mime_type: "application/pdf",
      rows: [
        { id: "r1", page_number: 1, field_path: "customer.gstin", value: "X", confidence: 0.9,
          bbox: { x0: 0, y0: 0, x1: 10, y1: 10, page_width: 100, page_height: 100 } },
        { id: "r2", page_number: 1, field_path: "order.po_number", value: "Y", confidence: 0.95,
          bbox: { x0: 20, y0: 20, x1: 30, y1: 30, page_width: 100, page_height: 100 } },
        { id: "r3", page_number: 1, field_path: "noisy", value: "Z", confidence: 0.4,
          bbox: null /* dropped because no geometry */ },
      ],
    }));
    installBackend({ documents: { evidence: evidenceSpy } });
    const { container } = render(<ReviewPane docId="doc-1" evidenceByField={{}} />);
    await waitFor(() => {
      const stub = container.querySelector('[data-testid="pdf-page-preview-stub"]') as HTMLElement | null;
      expect(stub).not.toBeNull();
      // Two bbox rows survived the no-geometry filter.
      expect(stub!.getAttribute("data-evidence-count")).toBe("2");
    });
    expect(evidenceSpy).toHaveBeenCalledWith("doc-1");
  });

  it("forwards an empty evidence list when /api/documents/<id>/evidence rejects", async () => {
    installBackend({ documents: { evidence: vi.fn(async () => { throw new Error("boom"); }) } });
    const { container } = render(<ReviewPane docId="doc-1" evidenceByField={{}} />);
    await waitFor(() => {
      const stub = container.querySelector('[data-testid="pdf-page-preview-stub"]') as HTMLElement | null;
      expect(stub).not.toBeNull();
      expect(stub!.getAttribute("data-evidence-count")).toBe("0");
    });
  });
});
