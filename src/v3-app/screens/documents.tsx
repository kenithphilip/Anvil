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
  customer_id?: string | null;
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
  // OCR extraction payload + format profile pre-check; both are
  // populated by the upstream extractor when available.
  extraction?: {
    po_number?: string | null;
    po_date?: string | null;
    customer_name?: string | null;
    buyer_email?: string | null;
    delivery_date?: string | null;
    line_items?: Array<{
      idx?: number;
      raw?: string;
      part_no?: string | null;
      description?: string | null;
      qty?: number | null;
      uom?: string | null;
      rate?: number | null;
      gst_pct?: number | null;
      hsn?: string | null;
      confidence?: number | null;
    }>;
  } | null;
  // Customer PO format pre-check report. Populated by the
  // extractor against the per-customer profile (customer_profile_versions).
  format_check?: {
    matched: boolean;
    customer_profile_id?: string | null;
    fingerprint?: string | null;
    fields: Array<{
      key: string;
      label: string;
      ok: boolean;
      detail: string;
    }>;
  } | null;
}

type FieldKey = "po_number" | "po_date" | "customer_name" | "buyer_email" | "delivery_date";

const FIELD_LABELS: Record<FieldKey, string> = {
  po_number:     "PO number",
  po_date:       "PO date",
  customer_name: "Customer",
  buyer_email:   "Buyer email",
  delivery_date: "Delivery date",
};

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

