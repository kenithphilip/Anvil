// Documents library + OCR review screen.
//
// Per the v1 design package (`screens-docs.jsx`), the doc workflow has
// three surfaces: Library (table of all uploaded docs), OCR Review
// (page thumbnails + extracted text + provenance), and Upload (drag-
// drop + in-progress tracker). This file wires the UI shell against
// the existing `documents` API in `src/api/documents/`. Page preview
// (PDF.js) is a follow-up; the structural design + provenance display
// ship now so the visual matches the design.

import React, { useEffect, useMemo, useState } from "react";
import { Banner, Btn, Card, Chip, KPI, KPIRow, WSTabs, WSTitle } from "../lib/primitives";
import { ObaraBackend } from "../lib/api";
import { Icon } from "../lib/icons";

type Tab = "library" | "review" | "upload";

interface DocRow {
  id: string;
  filename: string;
  doc_type?: string | null;
  customer_name?: string | null;
  source?: string | null;
  ocr_confidence?: number | null;
  linked_so_id?: string | null;
  size_bytes?: number | null;
  uploaded_at?: string | null;
  page_count?: number | null;
  sha256?: string | null;
  uploader_email?: string | null;
  email_msg_id?: string | null;
}

const TABS: Array<{ id: Tab; label: string; n?: number }> = [
  { id: "library", label: "Library" },
  { id: "review",  label: "OCR review" },
  { id: "upload",  label: "Upload" },
];

const fmtBytes = (n: number | null | undefined): string => {
  if (!n) return "—";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
};

const fmtAge = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const ts = Date.parse(iso);
  if (!ts) return iso;
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + "m ago";
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return hrs + "h ago";
  return Math.round(hrs / 24) + "d ago";
};

