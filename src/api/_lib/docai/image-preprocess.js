// Image preprocessing for OCR (Wave 2.1 / #1).
//
// Mistral OCR (and every other OCR engine) accuracy drops on:
//   1. Skewed scans where the page is rotated 1-15 degrees off
//      horizontal (typical sloppy phone capture).
//   2. Low-DPI scans (150dpi or less): characters anti-alias into
//      each other and the model conflates "8" with "B" or "0".
//   3. Noisy scans with paper grain, dust, fax artefacts that
//      look like underline or strike-through marks.
//   4. Low-contrast scans (faint laser printouts, photo of a
//      screen).
//
// This module wraps every image-bytes payload before it goes to
// the OCR provider and applies a conservative cleanup chain:
//
//   - sharp.rotate()    -> auto-rotate via EXIF if the camera
//                          captured a portrait/landscape flag
//   - sharp.resize()    -> if the image is smaller than 1500px
//                          on the longest side, upscale to ~2000px
//                          with Lanczos resampling. OCR accuracy
//                          peaks at ~300dpi which is ~2480px on
//                          A4
//   - sharp.normalize() -> linear contrast stretch (cheap, never
//                          worse)
//   - sharp.sharpen()   -> light sharpen to recover edges lost
//                          to JPEG compression
//   - sharp.greyscale() -> reduces token cost for image-input
//                          models that bill by channel and
//                          eliminates colour-cast issues
//
// Notes:
//   - sharp is loaded dynamically via import(). When the package
//     is absent the preprocessor returns the original bytes with
//     a "skipped" status; the OCR layer downstream still works.
//   - Full Hough-transform deskew is NOT included in this first
//     pass. Adding it later means swapping the rotate() call for
//     a detect-then-rotate path. The cost/benefit tradeoff is
//     better measured against real scans first.
//   - PDFs are NOT preprocessed here. PDFs route through
//     pdf-chunker.js + pdf-lib; if a page is image-only the
//     downstream Mistral OCR call rasterises it.

const DEFAULT_TARGET_LONG_EDGE = 2000;
const MIN_LONG_EDGE_FOR_UPSCALE = 1500;
const MAX_INPUT_BYTES = 25_000_000;   // 25MB sanity cap

const loadSharp = async () => {
  try {
    // Vite/Vitest evaluates static imports at build time even
    // inside try/catch; assigning the specifier to a variable
    // defers resolution until runtime so the optional-dep path
    // never breaks the test transform. The @vite-ignore comment
    // is belt-and-braces in case the variable form ever changes.
    const specifier = "sharp";
    const mod = await import(/* @vite-ignore */ specifier);
    return mod?.default || mod;
  } catch (_e) {
    return null;
  }
};

const isImageMime = (mime) => {
  const m = String(mime || "").toLowerCase();
  return m === "image/jpeg" || m === "image/jpg" || m === "image/png"
    || m === "image/webp" || m === "image/tiff" || m === "image/bmp"
    || m === "image/heic" || m === "image/heif";
};

// Public API. Returns:
//   { ok, bytes, mime, width, height, channels, applied: string[],
//     skipped_reason?, latency_ms }
//
// The caller compares `bytes` !== original `buffer` to know if
// the payload changed; the returned `mime` should be used for the
// downstream OCR call.
export const preprocessImage = async ({ buffer, mimeType, opts = {} }) => {
  const t0 = Date.now();
  const result = {
    ok: false,
    bytes: buffer,
    mime: mimeType,
    width: null,
    height: null,
    channels: null,
    applied: [],
    skipped_reason: null,
    latency_ms: 0,
  };
  if (!buffer || !buffer.length) {
    result.skipped_reason = "no_bytes";
    result.latency_ms = Date.now() - t0;
    return result;
  }
  if (buffer.length > MAX_INPUT_BYTES) {
    result.skipped_reason = "input_too_large";
    result.latency_ms = Date.now() - t0;
    return result;
  }
  if (!isImageMime(mimeType) && !opts.force) {
    result.skipped_reason = "not_an_image";
    result.latency_ms = Date.now() - t0;
    return result;
  }
  const sharp = await loadSharp();
  if (!sharp) {
    result.skipped_reason = "sharp_unavailable";
    result.latency_ms = Date.now() - t0;
    return result;
  }

  try {
    let img = sharp(buffer, { failOn: "none" });
    const meta = await img.metadata();
    result.width = meta.width || null;
    result.height = meta.height || null;
    result.channels = meta.channels || null;
    const targetLongEdge = Number(opts.targetLongEdge || DEFAULT_TARGET_LONG_EDGE);
    const minLongEdge = Number(opts.minLongEdge || MIN_LONG_EDGE_FOR_UPSCALE);

    // 1. Auto-rotate via EXIF orientation flag.
    img = img.rotate();
    result.applied.push("auto_rotate");

    // 2. Upsample small scans to OCR sweet spot.
    const longest = Math.max(meta.width || 0, meta.height || 0);
    if (longest && longest < minLongEdge) {
      const scale = targetLongEdge / longest;
      img = img.resize({
        width: Math.round((meta.width || 0) * scale) || undefined,
        height: Math.round((meta.height || 0) * scale) || undefined,
        kernel: "lanczos3",
      });
      result.applied.push("upscale_" + targetLongEdge);
    }

    // 3. Normalize contrast.
    if (opts.normalize !== false) {
      img = img.normalize();
      result.applied.push("normalize");
    }

    // 4. Light sharpen to recover lost edges.
    if (opts.sharpen !== false) {
      img = img.sharpen({ sigma: 0.5 });
      result.applied.push("sharpen");
    }

    // 5. Greyscale conversion. Saves bandwidth + removes colour
    //    cast that confuses some OCR engines on whiteboards.
    if (opts.greyscale !== false) {
      img = img.greyscale();
      result.applied.push("greyscale");
    }

    // 6. Encode to PNG by default (lossless, smaller for line art).
    //    Caller can opt-in to JPEG for photographs by passing
    //    opts.encode = "jpeg".
    const encode = opts.encode || "png";
    if (encode === "jpeg") {
      img = img.jpeg({ quality: 92, mozjpeg: true });
      result.mime = "image/jpeg";
    } else {
      img = img.png({ compressionLevel: 9 });
      result.mime = "image/png";
    }

    const out = await img.toBuffer({ resolveWithObject: true });
    result.ok = true;
    result.bytes = out.data;
    result.width = out.info.width;
    result.height = out.info.height;
    result.channels = out.info.channels;
    result.latency_ms = Date.now() - t0;
    return result;
  } catch (err) {
    result.skipped_reason = "sharp_failed: " + (err?.message || String(err));
    result.latency_ms = Date.now() - t0;
    return result;
  }
};

export const __test = { loadSharp, isImageMime };
