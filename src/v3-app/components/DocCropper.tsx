// 4-corner perspective crop for the SO-intake mobile camera flow.
//
// Audit P13.B.3 follow-up. The camera capture path lands a raw
// photo (rear camera, often skewed). This component lets the
// operator drag 4 corner handles to mark the document edges and
// computes a perspective warp to a rectangle on a canvas. No
// external library; the homography solver is inline below.
//
// Usage:
//   <DocCropper file={file} onCancel={...} onCropped={(file) => ...} />
//
// `file` is the original camera File. `onCropped` receives a new
// File with the cropped image as PNG. The original file is
// discarded once the crop is confirmed.

import React, { useEffect, useRef, useState } from "react";

interface Point { x: number; y: number; }

export interface DocCropperProps {
  file: File;
  onCancel: () => void;
  onCropped: (file: File) => void;
  // Output dimensions. The warped rectangle's width / height. Defaults
  // to A4-ish 1200x1700 which is plenty for OCR.
  outputWidth?: number;
  outputHeight?: number;
}

// Solve an 8x8 linear system using Gaussian elimination. Used to
// compute the 8 unknowns of a 3x3 homography (the 9th is fixed at 1
// by convention). Pure-JS, single-pass; the matrix is small enough
// that any algorithmic concern is irrelevant.
const solve8 = (A: number[][], b: number[]): number[] | null => {
  const n = 8;
  const M: number[][] = A.map((row, i) => [...row, b[i]]);
  for (let i = 0; i < n; i += 1) {
    // Partial pivot.
    let pivot = i;
    for (let r = i + 1; r < n; r += 1) {
      if (Math.abs(M[r][i]) > Math.abs(M[pivot][i])) pivot = r;
    }
    if (Math.abs(M[pivot][i]) < 1e-12) return null;
    if (pivot !== i) [M[i], M[pivot]] = [M[pivot], M[i]];
    for (let r = i + 1; r < n; r += 1) {
      const f = M[r][i] / M[i][i];
      for (let c = i; c <= n; c += 1) M[r][c] -= f * M[i][c];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i -= 1) {
    let s = M[i][n];
    for (let c = i + 1; c < n; c += 1) s -= M[i][c] * x[c];
    x[i] = s / M[i][i];
  }
  return x;
};

// Build the 3x3 homography that maps the 4 source points to the 4
// destination points. Returns the 9-element row-major matrix or
// null if the system is singular. The mapping convention is dst =
// H * src (homogeneous coordinates).
const homography = (src: Point[], dst: Point[]): number[] | null => {
  // 8 equations, 8 unknowns.
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    const { x: sx, y: sy } = src[i];
    const { x: dx, y: dy } = dst[i];
    A.push([sx, sy, 1, 0, 0, 0, -dx * sx, -dx * sy]); b.push(dx);
    A.push([0, 0, 0, sx, sy, 1, -dy * sx, -dy * sy]); b.push(dy);
  }
  const h = solve8(A, b);
  if (!h) return null;
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
};

// Apply the inverse-homography sampling to render the warped output.
// We compute the inverse of H (3x3 matrix invert by cofactors) once
// and then walk every output pixel, mapping back to source.
const invert3 = (m: number[]): number[] | null => {
  const a = m[0], b = m[1], c = m[2];
  const d = m[3], e = m[4], f = m[5];
  const g = m[6], h = m[7], i = m[8];
  const A =  (e * i - f * h);
  const B = -(d * i - f * g);
  const C =  (d * h - e * g);
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  const D = -(b * i - c * h);
  const E =  (a * i - c * g);
  const F = -(a * h - b * g);
  const G =  (b * f - c * e);
  const H = -(a * f - c * d);
  const I =  (a * e - b * d);
  return [A / det, D / det, G / det, B / det, E / det, H / det, C / det, F / det, I / det];
};

const HANDLE_R = 12;

