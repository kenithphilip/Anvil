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
import {
  ZOOM_FIT, ZOOM_MIN, ZOOM_MAX, scaleBy, zoomIn, zoomOut, zoomPercent,
  touchDistance, touchMidpoint, wheelZoomFactor, anchoredScroll,
} from "../lib/pdf-zoom";
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
  /** Base zoom factor (1 = fit-to-width). The viewer's own zoom control
   * multiplies this, so a caller can still pin a starting scale. */
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
  const { selectedField } = useReviewPaneSelection();

  // Committed zoom — drives react-pdf's `scale`, so the page is re-rastered and
  // stays sharp. `live` is the in-gesture CSS-transform multiplier, folded in
  // when the gesture settles; rasterising once per pinch frame would stutter.
  const [zoom, setZoom] = useState<number>(ZOOM_FIT);
  const [live, setLive] = useState<number>(1);
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveRef = useRef(1);
  const zoomRef = useRef(ZOOM_FIT);
  zoomRef.current = zoom;
  liveRef.current = live;

  const base = Number.isFinite(scale) && (scale as number) > 0 ? (scale as number) : 1;

  // Keep whatever the operator was looking at under the pointer. Applied after
  // paint, against the ratio the zoom actually moved by.
  const anchorRef = useRef<{ x: number; y: number } | null>(null);
  const applyAnchor = useCallback((ratio: number) => {
    const el = containerRef.current;
    const focal = anchorRef.current;
    if (!el || !focal || ratio === 1) return;
    const rect = el.getBoundingClientRect();
    const next = anchoredScroll({ scrollLeft: el.scrollLeft, scrollTop: el.scrollTop }, rect, focal, ratio);
    el.scrollLeft = next.scrollLeft;
    el.scrollTop = next.scrollTop;
  }, []);

  // Fold the live transform into the committed scale once the gesture stops.
  const scheduleCommit = useCallback(() => {
    if (commitTimer.current) clearTimeout(commitTimer.current);
    commitTimer.current = setTimeout(() => {
      const l = liveRef.current;
      if (l === 1) return;
      const before = zoomRef.current;
      const after = scaleBy(before, l);
      setZoom(after);
      setLive(1);
      // The transform is dropped in the same commit that grows the layout box,
      // so the net movement is after/before, not `l` — they differ whenever the
      // clamp bit.
      requestAnimationFrame(() => applyAnchor(after / before));
    }, 160);
  }, [applyAnchor]);

  const nudge = useCallback((factor: number, focal?: { x: number; y: number }) => {
    anchorRef.current = focal || null;
    setLive((l) => {
      const next = scaleBy(zoomRef.current * l, factor) / zoomRef.current;
      return next;
    });
    scheduleCommit();
  }, [scheduleCommit]);

  // Buttons and keyboard commit immediately — a discrete step should land sharp
  // rather than sit blurry for 160ms.
  const stepTo = useCallback((next: number) => {
    const before = zoomRef.current;
    if (commitTimer.current) clearTimeout(commitTimer.current);
    setLive(1);
    setZoom(next);
    anchorRef.current = null;
    requestAnimationFrame(() => applyAnchor(next / before));
  }, [applyAnchor]);

  // Ctrl+wheel is the desktop pinch: a trackpad pinch reaches the browser as a
  // ctrl-modified wheel on every OS, and Windows mouse users get it via
  // ctrl+scroll. Registered natively because React's wheel listener is passive,
  // and without preventDefault the browser zooms the whole page instead.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      nudge(wheelZoomFactor(e.deltaY, e.deltaMode), { x: e.clientX, y: e.clientY });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [nudge]);

  // Two-finger pinch. touch-action on the container (styles.css) leaves one
  // finger to pan and text-select as before, and hands us the second.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let startDist = 0;
    let startLive = 1;
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      startDist = touchDistance(e.touches[0], e.touches[1]);
      startLive = liveRef.current;
      anchorRef.current = touchMidpoint(e.touches[0], e.touches[1]);
    };
    const onMove = (e: TouchEvent) => {
      if (e.touches.length !== 2 || !startDist) return;
      e.preventDefault();
      const ratio = touchDistance(e.touches[0], e.touches[1]) / startDist;
      anchorRef.current = touchMidpoint(e.touches[0], e.touches[1]);
      setLive(scaleBy(zoomRef.current * startLive, ratio) / zoomRef.current);
    };
    const onEnd = () => {
      if (!startDist) return;
      startDist = 0;
      scheduleCommit();
    };
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd, { passive: true });
    el.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, [scheduleCommit]);

  useEffect(() => () => { if (commitTimer.current) clearTimeout(commitTimer.current); }, []);

  // Scroll the selected field's bbox into view. Lets a click on a
  // recon line row (or a header field) jump the PDF to that region
  // without the operator hunting for it. No-op when the field has no
  // rendered rect (e.g. its page has not painted yet, or the line has
  // no usable evidence geometry).
  useEffect(() => {
    if (!selectedField || !containerRef.current) return;
    const safe = selectedField.replace(/["\\]/g, "\\$&");
    const el = containerRef.current.querySelector(`[data-field-path="${safe}"]`);
    if (el && typeof (el as HTMLElement).scrollIntoView === "function") {
      (el as HTMLElement).scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [selectedField]);

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

  const effective = base * zoom;
  const atMin = zoom <= ZOOM_MIN + 1e-6;
  const atMax = zoom >= ZOOM_MAX - 1e-6;

  return (
    <div className="rp-pdf-shell">
      <div className="rp-pdf-zoombar" role="group" aria-label="Zoom">
        <button
          type="button" className="rp-zoom-btn" aria-label="Zoom out"
          disabled={atMin} onClick={() => stepTo(zoomOut(zoom))}
        >−</button>
        {/* aria-live so the value is announced on change; a bare number would
            read as "one hundred and fifty" with no unit. */}
        <span className="rp-zoom-readout mono-sm" aria-live="polite">
          {zoomPercent(zoom * live)}
        </span>
        <button
          type="button" className="rp-zoom-btn" aria-label="Zoom in"
          disabled={atMax} onClick={() => stepTo(zoomIn(zoom))}
        >+</button>
        <button
          type="button" className="rp-zoom-btn rp-zoom-reset mono-sm"
          aria-label="Reset zoom to fit width"
          disabled={zoom === ZOOM_FIT && live === 1} onClick={() => stepTo(ZOOM_FIT)}
        >Fit</button>
      </div>
      <div ref={containerRef} className="rp-pdf-container">
        {/* The live gesture scales this wrapper. The overlay SVG is inside it,
            so highlights track the page for free — and canvas.clientWidth is a
            layout value that a transform does not change, so the measured
            geometry the overlay is built from stays valid throughout. */}
        <div
          className="rp-pdf-zoomer"
          style={live === 1 ? undefined : { transform: `scale(${live})`, transformOrigin: "top center" }}
        >
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
                scale={effective}
                evidence={evidenceByPage[pageNumber] || []}
                colourForField={colourForField}
              />
            ))}
          </Document>
        </div>
      </div>
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
  // Remember the scale the size was measured AT, not just the size. Changing
  // `scale` re-keys the page and pdf.js rasterises asynchronously, so for a
  // frame or two the canvas is already the new size while renderedSize still
  // describes the old one — and the boxes visibly sit wrong. Scaling the SVG by
  // scale/measuredAt bridges that window exactly, and collapses to 1 the moment
  // the new measurement lands.
  const [rendered, setRendered] = useState<{ w: number; h: number; at: number } | null>(null);

  const onRenderSuccess = useCallback(() => {
    const canvas = pageWrapRef.current?.querySelector("canvas");
    if (!canvas) return;
    setRendered({ w: canvas.clientWidth, h: canvas.clientHeight, at: scale || 1 });
  }, [scale]);

  const renderedSize = rendered;
  const drift = rendered ? (scale || 1) / (rendered.at || 1) : 1;

  return (
    <div className="rp-pdf-page-wrap" ref={pageWrapRef} data-page-number={pageNumber}>
      <Page
        pageNumber={pageNumber}
        width={width}
        scale={scale}
        // Text layer ON so the operator can select/copy text out of the PO
        // (part numbers, GSTINs, addresses) instead of retyping them. Without
        // it react-pdf paints only a canvas and the cursor has nothing to grab.
        // The bbox overlay is pointer-events:none (individual rects opt back
        // in), so the highlight and the selection coexist.
        renderTextLayer
        renderAnnotationLayer={false}
        onRenderSuccess={onRenderSuccess}
      />
      {renderedSize && evidence.length > 0 && (
        <svg
          className="rp-pdf-overlay"
          // Rendered px follow the live scale; the viewBox stays in the units the
          // rects below are computed in, so the geometry maths is untouched.
          width={renderedSize.w * drift}
          height={renderedSize.h * drift}
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
                // "stroke", not "all": the rect sits ABOVE the text layer, so
                // capturing its whole interior would swallow the mousedown that
                // starts a text selection — the operator could not select the
                // very line the highlight points at. Limiting hit-testing to
                // the outline keeps hover/click on the box while leaving the
                // text underneath selectable. (Fill is transparent anyway.)
                pointerEvents={fp ? "stroke" : "none"}
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
