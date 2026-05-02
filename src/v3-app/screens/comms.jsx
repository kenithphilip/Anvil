import React, { useEffect, useState } from "react";
import { useFetch } from "../lib/helpers.js";
import { Banner, Btn, Card, Chip, WSTabs, WSTitle } from "../lib/primitives.jsx";
import { Icon } from "../lib/icons.jsx";
import { ObaraBackend } from "../lib/api.js";

// ============================================================
// ANVIL v3 — wired Communications
// Wave F · Comms
// Drafts, sent, templates + composer.
// ============================================================

const COMMS_TABS = [
  { id: "all",       label: "All" },
  { id: "drafts",    label: "Drafts" },
  { id: "sent",      label: "Sent" },
  { id: "templates", label: "Templates" },
];

const COMMS_TEMPLATES = [
  { id: "order-confirm",  name: "Order confirmation",  channel: "email", subject: "Order confirmation · {po_number}",          body: "Confirming receipt of your PO {po_number}. We will dispatch within {lead_time}." },
  { id: "missing-doc",    name: "Missing-doc nudge",   channel: "email", subject: "Quick request · {missing_doc} for {po_number}", body: "Hi, we are awaiting the {missing_doc} so we can release your order." },
  { id: "rate-confirm",   name: "Rate confirmation",   channel: "email", subject: "Rate confirmation · {po_number}",            body: "Confirming the unit rate of {rate} for {sku} on PO {po_number}." },
  { id: "anomaly-verify", name: "Anomaly verification",channel: "email", subject: "Verify line · {po_number}",                  body: "Could you confirm the rate {rate} on line {line_no} of PO {po_number}? Historical rate was {hist_rate}." },
  { id: "spare-attach",   name: "Spare attach offer",  channel: "email", subject: "Recommended spares for {sku}",               body: "Customers buying {sku} typically also order {spares}. Add to this order?" },
  { id: "sms-dispatch",   name: "SMS dispatch alert",  channel: "sms",   subject: "—",                                          body: "Your Anvil dispatch {tracking_id} is out for delivery." },
];

const commsRowsFromAudit = (resp) => {
  if (!resp) return [];
  const arr = Array.isArray(resp) ? resp : (resp.events || resp.rows || []);
  return arr.map((a) => {
    const detail = a.detail || {};
    return {
      id: a.id || a.object_id,
      channel: detail.channel || "email",
      orderRef: detail.order_ref || detail.order_id || a.object_id || "—",
      recipient: detail.recipient || detail.to || "—",
      subject: detail.subject || a.action || "—",
      status: a.action === "communication.sent" ? "sent" : "draft",
      created_at: a.created_at,
    };
  });
};

