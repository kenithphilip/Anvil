// Source-document pane: download + text selection.
//
// Two gaps the operator hit in the PDF window:
//   - no way to save the PO (there was no download control anywhere on the
//     pane), and
//   - the cursor could not select text, because PdfPagePreview passed
//     renderTextLayer={false} so react-pdf painted a bare canvas with no
//     selectable text.
//
// The download cannot be a plain `<a download>`: the URL is a cross-origin
// signed Supabase URL, where the download attribute is ignored and the browser
// navigates instead of saving. It fetches the bytes and saves a same-origin
// blob, falling back to opening the URL if the fetch is refused.

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

vi.mock("./PdfPagePreview", () => ({
  __esModule: true,
  default: (props: any) => <div data-testid="pdf-stub" data-url={props.url}>pdf</div>,
}));

vi.mock("../lib/api", () => ({
  AnvilBackend: {
    documents: {
      fetch: vi.fn(async () => ({
        downloadUrl: "https://storage.example.com/signed/po.pdf?token=abc",
        mime_type: "application/pdf",
        filename: "PO-0066026562.pdf",
      })),
      evidence: vi.fn(async () => ({ rows: [] })),
    },
  },
}));

import { ReviewDocPane } from "./ReviewPane";

const SIGNED = "https://storage.example.com/signed/po.pdf?token=abc";

let clicked: HTMLAnchorElement[] = [];
let origClick: any;

beforeEach(() => {
  clicked = [];
  origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () { clicked.push(this as HTMLAnchorElement); };
  if (!(globalThis.URL as any).createObjectURL) {
    (globalThis.URL as any).createObjectURL = () => "blob:mock";
    (globalThis.URL as any).revokeObjectURL = () => undefined;
  }
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
});

afterEach(() => {
  HTMLAnchorElement.prototype.click = origClick;
  vi.restoreAllMocks();
});

describe("source-document download", () => {
  it("saves a same-origin blob with the real filename", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      blob: async () => new Blob(["%PDF-1.4"], { type: "application/pdf" }),
    }));
    vi.stubGlobal("fetch", fetchMock as any);

    render(<ReviewDocPane docId="doc-1" />);
    const btn = await screen.findByRole("button", { name: /download/i });
    fireEvent.click(btn);

    await waitFor(() => expect(clicked.length).toBe(1));
    // The signed URL is fetched, not navigated to.
    expect(fetchMock).toHaveBeenCalledWith(SIGNED);
    const a = clicked[0];
    expect(a.getAttribute("href")).toBe("blob:mock");
    // Without this the browser would save "po.pdf?token=abc" or nothing.
    expect(a.getAttribute("download")).toBe("PO-0066026562.pdf");
    expect(URL.revokeObjectURL).toHaveBeenCalled();
  });

  it("falls back to opening the signed URL when the fetch is refused", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("CORS"); }) as any);
    const openSpy = vi.fn();
    vi.stubGlobal("open", openSpy as any);

    render(<ReviewDocPane docId="doc-1" />);
    fireEvent.click(await screen.findByRole("button", { name: /download/i }));

    // An expired signature or CORS refusal must still get the operator the
    // file rather than failing silently.
    await waitFor(() => expect(openSpy).toHaveBeenCalledWith(SIGNED, "_blank", "noopener,noreferrer"));
    expect(clicked.length).toBe(0);
  });

  it("shows no download control when the document has no URL", async () => {
    const api = await import("../lib/api");
    (api.AnvilBackend as any).documents.fetch.mockResolvedValueOnce({ downloadUrl: null });
    render(<ReviewDocPane docId="doc-2" />);
    await waitFor(() => expect(screen.queryByText(/No source document attached/i)).not.toBeNull());
    expect(screen.queryByRole("button", { name: /download/i })).toBeNull();
  });
});