const Documents: React.FC = () => {
  const [tab, setTab] = useState<Tab>("library");
  const [rows, setRows] = useState<DocRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<DocRow | null>(null);
  const [busyUpload, setBusyUpload] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const resp: any = await ObaraBackend?.documents?.list?.();
        const list = Array.isArray(resp?.documents) ? resp.documents
                   : Array.isArray(resp?.rows)      ? resp.rows
                   : Array.isArray(resp)             ? resp
                   : [];
        if (!cancelled) setRows(list);
      } catch (e: any) {
        if (!cancelled) setErr(e?.message || "Could not load documents");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const stats = useMemo(() => {
    const xs = rows || [];
    const linked = xs.filter((d) => !!d.linked_so_id).length;
    const conf = xs.map((d) => d.ocr_confidence || 0).filter((v) => v > 0);
    const avg = conf.length ? Math.round((conf.reduce((a, b) => a + b, 0) / conf.length) * 100) : null;
    return { total: xs.length, linked, avgConf: avg };
  }, [rows]);

  const onUpload = async (files: FileList | null) => {
    if (!files || !files.length) return;
    setBusyUpload(true);
    try {
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        if (ObaraBackend?.documents?.upload) {
          await ObaraBackend.documents.upload(f);
        }
      }
      window.notifySuccess?.("Uploaded", `${files.length} document(s)`);
      const resp: any = await ObaraBackend?.documents?.list?.();
      const list = Array.isArray(resp?.documents) ? resp.documents : (resp?.rows || resp || []);
      setRows(list);
      setTab("library");
    } catch (e: any) {
      window.notifyError?.("Upload failed", e?.message || String(e));
    } finally {
      setBusyUpload(false);
    }
  };

  return (
    <div className="page">
      <WSTitle eyebrow="Documents" title="Document library" meta={`${rows?.length ?? "—"} docs`} />
      <KPIRow cols={3}>
        <KPI lbl="Documents"      v={String(stats.total)} />
        <KPI lbl="Linked to SOs"  v={String(stats.linked)} />
        <KPI lbl="Avg OCR conf"   v={stats.avgConf == null ? "—" : stats.avgConf + "%"} />
      </KPIRow>
      <WSTabs
        tabs={TABS.map((t) => ({ id: t.id, label: t.label, count: t.n }))}
        active={tab}
        onChange={(id: string) => setTab(id as Tab)}
      />

      {err && <Banner kind="bad">{err}</Banner>}

      {tab === "library" && (
        <Card>
          {!rows && <p className="muted">Loading…</p>}
          {rows && rows.length === 0 && (
            <p className="muted">No documents uploaded yet. Switch to the Upload tab to add one.</p>
          )}
          {rows && rows.length > 0 && (
            <table className="tab">
              <thead>
                <tr>
                  <th>Document</th>
                  <th>Type</th>
                  <th>Customer</th>
                  <th>Source</th>
                  <th>OCR conf</th>
                  <th>Linked SO</th>
                  <th>Size</th>
                  <th>Uploaded</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <button type="button" className="link-btn" onClick={() => { setSelected(d); setTab("review"); }}>
                        {d.filename}
                      </button>
                    </td>
                    <td>{d.doc_type || "—"}</td>
                    <td>{d.customer_name || "—"}</td>
                    <td>
                      {d.source ? <Chip k="info">{d.source}</Chip> : "—"}
                    </td>
                    <td>
                      {d.ocr_confidence == null
                        ? "—"
                        : <Chip k={d.ocr_confidence >= 0.9 ? "good" : d.ocr_confidence >= 0.7 ? "warn" : "bad"}>
                            {Math.round(d.ocr_confidence * 100)}%
                          </Chip>}
                    </td>
                    <td>
                      {d.linked_so_id
                        ? <a href={"#/so?id=" + d.linked_so_id}>SO-{d.linked_so_id.slice(0, 6)}</a>
                        : "—"}
                    </td>
                    <td>{fmtBytes(d.size_bytes)}</td>
                    <td>{fmtAge(d.uploaded_at)}</td>
                    <td><Btn sm onClick={() => { setSelected(d); setTab("review"); }}>Review</Btn></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}

      {tab === "review" && (
        <div className="row gap-md" style={{ alignItems: "flex-start" }}>
          <Card style={{ flex: "0 0 200px" }} title="Pages">
            {!selected && <p className="muted">Pick a document from the library.</p>}
            {selected && (
              <div className="col gap-sm">
                {Array.from({ length: selected.page_count || 1 }, (_, i) => (
                  <button key={i} type="button" className="ws-thumbnail">
                    Page {i + 1}
                  </button>
                ))}
              </div>
            )}
          </Card>
          <Card style={{ flex: 1 }} title={selected ? selected.filename : "OCR review"} eyebrow="page preview">
            {!selected && <p className="muted">No document selected.</p>}
            {selected && (
              <div className="col gap-md">
                <div className="ws-pdf-stub">
                  PDF preview surface. PDF.js mount goes here in the
                  follow-up. Document id: <code>{selected.id}</code>
                </div>
                <div>
                  <strong>Provenance</strong>
                  <table className="kv" style={{ marginTop: 8 }}>
                    <tbody>
                      <tr><td>doc_id</td><td><code>{selected.id}</code></td></tr>
                      <tr><td>sha256</td><td><code>{selected.sha256 || "—"}</code></td></tr>
                      <tr><td>uploader</td><td>{selected.uploader_email || "—"}</td></tr>
                      <tr><td>email_msg_id</td><td><code>{selected.email_msg_id || "—"}</code></td></tr>
                      <tr><td>uploaded_at</td><td>{selected.uploaded_at || "—"}</td></tr>
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </Card>
        </div>
      )}

      {tab === "upload" && (
        <Card title="Upload document" eyebrow="drag-and-drop or pick">
          <label
            className="ws-drop"
            onDragOver={(e) => { e.preventDefault(); }}
            onDrop={(e) => { e.preventDefault(); onUpload(e.dataTransfer?.files || null); }}
          >
            <input
              type="file"
              accept="application/pdf,image/*,.zip,.xlsx"
              multiple
              hidden
              onChange={(e) => onUpload(e.target.files)}
            />
            <div className="ws-drop-icon" aria-hidden="true">{Icon.upload}</div>
            <div className="ws-drop-h">Drop PDF, image or ZIP</div>
            <div className="ws-drop-sub">{busyUpload ? "Uploading…" : "or click to choose"}</div>
          </label>
        </Card>
      )}
    </div>
  );
};

export default Documents;
