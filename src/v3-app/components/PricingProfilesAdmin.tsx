import React, { useEffect, useState } from "react";
import { Banner, Btn, Card, Chip } from "../lib/primitives";
import { ObaraBackend } from "../lib/api";

// Admin: per-tenant pricing-profile configuration.
//
// Lists the profiles visible to the tenant (global defaults + the
// tenant's own), lets an admin clone a global into a tenant override,
// toggle which components apply, edit their rates/amounts, and set the
// margin floor. Backs the configurable price-composition engine
// (lib/pricing.ts) via /api/admin/pricing_profiles.

type Profile = any;
type Comp = any;

const KIND_OPTIONS = [
  "fx_convert", "per_unit", "per_weight", "per_volume",
  "pct_of", "fixed", "margin_markup", "discount",
];

const blankComponent = (seq: number): Comp => ({
  seq,
  code: "component_" + seq,
  label: "New component",
  kind: "pct_of",
  base_ref: "running",
  rate: 0,
  amount: null,
  currency: "base",
  use_loaded_rate: false,
  enabled: true,
  visibility: "internal",
});

export const PricingProfilesAdmin: React.FC = () => {
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<Profile | null>(null);
  const [isClone, setIsClone] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = () => {
    setProfiles(null);
    setErr(null);
    Promise.resolve(ObaraBackend?.admin?.listPricingProfiles?.())
      .then((resp: any) => setProfiles(Array.isArray(resp) ? resp : resp?.profiles || []))
      .catch((e: any) => setErr(e?.message || String(e)));
  };
  useEffect(load, []);

  const startEdit = (p: Profile, clone: boolean) => {
    setIsClone(clone);
    setEditing({
      ...p,
      components: (p.components || []).map((c: Comp) => ({ ...c })),
    });
  };

  const setField = (k: string, v: any) => setEditing((e: Profile) => ({ ...e, [k]: v }));
  const setComp = (i: number, k: string, v: any) =>
    setEditing((e: Profile) => ({ ...e, components: e.components.map((c: Comp, idx: number) => (idx === i ? { ...c, [k]: v } : c)) }));
  const addComp = () =>
    setEditing((e: Profile) => ({ ...e, components: [...e.components, blankComponent(e.components.length + 1)] }));
  const removeComp = (i: number) =>
    setEditing((e: Profile) => ({ ...e, components: e.components.filter((_: Comp, idx: number) => idx !== i) }));

  const save = async () => {
    if (!editing?.code) { setErr("Profile code is required."); return; }
    setBusy(true);
    setErr(null);
    try {
      const payload = {
        code: editing.code,
        label: editing.label || editing.code,
        base_currency: editing.base_currency || "INR",
        margin_floor_pct: Number(editing.margin_floor_pct) || 0,
        fx_stale_days: editing.fx_stale_days != null ? Number(editing.fx_stale_days) : 30,
        components: (editing.components || []).map((c: Comp, idx: number) => ({
          seq: idx + 1,
          code: c.code,
          label: c.label || c.code,
          kind: c.kind,
          base_ref: c.base_ref || null,
          rate: c.rate === "" || c.rate == null ? null : Number(c.rate),
          amount: c.amount === "" || c.amount == null ? null : Number(c.amount),
          currency: c.currency === "supplier" ? "supplier" : "base",
          use_loaded_rate: !!c.use_loaded_rate,
          enabled: c.enabled !== false,
          visibility: c.visibility === "customer" ? "customer" : "internal",
        })),
      };
      await ObaraBackend?.admin?.upsertPricingProfile?.(payload);
      window.notifySuccess?.("Pricing profile saved", payload.code);
      setEditing(null);
      load();
    } catch (e: any) {
      const msg = e?.message || String(e);
      setErr(msg);
      window.notifyError?.("Could not save profile", msg);
    } finally { setBusy(false); }
  };

  const del = async (p: Profile) => {
    if (!p.id || p.tenant_id == null) return; // globals are protected
    if (typeof confirm === "function" && !confirm(`Delete profile "${p.code}"?`)) return;
    try {
      await ObaraBackend?.admin?.deletePricingProfile?.(p.id);
      load();
    } catch (e: any) {
      setErr(e?.message || String(e));
    }
  };

  if (editing) {
    return (
      <Card title={isClone ? "Customize profile (creates a tenant override)" : "Edit pricing profile"}
        eyebrow="Toggle components, edit rates, set the margin floor">
        {err && <Banner kind="bad" title="Error">{err}</Banner>}
        {isClone && <Banner kind="info" title="Tenant override">Saving creates a tenant-specific copy that shadows the global default of the same code.</Banner>}
        <div className="row" style={{ gap: 16, flexWrap: "wrap", marginBottom: 12 }}>
          <label className="mono-sm" style={{ display: "flex", flexDirection: "column", gap: 4 }}>Code
            <input className="input mono" aria-label="Profile code" value={editing.code || ""} onChange={(e) => setField("code", e.target.value)} /></label>
          <label className="mono-sm" style={{ display: "flex", flexDirection: "column", gap: 4 }}>Label
            <input className="input" aria-label="Profile label" value={editing.label || ""} onChange={(e) => setField("label", e.target.value)} style={{ width: 240 }} /></label>
          <label className="mono-sm" style={{ display: "flex", flexDirection: "column", gap: 4 }}>Margin floor (fraction)
            <input className="input mono r" aria-label="Margin floor" type="number" step="0.01" value={editing.margin_floor_pct ?? ""} onChange={(e) => setField("margin_floor_pct", e.target.value)} style={{ width: 110 }} /></label>
          <label className="mono-sm" style={{ display: "flex", flexDirection: "column", gap: 4 }}>FX stale days
            <input className="input mono r" aria-label="FX stale days" type="number" value={editing.fx_stale_days ?? ""} onChange={(e) => setField("fx_stale_days", e.target.value)} style={{ width: 90 }} /></label>
        </div>

        <table className="tbl" style={{ fontSize: 12 }}>
          <thead><tr>
            <th>On</th><th>Code</th><th>Label</th><th>Kind</th><th>Base</th>
            <th className="r">Rate</th><th className="r">Amount</th><th>Cur</th><th>Loaded</th><th>Shown</th><th></th>
          </tr></thead>
          <tbody>
            {(editing.components || []).map((c: Comp, i: number) => (
              <tr key={i}>
                <td><input type="checkbox" aria-label={"enabled " + c.code} checked={c.enabled !== false} onChange={(e) => setComp(i, "enabled", e.target.checked)} /></td>
                <td><input className="input mono" style={{ width: 120 }} value={c.code || ""} onChange={(e) => setComp(i, "code", e.target.value)} /></td>
                <td><input className="input" style={{ width: 150 }} value={c.label || ""} onChange={(e) => setComp(i, "label", e.target.value)} /></td>
                <td>
                  <select className="select" aria-label={"kind " + c.code} value={c.kind} onChange={(e) => setComp(i, "kind", e.target.value)}>
                    {KIND_OPTIONS.map((k) => <option key={k} value={k}>{k}</option>)}
                  </select>
                </td>
                <td><input className="input mono" style={{ width: 100 }} value={c.base_ref || ""} onChange={(e) => setComp(i, "base_ref", e.target.value)} /></td>
                <td className="r"><input className="input mono r" style={{ width: 80 }} type="number" step="0.0001" value={c.rate ?? ""} onChange={(e) => setComp(i, "rate", e.target.value)} /></td>
                <td className="r"><input className="input mono r" style={{ width: 90 }} type="number" step="0.01" value={c.amount ?? ""} onChange={(e) => setComp(i, "amount", e.target.value)} /></td>
                <td>
                  <select className="select" aria-label={"currency " + c.code} value={c.currency || "base"} onChange={(e) => setComp(i, "currency", e.target.value)}>
                    <option value="base">base</option><option value="supplier">supplier</option>
                  </select>
                </td>
                <td><input type="checkbox" aria-label={"loaded " + c.code} checked={!!c.use_loaded_rate} onChange={(e) => setComp(i, "use_loaded_rate", e.target.checked)} /></td>
                <td>
                  <select className="select" aria-label={"visibility " + c.code} value={c.visibility || "internal"} onChange={(e) => setComp(i, "visibility", e.target.value)}>
                    <option value="internal">internal</option><option value="customer">customer</option>
                  </select>
                </td>
                <td><Btn sm kind="ghost" onClick={() => removeComp(i)}>x</Btn></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="row" style={{ justifyContent: "space-between", marginTop: 12 }}>
          <Btn sm kind="ghost" onClick={addComp}>+ Add component</Btn>
          <div className="row" style={{ gap: 8 }}>
            <Btn sm kind="ghost" onClick={() => setEditing(null)}>Cancel</Btn>
            <Btn sm kind="primary" disabled={busy} onClick={save}>{busy ? "Saving..." : "Save profile"}</Btn>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card title="Pricing profiles" eyebrow="Configurable price-composition pipelines per tenant" flush>
      {err && <Banner kind="bad" title="Could not load profiles">{err}</Banner>}
      <table className="tbl">
        <thead><tr>
          <th>Code</th><th>Label</th><th>Scope</th><th className="r">Components</th><th className="r">Floor</th><th></th>
        </tr></thead>
        <tbody>
          {profiles == null ? (
            <tr><td colSpan={6} className="muted">Loading...</td></tr>
          ) : profiles.length === 0 ? (
            <tr><td colSpan={6} className="muted">No profiles. Apply migration 135 to seed the defaults.</td></tr>
          ) : profiles.map((p) => {
            const isGlobal = p.tenant_id == null;
            return (
              <tr key={p.id}>
                <td className="mono-sm">{p.code}</td>
                <td>{p.label}</td>
                <td><Chip k={isGlobal ? "ghost" : "good"}>{isGlobal ? "Global default" : "Tenant"}</Chip></td>
                <td className="r mono">{(p.components || []).length}</td>
                <td className="r mono">{p.margin_floor_pct != null ? (Number(p.margin_floor_pct) * 100).toFixed(1) + "%" : "-"}</td>
                <td className="r">
                  <div className="row" style={{ gap: 6, justifyContent: "flex-end" }}>
                    <Btn sm kind="ghost" onClick={() => startEdit(p, isGlobal)}>{isGlobal ? "Customize" : "Edit"}</Btn>
                    {!isGlobal && <Btn sm kind="ghost" onClick={() => del(p)}>Delete</Btn>}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
};

export default PricingProfilesAdmin;
