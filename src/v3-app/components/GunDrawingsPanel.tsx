// Gun Drawings panel — bulk upload of EG sheets (PDF) + 2D drawings (PDF/DWG)
// + 3D models (STEP file OR external link) per spare-matrix gun, with a
// correct-after-upload review step and an upload track.
//
// Mounts as a right-side drawer over the Spare Matrix worksheet. Files upload
// straight to storage (documents.upload → signed URL), then the batch is
// filename-matched to guns server-side (spareMatrix.drawings.stage); the
// operator fixes any flagged rows and commits.

import React, { useEffect, useMemo, useState } from "react";
import { Banner, Btn, Card, Chip } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { AnvilBackend } from "../lib/api";

const KINDS: { id: string; label: string; accept: string }[] = [
  { id: "eg_sheet",   label: "EG sheet (PDF)",     accept: ".pdf" },
  { id: "drawing_2d", label: "2D drawing (PDF/DWG)", accept: ".pdf,.dwg,.dxf" },
  { id: "drawing_3d", label: "3D model (STEP)",     accept: ".step,.stp,.stpz" },
];
const KIND_LABEL: Record<string, string> = { eg_sheet: "EG", drawing_2d: "2D", drawing_3d: "3D" };
const STATUS_CHIP: Record<string, "good" | "warn" | "bad" | "info"> = {
  matched: "good", matched_suffix: "good", resolved: "good",
  ambiguous: "warn", unmatched: "warn", duplicate: "warn", wrong_type: "bad",
};
const CLEAN = new Set(["matched", "matched_suffix", "resolved"]);

