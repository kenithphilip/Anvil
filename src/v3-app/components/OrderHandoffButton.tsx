import React from "react";
import { Banner, Btn, Chip, Modal } from "../lib/primitives";
import { AnvilBackend } from "../lib/api";
import { canDo } from "../lib/rbac";
import { fmtDate } from "../lib/helpers";

// "Send to order processing" in the SO workspace header: the Mode B handoff
// (docs/SO_TERMS_AND_HANDOFF_SCOPE.md 8.2). Hidden unless the tenant turned
// the handoff on, the tenant is in Mode B, and the user may send it
// (order.handoff). The modal shows the prefill with its sources, a shipment
// mode per origin group, the recipients and why each is there, the email, the
// attachments and the blockers. The server decides the blockers again on
// send. Data: GET and POST /api/orders/handoff.

type Handoff = { status: string; sent_at?: string | null; sent_by_name?: string | null; changed_since?: boolean };

const SOURCE_LABEL: Record<string, string> = {
  po_header: "PO delivery date",
  po_line: "earliest PO line date",
  po_description: "a line description",
  committed: "committed by us",
  delivery_contact: "delivery contact",
  po_buyer: "PO buyer block",
  primary_contact: "customer's primary contact",
  entered: "entered by you",
};
const GROUP_LABEL: Record<string, string> = { import: "Imported", local: "Local", unknown: "Origin unknown" };

const fmtTime = (iso?: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : fmtDate(iso) + " " + d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
};

// The handoff state as one chip: the workspace header and the register.
export const handoffChip = (h: Handoff | null | undefined): { k: string; label: string } => {
  if (!h || h.status === "not_sent") return { k: "ghost", label: "not sent" };
  if (h.status === "not_configured") return { k: "bad", label: "Not sent: no mail provider" };
  if (h.status === "failed") return { k: "bad", label: "Handoff failed" };
  if (h.changed_since) return { k: "warn", label: "Changed since handoff" };
  return { k: "good", label: ["Sent", fmtTime(h.sent_at), h.sent_by_name ? "by " + h.sent_by_name : ""].filter(Boolean).join(" ") };
};

const inputStyle: React.CSSProperties = {
  border: "1px solid var(--hairline)", borderRadius: 6, padding: "6px 9px",
  font: "inherit", fontSize: 12.5, background: "var(--paper)", color: "var(--ink)", width: "100%",
};

const Source: React.FC<{ s?: string | null }> = ({ s }) => (
  <span className="mono-sm" style={{ color: "var(--ink-3)" }}>{s ? "source: " + (SOURCE_LABEL[s] || s) : "required"}</span>
);

