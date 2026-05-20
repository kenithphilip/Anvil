// PDF page renderer with bbox overlay support (Phase B).
//
// Replaces the Phase-A native `<embed type="application/pdf">` for the
// PDF path when the operator has the Review tab open. PDF.js renders
// each page to a <canvas>; we then layer an <svg> on top with one
// <rect> per evidence row, click-able + hoverable, wired into the
// ReviewPaneSelection context.
//
// Why react-pdf / pdfjs-dist:
//   - Renders pages we can position SVG over. <embed>/<iframe> are
//     opaque and cannot host overlays.
//   - Lazy-loaded via React.lazy at the call site so the ~280KB
//     gzipped pdfjs payload only lands in the chunk that mounts when
//     the Review tab is opened. Other screens keep their bundle size.
//
// Failure modes handled:
//   - PDF.js worker fails to start -> caller's ErrorBoundary catches
//     and we fall back to the native <embed>.
//   - Document load fails (bad URL, CORS) -> renders an inline error
//     with a download link.
//   - Page render fails on a single page (corrupt page) -> that page
//     is skipped; other pages still render.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import { useReviewPaneSelection } from "./ReviewPaneContext";

// Configure the PDF.js worker once at module load. Vite serves the
// worker bundled into our /assets/ tree (?url import emits a URL
// pointing at the hashed file). CSP `default-src 'self'` covers this
// because the worker is same-origin.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - Vite-specific import attribute, no .d.ts shipped.
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

// Evidence row from /api/documents/<id>/evidence. Same shape
// BboxOverlay uses, repeated here so this file has no implicit
// coupling to that component.
export interface EvidenceBbox {
  id: string;
  page_number: number | null;
  field_path: string | null;
  value: string | null;
  confidence: number | null;
  bbox: {
    x0: number; y0: number; x1: number; y1: number;
    page_width: number; page_height: number;
  } | null;
}

export interface PdfPagePreviewProps {
  url: string;
  filename?: string | null;
  /** Evidence rows from `/api/documents/<id>/evidence`. Each row's
   * `field_path` is matched against the right-pane field list via
   * ReviewPaneSelection for bidirectional highlighting. */
  evidenceRows?: EvidenceBbox[];
  /** Optional zoom factor (1 = native width). Phase B exposes only
   * fit-to-width via the parent; explicit zoom controls are Phase D. */
  scale?: number;
  /** Map a field path to a colour token (e.g. "var(--accent-2)").
   * The rect's stroke uses this; falls back to ink-4 when missing. */
  colourForField?: (fieldPath: string) => string;
}

const DEFAULT_COLOUR = "var(--ink-4)";