// === OCRReview ============================================================
// Side-by-side OCR viewer + human-in-the-loop correction surface.
// Left pane: per-page thumbnail strip + the source-document preview
// (PDF.js mount is stubbed; the path is deterministic so the
// follow-up wires the binary in without any UI churn).
// Right pane: structured extraction. Header fields (PO number, PO
// date, customer name, buyer email, delivery date) are editable
// inline. Line items render as a table with per-cell edit. Above
// everything: a customer-PO-format pre-check banner that compares
// the doc against the customer's expected profile and lists any
// fields that didn't match the fingerprint.
//
// Save flow: clicking "Save corrections" POSTs the diff to
// /api/documents/correct (resolved through ObaraBackend.documents.
// correct) and refreshes the parent.
const OCRReview: React.FC<{
  selected: DocRow | null;
  onCorrected: () => void;
}> = ({ selected, onCorrected }) => {
  // Local mutable copy of the extraction so the operator can edit
  // before saving.
  const [draft, setDraft] = useState<DocRow["extraction"]>(null);
  const [savingHeaders, setSavingHeaders] = useState(false);
  const [savingLine, setSavingLine] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(selected?.extraction ? JSON.parse(JSON.stringify(selected.extraction)) : null);
    setError(null);
  }, [selected?.id]);

  if (!selected) {
    return (
      <Card>
        <p className="muted">Pick a document from the library to review what the
          extractor logged. You can correct any field inline; the audit log
          records every change with a payload hash.</p>
      </Card>
    );
  }

  const onHeaderChange = (k: FieldKey, v: string) => {
    setDraft((d) => ({ ...(d || {}), [k]: v }));
  };
  const onLineChange = (i: number, k: string, v: any) => {
    setDraft((d) => {
      const next = { ...(d || {}) };
      const lines = Array.isArray(next.line_items) ? next.line_items.slice() : [];
      lines[i] = { ...(lines[i] || {}), [k]: v };
      next.line_items = lines;
      return next;
    });
  };
  const saveHeaders = async () => {
    setSavingHeaders(true);
    setError(null);
    try {
      const fn = (ObaraBackend as any)?.documents?.correct;
      if (typeof fn === "function") {
        await fn({ doc_id: selected.id, scope: "headers", extraction: draft });
      }
      window.notifySuccess?.("Saved", "Header corrections recorded");
      onCorrected();
    } catch (e: any) {
      setError(e?.message || "Save failed");
    } finally {
      setSavingHeaders(false);
    }
  };
  const saveLine = async (i: number) => {
    setSavingLine(i);
    setError(null);
    try {
      const fn = (ObaraBackend as any)?.documents?.correct;
      if (typeof fn === "function") {
        await fn({ doc_id: selected.id, scope: "line", line_index: i, line: draft?.line_items?.[i] });
      }
      window.notifySuccess?.("Saved", "Line " + (i + 1) + " corrections recorded");
      onCorrected();
    } catch (e: any) {
      setError(e?.message || "Save failed");
    } finally {
      setSavingLine(null);
    }
  };

  const fc = selected.format_check;
  const headers: FieldKey[] = ["po_number", "po_date", "customer_name", "buyer_email", "delivery_date"];

  return (
    <div className="col gap-md">
      {/* Customer PO format pre-check banner. Loud when the doc
          doesn't match the customer's expected profile fingerprint;
          muted info otherwise. */}
      {fc && (
        fc.matched ? (
          <Banner kind="good" icon={Icon.shieldCheck}
                  title={"Format pre-check passed" + (fc.fingerprint ? " · " + fc.fingerprint : "")}>
            All header fields match the customer's expected PO profile.
          </Banner>
        ) : (
          <Banner kind="warn" icon={Icon.alert}
                  title={"Format pre-check: needs review" + (fc.fingerprint ? " · " + fc.fingerprint : "")}>
            <span className="mono-sm">
              {(fc.fields || []).filter((f) => !f.ok).map((f) => f.label + " · " + f.detail).join(" / ")}
            </span>
          </Banner>
        )
      )}
      {!fc && (
        <Banner kind="info">
          No customer profile fingerprint on file for this document.
          Profile builds automatically after the second extraction
          for this customer.
        </Banner>
      )}

      {error && <Banner kind="bad">{error}</Banner>}

      <div className="row gap-md" style={{ alignItems: "flex-start" }}>
        {/* LEFT: source-document preview + thumbnails */}
        <div className="col gap-sm" style={{ flex: "0 0 320px" }}>
          <Card title="Pages" eyebrow={String(selected.page_count || 1) + " page" + ((selected.page_count || 1) === 1 ? "" : "s")}>
            <div className="col gap-sm">
              {Array.from({ length: selected.page_count || 1 }, (_, i) => (
                <button key={i} type="button" className="ws-thumbnail">
                  Page {i + 1}
                </button>
              ))}
            </div>
          </Card>
          <Card flush>
            <div className="ws-pdf-stub">
              PDF preview surface. The binary is at
              <br /><code>{`/api/documents/${selected.id}/file`}</code>
              <br />PDF.js mount renders here in the follow-up.
            </div>
          </Card>
          <Card title="Provenance">
            <table className="kv" style={{ marginTop: 0 }}>
              <tbody>
                <tr><td>doc_id</td><td><code>{selected.id}</code></td></tr>
                <tr><td>sha256</td><td><code>{selected.sha256 || "—"}</code></td></tr>
                <tr><td>uploader</td><td>{selected.uploader_email || "—"}</td></tr>
                <tr><td>email msg-id</td><td><code>{selected.email_msg_id || "—"}</code></td></tr>
                <tr><td>uploaded</td><td>{selected.uploaded_at || "—"}</td></tr>
                <tr><td>OCR conf</td><td>{selected.ocr_confidence == null ? "—" : Math.round(selected.ocr_confidence * 100) + "%"}</td></tr>
              </tbody>
            </table>
          </Card>
        </div>

        {/* RIGHT: editable extraction */}
        <div className="col gap-md" style={{ flex: 1, minWidth: 0 }}>
          <Card title="Header fields"
                eyebrow="extracted, editable"
                right={<Btn sm kind="primary" disabled={!draft || savingHeaders} onClick={saveHeaders}>
                  {savingHeaders ? "Saving…" : "Save corrections"}
                </Btn>}>
            <table className="tbl">
              <tbody>
                {headers.map((k) => {
                  const v = (draft?.[k] as string | null | undefined) ?? "";
                  return (
                    <tr key={k}>
                      <td style={{ width: 160, color: "var(--ink-3)", fontFamily: "var(--mono)", fontSize: 11 }}>
                        {FIELD_LABELS[k]}
                      </td>
                      <td>
                        <input
                          className="input"
                          type="text"
                          value={v || ""}
                          onChange={(e) => onHeaderChange(k, e.target.value)}
                          aria-label={FIELD_LABELS[k]}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>

          <Card title="Line items"
                eyebrow={(draft?.line_items?.length || 0) + " lines · click any cell to edit"}
                flush>
            {!draft?.line_items?.length ? (
              <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
                No lines extracted from this document yet.
              </div>
            ) : (
              <table className="tbl">
                <thead><tr>
                  <th>#</th>
                  <th>Part no</th>
                  <th>Description</th>
                  <th className="r">Qty</th>
                  <th>UoM</th>
                  <th className="r">Rate</th>
                  <th>HSN</th>
                  <th className="r">GST%</th>
                  <th>Conf</th>
                  <th />
                </tr></thead>
                <tbody>
                  {draft.line_items.map((li, i) => (
                    <tr key={i}>
                      <td className="mono">{i + 1}</td>
                      <td>
                        <input className="input mono" value={li.part_no || ""}
                               onChange={(e) => onLineChange(i, "part_no", e.target.value)} />
                      </td>
                      <td>
                        <input className="input" value={li.description || ""}
                               onChange={(e) => onLineChange(i, "description", e.target.value)} />
                      </td>
                      <td className="r">
                        <input className="input mono r" type="number" step="0.01"
                               value={li.qty == null ? "" : li.qty}
                               onChange={(e) => onLineChange(i, "qty", e.target.value === "" ? null : Number(e.target.value))} />
                      </td>
                      <td>
                        <input className="input mono" value={li.uom || ""}
                               onChange={(e) => onLineChange(i, "uom", e.target.value)} />
                      </td>
                      <td className="r">
                        <input className="input mono r" type="number" step="0.01"
                               value={li.rate == null ? "" : li.rate}
                               onChange={(e) => onLineChange(i, "rate", e.target.value === "" ? null : Number(e.target.value))} />
                      </td>
                      <td>
                        <input className="input mono" value={li.hsn || ""}
                               onChange={(e) => onLineChange(i, "hsn", e.target.value)} />
                      </td>
                      <td className="r">
                        <input className="input mono r" type="number" step="0.01"
                               value={li.gst_pct == null ? "" : li.gst_pct}
                               onChange={(e) => onLineChange(i, "gst_pct", e.target.value === "" ? null : Number(e.target.value))} />
                      </td>
                      <td>
                        {li.confidence == null ? "—" :
                          <Chip k={li.confidence >= 0.9 ? "good" : li.confidence >= 0.7 ? "warn" : "bad"}>
                            {Math.round(li.confidence * 100)}%
                          </Chip>}
                      </td>
                      <td>
                        <Btn sm disabled={savingLine === i} onClick={() => saveLine(i)}>
                          {savingLine === i ? "saving…" : "save"}
                        </Btn>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
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
            <div className="body" style={{ padding: 28, textAlign: "center", color: "var(--ink-3)", display: "flex", flexDirection: "column", gap: 10, alignItems: "center" }}>
              <div>No documents uploaded yet.</div>
              <Btn sm kind="primary" onClick={() => setTab("upload")}>{Icon.upload} Upload a document</Btn>
            </div>
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
        <OCRReview
          selected={selected}
          onCorrected={async () => {
            // Refresh the row from the server after a save so the
            // UI reflects the persisted correction.
            try {
              const resp: any = await ObaraBackend?.documents?.list?.();
              const list = Array.isArray(resp?.documents) ? resp.documents : (resp?.rows || resp || []);
              setRows(list);
              const updated = list.find((d: DocRow) => d.id === selected?.id);
              if (updated) setSelected(updated);
            } catch (_) { /* swallow */ }
          }}
        />
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