export const OrderHandoffButton: React.FC<{ orderId: string; refreshKey?: string; onSent?: () => void }> = ({ orderId, refreshKey, onSent }) => {
  const allowed = canDo("order.handoff");
  const [preview, setPreview] = React.useState<any>(null);
  const [open, setOpen] = React.useState(false);
  const [fields, setFields] = React.useState<any>(null);
  const [busy, setBusy] = React.useState(false);
  const [confirmResend, setConfirmResend] = React.useState(false);
  const [result, setResult] = React.useState<{ kind: string; text: string; blockers?: any[] } | null>(null);

  const load = React.useCallback(() => {
    if (!allowed || !orderId) return Promise.resolve();
    return Promise.resolve(AnvilBackend?.orders?.handoff?.(orderId))
      .then((r: any) => { setPreview(r || null); setFields(r?.fields || null); })
      .catch(() => setPreview(null));
  }, [allowed, orderId]);

  React.useEffect(() => { load(); }, [load, refreshKey]);

  if (!allowed || !preview?.enabled) return null;
  const h: Handoff = preview.handoff || { status: "not_sent" };
  const chip = handoffChip(h);
  const sent = h.status === "sent";
  const label = sent ? (h.changed_since ? "Re-send handoff" : "Send again") : "Send to order processing";

  const openModal = () => { setResult(null); setConfirmResend(false); setOpen(true); load(); };

  const send = async () => {
    if (sent && !confirmResend) { setConfirmResend(true); return; }
    setBusy(true); setResult(null);
    try {
      const r: any = await AnvilBackend?.orders?.handoffSend?.(orderId, fields, sent);
      setResult({ kind: r?.ok ? "good" : "bad", text: r?.message || r?.status || "Done." });
      if (r?.ok) setOpen(false);
      await load();
      onSent?.();
    } catch (e: any) {
      const err = e?.body?.error;
      setResult({ kind: "bad", text: err?.message || e?.message || String(e), blockers: err?.blockers });
    } finally { setBusy(false); setConfirmResend(false); }
  };

  const set = (patch: any) => setFields((f: any) => ({ ...f, ...patch }));
  const blockers = result?.blockers || preview.blockers || [];
  const rec = preview.recipients || { to: [], cc: [], dropped: [] };

  return (
    <>
      {h.status !== "not_sent" && <span data-testid="handoff-chip"><Chip k={chip.k}>{chip.label}</Chip></span>}
      <Btn sm kind={sent && !h.changed_since ? "ghost" : "primary"} onClick={openModal} title="Email the order processing team the inputs to key this order into the ERP">
        {label}
      </Btn>
      {result && !open && <span className="mono-sm" role="status" style={{ color: result.kind === "good" ? "var(--good)" : "var(--bad)" }}>{result.text}</span>}
      <Modal open={open} onClose={() => setOpen(false)} title="Send to order processing" maxWidth={760}>
        <Modal.Body>
          {sent && (
            <Banner kind={h.changed_since ? "warn" : "info"} title={h.changed_since ? "The order changed since the handoff" : "Already sent"}>
              <span className="mono-sm">{chip.label}. Sending again makes a new email.</span>
            </Banner>
          )}
          {blockers.length > 0 && (
            <Banner kind="bad" title="Not ready to send">
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {blockers.map((b: any, i: number) => <li key={b.code + i} className="mono-sm">{b.message}</li>)}
              </ul>
            </Banner>
          )}
          {result && result.kind === "bad" && !result.blockers && <Banner kind="bad" title="Not sent"><span className="mono-sm">{result.text}</span></Banner>}
          {fields && (
            <div className="col gap-sm" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <label className="lbl">Material required date
                <input aria-label="Material required date" style={inputStyle} value={fields.required_by || ""} onChange={(e) => set({ required_by: e.target.value, required_by_source: "entered" })} />
                <Source s={fields.required_by_source} />
                {preview.prefill?.committed && (
                  <span className="mono-sm" style={{ color: "var(--ink-3)" }}> Committed date: {preview.prefill.committed.value} (committed by us)</span>
                )}
              </label>
              <div className="row gap-sm" style={{ display: "flex", gap: 10 }}>
                <label className="lbl" style={{ flex: 1 }}>Contact name
                  <input aria-label="Contact name" style={inputStyle} value={fields.contact_name || ""} onChange={(e) => set({ contact_name: e.target.value, contact_source: "entered" })} />
                  <Source s={fields.contact_source} />
                </label>
                <label className="lbl" style={{ flex: 1 }}>Contact phone
                  <input aria-label="Contact phone" style={inputStyle} value={fields.contact_phone || ""} onChange={(e) => set({ contact_phone: e.target.value })} />
                </label>
              </div>
              {(preview.groups || []).map((g: any) => (
                <label key={g.group} className="lbl">{GROUP_LABEL[g.group] || g.group} lines ({g.line_nos.length}): shipment mode
                  <select aria-label={`Shipment mode for ${GROUP_LABEL[g.group] || g.group} lines`} className="select" style={inputStyle}
                          value={fields.modes?.[g.group] || ""}
                          onChange={(e) => set({ modes: { ...fields.modes, [g.group]: e.target.value } })}>
                    {!g.default_mode && <option value="">Choose a mode</option>}
                    {g.allowed_modes.map((m: string) => <option key={m} value={m}>{preview.modes?.[m] || m}</option>)}
                  </select>
                </label>
              ))}
              <div className="mono-sm">
                <div><b>To:</b> {rec.to.map((r: any) => r.email + " (" + r.reason + ")").join(", ") || "nobody"}</div>
                <div><b>CC:</b> {rec.cc.map((r: any) => r.email + " (" + r.reason + ")").join(", ") || "nobody"}</div>
                <div><b>Reply-to:</b> {rec.reply_to || "none"}</div>
                {rec.dropped?.length > 0 && <div style={{ color: "var(--ink-3)" }}>Left out: {rec.dropped.map((d: any) => d.entry + " (" + (d.detail || d.reason) + ")").join(", ")}</div>}
                <div><b>Attachments:</b> {(preview.attachments || []).map((a: any) => a.label).join(", ") || "none"}</div>
                <div><b>Subject:</b> {preview.subject}</div>
              </div>
              <pre className="mono-sm" style={{ whiteSpace: "pre-wrap", maxHeight: 260, overflow: "auto", background: "var(--paper-2)", padding: 8, borderRadius: 6 }}>{preview.body}</pre>
              <span className="mono-sm" style={{ color: "var(--ink-3)" }}>The preview shows the prefilled values. The email that goes out uses the values above.</span>
            </div>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Btn kind="ghost" onClick={() => setOpen(false)}>Close</Btn>
          <Btn kind="primary" disabled={busy || !fields} onClick={send}>
            {busy ? "Sending…" : confirmResend ? "Confirm: send again" : sent ? "Send again" : "Send"}
          </Btn>
        </Modal.Footer>
      </Modal>
    </>
  );
};
