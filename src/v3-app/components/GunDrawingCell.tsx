import React, { useState } from "react";
import { Banner, Btn, Chip, Modal } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { ObaraBackend } from "../lib/api";

// Per-gun drawing manager, used as a cell in the spare-matrix worksheet.
//
// A gun's assembly drawing (PDF / DWG-DXF / STEP-STP) is uploaded through the
// documents pipeline (signed URL + ClamAV scan) and linked to the gun by
// gun_no, so it's available while spares are identified on the gun and reused
// across every matrix. Files are fetched on demand with fresh signed URLs.

const FORMAT_CHIP: Record<string, string> = { pdf: "info", dwg: "warn", step: "plum", other: "ghost" };

export const GunDrawingCell: React.FC<{ gunNo: string }> = ({ gunNo }) => {
  const [open, setOpen] = useState(false);
  const [drawings, setDrawings] = useState<any[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const code = String(gunNo || "").trim();

  const load = async () => {
    setErr(null); setDrawings(null);
    try {
      const resp: any = await ObaraBackend?.gunDrawings?.list?.(code);
      setDrawings(resp?.drawings || []);
    } catch (e: any) { setErr(e?.message || String(e)); setDrawings([]); }
  };
  const openMgr = () => { if (!code) return; setOpen(true); load(); };

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusy(true); setErr(null);
    try {
      const up: any = await ObaraBackend?.documents?.upload?.(file, "gun_drawing");
      if (!up?.documentId) throw new Error("Upload did not return a document id");
      await ObaraBackend?.gunDrawings?.link?.({ gun_no: code, document_id: up.documentId, label: file.name });
      window.notifySuccess?.("Drawing attached", file.name);
      await load();
    } catch (e: any) {
      const msg = e?.message || String(e);
      setErr(msg);
      window.notifyError?.("Could not attach drawing", msg);
    } finally { setBusy(false); }
  };

  const del = async (d: any) => {
    if (typeof confirm === "function" && !confirm("Remove drawing " + (d.filename || d.id) + "?")) return;
    try { await ObaraBackend?.gunDrawings?.unlink?.(d.id); await load(); }
    catch (e: any) { setErr(e?.message || String(e)); }
  };

  const count = drawings ? drawings.length : null;

  return (
    <>
      <Btn icon sm kind="ghost" disabled={!code}
           title={code ? "Drawings for " + code : "Set gun_no first"} onClick={openMgr}>
        {Icon.doc}
      </Btn>
      <Modal open={open} title={"Drawings · " + code} onClose={() => setOpen(false)} maxWidth={540}>
        <Modal.Body>
          {err && <Banner kind="bad" title="Drawings">{err}</Banner>}
          <label className="mono-sm" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <input type="file" accept=".pdf,.dwg,.dxf,.step,.stp,application/pdf" disabled={busy} onChange={onPick} />
            {busy && <span style={{ color: "var(--ink-3)" }}>uploading…</span>}
          </label>
          <div className="mono-sm" style={{ color: "var(--ink-4)", fontSize: 10 }}>
            PDF, DWG/DXF or STEP/STP. Files are virus-scanned before they attach.
          </div>
          {drawings == null ? (
            <div className="mono-sm" style={{ color: "var(--ink-3)" }}>Loading…</div>
          ) : count === 0 ? (
            <div className="mono-sm" style={{ color: "var(--ink-3)" }}>No drawings yet for this gun.</div>
          ) : (
            <table className="tbl" style={{ fontSize: 12 }}>
              <thead><tr><th>File</th><th>Format</th><th></th><th></th></tr></thead>
              <tbody>
                {(drawings || []).map((d) => (
                  <tr key={d.id}>
                    <td className="mono-sm">{d.filename || (d.document_id ? String(d.document_id).slice(0, 8) : "—")}</td>
                    <td><Chip k={(FORMAT_CHIP[d.format] || "ghost") as any}>{d.format || "?"}</Chip></td>
                    <td>
                      {d.download_url
                        ? <a href={d.download_url} target="_blank" rel="noopener noreferrer" className="mono-sm" style={{ textDecoration: "underline", color: "var(--ink)" }}>open</a>
                        : (d.scan_status && d.scan_status !== "clean"
                            ? <span className="mono-sm" style={{ color: "var(--ink-4)" }}>{d.scan_status}</span>
                            : "—")}
                    </td>
                    <td className="r"><Btn sm kind="ghost" onClick={() => del(d)}>Remove</Btn></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Modal.Body>
      </Modal>
    </>
  );
};

export default GunDrawingCell;
