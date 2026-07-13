import React, { useEffect, useMemo, useState } from "react";
import { Banner, Btn, Chip } from "../lib/primitives";
import { ObaraBackend } from "../lib/api";
import { RBAC } from "../lib/rbac";

// Categorized customer-registration data-point capture.
//
// Renders the 6-category registration catalog (statutory identity, business
// profile, contacts, commercial terms, banking, internal) merged with the
// customer's stored values from /api/customers/registration. View mode shows
// only filled fields per category with a provenance badge; edit mode shows
// every field as a typed input and saves the changed ones. The later
// automation (GSTIN fetch #186, document OCR cross-check, customer
// self-service email) writes through the same endpoint with source/verified
// set per field, which this panel surfaces as badges.

type Field = {
  key: string; label: string; type: string; mandatory: boolean;
  options: string[] | null; mapsTo: string | null;
  value: string | null; source: string | null; verified: boolean;
  verified_against: string | null; updated_at: string | null;
};
type Category = { key: string; label: string; fields: Field[] };

const SOURCE_CHIP: Record<string, "good" | "info" | "ghost" | "plum"> = {
  gst: "good", doc: "info", manual: "ghost", internal: "plum",
};

const fieldInput = (f: Field, val: string, onChange: (v: string) => void) => {
  const common = { className: "input", value: val, style: { width: "100%" } as React.CSSProperties };
  if (f.type === "select") {
    return (
      <select className="select" value={val} onChange={(e) => onChange(e.target.value)} style={{ width: "100%" }}>
        <option value="">—</option>
        {(f.options || []).map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  if (f.type === "longtext") {
    return <textarea {...common} rows={2} onChange={(e) => onChange(e.target.value)} />;
  }
  const inputType = f.type === "date" ? "date" : f.type === "amount" ? "number" : "text";
  return <input {...common} type={inputType} onChange={(e) => onChange(e.target.value)} />;
};

export const CustomerRegistrationPanel: React.FC<{ customerId: string }> = ({ customerId }) => {
  // Server gates writes to `write`; mirror that for the edit affordance. (This
  // captures into customer_registration_fields, not the master directly, so it
  // is not bound by the admin-only customer-master guard rail.)
  const canEdit = (RBAC.canWrite?.("customers") ?? RBAC.isAdmin?.()) || false;

  const [cats, setCats] = useState<Category[] | null>(null);
  const [completeness, setCompleteness] = useState<any>(null);
  const [icp, setIcp] = useState<any>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = () => {
    setCats(null); setErr(null);
    Promise.resolve(ObaraBackend?.customers?.getRegistration?.(customerId))
      .then((resp: any) => { setCats(resp?.categories || []); setCompleteness(resp?.completeness || null); })
      .catch((e: any) => setErr(e?.message || String(e)));
    // ICP fit (firmographic) — separate axis from the health score. Computed
    // on first read; re-scored server-side whenever registration fields change.
    Promise.resolve(ObaraBackend?.customers?.getIcp?.(customerId))
      .then((resp: any) => setIcp(resp || null))
      .catch(() => setIcp(null));
  };
  useEffect(load, [customerId]);

  const ICP_CHIP: Record<string, string> = { A: "good", B: "warn", C: "bad", Out: "ghost" };
  const icpChip = () => {
    if (!icp || icp.tier == null) return null;
    const missed = (icp.signals?.missed || []).slice(0, 4).join(", ");
    const title = "ICP fit — matched: " + ((icp.signals?.matched || []).join(", ") || "none")
      + (missed ? " · missing: " + missed : "");
    return (
      <span title={title}>
        <Chip k={(ICP_CHIP[icp.tier] || "ghost") as any}>ICP {icp.tier}{icp.score != null ? " · " + icp.score : ""}</Chip>
      </span>
    );
  };

  const allFields = useMemo(() => (cats || []).flatMap((c) => c.fields), [cats]);

  const startEdit = () => {
    const d: Record<string, string> = {};
    for (const f of allFields) d[f.key] = f.value ?? "";
    setDraft(d); setEditing(true); setErr(null);
  };
  const cancel = () => { setEditing(false); setDraft({}); setErr(null); };

  const save = async () => {
    // Only send fields whose value actually changed.
    const changed: Record<string, string> = {};
    for (const f of allFields) {
      const next = draft[f.key] ?? "";
      if (next !== (f.value ?? "")) changed[f.key] = next;
    }
    if (!Object.keys(changed).length) { setEditing(false); return; }
    setBusy(true); setErr(null);
    try {
      await ObaraBackend?.customers?.saveRegistration?.({ customer_id: customerId, fields: changed });
      window.notifySuccess?.("Registration saved", `${Object.keys(changed).length} field(s)`);
      setEditing(false); setDraft({});
      load();
    } catch (e: any) {
      const msg = e?.message || String(e);
      setErr(msg);
      window.notifyError?.("Could not save registration", msg);
    } finally { setBusy(false); }
  };

  const badge = (f: Field) => {
    if (!f.source) return null;
    return (
      <span style={{ display: "inline-flex", gap: 4, alignItems: "center", marginLeft: 6 }}>
        <Chip k={SOURCE_CHIP[f.source] || "ghost"}>{f.source}</Chip>
        {f.verified && (
          <span title={f.verified_against ? "verified vs " + f.verified_against : "verified"}>
            <Chip k="good">✓</Chip>
          </span>
        )}
      </span>
    );
  };

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <div className="mono-sm" style={{ color: "var(--ink-3)", display: "flex", gap: 8, alignItems: "center" }}>
          Registration profile
          {completeness && (
            <Chip k={completeness.pct >= 100 ? "good" : completeness.pct >= 50 ? "warn" : "bad"}>
              {completeness.pct}% · {completeness.mandatory_filled}/{completeness.mandatory_total} required
            </Chip>
          )}
          {icpChip()}
        </div>
        {canEdit ? (
          editing
            ? <div className="row gap-sm">
                <Btn sm kind="ghost" disabled={busy} onClick={cancel}>Cancel</Btn>
                <Btn sm kind="primary" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save"}</Btn>
              </div>
            : <Btn sm kind="ghost" onClick={startEdit}>{cats && cats.length ? "Edit registration" : "Edit"}</Btn>
        ) : <span className="mono-sm" style={{ color: "var(--ink-4)", fontSize: 10 }}>Read-only</span>}
      </div>

      {err && <Banner kind="bad" title="Registration">{err}</Banner>}

      {cats == null ? (
        <div className="mono-sm" style={{ color: "var(--ink-3)", padding: 8 }}>Loading…</div>
      ) : (
        cats.map((cat) => {
          const filled = cat.fields.filter((f) => f.value != null && String(f.value).trim() !== "");
          if (!editing && filled.length === 0) {
            return (
              <div key={cat.key} style={{ marginTop: 10 }}>
                <div className="mono-sm" style={{ color: "var(--ink-3)", fontWeight: 600 }}>{cat.label}</div>
                <div className="mono-sm" style={{ color: "var(--ink-4)", padding: "4px 0" }}>— empty</div>
              </div>
            );
          }
          return (
            <div key={cat.key} style={{ marginTop: 12 }}>
              <div className="mono-sm" style={{ color: "var(--ink-3)", fontWeight: 600, marginBottom: 6 }}>{cat.label}</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: editing ? 10 : 4 }}>
                {(editing ? cat.fields : filled).map((f) => (
                  <div key={f.key} style={editing ? {} : { display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12 }}>
                    {editing ? (
                      <label className="mono-sm" style={{ display: "block" }}>
                        <span style={{ color: "var(--ink-3)" }}>{f.label}{f.mandatory ? " *" : ""}</span>
                        {fieldInput(f, draft[f.key] ?? "", (v) => setDraft((d) => ({ ...d, [f.key]: v })))}
                      </label>
                    ) : (
                      <>
                        <span style={{ color: "var(--ink-3)" }}>{f.label}{f.mandatory ? " *" : ""}</span>
                        <span className="mono-sm" style={{ textAlign: "right" }}>{f.value}{badge(f)}</span>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
};

export default CustomerRegistrationPanel;
