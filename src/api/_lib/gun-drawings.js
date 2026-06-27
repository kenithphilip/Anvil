// Gun-drawing helpers (shared by documents/upload allowlist + the
// gun_drawings endpoint). A gun drawing is the physical assembly drawing
// for a gun/asset — PDF for viewing, DWG/DXF or STEP/STP for CAD — uploaded
// and stored (via the documents pipeline) so the spare matrix can show it
// while spares are being identified on the gun.
//
// Pure module: no DB/network. Safe to unit-test.

// CAD mime types to allow on top of the documents upload allowlist (PDF is
// already allowed there). Browsers are inconsistent for .dwg/.step — many
// send "" or application/octet-stream (already allowed), so this set is the
// belt-and-braces for browsers that do send a real CAD mime.
export const DRAWING_MIME = new Set([
  "image/vnd.dwg",
  "application/acad",
  "application/dwg",
  "application/x-dwg",
  "application/x-autocad",
  "image/x-dwg",
  "application/dxf",
  "image/vnd.dxf",
  "model/step",
  "application/step",
  "application/x-step",
  "application/p21",
  "model/stp",
]);

// Canonical drawing format from filename extension (preferred) then mime.
// Returns: pdf | dwg | step | other.
export const inferDrawingFormat = (filename, mime) => {
  const f = String(filename || "").toLowerCase();
  const ext = f.includes(".") ? f.slice(f.lastIndexOf(".") + 1) : "";
  if (ext === "pdf") return "pdf";
  if (ext === "dwg" || ext === "dxf") return "dwg";
  if (ext === "step" || ext === "stp") return "step";
  const m = String(mime || "").toLowerCase();
  if (m === "application/pdf") return "pdf";
  if (m.includes("dwg") || m.includes("dxf") || m.includes("acad")) return "dwg";
  if (m.includes("step") || m === "application/p21" || m === "model/stp") return "step";
  return "other";
};

export const DRAWING_FORMATS = new Set(["pdf", "dwg", "step", "other"]);

// Normalize an asset/gun number for tolerant matching: uppercase, strip every
// non-alphanumeric (so "X2C-X MEDIUM" == "x2c_x_medium" == "X2CXMEDIUM").
export const normalizeGunNo = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

// Vet a drawing against the gun it's being attached to. Confirms the asset
// number appears in the FILE NAME and/or the actual FILE CONTENT (text layer
// or OCR). Pure: the caller supplies the already-extracted text + ocr_status.
//
//   gunNo            - the gun/asset number the drawing is being linked to
//   filename         - uploaded file name
//   text             - extracted text (pdf text layer / OCR / STEP ascii); ""
//                      when the format is unreadable (e.g. binary DWG)
//   ocrStatus        - how `text` was obtained (text_layer | ocr | step_text |
//                      binary_unreadable | download_failed | error | ...)
//
// Returns { normalized_gun, filename_match, content_match, content_checkable,
//           ocr_status, verdict, blocked }.
//   verdict: verified      - asset number found IN THE CONTENT (strongest)
//            filename_only  - matched the file name but not (readable) content
//            mismatch       - content was readable but the number is absent
//                             everywhere
//            unverifiable   - content unreadable AND the file name didn't match
//            no_gun         - no gun number supplied (cannot vet)
//   blocked: true when neither the file name nor the content matched, i.e. the
//            link should be refused unless explicitly overridden.
export const vetDrawingMatch = ({ gunNo, filename, text, ocrStatus } = {}) => {
  const ng = normalizeGunNo(gunNo);
  const nFile = normalizeGunNo(filename);
  const nText = normalizeGunNo(text);
  const content_checkable = !!(text && String(text).trim().length > 0);

  const filename_match = !!(ng && nFile.includes(ng));
  const content_match = !!(ng && content_checkable && nText.includes(ng));

  let verdict;
  if (!ng) verdict = "no_gun";
  else if (content_match) verdict = "verified";
  else if (filename_match) verdict = "filename_only";
  else if (!content_checkable) verdict = "unverifiable";
  else verdict = "mismatch";

  // Block only when nothing matched at all. no_gun can't be vetted but the
  // endpoint requires gun_no separately, so it never reaches here blocked.
  const blocked = !!ng && !filename_match && !content_match;

  return {
    normalized_gun: ng,
    filename_match,
    content_match,
    content_checkable,
    ocr_status: ocrStatus || null,
    verdict,
    blocked,
  };
};