const PdfPagePreview: React.FC<PdfPagePreviewProps> = ({
  url, filename, evidenceRows, scale, colourForField,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState<number>(0);
  const [numPages, setNumPages] = useState<number>(0);
  const [loadError, setLoadError] = useState<Error | null>(null);

  // Measure container width so pages render at fit-to-width by
  // default. Re-measures on container resize via ResizeObserver
  // when available; falls back to a one-shot measurement otherwise.
  useEffect(() => {
    if (typeof window === "undefined" || !containerRef.current) return;
    const measure = () => {
      const w = containerRef.current?.clientWidth || 0;
      if (w > 0) setContainerWidth(w);
    };
    measure();
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(measure);
      ro.observe(containerRef.current);
      return () => ro.disconnect();
    }
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  // Stable document options object — re-creating it on every render
  // triggers react-pdf to reload the PDF from scratch (network +
  // worker spin-up), which thrashes a long document.
  const docOptions = useMemo(() => ({}), []);

  // Memoise the file source the same way: react-pdf compares by
  // reference so a fresh `{ url }` object would re-fetch each render.
  const file = useMemo(() => ({ url }), [url]);

  const onDocumentLoadSuccess = useCallback((doc: { numPages: number }) => {
    setNumPages(doc.numPages);
    setLoadError(null);
  }, []);

  const onDocumentLoadError = useCallback((err: Error) => {
    setLoadError(err);
  }, []);

  // Group evidence rows by page number once per props change so
  // each page only iterates its own rows.
  const evidenceByPage = useMemo(() => {
    const map: Record<number, EvidenceBbox[]> = {};
    for (const row of evidenceRows || []) {
      const page = Number(row.page_number || 1);
      (map[page] = map[page] || []).push(row);
    }
    return map;
  }, [evidenceRows]);

  if (loadError) {
    return (
      <div className="rp-pdf-error mono-sm" role="alert">
        Could not render PDF: {loadError.message}.{" "}
        <a href={url} target="_blank" rel="noopener noreferrer">Open the file directly</a>.
      </div>
    );
  }

  return (
    <div ref={containerRef} className="rp-pdf-container">
      <Document
        file={file}
        options={docOptions}
        onLoadSuccess={onDocumentLoadSuccess}
        onLoadError={onDocumentLoadError}
        loading={<div className="rp-pdf-loading mono-sm">Loading {filename || "PDF"}…</div>}
        error={null /* handled via onLoadError above */}
      >
        {Array.from({ length: numPages }, (_, i) => i + 1).map((pageNumber) => (
          <PdfPageWithOverlay
            key={pageNumber}
            pageNumber={pageNumber}
            width={containerWidth || undefined}
            scale={scale}
            evidence={evidenceByPage[pageNumber] || []}
            colourForField={colourForField}
          />
        ))}
      </Document>
    </div>
  );
};

interface PdfPageWithOverlayProps {
  pageNumber: number;
  width?: number;
  scale?: number;
  evidence: EvidenceBbox[];
  colourForField?: (fieldPath: string) => string;
}

const PdfPageWithOverlay: React.FC<PdfPageWithOverlayProps> = ({
  pageNumber, width, scale, evidence, colourForField,
}) => {
  const { hoveredField, selectedField, setHoveredField, setSelectedField } = useReviewPaneSelection();
  const pageWrapRef = useRef<HTMLDivElement | null>(null);
  const [renderedSize, setRenderedSize] = useState<{ w: number; h: number } | null>(null);

  // After PDF.js paints the canvas, read its size so the overlay SVG
  // matches exactly. Stored as state to trigger an overlay re-render.
  const onRenderSuccess = useCallback(() => {
    const canvas = pageWrapRef.current?.querySelector("canvas");
    if (!canvas) return;
    setRenderedSize({ w: canvas.clientWidth, h: canvas.clientHeight });
  }, []);

  return (
    <div className="rp-pdf-page-wrap" ref={pageWrapRef} data-page-number={pageNumber}>
      <Page
        pageNumber={pageNumber}
        width={width}
        scale={scale}
        renderTextLayer={false}
        renderAnnotationLayer={false}
        onRenderSuccess={onRenderSuccess}
      />
      {renderedSize && evidence.length > 0 && (
        <svg
          className="rp-pdf-overlay"
          width={renderedSize.w}
          height={renderedSize.h}
          viewBox={`0 0 ${renderedSize.w} ${renderedSize.h}`}
          aria-hidden="true"
        >
          {evidence.map((row) => {
            if (!row.bbox) return null;
            const { x0, y0, x1, y1, page_width, page_height } = row.bbox;
            if (!page_width || !page_height) return null;
            const sx = renderedSize.w / page_width;
            const sy = renderedSize.h / page_height;
            const x = x0 * sx;
            const y = y0 * sy;
            const w = (x1 - x0) * sx;
            const h = (y1 - y0) * sy;
            const fp = row.field_path || "";
            const colour = (fp && colourForField?.(fp)) || DEFAULT_COLOUR;
            const isActive = !!fp && (fp === hoveredField || fp === selectedField);
            return (
              <rect
                key={row.id}
                x={x} y={y} width={w} height={h}
                className={"rp-bbox-rect" + (isActive ? " is-active" : "")}
                style={{ stroke: colour }}
                data-field-path={fp || undefined}
                pointerEvents={fp ? "all" : "none"}
                onMouseEnter={() => fp && setHoveredField(fp)}
                onMouseLeave={() => fp && setHoveredField(null)}
                onClick={() => fp && setSelectedField(fp === selectedField ? null : fp)}
              >
                {fp && (
                  <title>{fp}{row.value ? `: ${row.value}` : ""}{row.confidence != null ? ` (${Math.round(row.confidence * 100)}%)` : ""}</title>
                )}
              </rect>
            );
          })}
        </svg>
      )}
    </div>
  );
};

export default PdfPagePreview;
