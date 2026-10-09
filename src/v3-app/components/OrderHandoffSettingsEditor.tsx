import React, { useEffect, useState } from "react";
import { Banner, Btn, Card, Chip } from "../lib/primitives";
import { AnvilBackend } from "../lib/api";
import { RBAC } from "../lib/rbac";

// Who receives the order-processing handoff email
// (docs/SO_TERMS_AND_HANDOFF_SCOPE.md, 8.1). After a sales order is logged, a
// sales engineer emails the order processing team the inputs for the ERP.
// This tab sets that team: To, CC and the sending mailbox.
//
// An entry is an email address or a role token such as role:operator, which
// expands to the approved members with that role. The preview shows what the
// lists resolve to right now, and why each address is there, so an admin sees
// a role with nobody in it before an engineer does.
//
// Nothing is sent from here. Saved via /api/admin/order_handoff_settings,
// which answers 409 MIGRATION_NOT_APPLIED until migration 251 is applied;
// that message is shown as the server words it, because it names the file.

type Recipient = { email: string; name?: string | null; reason?: string };
type Dropped = { list: string; entry: string; reason: string; detail?: string; status?: string | null };
type Resolution = { to: Recipient[]; cc: Recipient[]; dropped: Dropped[] };
type Settings = {
  order_handoff_enabled: boolean;
  order_handoff_to: string[];
  order_handoff_cc: string[];
  order_handoff_sender: string | null;
};

const SENDERS: Array<{ v: string; label: string }> = [
  { v: "", label: "Not chosen" },
  { v: "graph", label: "Shared Outlook mailbox (Microsoft Graph)" },
  { v: "mailer", label: "Mail provider (Brevo, Resend or SendGrid)" },
];

// One entry per line. Commas and semicolons also separate, so a pasted
// "a@example.com, b@example.com" becomes two entries, not one bad one.
const toEntries = (text: string): string[] =>
  text.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
const joinEntries = (list: string[] | null | undefined) => (list || []).join("\n");

const migrationMessage = (e: any): string | null =>
  (e?.body?.error?.code === "MIGRATION_NOT_APPLIED" ? String(e?.body?.error?.message || e?.message) : null);

const inputStyle: React.CSSProperties = {
  border: "1px solid var(--hairline)", borderRadius: 6, padding: "6px 9px",
  font: "inherit", fontSize: 12.5, background: "var(--paper)", color: "var(--ink)",
};

const RecipientTable: React.FC<{ label: string; rows: Recipient[] }> = ({ label, rows }) => (
  <div style={{ marginTop: 8 }}>
    <div className="mono-sm" style={{ color: "var(--ink-3)", marginBottom: 4 }}>{label}</div>
    {rows.length === 0 ? (
      <div className="mono-sm" data-testid={`handoff-${label.toLowerCase()}-empty`}>Nobody.</div>
    ) : (
      <table className="tbl" data-testid={`handoff-${label.toLowerCase()}-resolved`}>
        <thead><tr><th>Address</th><th>Name</th><th>Why</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.email}>
              <td className="mono">{r.email}</td>
              <td>{r.name || ""}</td>
              <td className="mono-sm">{r.reason || ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    )}
  </div>
);

