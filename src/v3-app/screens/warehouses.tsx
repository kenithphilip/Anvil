import React, { useState } from "react";
import { useFetch } from "../lib/helpers";
import { Btn, Card, Chip, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { AnvilBackend } from "../lib/api";

// ============================================================
// ANVIL v3 — Warehouses (MEIO step 4d, Phase A)
// Internal stocking-location master. The planning engine ignores
// location until MEIO is enabled for the tenant (Phase B).
// Reads/writes AnvilBackend.locations; reached at #/warehouses.
// ============================================================

const TYPES = ["warehouse", "plant", "depot", "store", "other"];
const emptyForm = () => ({ id: null as string | null, location_code: "", name: "", location_type: "warehouse", gstin: "", state_code: "", city: "", pincode: "", is_default: false, active: true, notes: "" });

const WiredWarehouses = () => {
  const locs = useFetch(() => AnvilBackend?.locations?.list?.() || Promise.resolve({ locations: [] }), []);
  const [form, setForm] = useState(emptyForm);
  const [busy, setBusy] = useState(false);
  const list: any[] = (locs.data as any)?.locations || [];
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const editRow = (l) => setForm({
    id: l.id, location_code: l.location_code || "", name: l.name || "", location_type: l.location_type || "warehouse",
    gstin: l.gstin || "", state_code: l.state_code || "", city: l.city || "", pincode: l.pincode || "",
    is_default: !!l.is_default, active: l.active !== false, notes: l.notes || "",
  });
  const save = async () => {
    const code = form.location_code.trim();
    if (!code) { window.notifyError?.("Location code is required."); return; }
    // Creating with a code that already exists would collide; load it for editing
    // instead of silently overwriting.
    if (!form.id) {
      const dup = list.find((l) => String(l.location_code || "").toUpperCase() === code.toUpperCase());
      if (dup) { editRow(dup); window.notifyError?.(`Code "${code}" already exists`, "Loaded it for editing."); return; }
    }
    setBusy(true);
    try {
      await AnvilBackend.locations.upsert({ ...form, location_code: form.location_code.trim() });
      window.notifySuccess?.("Saved", "Warehouse saved.");
      setForm(emptyForm()); locs.reload();
    } catch (e) { window.notifyError?.(e.message || String(e)); } finally { setBusy(false); }
  };
  const del = async (id) => {
    if (!window.confirm("Delete this warehouse?")) return;
    try { await AnvilBackend.locations.remove(id); window.notifySuccess?.("Deleted", "Warehouse removed."); locs.reload(); }
    catch (e) { window.notifyError?.(e.message || String(e)); }
  };

  const fld = (label, ctrl) => (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span className="mono-sm" style={{ color: "var(--ink-3)", fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.04 }}>{label}</span>
      {ctrl}
    </label>
  );

  return (
    <>
      <WSTitle
        eyebrow="Data · Inventory · Warehouses"
        title="Warehouses"
        meta={`${list.length} location${list.length === 1 ? "" : "s"} · stocking-location master (MEIO)`}
        right={<Btn icon kind="ghost" sm onClick={() => locs.reload()} title="Refresh">{Icon.cycle}</Btn>}
      />
      <div className="ws-content">
        <div style={{ display: "grid", gridTemplateColumns: "minmax(320px, 38%) 1fr", gap: 14, alignItems: "start" }}>
          <Card title={form.id ? "Edit warehouse" : "Add warehouse"} eyebrow="stocking location">
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              {fld("Code *", <input className="input mono" value={form.location_code} onChange={(e) => set("location_code", e.target.value)} aria-label="Location code" />)}
              {fld("Name", <input className="input" value={form.name} onChange={(e) => set("name", e.target.value)} aria-label="Name" />)}
              {fld("Type", <select className="select" value={form.location_type} onChange={(e) => set("location_type", e.target.value)} aria-label="Type">{TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</select>)}
              {fld("GSTIN", <input className="input mono" value={form.gstin} onChange={(e) => set("gstin", e.target.value)} aria-label="GSTIN" />)}
              {fld("State code", <input className="input mono" value={form.state_code} onChange={(e) => set("state_code", e.target.value)} aria-label="State code" />)}
              {fld("City", <input className="input" value={form.city} onChange={(e) => set("city", e.target.value)} aria-label="City" />)}
            </div>
            <label style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 10 }}><input type="checkbox" checked={form.is_default} onChange={(e) => set("is_default", e.target.checked)} aria-label="Default" /> <span className="mono-sm">Default location</span></label>
            <label style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 6 }}><input type="checkbox" checked={form.active} onChange={(e) => set("active", e.target.checked)} aria-label="Active" /> <span className="mono-sm">Active</span></label>
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <Btn kind="primary" sm disabled={busy} onClick={save}>{busy ? "Saving…" : (form.id ? "Save" : "Add warehouse")}</Btn>
              {form.id && <Btn kind="ghost" sm onClick={() => setForm(emptyForm())}>New</Btn>}
            </div>
            <div className="fieldnote" style={{ marginTop: 10 }}>The MEIO stocking-location master. Per-location planning stays off until MEIO is enabled for the tenant.</div>
          </Card>

          <Card title="Warehouses" eyebrow="stocking locations" flush>
            {locs.loading && !locs.data ? (
              <div className="body" style={{ padding: 16 }}>Loading…</div>
            ) : list.length === 0 ? (
              <div className="body" style={{ padding: 18, textAlign: "center", color: "var(--ink-3)" }}>No warehouses yet. Add one on the left.</div>
            ) : (
              <table className="tbl">
                <thead><tr><th>Code</th><th>Name</th><th>Type</th><th>GST · State</th><th>Default</th><th style={{ width: 40 }}></th></tr></thead>
                <tbody>
                  {list.map((l) => (
                    <tr key={l.id} style={{ cursor: "pointer" }} onClick={() => editRow(l)}>
                      <td className="mono-sm">{l.location_code} {l.active === false && <Chip k="warn">inactive</Chip>}</td>
                      <td>{l.name || "—"}</td>
                      <td className="mono-sm">{l.location_type || "—"}</td>
                      <td className="mono-sm">{[l.gstin, l.state_code].filter(Boolean).join(" · ") || "—"}</td>
                      <td>{l.is_default ? <Chip k="ok">default</Chip> : ""}</td>
                      <td><Btn icon kind="ghost" sm onClick={(e) => { e.stopPropagation(); del(l.id); }} title="Delete">{Icon.x}</Btn></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>
      </div>
    </>
  );
};

export default WiredWarehouses;
