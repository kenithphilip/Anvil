import React, { useEffect, useState } from "react";
import { ageLabel } from "../lib/helpers";
import { Banner, Btn, Card, Chip, WSTabs, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { AnvilBackend } from "../lib/api";

// ============================================================
// ANVIL v3 — Internal SOs CRUD overlay
// Adds per-type tab strip + create form on top of the read-only
// list in wired-internal-sos.jsx.
// ============================================================

const ISO_TYPES = [
  { id: "FOC_SUPPLY",           label: "FOC Supply",          k: "good"  },
  { id: "WARRANTY_REPLACEMENT", label: "Warranty replacement", k: "info"  },
  { id: "PRODUCT_TRIAL",        label: "Product trial",       k: "live"  },
  { id: "EXPECTED_PO",          label: "Expected PO",         k: "warn"  },
  { id: "INTERNAL_TRANSFER",    label: "Internal transfer",   k: "plum"  },
];

const ISO_FORM_BLANK = (type?: string): any => ({
  iso_type: type || "FOC_SUPPLY",
  reference: "",
  customer_id: "",
  customer_location_id: "",
  notes: "",
  status: "DRAFT",
  expected_value_inr: "",
  iso_lines: [{ part_no: "", description: "", qty: 1, uom: "Nos" }],
});

const isoReadParams = () => {
  const hash = window.location.hash || "";
  const q = hash.split("?")[1];
  return new URLSearchParams(q || "");
};

const WiredInternalSosCRUD = () => {
  const { useState: u, useEffect: e } = React;
  const params = isoReadParams();
  const editId = params.get("id");
  const isNew = params.get("new") === "1";
  const presetType = params.get("type") || "FOC_SUPPLY";

  const [list, setList] = u({ rows: [], loading: true, error: null });
  const [customers, setCustomers] = u([]);
  const [active, setActive] = u("all");
  const [editing, setEditing] = u(null);
  const [form, setForm] = u(null);
  const [busy, setBusy] = u(false);

  const reload = () => {
    setList((s) => ({ ...s, loading: true }));
    Promise.resolve(AnvilBackend?.sales?.listInternalSos?.() || { rows: [] })
      .then((r) => {
        const rows = Array.isArray(r) ? r : (r?.internal_sales_orders || r?.rows || []);
        setList({ rows, loading: false, error: null });
      })
      .catch((err) => setList({ rows: [], loading: false, error: err }));
  };

  e(reload, []);
  e(() => {
    Promise.resolve(AnvilBackend?.customers?.list?.() || [])
      .then((r) => setCustomers(Array.isArray(r) ? r : (r?.rows || [])));
  }, []);

  e(() => {
    if (isNew) {
      setForm(ISO_FORM_BLANK(presetType));
      setEditing("__new__");
      return;
    }
    if (editId) {
      const found = list.rows.find((r) => r.id === editId);
      if (found) {
        setForm({ ...ISO_FORM_BLANK(), ...found });
        setEditing(editId);
      }
      return;
    }
    setForm(null);
    setEditing(null);
  }, [editId, isNew, presetType, list.rows.length]);

  const closeForm = () => {
    setForm(null);
    setEditing(null);
    window.location.hash = "#/internal";
  };

  const updateLine = (i, field, value) => {
    const lines = [...(form.iso_lines || [])];
    lines[i] = { ...lines[i], [field]: value };
    setForm({ ...form, iso_lines: lines });
  };

  const addLine = () => {
    setForm({ ...form, iso_lines: [...(form.iso_lines || []), { part_no: "", description: "", qty: 1, uom: "Nos" }] });
  };

  const removeLine = (i) => {
    const lines = (form.iso_lines || []).filter((_, j) => j !== i);
    setForm({ ...form, iso_lines: lines });
  };

  const submit = async () => {
    if (!form) return;
    if (!form.reference?.trim()) {
      window.notifyError?.("Reference is required");
      return;
    }
    if (!form.customer_id) {
      window.notifyError?.("Customer is required");
      return;
    }
    setBusy(true);
    try {
      const payload = { ...form };
      if (payload.expected_value_inr) payload.expected_value_inr = Number(payload.expected_value_inr);
      if (editing && editing !== "__new__") payload.id = editing;
      const fn = (editing && editing !== "__new__")
        ? AnvilBackend?.sales?.updateInternalSo
        : AnvilBackend?.sales?.createInternalSo;
      let result;
      if (typeof fn === "function") {
        result = await fn(payload);
      } else {
        const cfg = (AnvilBackend?.getConfig?.() || {});
        const session = (AnvilBackend?.getSession?.() || null);
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (session?.access_token) headers.Authorization = "Bearer " + session.access_token;
        if (cfg.tenantId) headers["x-obara-tenant"] = cfg.tenantId;
        const url = cfg.url.replace(/\/+$/, "") + "/api/sales/internal_so";
        const resp = await fetch(url, {
          method: editing && editing !== "__new__" ? "PATCH" : "POST",
          headers,
          body: JSON.stringify(payload),
        });
        if (!resp.ok) throw new Error("HTTP " + resp.status + ": " + (await resp.text()));
        result = await resp.json();
      }
      window.notifySuccess?.(editing === "__new__" ? "Internal SO created" : "Internal SO updated", result?.iso?.reference || form.reference);
      reload();
      closeForm();
    } catch (err) {
      window.notifyError?.("Save failed", err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id, ref) => {
    if (!window.confirm(`Delete internal SO ${ref || id}?`)) return;
    setBusy(true);
    try {
      const fn = AnvilBackend?.sales?.deleteInternalSo;
      if (typeof fn === "function") {
        await fn(id);
      } else {
        const cfg = (AnvilBackend?.getConfig?.() || {});
        const session = (AnvilBackend?.getSession?.() || null);
        const headers: Record<string, string> = {};
        if (session?.access_token) headers.Authorization = "Bearer " + session.access_token;
        if (cfg.tenantId) headers["x-obara-tenant"] = cfg.tenantId;
        const url = cfg.url.replace(/\/+$/, "") + "/api/sales/internal_so?id=" + encodeURIComponent(id);
        await fetch(url, { method: "DELETE", headers });
      }
      window.notifySuccess?.("Internal SO deleted");
      reload();
      closeForm();
    } catch (err) {
      window.notifyError?.("Delete failed", err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const tabs = [
    { id: "all", label: "All", match: () => true },
    ...ISO_TYPES.map((t) => ({ id: t.id, label: t.label, match: (r) => r.iso_type === t.id })),
  ];
  const matcher = tabs.find((t) => t.id === active)?.match || (() => true);
  const filtered = list.rows.filter(matcher);
  const counts = Object.fromEntries(tabs.map((t) => [t.id, list.rows.filter(t.match).length]));

  const customerName = (id) => customers.find((c) => c.id === id)?.customer_name || (id || "—");

  return (
    <>
      <WSTitle
        eyebrow="Workflows · Internal SOs"
        title="Internal sales orders"
        meta={`${list.rows.length} total · ${counts.FOC_SUPPLY || 0} FOC · ${counts.WARRANTY_REPLACEMENT || 0} warranty · ${counts.PRODUCT_TRIAL || 0} trials`}
        right={<>
          <Btn icon kind="ghost" sm onClick={reload} title="Refresh">{Icon.cycle}</Btn>
          <Btn sm kind="primary" onClick={() => window.location.hash = "#/internal?new=1&type=" + (active === "all" ? "FOC_SUPPLY" : active)}>{Icon.plus} New {active === "all" ? "" : ISO_TYPES.find(t => t.id === active)?.label || ""}</Btn>
        </>}
      />
      <WSTabs tabs={tabs.map((t) => ({ id: t.id, label: t.label, count: counts[t.id] }))} active={active} onChange={setActive} />

      <div className="ws-content">
        {list.error && (
          <Banner kind="bad" icon={Icon.alert} title="Could not load internal SOs">
            <span className="mono-sm">{String(list.error.message || list.error)}</span>
          </Banner>
        )}

        {form && (
          <Card title={editing === "__new__" ? "New internal SO" : "Edit " + form.reference}
                eyebrow={ISO_TYPES.find(t => t.id === form.iso_type)?.label || "form"}
                right={<Btn sm icon kind="ghost" onClick={closeForm} aria-label="Close">{Icon.x}</Btn>}>
            <div className="form-grid">
              <div>
                <label htmlFor="iso-type" className="label">Type *</label>
                <select id="iso-type" className="select" value={form.iso_type} onChange={(ev) => setForm({ ...form, iso_type: ev.target.value })}>
                  {ISO_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="iso-ref" className="label">Reference *</label>
                <input id="iso-ref" className="input mono" value={form.reference} onChange={(ev) => setForm({ ...form, reference: ev.target.value })} />
              </div>
              <div>
                <label htmlFor="iso-customer" className="label">Customer *</label>
                <select id="iso-customer" className="select" value={form.customer_id} onChange={(ev) => setForm({ ...form, customer_id: ev.target.value })}>
                  <option value="">Pick customer…</option>
                  {customers.map((c) => <option key={c.id} value={c.id}>{c.customer_name || c.customer_key}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="iso-status" className="label">Status</label>
                <select id="iso-status" className="select" value={form.status} onChange={(ev) => setForm({ ...form, status: ev.target.value })}>
                  {["DRAFT", "ISSUED", "DELIVERED", "CLOSED", "CANCELLED"].map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="iso-value" className="label">Expected value INR (optional)</label>
                <input id="iso-value" type="number" className="input mono" value={form.expected_value_inr || ""} onChange={(ev) => setForm({ ...form, expected_value_inr: ev.target.value })} />
              </div>
              <div className="span-2">
                <label htmlFor="iso-notes" className="label">Notes</label>
                <textarea id="iso-notes" className="input" rows={2} value={form.notes || ""} onChange={(ev) => setForm({ ...form, notes: ev.target.value })} />
              </div>
            </div>

            <div className="divider" />

            <div className="row" style={{ marginBottom: 8 }}>
              <span className="h2">Lines</span>
              <span style={{ flex: 1 }} />
              <Btn sm kind="ghost" onClick={addLine}>{Icon.plus} Add line</Btn>
            </div>

            <table className="tbl">
              <thead><tr>
                <th>Part no</th>
                <th>Description</th>
                <th className="r">Qty</th>
                <th>UoM</th>
                <th></th>
              </tr></thead>
              <tbody>
                {(form.iso_lines || []).map((ln, i) => (
                  <tr key={i}>
                    <td><input className="input mono" value={ln.part_no || ""} onChange={(ev) => updateLine(i, "part_no", ev.target.value)} aria-label={`Line ${i + 1} part number`} style={{ height: 26 }} /></td>
                    <td><input className="input" value={ln.description || ""} onChange={(ev) => updateLine(i, "description", ev.target.value)} aria-label={`Line ${i + 1} description`} style={{ height: 26 }} /></td>
                    <td className="r"><input type="number" className="input mono r" value={ln.qty || 0} onChange={(ev) => updateLine(i, "qty", Number(ev.target.value))} aria-label={`Line ${i + 1} qty`} style={{ height: 26, textAlign: "right" }} /></td>
                    <td><input className="input mono" value={ln.uom || ""} onChange={(ev) => updateLine(i, "uom", ev.target.value)} aria-label={`Line ${i + 1} uom`} style={{ height: 26, width: 80 }} /></td>
                    <td><Btn sm icon kind="ghost" onClick={() => removeLine(i)} aria-label="Remove line">{Icon.x}</Btn></td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="row" style={{ gap: 8, marginTop: 12 }}>
              <Btn kind="primary" disabled={busy} onClick={submit}>{busy ? "Saving…" : editing === "__new__" ? "Create" : "Save"}</Btn>
              <Btn kind="ghost" onClick={closeForm}>Cancel</Btn>
              <span style={{ flex: 1 }} />
              {editing && editing !== "__new__" && (
                <Btn kind="danger" disabled={busy} onClick={() => remove(editing, form.reference)}>{Icon.x} Delete</Btn>
              )}
            </div>
          </Card>
        )}

        <Card flush>
          {list.loading ? (
            <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
              {list.rows.length === 0 ? "No internal SOs yet." :
                <>No internal SOs in this view. <button type="button" onClick={() => setActive("all")} className="link-btn" style={{ color: "var(--ink)", cursor: "pointer", textDecoration: "underline" }}>show all</button></>}
            </div>
          ) : (
            <table className="tbl">
              <thead><tr>
                <th>Reference</th>
                <th>Type</th>
                <th>Customer</th>
                <th className="r">Lines</th>
                <th>Status</th>
                <th>Created</th>
                <th></th>
              </tr></thead>
              <tbody>
                {filtered.slice(0, 200).map((r) => {
                  const tdef = ISO_TYPES.find((t) => t.id === r.iso_type);
                  return (
                    <tr key={r.id}>
                      <td className="mono"><span className="pri">{r.reference}</span></td>
                      <td><Chip k={tdef?.k || "ghost"}>{tdef?.label || r.iso_type}</Chip></td>
                      <td className="mono-sm">{customerName(r.customer_id)}</td>
                      <td className="r mono">{(r.iso_lines || []).length || "—"}</td>
                      <td><Chip k={r.status === "CLOSED" || r.status === "DELIVERED" ? "good" : r.status === "CANCELLED" ? "bad" : "ghost"}>{(r.status || "DRAFT").toLowerCase()}</Chip></td>
                      <td className="mono-sm">{ageLabel(r.created_at)}</td>
                      <td>
                        <div className="row" style={{ gap: 4, justifyContent: "flex-end" }}>
                          <Btn sm kind="ghost" onClick={() => window.location.hash = `#/internal?id=${r.id}`}>{Icon.eye}</Btn>
                          <Btn sm kind="ghost" onClick={() => remove(r.id, r.reference)} disabled={busy}>{Icon.x}</Btn>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </>
  );
};


export default WiredInternalSosCRUD;