const WiredComms = () => {
  const [active, setActive] = useState("all");
  const [composer, setComposer] = useState({
    templateId: COMMS_TEMPLATES[0].id,
    recipient: "",
    subject: COMMS_TEMPLATES[0].subject,
    body: COMMS_TEMPLATES[0].body,
    busy: false,
    flash: null,
  });

  const drafts = useFetch(
    () => fetch("/api/audit?action=communication.draft&limit=100")
      .then((r) => r.ok ? r.json() : { events: [] })
      .catch(() => ({ events: [] })),
    []
  );
  const sent = useFetch(
    () => fetch("/api/audit?action=communication.sent&limit=100")
      .then((r) => r.ok ? r.json() : { events: [] })
      .catch(() => ({ events: [] })),
    []
  );

  const draftRows = commsRowsFromAudit(drafts.data);
  const sentRows = commsRowsFromAudit(sent.data).map((r) => ({ ...r, status: "sent" }));
  const allRows = [...draftRows, ...sentRows].sort((a, b) =>
    new Date(b.created_at || 0) - new Date(a.created_at || 0)
  );

  const counts = {
    all: allRows.length,
    drafts: draftRows.length,
    sent: sentRows.length,
    templates: COMMS_TEMPLATES.length,
  };

  const visibleRows = active === "drafts" ? draftRows
    : active === "sent" ? sentRows
    : active === "templates" ? []
    : allRows;

  const onTemplatePick = (id) => {
    const tpl = COMMS_TEMPLATES.find((t) => t.id === id) || COMMS_TEMPLATES[0];
    setComposer((c) => ({ ...c, templateId: tpl.id, subject: tpl.subject, body: tpl.body }));
  };

  const onSubmit = async (ev) => {
    ev.preventDefault();
    if (!composer.recipient) {
      setComposer((c) => ({ ...c, flash: { kind: "bad", msg: "Recipient required" } }));
      return;
    }
    setComposer((c) => ({ ...c, busy: true, flash: null }));
    try {
      const tpl = COMMS_TEMPLATES.find((t) => t.id === composer.templateId);
      await ObaraBackend?.communications?.draft?.({
        channel: tpl?.channel || "email",
        recipient: composer.recipient,
        subject: composer.subject,
        body: composer.body,
        template_id: composer.templateId,
      });
      setComposer((c) => ({ ...c, busy: false, flash: { kind: "good", msg: "Draft saved" }, recipient: "" }));
      drafts.reload();
    } catch (err) {
      setComposer((c) => ({ ...c, busy: false, flash: { kind: "bad", msg: String(err.message || err) } }));
    }
  };

  const loading = drafts.loading && sent.loading;
  const error = drafts.error && sent.error;

  return (
    <>
      <WSTitle
        eyebrow="Comms · Drafts"
        title="Communications"
        meta={`${counts.drafts} drafts · ${counts.sent} sent · ${counts.templates} templates`}
        right={<>
          <Btn icon kind="ghost" sm onClick={() => { drafts.reload(); sent.reload(); }} title="Refresh">{Icon.cycle}</Btn>
        </>}
      />
      <WSTabs
        tabs={COMMS_TABS.map((t) => ({ id: t.id, label: t.label, count: counts[t.id] }))}
        active={active}
        onChange={setActive}
      />

      <div className="ws-content">
        {error ? (
          <Banner kind="bad" icon={Icon.alert} title="Failed to load communications" action={<Btn sm onClick={() => { drafts.reload(); sent.reload(); }}>Retry</Btn>}>
            <span className="mono-sm">{String((drafts.error || sent.error)?.message || drafts.error || sent.error)}</span>
          </Banner>
        ) : null}

        <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 14 }}>
          <Card flush>
            {active === "templates" ? (
              <table className="tbl">
                <thead><tr>
                  <th scope="col">Template</th>
                  <th scope="col">Channel</th>
                  <th scope="col">Subject</th>
                  <th scope="col" style={{ width: 100 }}></th>
                </tr></thead>
                <tbody>
                  {COMMS_TEMPLATES.map((t) => (
                    <tr key={t.id}>
                      <td><span className="pri">{t.name}</span></td>
                      <td><Chip k={t.channel === "sms" ? "info" : "ghost"}>{t.channel}</Chip></td>
                      <td className="mono-sm">{t.subject}</td>
                      <td>
                        <Btn sm onClick={() => { onTemplatePick(t.id); setActive("drafts"); }}>use</Btn>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : loading ? (
              <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>Loading communications…</div>
            ) : visibleRows.length === 0 ? (
              <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
                No {active === "all" ? "" : active + " "}communications yet.
              </div>
            ) : (
              <table className="tbl">
                <thead><tr>
                  <th scope="col">ID</th>
                  <th scope="col">Channel</th>
                  <th scope="col">Order ref</th>
                  <th scope="col">Recipient</th>
                  <th scope="col">Subject</th>
                  <th scope="col">Status</th>
                  <th scope="col" style={{ width: 80 }}></th>
                </tr></thead>
                <tbody>
                  {visibleRows.slice(0, 100).map((r) => (
                    <tr key={r.id}>
                      <td className="mono-sm">{r.id ? String(r.id).slice(0, 8) : "—"}</td>
                      <td><Chip k={r.channel === "sms" ? "info" : "ghost"}>{r.channel}</Chip></td>
                      <td className="mono-sm">{r.orderRef ? String(r.orderRef).slice(0, 12) : "—"}</td>
                      <td className="mono-sm">{r.recipient}</td>
                      <td>{r.subject}</td>
                      <td><Chip k={r.status === "sent" ? "good" : "warn"}>{r.status}</Chip></td>
                      <td><Btn sm kind="ghost">open</Btn></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <Card title="New comm" eyebrow="template + recipient + body">
            {composer.flash && (
              <Banner kind={composer.flash.kind} icon={composer.flash.kind === "bad" ? Icon.alert : Icon.check} title={composer.flash.kind === "bad" ? "Action failed" : "Draft saved"}>
                <span className="mono-sm">{composer.flash.msg}</span>
              </Banner>
            )}
            <form onSubmit={onSubmit} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span className="mono-sm" style={{ color: "var(--ink-3)" }}>Template</span>
                <select
                  className="input"
                  value={composer.templateId}
                  onChange={(ev) => onTemplatePick(ev.target.value)}
                  aria-label="Template"
                  style={{ height: 32 }}
                >
                  {COMMS_TEMPLATES.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span className="mono-sm" style={{ color: "var(--ink-3)" }}>Recipient</span>
                <input
                  className="input"
                  type="email"
                  value={composer.recipient}
                  onChange={(ev) => setComposer((c) => ({ ...c, recipient: ev.target.value }))}
                  placeholder="email@customer.example"
                  aria-label="Recipient"
                  required
                  style={{ height: 32 }}
                />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span className="mono-sm" style={{ color: "var(--ink-3)" }}>Subject</span>
                <input
                  className="input"
                  value={composer.subject}
                  onChange={(ev) => setComposer((c) => ({ ...c, subject: ev.target.value }))}
                  aria-label="Subject"
                  style={{ height: 32 }}
                />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span className="mono-sm" style={{ color: "var(--ink-3)" }}>Body</span>
                <textarea
                  className="input"
                  value={composer.body}
                  onChange={(ev) => setComposer((c) => ({ ...c, body: ev.target.value }))}
                  aria-label="Body"
                  rows={8}
                  style={{ resize: "vertical", padding: 8, fontFamily: "var(--mono)", fontSize: 12 }}
                />
              </label>
              <div style={{ display: "flex", gap: 8 }}>
                <Btn type="submit" kind="primary" sm disabled={composer.busy}>
                  {composer.busy ? "saving…" : <>{Icon.send} save draft</>}
                </Btn>
              </div>
            </form>
          </Card>
        </div>
      </div>
    </>
  );
};


export default WiredComms;
