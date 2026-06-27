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
