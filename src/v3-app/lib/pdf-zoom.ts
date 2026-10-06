// Zoom arithmetic for the PO viewer.
//
// An operator checking a total or counting scanned line items needs to magnify a
// region of the page. The viewer rendered at fit-to-width and nothing else — the
// `scale` prop existed and was threaded all the way to react-pdf's <Page>, but
// no caller ever passed it.
//
// Two mechanisms, because they have different costs:
//
//   LIVE   a CSS transform applied during a gesture. Cheap, 60fps, and the bbox
//          overlay rides along for free because it is inside the transformed
//          subtree. Blurry, since pdf.js does not re-raster.
//   COMMIT the `scale` prop. react-pdf re-keys the page and rasterises at the
//          new scale, so text is sharp — which is the entire point when the
//          thing being read is a printed total.
//
// A pinch runs LIVE and commits when the fingers settle. That keeps the gesture
// smooth without rasterising once per frame.

/** Below fit-to-width the page stops being readable; above 4x pdf.js rasters get costly. */
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 4;
/** Where "fit" resets to. */
export const ZOOM_FIT = 1;
/** One button press / one keyboard step. */
export const ZOOM_STEP = 1.25;

export const clampZoom = (z: number): number => {
  if (!Number.isFinite(z)) return ZOOM_FIT;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
};

/** Multiply and clamp — the single path every gesture and button goes through. */
export const scaleBy = (zoom: number, factor: number): number => {
  if (!Number.isFinite(factor) || factor <= 0) return clampZoom(zoom);
  return clampZoom(zoom * factor);
};

export const zoomIn = (z: number) => scaleBy(z, ZOOM_STEP);
export const zoomOut = (z: number) => scaleBy(z, 1 / ZOOM_STEP);

/** "150%" — what the readout shows, and what a screen reader announces. */
export const zoomPercent = (z: number): string => `${Math.round(clampZoom(z) * 100)}%`;

/** Distance between two active touches, for a pinch. */
export const touchDistance = (a: { clientX: number; clientY: number }, b: { clientX: number; clientY: number }): number =>
  Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);

/** Midpoint of a pinch — the point the zoom should stay anchored to. */
export const touchMidpoint = (
  a: { clientX: number; clientY: number },
  b: { clientX: number; clientY: number },
): { x: number; y: number } => ({ x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });

/**
 * A ctrl+wheel notch as a zoom factor.
 *
 * A trackpad pinch reaches the browser as wheel events with ctrlKey set — on
 * every OS, and it is the desktop pinch gesture. Windows mouse users get the
 * same path via ctrl+scroll.
 *
 * deltaMode 1 is lines and 2 is pages; both carry far smaller numbers than
 * pixels, so treating them alike would make one notch of a line-mode wheel jump
 * the whole range.
 */
export const wheelZoomFactor = (deltaY: number, deltaMode = 0): number => {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 1;
  const perUnit = deltaMode === 0 ? 0.01 : deltaMode === 1 ? 0.2 : 0.4;
  // Exponential so zooming out then back in returns to where it started.
  return Math.exp(-deltaY * perUnit);
};

/**
 * Scroll offset that keeps the point under the fingers under the fingers.
 *
 * Without this, zooming always pulls toward the top-left and the region being
 * inspected slides out of view — the operator re-hunts for it after every step.
 *
 * `focal` is viewport-relative (a clientX/clientY); `rect` is the scroll
 * container's own bounding rect.
 */
export const anchoredScroll = (
  before: { scrollLeft: number; scrollTop: number },
  rect: { left: number; top: number },
  focal: { x: number; y: number },
  ratio: number,
): { scrollLeft: number; scrollTop: number } => {
  if (!Number.isFinite(ratio) || ratio <= 0) return { ...before };
  // Where the focal point sits within the scrolled content, pre-zoom.
  const cx = before.scrollLeft + (focal.x - rect.left);
  const cy = before.scrollTop + (focal.y - rect.top);
  return {
    scrollLeft: Math.max(0, cx * ratio - (focal.x - rect.left)),
    scrollTop: Math.max(0, cy * ratio - (focal.y - rect.top)),
  };
};