export const DocCropper: React.FC<DocCropperProps> = ({
  file, onCancel, onCropped, outputWidth = 1200, outputHeight = 1700,
}) => {
  // Loaded image bitmap + visible canvas size.
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [boxW, setBoxW] = useState(0);
  const [boxH, setBoxH] = useState(0);
  // 4 corner positions in display coords (top-left, top-right,
  // bottom-right, bottom-left; matches the dst rectangle order).
  const [corners, setCorners] = useState<Point[]>([
    { x: 0,   y: 0   },
    { x: 100, y: 0   },
    { x: 100, y: 100 },
    { x: 0,   y: 100 },
  ]);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Load the image when the file prop changes.
  useEffect(() => {
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => {
      // Fit the image within a 720x900 box, keeping aspect ratio.
      const maxW = 720, maxH = 900;
      const scale = Math.min(maxW / im.width, maxH / im.height, 1);
      const w = Math.round(im.width * scale);
      const h = Math.round(im.height * scale);
      setBoxW(w); setBoxH(h);
      setCorners([
        { x: w * 0.05, y: h * 0.05 },
        { x: w * 0.95, y: h * 0.05 },
        { x: w * 0.95, y: h * 0.95 },
        { x: w * 0.05, y: h * 0.95 },
      ]);
      setImg(im);
    };
    im.onerror = () => setError("Could not decode the image.");
    im.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const onMouseDown = (idx: number) => (ev: React.MouseEvent) => {
    ev.preventDefault();
    setDragIdx(idx);
  };
  useEffect(() => {
    if (dragIdx == null) return;
    const onMove = (ev: MouseEvent) => {
      const rect = wrapRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = Math.max(0, Math.min(boxW, ev.clientX - rect.left));
      const y = Math.max(0, Math.min(boxH, ev.clientY - rect.top));
      setCorners((prev) => prev.map((p, i) => (i === dragIdx ? { x, y } : p)));
    };
    const onUp = () => setDragIdx(null);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    // Touch parity. Each touch event maps the first changed touch
    // to the same logic so a phone can drag handles without a
    // mouse.
    const onTouchMove = (ev: TouchEvent) => {
      ev.preventDefault();
      const t = ev.touches[0];
      if (!t) return;
      const rect = wrapRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = Math.max(0, Math.min(boxW, t.clientX - rect.left));
      const y = Math.max(0, Math.min(boxH, t.clientY - rect.top));
      setCorners((prev) => prev.map((p, i) => (i === dragIdx ? { x, y } : p)));
    };
    const onTouchEnd = () => setDragIdx(null);
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("touchend", onTouchEnd);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
    };
  }, [dragIdx, boxW, boxH]);

  const applyCrop = async () => {
    if (!img) return;
    setWorking(true);
    setError(null);
    try {
      // Map display corners back into image-coordinate space (we
      // shrunk the image to fit the box; reverse that).
      const sx = img.width / boxW;
      const sy = img.height / boxH;
      const src: Point[] = corners.map((p) => ({ x: p.x * sx, y: p.y * sy }));
      const dst: Point[] = [
        { x: 0,           y: 0 },
        { x: outputWidth, y: 0 },
        { x: outputWidth, y: outputHeight },
        { x: 0,           y: outputHeight },
      ];
      // We want to sample the source image; build the inverse
      // homography from dst to src so we walk output pixels and
      // pull from the source.
      const H = homography(dst, src);
      if (!H) throw new Error("Could not solve perspective transform; check the corner positions.");
      const Hinv = H;            // homography(dst, src) IS already dst -> src
      // Render to an offscreen canvas. Use a sampling canvas to
      // read source pixels.
      const srcCanvas = document.createElement("canvas");
      srcCanvas.width = img.width; srcCanvas.height = img.height;
      const sctx = srcCanvas.getContext("2d");
      if (!sctx) throw new Error("Canvas 2D context unavailable.");
      sctx.drawImage(img, 0, 0);
      const sdata = sctx.getImageData(0, 0, img.width, img.height).data;

      const dstCanvas = document.createElement("canvas");
      dstCanvas.width = outputWidth; dstCanvas.height = outputHeight;
      const dctx = dstCanvas.getContext("2d");
      if (!dctx) throw new Error("Canvas 2D context unavailable.");
      const dimg = dctx.createImageData(outputWidth, outputHeight);
      const ddata = dimg.data;

      for (let y = 0; y < outputHeight; y += 1) {
        for (let x = 0; x < outputWidth; x += 1) {
          const w = Hinv[6] * x + Hinv[7] * y + Hinv[8];
          const xs = (Hinv[0] * x + Hinv[1] * y + Hinv[2]) / w;
          const ys = (Hinv[3] * x + Hinv[4] * y + Hinv[5]) / w;
          // Nearest-neighbour sampling. Bilinear is nicer but
          // adds ~3x runtime; nearest is fast enough for the
          // 1200x1700 default.
          const ix = Math.round(xs);
          const iy = Math.round(ys);
          const di = (y * outputWidth + x) * 4;
          if (ix < 0 || iy < 0 || ix >= img.width || iy >= img.height) {
            ddata[di] = 255; ddata[di + 1] = 255; ddata[di + 2] = 255; ddata[di + 3] = 255;
            continue;
          }
          const si = (iy * img.width + ix) * 4;
          ddata[di]     = sdata[si];
          ddata[di + 1] = sdata[si + 1];
          ddata[di + 2] = sdata[si + 2];
          ddata[di + 3] = sdata[si + 3];
        }
      }
      dctx.putImageData(dimg, 0, 0);
      const blob: Blob = await new Promise((resolve, reject) => {
        dstCanvas.toBlob((b) => b ? resolve(b) : reject(new Error("Could not encode the cropped image.")), "image/png");
      });
      const cropped = new File([blob], (file.name || "capture").replace(/\.[^.]+$/, "") + ".cropped.png", { type: "image/png" });
      onCropped(cropped);
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setWorking(false);
    }
  };

  return (
    <div role="dialog" aria-modal="true" style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)",
      zIndex: 100, display: "grid", placeItems: "center", padding: 16,
    }}>
      <div style={{ background: "var(--paper)", borderRadius: 8, padding: 16, maxWidth: "calc(100vw - 32px)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <div>
            <div className="h2">Crop the document</div>
            <div className="mono-sm" style={{ color: "var(--ink-3)" }}>Drag the four corner handles to the document edges, then crop.</div>
          </div>
          <button type="button" className="btn icon sm ghost" onClick={onCancel} aria-label="Cancel crop" title="Cancel (Esc)">×</button>
        </div>
        {error && <div className="mono-sm" style={{ color: "var(--bad, #a00)", marginBottom: 8 }}>{error}</div>}
        <div
          ref={wrapRef}
          style={{ position: "relative", width: boxW, height: boxH, background: "#000", maxWidth: "100%", touchAction: "none" }}
        >
          {img && <img src={img.src} alt="captured document" style={{ width: boxW, height: boxH, display: "block", userSelect: "none", pointerEvents: "none" }} draggable={false} />}
          {/* Quad outline */}
          <svg style={{ position: "absolute", inset: 0, width: boxW, height: boxH, pointerEvents: "none" }}>
            <polygon
              points={corners.map((p) => p.x + "," + p.y).join(" ")}
              fill="rgba(200, 255, 43, 0.08)"
              stroke="var(--accent-2, #6BBA00)"
              strokeWidth={2}
            />
          </svg>
          {/* Corner handles */}
          {corners.map((p, i) => (
            <button
              key={i}
              type="button"
              aria-label={["top-left", "top-right", "bottom-right", "bottom-left"][i] + " corner"}
              onMouseDown={onMouseDown(i)}
              onTouchStart={(ev) => { ev.preventDefault(); setDragIdx(i); }}
              style={{
                position: "absolute",
                left: p.x - HANDLE_R,
                top:  p.y - HANDLE_R,
                width: HANDLE_R * 2,
                height: HANDLE_R * 2,
                borderRadius: "50%",
                background: dragIdx === i ? "var(--accent-2, #6BBA00)" : "var(--accent, #C8FF2B)",
                border: "2px solid var(--ink, #000)",
                cursor: "grab",
                touchAction: "none",
                padding: 0,
              }}
            />
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
          <button type="button" className="btn sm ghost" onClick={onCancel} disabled={working}>Cancel</button>
          <button type="button" className="btn sm primary" onClick={applyCrop} disabled={working || !img}>
            {working ? "Cropping..." : "Crop and use"}
          </button>
        </div>
      </div>
    </div>
  );
};

export default DocCropper;