export const OrderHandoffSettingsEditor: React.FC = () => {
  const canEdit = RBAC.isAdmin?.() ?? false;
  const [saved, setSaved] = useState<Settings | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [toDraft, setToDraft] = useState("");
  const [ccDraft, setCcDraft] = useState("");
  const [sender, setSender] = useState("");
  const [resolution, setResolution] = useState<Resolution | null>(null);
  const [roleTokens, setRoleTokens] = useState<string[]>([]);
  const [migration, setMigration] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const apply = (r: any) => {
    const s: Settings = r?.settings || { order_handoff_enabled: false, order_handoff_to: [], order_handoff_cc: [], order_handoff_sender: null };
    setSaved(s);
    setEnabled(!!s.order_handoff_enabled);
    setToDraft(joinEntries(s.order_handoff_to));
    setCcDraft(joinEntries(s.order_handoff_cc));
    setSender(s.order_handoff_sender || "");
    setResolution(r?.recipients || null);
    if (Array.isArray(r?.role_tokens)) setRoleTokens(r.role_tokens);
    setMigration(null);
  };

  const fail = (e: any) => {
    const m = migrationMessage(e);
    if (m) setMigration(m);
    else setErr(e?.message || String(e));
  };

  useEffect(() => {
    if (!canEdit) return;
    Promise.resolve(AnvilBackend?.admin?.orderHandoffSettings?.())
      .then(apply)
      .catch(fail);
  }, [canEdit]);

  const draft = () => ({
    order_handoff_enabled: enabled,
    order_handoff_to: toEntries(toDraft),
    order_handoff_cc: toEntries(ccDraft),
    order_handoff_sender: sender || null,
  });

  const dirty = !!saved && JSON.stringify(draft()) !== JSON.stringify({
    order_handoff_enabled: !!saved.order_handoff_enabled,
    order_handoff_to: saved.order_handoff_to || [],
    order_handoff_cc: saved.order_handoff_cc || [],
    order_handoff_sender: saved.order_handoff_sender || null,
  });

  const save = async () => {
    setBusy("save"); setErr(null); setFlash(null);
    try {
      const r: any = await AnvilBackend?.admin?.updateOrderHandoffSettings?.(draft());
      apply(r);
      setFlash("Saved. The preview below shows who receives the handoff right now.");
    } catch (e: any) { fail(e); } finally { setBusy(null); }
  };

  const preview = async () => {
    setBusy("preview"); setErr(null); setFlash(null);
    try {
      const d = draft();
      const r: any = await AnvilBackend?.admin?.previewOrderHandoffRecipients?.({ to: d.order_handoff_to, cc: d.order_handoff_cc });
      setResolution(r?.recipients || null);
    } catch (e: any) { fail(e); } finally { setBusy(null); }
  };

  if (!canEdit) {
    return (
      <Card title="Order handoff" eyebrow="who receives the order-processing email">
        <Banner kind="info" title="Admin only">
          <span className="mono-sm">These lists decide who receives customer order data, so only an admin can see or change them.</span>
        </Banner>
      </Card>
    );
  }

  return (
    <Card title="Order handoff" eyebrow="who receives the order-processing email">
      <div className="mono-sm" style={{ opacity: 0.85 }}>
        After a sales order is logged, a sales engineer emails the order processing team the inputs for the ERP.
        These settings say who receives that email. Nothing is sent from this tab.
      </div>

      {migration && (
        <Banner kind="warn" title="Not stored yet">
          <span className="mono-sm" data-testid="handoff-migration-missing">{migration}</span>
        </Banner>
      )}
      {err && <Banner kind="bad" title="Could not load or save"><span className="mono-sm">{err}</span></Banner>}
      {flash && <Banner kind="good" title="Saved"><span className="mono-sm">{flash}</span></Banner>}

      <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="checkbox" aria-label="Handoff email on" checked={enabled} disabled={!!busy} onChange={(e) => setEnabled(e.target.checked)} />
          <span>Handoff email on</span>
          <span className="mono-sm" style={{ color: "var(--ink-3)" }}>Off by default. While off, nobody can send it.</span>
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <span className="mono-sm" style={{ color: "var(--ink-3)" }}>To: the order processing team. One address or role token per line.</span>
          <textarea aria-label="To" rows={3} value={toDraft} disabled={!!busy} placeholder={"orders@example.com\nrole:operator"} onChange={(e) => setToDraft(e.target.value)} style={inputStyle} />
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <span className="mono-sm" style={{ color: "var(--ink-3)" }}>CC. Same format. The sending engineer is added to CC and set as reply-to when the email goes out.</span>
          <textarea aria-label="CC" rows={2} value={ccDraft} disabled={!!busy} placeholder="role:sales_manager" onChange={(e) => setCcDraft(e.target.value)} style={inputStyle} />
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <span className="mono-sm" style={{ color: "var(--ink-3)" }}>Sending mailbox</span>
          <select className="select" aria-label="Sending mailbox" value={sender} disabled={!!busy} onChange={(e) => setSender(e.target.value)}>
            {SENDERS.map((s) => <option key={s.v} value={s.v}>{s.label}</option>)}
          </select>
        </label>

        {roleTokens.length > 0 && (
          <div className="mono-sm" style={{ color: "var(--ink-3)" }}>
            Role tokens: {roleTokens.join(", ")}. Each expands to the approved members with that role.
          </div>
        )}

        <div style={{ display: "flex", gap: 8 }}>
          <Btn kind="primary" onClick={save} disabled={!!busy || !!migration || !dirty}>
            {busy === "save" ? "Saving..." : "Save"}
          </Btn>
          <Btn kind="ghost" onClick={preview} disabled={!!busy}>
            {busy === "preview" ? "Resolving..." : "Preview recipients"}
          </Btn>
        </div>
      </div>

      {resolution && (
        <div style={{ marginTop: 16, borderTop: "1px solid var(--line)", paddingTop: 10 }} data-testid="handoff-preview">
          <b style={{ fontSize: 13 }}>Who receives it right now</b>
          <RecipientTable label="To" rows={resolution.to || []} />
          <RecipientTable label="CC" rows={resolution.cc || []} />
          {(resolution.dropped || []).length > 0 && (
            <div style={{ marginTop: 10 }} data-testid="handoff-dropped">
              <div className="mono-sm" style={{ color: "var(--ink-3)", marginBottom: 4 }}>Not included</div>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {resolution.dropped.map((d, i) => (
                  <li key={i} className="mono-sm">
                    <Chip k="warn">{d.list.toUpperCase()}</Chip> {d.entry}: {d.detail || d.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Card>
  );
};
