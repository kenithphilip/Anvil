// OCR bbox overlay. Renders an SVG layer absolutely positioned on
// top of an <img>, with a rectangle per OCR evidence row and a
// hover tooltip showing the recognized text + confidence.
//
// Audit P13.B.3 follow-up. The Mistral OCR endpoint
// (/api/documents/ocr) emits per-token bboxes in source-pixel
// coordinates plus the page width/height. We rescale into the
// rendered image's display box at component-load time so the
// overlay tracks responsive layouts.
//
// PDF documents are not supported here: the browser's native
// <embed type="application/pdf"> viewer is opaque and we cannot
// position an SVG overlay against the rendered pages without
// PDF.js. Image documents (PNG / JPG / WebP / TIFF) work
// directly.

import React, { useLayoutEffect, useRef, useState } from "react";

export interface OcrBbox {
  // Source-pixel rectangle. The Mistral pipeline persists these
  // alongside `page_width` and `page_height` so we can rescale
  // for any display size.
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  page_width: number;
  page_height: number;
}

export interface OcrEvidenceRow {
  id: string;
  page_number: number | null;
  bbox: OcrBbox | null;
  value: string | null;
  confidence: number | null;
  field_path?: string | null;
}

export interface BboxOverlayProps {
  src: string;
  alt?: string;
  rows: OcrEvidenceRow[];
  // Filter: when set, only this page's bboxes render. Defaults to
  // the first page that has any bboxes.
  page?: number;
  // Forwarded to the <img>.
  imgStyle?: React.CSSProperties;
}

export const BboxOverlay: React.FC<BboxOverlayProps> = ({
  src, alt, rows, page, imgStyle,
}) => {
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const [active, setActive] = useState<string | null>(null);

  // Track the rendered image size so the SVG overlay matches.
  // ResizeObserver keeps the box in sync if the layout reflows.
  useLayoutEffect(() => {
    const im = imgRef.current;
    if (!im) return;
    const measure = () => {
      const r = im.getBoundingClientRect();
      setBox({ w: r.width, h: r.height });
    };
    measure();
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(measure);
      ro.observe(im);
      return () => ro.disconnect();
    }
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [src]);

  // Pick the page to draw. The default is the lowest page number
  // that has at least one bbox.
  const pages = Array.from(new Set(rows
    .filter((r) => r.bbox && r.page_number != null)
    .map((r) => r.page_number as number))).sort((a, b) => a - b);
  const activePage = page != null
    ? page
    : (pages[0] ?? null);

  const visible = rows.filter((r) =>
    r.bbox && (activePage == null || r.page_number === activePage));

  return (
    <div style={{ position: "relative", display: "inline-block", maxWidth: "100%" }}>
      <img
        ref={imgRef}
        src={src}
        alt={alt || "document"}
        style={{ width: "100%", display: "block", ...imgStyle }}
        onLoad={() => {
          const im = imgRef.current;
          if (!im) return;
          const r = im.getBoundingClientRect();
          setBox({ w: r.width, h: r.height });
        }}
      />
      {box && visible.length > 0 && (
        <svg
          aria-hidden="true"
          width={box.w}
          height={box.h}
          viewBox={`0 0 ${box.w} ${box.h}`}
          style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
        >
          {visible.map((row) => {
            const b = row.bbox as OcrBbox;
            if (!b.page_width || !b.page_height) return null;
            const sx = box.w / b.page_width;
            const sy = box.h / b.page_height;
            const x = b.x0 * sx;
            const y = b.y0 * sy;
            const w = (b.x1 - b.x0) * sx;
            const h = (b.y1 - b.y0) * sy;
            const isActive = active === row.id;
            return (
              <g key={row.id}>
                <rect
                  x={x} y={y} width={w} height={h}
                  fill={isActive ? "rgba(200, 255, 43, 0.25)" : "rgba(200, 255, 43, 0.08)"}
                  stroke={isActive ? "var(--accent-2, #6BBA00)" : "var(--accent, #C8FF2B)"}
                  strokeWidth={isActive ? 2 : 1}
                  style={{ pointerEvents: "auto", cursor: "pointer" }}
                  onMouseEnter={() => setActive(row.id)}
                  onMouseLeave={() => setActive((cur) => (cur === row.id ? null : cur))}
                >
                  <title>{(row.value || "").slice(0, 200) + (row.confidence != null ? "  (conf " + Math.round(row.confidence * 100) + "%)" : "")}</title>
                </rect>
              </g>
            );
          })}
        </svg>
      )}
      {pages.length > 1 && (
        <div
          className="mono-sm"
          style={{
            position: "absolute",
            top: 8, right: 8,
            background: "rgba(0,0,0,0.55)",
            color: "white",
            padding: "2px 6px",
            borderRadius: 4,
            pointerEvents: "none",
          }}
          aria-label={"Page " + (activePage ?? "?") + " of " + pages.length}
        >
          page {activePage ?? "?"} / {pages.length}
        </div>
      )}
    </div>
  );
};

export default BboxOverlay;