export const GunDrawingsPanel: React.FC<{ matrixId: string; guns: string[]; onClose: () => void }> = ({ matrixId, guns, onClose }) => {
  const [kind, setKind] = useState("eg_sheet");
  const [rows, setRows] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [linkGun, setLinkGun] = useState("");
  const [linkUrl, setLinkUrl] = useState("");

  const load = async () => {
    try {
      const r = await AnvilBackend.spareMatrix.drawings.list({ matrix_id: matrixId });
      setRows(r?.drawings || []);
    } catch (e: any) { setErr(e?.message || String(e)); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [matrixId]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const staged = rows.filter((r) => r.status === "staged");
  const committed = rows.filter((r) => r.status === "committed");
  const needsReview = staged.filter((r) => !CLEAN.has(r.match_status));
  const activeKind = KINDS.find((k) => k.id === kind)!;

  const onFiles = async (files: FileList | null) => {
    if (!files || !files.length) return;
    setBusy(true); setErr(null); setMsg(null);
    try {
      const uploaded: any[] = [];
      for (const f of Array.from(files)) {
        // autoScan off: gun drawings are not OCR/extract inputs, so the
        // scan_status gate doesn't apply; skip the ClamAV round-trip.
        const up = await AnvilBackend.documents.upload(f, "gun_drawing", { autoScan: false });
        uploaded.push({ document_id: up.documentId, filename: f.name, size: f.size });
      }
      const res = await AnvilBackend.spareMatrix.drawings.stage({ matrix_id: matrixId, kind, files: uploaded });
      const s = res?.summary || {};
      setMsg(`Staged ${uploaded.length} file(s): ` + (Object.entries(s).map(([k, v]) => `${v} ${k}`).join(", ") || "—"));
      await load();
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  };

  const addLink = async () => {
    if (!linkGun || !linkUrl) return;
    setBusy(true); setErr(null);
    try {
      await AnvilBackend.spareMatrix.drawings.stage({ matrix_id: matrixId, kind: "drawing_3d", files: [{ link_url: linkUrl, filename: linkGun + ".step" }] });
      setLinkGun(""); setLinkUrl(""); setMsg("3D link staged."); await load();
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  };

  const correct = async (id: string, patch: any) => {
    setBusy(true); setErr(null);
    try { await AnvilBackend.spareMatrix.drawings.update({ id, ...patch }); await load(); }
    catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  };

  const commit = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await AnvilBackend.spareMatrix.drawings.commit({ matrix_id: matrixId });
      setMsg(`Committed ${r.committed?.length || 0}, skipped ${r.skipped?.length || 0}.`);
      await load();
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  };

  const byGun = useMemo(() => {
    const m = new Map<string, any[]>();
    for (const r of committed) { const g = r.gun_no || "—"; const a = m.get(g); if (a) a.push(r); else m.set(g, [r]); }
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [committed]);

  return (
    <div role="dialog" aria-modal="true" aria-label="Gun drawings"
      style={{ position: "fixed", inset: 0, background: "rgba(8,10,12,0.55)", display: "flex", justifyContent: "flex-end", zIndex: 200 }}
      onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ width: "min(940px, 96vw)", height: "100%", overflowY: "auto", background: "var(--surface-0)", borderLeft: "1px solid var(--hairline-2)", padding: 18 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <div><div className="h-eyebrow">Spare matrix</div><div className="h2" style={{ marginTop: 2 }}>Gun drawings</div></div>
          <Btn sm kind="ghost" onClick={onClose}>close</Btn>
        </div>
        {err && <Banner kind="bad">{err}</Banner>}
        {msg && <Banner kind="info">{msg}</Banner>}

        <Card title="Bulk upload">
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <span className="mono-sm" style={{ opacity: 0.7 }}>Kind</span>
            {KINDS.map((k) => <Btn key={k.id} sm kind={kind === k.id ? "primary" : "ghost"} onClick={() => setKind(k.id)}>{k.label}</Btn>)}
          </div>
          <div style={{ marginTop: 10 }}>
            <label className="mono-sm" style={{ display: "inline-block", padding: "8px 12px", border: "1px dashed var(--hairline-2)", borderRadius: 8, cursor: busy ? "wait" : "pointer" }}>
              {Icon.upload} {busy ? "Uploading…" : `Choose ${activeKind.accept} files…`}
              <input type="file" multiple accept={activeKind.accept} style={{ display: "none" }} disabled={busy}
                onChange={(e) => { onFiles(e.target.files); e.currentTarget.value = ""; }} />
            </label>
            <span className="mono-sm" style={{ opacity: 0.6, marginLeft: 8 }}>Filenames are matched to guns; fix any flagged rows below before committing.</span>
          </div>
          <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <span className="mono-sm" style={{ opacity: 0.7 }}>{Icon.link} or link a 3D model</span>
            <select value={linkGun} onChange={(e) => setLinkGun(e.target.value)} className="input" style={{ maxWidth: 160 }}>
              <option value="">gun…</option>{guns.map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
            <input className="input" placeholder="https://…/model.step" value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} style={{ minWidth: 240 }} />
            <Btn sm kind="ghost" disabled={!linkGun || !linkUrl || busy} onClick={addLink}>add link</Btn>
          </div>
        </Card>

        <Card title={`Review${needsReview.length ? ` — ${needsReview.length} need attention` : ""}`}>
          {staged.length === 0 ? <div className="mono-sm" style={{ opacity: 0.6 }}>No staged files. Upload a batch above.</div> : (
            <>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead><tr style={{ textAlign: "left", opacity: 0.6 }}>
                    <th>File</th><th>Kind</th><th>Status</th><th>Gun</th><th></th>
                  </tr></thead>
                  <tbody>
                    {staged.map((r) => (
                      <tr key={r.id} style={{ borderTop: "1px solid var(--hairline-2)" }}>
                        <td className="mono-sm">{r.original_filename || (r.link_url ? "(link)" : "—")}</td>
                        <td><Chip k="info">{KIND_LABEL[r.kind] || r.kind}{r.format ? ` · ${r.format}` : ""}</Chip></td>
                        <td><Chip k={STATUS_CHIP[r.match_status] || "info"}>{r.match_status}</Chip></td>
                        <td>
                          <select className="input" value={r.gun_no || ""} onChange={(e) => correct(r.id, { gun_no: e.target.value })} style={{ maxWidth: 150 }}>
                            <option value="">— pick gun —</option>{guns.map((g) => <option key={g} value={g}>{g}</option>)}
                          </select>
                        </td>
                        <td><Btn sm kind="ghost" onClick={() => correct(r.id, { status: "discarded" })}>discard</Btn></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ marginTop: 10 }}>
                <Btn sm kind="primary" disabled={busy} onClick={commit}>{Icon.check} Commit reviewed</Btn>
              </div>
            </>
          )}
        </Card>

        <Card title={`Stored drawings (${committed.length})`}>
          {byGun.length === 0 ? <div className="mono-sm" style={{ opacity: 0.6 }}>Nothing committed yet.</div> :
            byGun.map(([gun, ds]) => (
              <div key={gun} className="mono-sm" style={{ padding: "5px 0", borderTop: "1px solid var(--hairline-2)", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <strong style={{ minWidth: 120 }}>{gun}</strong>
                {ds.map((d) => d.link_url
                  ? <a key={d.id} href={d.link_url} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}><Chip k="good">{KIND_LABEL[d.kind]} ↗</Chip></a>
                  : <Chip key={d.id} k="good">{KIND_LABEL[d.kind]} · {d.original_filename || "file"}</Chip>)}
              </div>
            ))}
        </Card>

        <Card title="Upload track">
          {rows.length === 0 ? <div className="mono-sm" style={{ opacity: 0.6 }}>No uploads yet.</div> : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                <thead><tr style={{ textAlign: "left", opacity: 0.6 }}><th>File</th><th>Kind</th><th>Gun</th><th>Status</th><th>By (role)</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} style={{ borderTop: "1px solid var(--hairline-2)" }}>
                      <td className="mono-sm">{r.original_filename || (r.link_url ? "(link)" : "—")}</td>
                      <td>{KIND_LABEL[r.kind] || r.kind}</td>
                      <td>{r.gun_no || "—"}</td>
                      <td><Chip k={r.status === "committed" ? "good" : r.status === "discarded" ? "bad" : "info"}>{r.status}</Chip></td>
                      <td className="mono-sm" style={{ opacity: 0.7 }}>{r.uploader_role || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
};
