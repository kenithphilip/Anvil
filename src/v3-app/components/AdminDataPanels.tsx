// Admin Center data/config panels — extracted verbatim from screens/admin.tsx
// (item fields, document templates, freight rates, pricing, vendor codes,
// customer parts, customer terms). Split out to keep admin.tsx maintainable.

import React, { useState, useEffect } from "react";
import { Banner, Btn, Card, Chip } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { adminCrudFetch, parseCSV } from "../lib/admin-shared";

export const ItemFieldsPanel: React.FC = () => {
  const [defs, setDefs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<any>(null);
  const [draft, setDraft] = useState<any>({
    field_label: "",
    field_type: "text",
    field_group: "engineering",
    field_required: false,
    is_visible_invoice: false,
    is_visible_po: false,
    is_visible_master: true,
  });

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await adminCrudFetch("/api/admin/item_field_definitions");
      setDefs(r.definitions || []);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { reload(); }, []);

  const save = async () => {
    if (!draft.field_label?.trim()) {
      window.notifyWarn?.("Field label required", "Give the field a human-readable label first.");
      return;
    }
    try {
      await adminCrudFetch("/api/admin/item_field_definitions", { method: "POST", body: draft });
      window.notifySuccess?.("Field saved", draft.field_label);
      setDraft({
        field_label: "",
        field_type: "text",
        field_group: "engineering",
        field_required: false,
        is_visible_invoice: false,
        is_visible_po: false,
        is_visible_master: true,
      });
      await reload();
    } catch (e: any) {
      window.notifyError?.("Could not save field", e?.message || String(e));
    }
  };

  const disableField = async (id: string) => {
    if (!window.confirm("Disable this field? Historical values are preserved. Use ?hard=1 for a destructive delete.")) return;
    try {
      await adminCrudFetch("/api/admin/item_field_definitions?id=" + encodeURIComponent(id), { method: "DELETE" });
      await reload();
    } catch (e: any) {
      window.notifyError?.("Could not disable field", e?.message || String(e));
    }
  };

  if (loading) return <Card><div className="body">Loading custom item fields...</div></Card>;
  if (error) return (
    <Banner kind="bad" icon={Icon.alert} title="Could not load item fields" action={<Btn sm onClick={reload}>Retry</Btn>}>
      <span className="mono-sm">{String((error as any)?.message || error)}</span>
    </Banner>
  );

  return (
    <>
      <Card title="Add or update a custom field" eyebrow="per-tenant Item Master extension">
        <div className="row" style={{ gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div>
            <label className="mono-sm" style={{ color: "var(--ink-3)", display: "block", marginBottom: 4 }}>Label</label>
            <input className="input" value={draft.field_label} onChange={(e) => setDraft({ ...draft, field_label: e.target.value })} placeholder="e.g., Gun Number" />
          </div>
          <div>
            <label className="mono-sm" style={{ color: "var(--ink-3)", display: "block", marginBottom: 4 }}>Type</label>
            <select className="select" value={draft.field_type} onChange={(e) => setDraft({ ...draft, field_type: e.target.value })}>
              <option value="text">Text</option>
              <option value="number">Number</option>
              <option value="boolean">Yes / No</option>
              <option value="select">Select (dropdown)</option>
              <option value="date">Date</option>
              <option value="url">URL</option>
              <option value="file">File</option>
            </select>
          </div>
          <div>
            <label className="mono-sm" style={{ color: "var(--ink-3)", display: "block", marginBottom: 4 }}>Group</label>
            <select className="select" value={draft.field_group} onChange={(e) => setDraft({ ...draft, field_group: e.target.value })}>
              <option value="identification">Identification</option>
              <option value="classification">Classification</option>
              <option value="tax">Tax</option>
              <option value="inventory">Inventory</option>
              <option value="engineering">Engineering</option>
              <option value="logistics">Logistics</option>
              <option value="custom">Custom</option>
            </select>
          </div>
          <label className="mono-sm row" style={{ gap: 6 }}>
            <input type="checkbox" checked={!!draft.field_required} onChange={(e) => setDraft({ ...draft, field_required: e.target.checked })} /> required
          </label>
          <label className="mono-sm row" style={{ gap: 6 }}>
            <input type="checkbox" checked={!!draft.is_visible_master} onChange={(e) => setDraft({ ...draft, is_visible_master: e.target.checked })} /> show on master
          </label>
          <label className="mono-sm row" style={{ gap: 6 }}>
            <input type="checkbox" checked={!!draft.is_visible_invoice} onChange={(e) => setDraft({ ...draft, is_visible_invoice: e.target.checked })} /> show on invoice
          </label>
          <label className="mono-sm row" style={{ gap: 6 }}>
            <input type="checkbox" checked={!!draft.is_visible_po} onChange={(e) => setDraft({ ...draft, is_visible_po: e.target.checked })} /> show on PO
          </label>
          <Btn sm kind="primary" onClick={save}>{Icon.plus} save field</Btn>
        </div>
        {draft.field_type === "select" && (
          <div style={{ marginTop: 8 }}>
            <label className="mono-sm" style={{ color: "var(--ink-3)" }}>Select options (one per line, format: value or value=label)</label>
            <textarea
              className="input"
              rows={4}
              style={{ width: "100%" }}
              value={(draft.field_options || []).map((o: any) => o.value === o.label ? o.value : `${o.value}=${o.label}`).join("\n")}
              onChange={(e) => {
                const lines = e.target.value.split("\n").map((s) => s.trim()).filter(Boolean);
                const options = lines.map((line) => {
                  const [v, l] = line.split("=");
                  return { value: v.trim(), label: (l || v).trim() };
                });
                setDraft({ ...draft, field_options: options });
              }}
            />
          </div>
        )}
      </Card>

      <Card flush>
        {defs.length === 0 ? (
          <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
            No custom item fields defined yet. Add one above to extend the item master schema for your tenant.
          </div>
        ) : (
          <table className="tbl">
            <thead><tr>
              <th>Key</th><th>Label</th><th>Type</th><th>Group</th>
              <th className="r">Required</th><th className="r">Master</th><th className="r">Invoice</th><th className="r">PO</th>
              <th className="r">Status</th><th></th>
            </tr></thead>
            <tbody>
              {defs.map((d) => (
                <tr key={d.id}>
                  <td className="mono"><span className="pri">{d.field_key}</span></td>
                  <td>{d.field_label}</td>
                  <td className="mono-sm">{d.field_type}</td>
                  <td className="mono-sm">{d.field_group}</td>
                  <td className="r">{d.field_required ? "yes" : "-"}</td>
                  <td className="r">{d.is_visible_master ? "yes" : "-"}</td>
                  <td className="r">{d.is_visible_invoice ? "yes" : "-"}</td>
                  <td className="r">{d.is_visible_po ? "yes" : "-"}</td>
                  <td className="r"><Chip k={d.is_active ? "good" : "ghost"}>{d.is_active ? "active" : "disabled"}</Chip></td>
                  <td className="r">
                    {d.is_active && <Btn sm kind="ghost" onClick={() => disableField(d.id)}>disable</Btn>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
};

// Per-tenant document templates editor (migration 106). Lets the
// tenant carry their own quotation / SO / PO / invoice / e-way bill
// boilerplate without code edits. Each doc type can have many
// templates with at most one default.
export const DocumentTemplatesPanel: React.FC = () => {
  const [templates, setTemplates] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<any>(null);
  const [editing, setEditing] = useState<any | null>(null);

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await adminCrudFetch("/api/admin/document_templates");
      setTemplates(r.templates || []);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { reload(); }, []);

  const save = async () => {
    if (!editing?.template_name?.trim()) {
      window.notifyWarn?.("Template name required", "Give the template a label first.");
      return;
    }
    if (!editing?.doc_type) {
      window.notifyWarn?.("Document type required", "Pick a doc type (quotation, sales_order, etc.)");
      return;
    }
    try {
      await adminCrudFetch("/api/admin/document_templates", { method: "POST", body: editing });
      window.notifySuccess?.("Template saved", editing.template_name);
      setEditing(null);
      await reload();
    } catch (e: any) {
      window.notifyError?.("Could not save template", e?.message || String(e));
    }
  };

  if (loading) return <Card><div className="body">Loading templates...</div></Card>;
  if (error) return (
    <Banner kind="bad" icon={Icon.alert} title="Could not load document templates" action={<Btn sm onClick={reload}>Retry</Btn>}>
      <span className="mono-sm">{String((error as any)?.message || error)}</span>
    </Banner>
  );

  return (
    <>
      <div className="row" style={{ justifyContent: "flex-end", marginBottom: 8 }}>
        <Btn sm kind="primary" onClick={() => setEditing({ doc_type: "quotation", template_name: "", version: 1, is_active: true, is_default: false })}>
          {Icon.plus} New template
        </Btn>
      </div>
      <Card flush>
        {templates.length === 0 ? (
          <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
            No document templates yet. Click <b>New template</b> to add one.
          </div>
        ) : (
          <table className="tbl">
            <thead><tr>
              <th>Doc type</th><th>Name</th><th>Form code</th><th className="r">Version</th>
              <th className="r">Active</th><th className="r">Default</th><th></th>
            </tr></thead>
            <tbody>
              {templates.map((t) => (
                <tr key={t.id} style={{ cursor: "pointer" }} onClick={() => setEditing({ ...t })}>
                  <td className="mono-sm">{t.doc_type}</td>
                  <td><span className="pri">{t.template_name}</span></td>
                  <td className="mono-sm">{t.form_code || "-"}</td>
                  <td className="r mono">{t.version}</td>
                  <td className="r">{t.is_active ? "yes" : "-"}</td>
                  <td className="r">{t.is_default ? <Chip k="good">default</Chip> : "-"}</td>
                  <td className="r"><Btn sm kind="ghost" onClick={(e) => { e.stopPropagation(); setEditing({ ...t }); }}>edit</Btn></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {editing && (
        <div role="dialog" aria-modal="true" style={{ position: "fixed", inset: 0, background: "rgba(8,10,12,0.55)", display: "flex", justifyContent: "flex-end", zIndex: 200 }} onClick={() => setEditing(null)}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: "min(800px, 100vw)", height: "100vh", background: "var(--bg)", borderLeft: "1px solid var(--line)", padding: 18, overflowY: "auto" }}>
            <div className="row" style={{ alignItems: "center", marginBottom: 12 }}>
              <div style={{ flex: 1 }}>
                <div className="mono-sm" style={{ color: "var(--ink-3)" }}>Admin . Document template</div>
                <div style={{ fontSize: 16, fontWeight: 600 }}>{editing.id ? editing.template_name : "New template"}</div>
              </div>
              <Btn sm kind="ghost" onClick={() => setEditing(null)}>close</Btn>
            </div>
            <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
              <div>
                <label className="mono-sm">Doc type</label>
                <select className="select" value={editing.doc_type} onChange={(e) => setEditing({ ...editing, doc_type: e.target.value })}>
                  <option value="quotation">Quotation</option>
                  <option value="sales_order">Sales order</option>
                  <option value="purchase_order">Purchase order</option>
                  <option value="tax_invoice">Tax invoice</option>
                  <option value="proforma_invoice">Proforma invoice</option>
                  <option value="credit_note">Credit note</option>
                  <option value="eway_bill">E-way bill</option>
                  <option value="delivery_note">Delivery note</option>
                </select>
              </div>
              <div>
                <label className="mono-sm">Template name</label>
                <input className="input" value={editing.template_name || ""} onChange={(e) => setEditing({ ...editing, template_name: e.target.value })} />
              </div>
              <div>
                <label className="mono-sm">Form code</label>
                <input className="input mono" value={editing.form_code || ""} onChange={(e) => setEditing({ ...editing, form_code: e.target.value })} placeholder="e.g., OI/F/SP/19/R-00/020226" />
              </div>
              <div>
                <label className="mono-sm">Version</label>
                <input className="input mono r" type="number" value={editing.version || 1} onChange={(e) => setEditing({ ...editing, version: Number(e.target.value) })} />
              </div>
              <label className="mono-sm row" style={{ gap: 6, alignItems: "center" }}>
                <input type="checkbox" checked={!!editing.is_active} onChange={(e) => setEditing({ ...editing, is_active: e.target.checked })} /> active
              </label>
              <label className="mono-sm row" style={{ gap: 6, alignItems: "center" }}>
                <input type="checkbox" checked={!!editing.is_default} onChange={(e) => setEditing({ ...editing, is_default: e.target.checked })} /> default
              </label>
            </div>
            {[
              ["header_block", "Header block"],
              ["footer_block", "Footer block"],
              ["signatory_block", "Authorised signatory block"],
              ["standard_message", "Standard message (e.g., 7-day discrepancy notice)"],
              ["warranty_clause", "Warranty clause"],
              ["penalty_clause", "Penalty clause"],
              ["cancellation_clause", "Cancellation clause"],
              ["force_majeure_clause", "Force majeure clause"],
              ["payment_terms_clause", "Payment terms clause"],
              ["delivery_terms_clause", "Delivery terms clause"],
            ].map(([k, label]) => (
              <div key={k} style={{ marginTop: 10 }}>
                <label className="mono-sm" style={{ color: "var(--ink-3)" }}>{label}</label>
                <textarea className="input" rows={3} style={{ width: "100%" }} value={editing[k] || ""} onChange={(e) => setEditing({ ...editing, [k]: e.target.value })} />
              </div>
            ))}
            <div className="row" style={{ gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
              <Btn sm kind="ghost" onClick={() => setEditing(null)}>Cancel</Btn>
              <Btn sm kind="primary" onClick={save}>Save template</Btn>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

// Freight rate table editor (migration 106). Simple CRUD over the
// freight_rates table; rows feed the price-composition cockpit.
export const FreightRatesPanel: React.FC = () => {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<any>(null);
  const [draft, setDraft] = useState<any>({ mode: "ocean", unit: "cbm", currency: "INR", rate_per_unit: 0, is_active: true });

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await adminCrudFetch("/api/admin/freight_rates");
      setRows(r.rates || []);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { reload(); }, []);

  const save = async () => {
    try {
      await adminCrudFetch("/api/admin/freight_rates", { method: "POST", body: draft });
      window.notifySuccess?.("Freight rate saved", `${draft.mode} . ${draft.unit}`);
      setDraft({ mode: "ocean", unit: "cbm", currency: "INR", rate_per_unit: 0, is_active: true });
      await reload();
    } catch (e: any) {
      window.notifyError?.("Could not save freight rate", e?.message || String(e));
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm("Delete this freight rate row?")) return;
    try {
      await adminCrudFetch("/api/admin/freight_rates?id=" + encodeURIComponent(id), { method: "DELETE" });
      await reload();
    } catch (e: any) {
      window.notifyError?.("Could not delete", e?.message || String(e));
    }
  };

  if (loading) return <Card><div className="body">Loading freight rates...</div></Card>;
  if (error) return (
    <Banner kind="bad" icon={Icon.alert} title="Could not load freight rates" action={<Btn sm onClick={reload}>Retry</Btn>}>
      <span className="mono-sm">{String((error as any)?.message || error)}</span>
    </Banner>
  );

  return (
    <>
      <Card title="Add freight rate" eyebrow="per-tenant air / ocean / road / courier rate table">
        <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div>
            <label className="mono-sm">Mode</label>
            <select className="select" value={draft.mode} onChange={(e) => setDraft({ ...draft, mode: e.target.value })}>
              <option value="ocean">Ocean</option>
              <option value="air">Air</option>
              <option value="road">Road</option>
              <option value="courier">Courier</option>
            </select>
          </div>
          <div>
            <label className="mono-sm">Origin</label>
            <input className="input mono" maxLength={2} value={draft.origin || ""} onChange={(e) => setDraft({ ...draft, origin: e.target.value.toUpperCase() })} placeholder="KR, JP, IN, ..." />
          </div>
          <div>
            <label className="mono-sm">Destination</label>
            <input className="input mono" maxLength={2} value={draft.destination || ""} onChange={(e) => setDraft({ ...draft, destination: e.target.value.toUpperCase() })} placeholder="IN" />
          </div>
          <div>
            <label className="mono-sm">Unit</label>
            <select className="select" value={draft.unit} onChange={(e) => setDraft({ ...draft, unit: e.target.value })}>
              <option value="kg">per kg</option>
              <option value="cbm">per CBM</option>
              <option value="container_20ft">per 20ft container</option>
              <option value="container_40ft">per 40ft container</option>
              <option value="set">per set</option>
            </select>
          </div>
          <div>
            <label className="mono-sm">Rate per unit</label>
            <input className="input mono r" type="number" step="0.01" value={draft.rate_per_unit ?? 0} onChange={(e) => setDraft({ ...draft, rate_per_unit: Number(e.target.value) })} />
          </div>
          <div>
            <label className="mono-sm">Packing fee</label>
            <input className="input mono r" type="number" step="0.01" value={draft.packing_fee ?? ""} onChange={(e) => setDraft({ ...draft, packing_fee: e.target.value === "" ? null : Number(e.target.value) })} />
          </div>
          <div>
            <label className="mono-sm">Currency</label>
            <input className="input mono" maxLength={3} value={draft.currency || "INR"} onChange={(e) => setDraft({ ...draft, currency: e.target.value.toUpperCase() })} />
          </div>
          <Btn sm kind="primary" onClick={save}>{Icon.plus} Add</Btn>
        </div>
      </Card>
      <Card flush>
        {rows.length === 0 ? (
          <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>No freight rates yet.</div>
        ) : (
          <table className="tbl">
            <thead><tr>
              <th>Mode</th><th>Origin</th><th>Destination</th><th>Unit</th>
              <th className="r">Rate</th><th className="r">Packing</th><th>Currency</th><th className="r">Active</th><th></th>
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="mono-sm">{r.mode}</td>
                  <td className="mono-sm">{r.origin || "-"}</td>
                  <td className="mono-sm">{r.destination || "-"}</td>
                  <td className="mono-sm">{r.unit}</td>
                  <td className="r mono"><span className="pri">{r.rate_per_unit}</span></td>
                  <td className="r mono">{r.packing_fee || "-"}</td>
                  <td className="mono-sm">{r.currency}</td>
                  <td className="r">{r.is_active ? "yes" : "-"}</td>
                  <td className="r"><Btn sm kind="ghost" onClick={() => remove(r.id)}>delete</Btn></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
};

// Tenant-wide pricing settings (migration 106). Backs the price
// composition cockpit defaults. Single row per tenant.
export const PricingSettingsPanel: React.FC = () => {
  const [settings, setSettings] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<any>(null);
  const [factorEdit, setFactorEdit] = useState("");

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await adminCrudFetch("/api/admin/tenant_pricing_settings");
      const s = r.settings || {
        target_margin_pct: 0.35,
        default_conversion_factor: 1.0,
        multiplication_factors: {},
        default_freight_mode: "ocean",
        enable_landed_cost: true,
        rounding_rule: "NEAREST_1",
        show_supplier_price_in_quote: false,
        show_reference_price_in_quote: false,
      };
      setSettings(s);
      setFactorEdit(JSON.stringify(s.multiplication_factors || {}, null, 2));
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { reload(); }, []);

  const save = async () => {
    let factors = {};
    try { factors = JSON.parse(factorEdit || "{}"); } catch (e: any) {
      window.notifyError?.("Multiplication factors not valid JSON", e?.message || String(e));
      return;
    }
    try {
      await adminCrudFetch("/api/admin/tenant_pricing_settings", { method: "POST", body: { ...settings, multiplication_factors: factors } });
      window.notifySuccess?.("Pricing settings saved", "tenant-wide defaults updated");
      await reload();
    } catch (e: any) {
      window.notifyError?.("Could not save pricing settings", e?.message || String(e));
    }
  };

  if (loading) return <Card><div className="body">Loading pricing settings...</div></Card>;
  if (error) return (
    <Banner kind="bad" icon={Icon.alert} title="Could not load pricing settings" action={<Btn sm onClick={reload}>Retry</Btn>}>
      <span className="mono-sm">{String((error as any)?.message || error)}</span>
    </Banner>
  );
  if (!settings) return null;

  return (
    <Card title="Pricing defaults" eyebrow="tenant-wide. Price-composition cockpit uses these unless overridden per quote.">
      <div className="row" style={{ gap: 14, flexWrap: "wrap" }}>
        <div>
          <label className="mono-sm">Target margin %</label>
          <input className="input mono r" type="number" step="0.01" value={settings.target_margin_pct ?? 0} onChange={(e) => setSettings({ ...settings, target_margin_pct: Number(e.target.value) })} />
        </div>
        <div>
          <label className="mono-sm">Default conversion factor</label>
          <input className="input mono r" type="number" step="0.001" value={settings.default_conversion_factor ?? 1} onChange={(e) => setSettings({ ...settings, default_conversion_factor: Number(e.target.value) })} />
        </div>
        <div>
          <label className="mono-sm">Default freight mode</label>
          <select className="select" value={settings.default_freight_mode || "ocean"} onChange={(e) => setSettings({ ...settings, default_freight_mode: e.target.value })}>
            <option value="ocean">Ocean</option><option value="air">Air</option><option value="road">Road</option><option value="courier">Courier</option>
          </select>
        </div>
        <div>
          <label className="mono-sm">Rounding rule</label>
          <select className="select" value={settings.rounding_rule || "NEAREST_1"} onChange={(e) => setSettings({ ...settings, rounding_rule: e.target.value })}>
            <option value="NONE">None</option><option value="NEAREST_1">Nearest 1</option><option value="NEAREST_10">Nearest 10</option><option value="NEAREST_100">Nearest 100</option>
          </select>
        </div>
        <label className="mono-sm row" style={{ gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={!!settings.enable_landed_cost} onChange={(e) => setSettings({ ...settings, enable_landed_cost: e.target.checked })} /> enable landed cost
        </label>
        <label className="mono-sm row" style={{ gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={!!settings.show_supplier_price_in_quote} onChange={(e) => setSettings({ ...settings, show_supplier_price_in_quote: e.target.checked })} /> show supplier price
        </label>
        <label className="mono-sm row" style={{ gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={!!settings.show_reference_price_in_quote} onChange={(e) => setSettings({ ...settings, show_reference_price_in_quote: e.target.checked })} /> show reference price
        </label>
      </div>
      <div style={{ marginTop: 14 }}>
        <label className="mono-sm" style={{ color: "var(--ink-3)" }}>Multiplication factors per currency (JSON object, e.g., {"{ \"USD\": 126.6, \"CNY\": 18.5, \"JPY\": 0.86 }"})</label>
        <textarea className="input mono" rows={6} style={{ width: "100%" }} value={factorEdit} onChange={(e) => setFactorEdit(e.target.value)} />
      </div>
      <div className="row" style={{ justifyContent: "flex-end", marginTop: 12 }}>
        <Btn sm kind="primary" onClick={save}>Save</Btn>
      </div>
    </Card>
  );
};

// Vendor codes editor (migration 106). Records how each customer
// refers to the tenant. Inbound POs can be matched on this code so
// the intake flow can auto-resolve the customer.
export const VendorCodesPanel: React.FC = () => {
  const [customers, setCustomers] = useState<any[]>([]);
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<any>(null);
  const [draft, setDraft] = useState<any>({ customer_id: "", vendor_code: "", is_primary: true, notes: "" });

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      const [cs, vc] = await Promise.all([
        adminCrudFetch("/api/customers"),
        adminCrudFetch("/api/admin/customer_vendor_codes"),
      ]);
      setCustomers(cs.customers || []);
      setRows(vc.mappings || []);
    } catch (e) { setError(e); } finally { setLoading(false); }
  };
  useEffect(() => { reload(); }, []);

  const save = async () => {
    if (!draft.customer_id || !draft.vendor_code) {
      window.notifyWarn?.("Customer + vendor code required", "Pick a customer and enter the code they use for this tenant.");
      return;
    }
    try {
      await adminCrudFetch("/api/admin/customer_vendor_codes", { method: "POST", body: draft });
      window.notifySuccess?.("Vendor code saved", draft.vendor_code);
      setDraft({ customer_id: "", vendor_code: "", is_primary: true, notes: "" });
      await reload();
    } catch (e: any) { window.notifyError?.("Could not save", e?.message || String(e)); }
  };

  const remove = async (customer_id: string, vendor_code: string) => {
    if (!window.confirm(`Delete vendor code "${vendor_code}"?`)) return;
    try {
      await adminCrudFetch(`/api/admin/customer_vendor_codes?customer_id=${customer_id}&vendor_code=${encodeURIComponent(vendor_code)}`, { method: "DELETE" });
      await reload();
    } catch (e: any) { window.notifyError?.("Could not delete", e?.message || String(e)); }
  };

  if (loading) return <Card><div className="body">Loading vendor codes...</div></Card>;
  if (error) return <Banner kind="bad" icon={Icon.alert} title="Could not load" action={<Btn sm onClick={reload}>Retry</Btn>}><span className="mono-sm">{String((error as any)?.message || error)}</span></Banner>;

  return (
    <>
      <Card title="Add vendor code" eyebrow="how each customer refers to this tenant as their supplier">
        <div className="row" style={{ gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div>
            <label className="mono-sm">Customer</label>
            <select className="select" value={draft.customer_id} onChange={(e) => setDraft({ ...draft, customer_id: e.target.value })}>
              <option value="">Select...</option>
              {customers.map((c: any) => <option key={c.id} value={c.id}>{c.customer_name}</option>)}
            </select>
          </div>
          <div>
            <label className="mono-sm">Vendor code</label>
            <input className="input mono" value={draft.vendor_code} onChange={(e) => setDraft({ ...draft, vendor_code: e.target.value })} placeholder="e.g., TH1M" />
          </div>
          <label className="mono-sm row" style={{ gap: 6, alignItems: "center" }}>
            <input type="checkbox" checked={!!draft.is_primary} onChange={(e) => setDraft({ ...draft, is_primary: e.target.checked })} /> primary
          </label>
          <div style={{ flex: 1 }}>
            <label className="mono-sm">Notes</label>
            <input className="input" value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
          </div>
          <Btn sm kind="primary" onClick={save}>{Icon.plus} Add</Btn>
        </div>
      </Card>
      <Card flush>
        {rows.length === 0 ? (
          <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
            No vendor codes mapped yet. Add the supplier code each customer uses for your tenant.
          </div>
        ) : (
          <table className="tbl">
            <thead><tr><th>Customer</th><th>Vendor code</th><th>Primary</th><th>Notes</th><th></th></tr></thead>
            <tbody>
              {rows.map((r) => {
                const c = customers.find((cc: any) => cc.id === r.customer_id);
                return (
                  <tr key={`${r.customer_id}:${r.vendor_code}`}>
                    <td>{c?.customer_name || r.customer_id.slice(0, 8)}</td>
                    <td className="mono"><span className="pri">{r.vendor_code}</span></td>
                    <td>{r.is_primary ? <Chip k="good">primary</Chip> : "-"}</td>
                    <td className="mono-sm">{r.notes || "-"}</td>
                    <td className="r"><Btn sm kind="ghost" onClick={() => remove(r.customer_id, r.vendor_code)}>delete</Btn></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
};

// Layer D: bulk + per-row CSV/XLSX import for item_customer_parts.
// Mirrors the VendorCodesPanel shape (load lists, add-row form,
// table) plus a hidden file input that parses CSV via the inline
// parseCSV at the top of this file or XLSX via the lazy-loaded
// SheetJS CDN bundle from bom-import.tsx. The endpoint at
// /api/admin/item_customer_parts already accepts both single and
// { rows: [...] } batch shapes per stage 2 of the plan; this
// panel calls the batch shape with parsedRows.
//
// CSV / XLSX columns recognised (any subset, case-insensitive):
//   customer_id | customer_name
//   item_master_id | item_master_part_no | part_no
//   customer_part_number   (required)
//   customer_part_description
//   customer_project
//   valid_from, valid_to     (YYYY-MM-DD)
//   is_primary               (truthy: "1", "true", "yes", "y")
//
// Errors are returned per-row by the server; the UI renders them
// inline below the import button without aborting the rest of the
// batch.
let __xlsxPanelPromise: Promise<any> | null = null;
const loadXLSXForCustomerParts = () => {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  if ((window as any).XLSX) return Promise.resolve((window as any).XLSX);
  if (__xlsxPanelPromise) return __xlsxPanelPromise;
  // xlsx is a bundled dep loaded via dynamic import (CSP blocks CDN scripts).
  __xlsxPanelPromise = import("xlsx").then((m: any) => {
    const XLSX = (m && m.read) ? m : (m.default || m);
    try { (window as any).XLSX = XLSX; } catch (_) { /* noop */ }
    return XLSX;
  });
  return __xlsxPanelPromise;
};

const PARTS_TRUTHY = new Set(["1", "true", "yes", "y", "t"]);
const normalizePartsRow = (raw: Record<string, any>) => {
  const obj: Record<string, any> = {};
  for (const k of Object.keys(raw || {})) {
    const v = raw[k];
    const key = String(k || "").trim().toLowerCase().replace(/\s+/g, "_");
    obj[key] = typeof v === "string" ? v.trim() : v;
  }
  return {
    customer_id: obj.customer_id || null,
    customer_name: obj.customer_name || obj.customer || null,
    item_master_id: obj.item_master_id || obj.item_id || null,
    item_master_part_no: obj.item_master_part_no || obj.part_no || obj.tally_item_name || null,
    customer_part_number: obj.customer_part_number || obj.customer_part || obj.part_number || obj.code || null,
    customer_part_description: obj.customer_part_description || obj.description || null,
    customer_project: obj.customer_project || obj.project || null,
    valid_from: obj.valid_from || null,
    valid_to: obj.valid_to || null,
    is_primary: obj.is_primary == null ? false : PARTS_TRUTHY.has(String(obj.is_primary).toLowerCase()),
  };
};

// Parse a CSV string into an array of normalised row objects,
// using the first row as the header. Reuses parseCSV defined at
// the top of admin.tsx.
const csvToPartsRows = (text: string): Array<Record<string, any>> => {
  const grid = parseCSV(text);
  if (!grid.length) return [];
  const header = grid[0].map((h: any) => String(h).trim());
  return grid.slice(1).map((cells: any[]) => {
    const obj: Record<string, any> = {};
    for (let i = 0; i < header.length; i++) obj[header[i]] = cells[i] != null ? cells[i] : "";
    return normalizePartsRow(obj);
  }).filter((r: any) => r.customer_part_number);
};

const xlsxToPartsRows = async (file: File): Promise<Array<Record<string, any>>> => {
  const XLSX = await loadXLSXForCustomerParts();
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array", raw: false, cellDates: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const json: any[] = XLSX.utils.sheet_to_json(ws, { defval: "" });
  return json.map(normalizePartsRow).filter((r: any) => r.customer_part_number);
};

interface PartsImportResult {
  ok: number;
  errors: Array<{ row_index: number; reason: string }>;
  total: number;
}

export const CustomerPartsPanel: React.FC = () => {
  const [customers, setCustomers] = useState<any[]>([]);
  const [items, setItems] = useState<any[]>([]);
  const [rows, setRows] = useState<any[]>([]);
  const [filterCustomerId, setFilterCustomerId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<any>(null);
  const [draft, setDraft] = useState<any>({ customer_id: "", item_master_id: "", customer_part_number: "", customer_part_description: "", is_primary: false });
  const [busy, setBusy] = useState(false);
  const [importResult, setImportResult] = useState<PartsImportResult | null>(null);

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      const [cs, im] = await Promise.all([
        adminCrudFetch("/api/customers"),
        adminCrudFetch("/api/admin/item_master?limit=2000"),
      ]);
      setCustomers((cs as any).customers || []);
      setItems((im as any).items || []);
      // Pull mappings filtered by current customer (or none, which
      // returns all up to the server's 1000 cap).
      const mp = await adminCrudFetch(filterCustomerId
        ? `/api/admin/item_customer_parts?customer_id=${encodeURIComponent(filterCustomerId)}`
        : "/api/admin/item_customer_parts");
      setRows((mp as any).mappings || []);
    } catch (e) { setError(e); } finally { setLoading(false); }
  };
  useEffect(() => { reload(); }, [filterCustomerId]);

  const save = async () => {
    if (!draft.customer_id || !draft.item_master_id || !draft.customer_part_number) {
      window.notifyWarn?.("All three fields required", "Pick a customer, pick a canonical item, and enter the customer's part number.");
      return;
    }
    try {
      await adminCrudFetch("/api/admin/item_customer_parts", {
        method: "POST",
        body: {
          item_id: draft.item_master_id,
          customer_id: draft.customer_id,
          customer_part_number: String(draft.customer_part_number).trim(),
          customer_part_description: draft.customer_part_description || null,
          is_primary: !!draft.is_primary,
        },
      });
      window.notifySuccess?.("Mapping saved", draft.customer_part_number);
      setDraft({ customer_id: draft.customer_id, item_master_id: "", customer_part_number: "", customer_part_description: "", is_primary: false });
      await reload();
    } catch (e: any) { window.notifyError?.("Could not save", e?.message || String(e)); }
  };

  const remove = async (m: any) => {
    if (!window.confirm(`Delete mapping ${m.customer_part_number}?`)) return;
    try {
      await adminCrudFetch(`/api/admin/item_customer_parts?item_id=${m.item_id}&customer_id=${m.customer_id}&customer_part_number=${encodeURIComponent(m.customer_part_number)}`, { method: "DELETE" });
      await reload();
    } catch (e: any) { window.notifyError?.("Could not delete", e?.message || String(e)); }
  };

  const onImport = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setImportResult(null);
    try {
      const isXlsx = /\.(xlsx|xls)$/i.test(file.name);
      const parsed = isXlsx ? await xlsxToPartsRows(file) : csvToPartsRows(await file.text());
      if (!parsed.length) {
        window.notifyWarn?.("No rows parsed", "The file had no rows with a customer_part_number. Check the header row.");
        return;
      }
      const resp = await adminCrudFetch("/api/admin/item_customer_parts", {
        method: "POST",
        body: { rows: parsed },
      });
      const out: PartsImportResult = {
        ok: (resp as any).ok || 0,
        errors: (resp as any).errors || [],
        total: parsed.length,
      };
      setImportResult(out);
      if (out.ok > 0) window.notifySuccess?.("Imported " + out.ok + " mapping" + (out.ok === 1 ? "" : "s"), out.errors.length ? out.errors.length + " row" + (out.errors.length === 1 ? "" : "s") + " skipped" : undefined);
      else window.notifyError?.("No rows imported", "All rows failed. See the result table below.");
      await reload();
    } catch (e: any) {
      window.notifyError?.("Import failed", e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Card><div className="body">Loading customer parts...</div></Card>;
  if (error) return <Banner kind="bad" icon={Icon.alert} title="Could not load" action={<Btn sm onClick={reload}>Retry</Btn>}><span className="mono-sm">{String((error as any)?.message || error)}</span></Banner>;

  const filteredRows = rows;

  return (
    <>
      <Card title="Add customer part" eyebrow="customer-specific code that maps to your canonical item">
        <div className="row" style={{ gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div>
            <label className="mono-sm">Customer</label>
            <select className="select" value={draft.customer_id} onChange={(e) => setDraft({ ...draft, customer_id: e.target.value })}>
              <option value="">Select...</option>
              {customers.map((c: any) => <option key={c.id} value={c.id}>{c.customer_name}</option>)}
            </select>
          </div>
          <div>
            <label className="mono-sm">Canonical item</label>
            <select className="select" value={draft.item_master_id} onChange={(e) => setDraft({ ...draft, item_master_id: e.target.value })}>
              <option value="">Select...</option>
              {items.slice(0, 500).map((it: any) => (
                <option key={it.id} value={it.id}>{it.part_no}{it.alias ? " (" + it.alias + ")" : ""}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mono-sm">Customer part #</label>
            <input className="input mono" value={draft.customer_part_number} onChange={(e) => setDraft({ ...draft, customer_part_number: e.target.value })} placeholder="e.g., GD544202603190008" />
          </div>
          <div style={{ flex: 1, minWidth: 220 }}>
            <label className="mono-sm">Description (optional)</label>
            <input className="input" value={draft.customer_part_description} onChange={(e) => setDraft({ ...draft, customer_part_description: e.target.value })} />
          </div>
          <label className="mono-sm row" style={{ gap: 6, alignItems: "center" }}>
            <input type="checkbox" checked={!!draft.is_primary} onChange={(e) => setDraft({ ...draft, is_primary: e.target.checked })} /> primary
          </label>
          <Btn sm kind="primary" onClick={save}>{Icon.plus} Add</Btn>
        </div>
      </Card>

      <Card title="Bulk import" eyebrow="CSV or XLSX with one mapping per row" right={
        <label className="btn btn-sm" style={{ cursor: busy ? "wait" : "pointer" }}>
          {busy ? "importing…" : <>{Icon.upload || "↑"} Upload CSV / XLSX</>}
          <input type="file" accept=".csv,text/csv,.xlsx,.xls" disabled={busy} style={{ display: "none" }}
                 onChange={(ev) => { const f = ev.target.files?.[0]; ev.target.value = ""; onImport(f); }} />
        </label>
      }>
        <div className="mono-sm" style={{ color: "var(--ink-3)", lineHeight: 1.5 }}>
          Required column: <span className="mono">customer_part_number</span>. Plus one of:{" "}
          <span className="mono">customer_id</span> or <span className="mono">customer_name</span>,
          and one of <span className="mono">item_master_id</span> or <span className="mono">item_master_part_no</span>.{" "}
          Optional: <span className="mono">customer_part_description</span>, <span className="mono">customer_project</span>,
          <span className="mono">valid_from</span>, <span className="mono">valid_to</span>, <span className="mono">is_primary</span>.
        </div>
        {importResult && (
          <div style={{ marginTop: 12 }}>
            <Banner
              kind={importResult.errors.length === 0 ? "good" : "warn"}
              title={`Imported ${importResult.ok} of ${importResult.total} row${importResult.total === 1 ? "" : "s"}`}
            >
              {importResult.errors.length > 0 && (
                <table className="tbl" style={{ marginTop: 8 }}>
                  <thead><tr><th>Row</th><th>Reason</th></tr></thead>
                  <tbody>
                    {importResult.errors.slice(0, 50).map((er, j) => (
                      <tr key={j}>
                        <td className="mono-sm">{er.row_index + 2}</td>
                        <td className="mono-sm">{er.reason}</td>
                      </tr>
                    ))}
                    {importResult.errors.length > 50 && (
                      <tr><td colSpan={2} className="mono-sm" style={{ color: "var(--ink-3)" }}>
                        ...and {importResult.errors.length - 50} more.
                      </td></tr>
                    )}
                  </tbody>
                </table>
              )}
            </Banner>
          </div>
        )}
      </Card>

      <Card title="Existing mappings" eyebrow={`${rows.length} row${rows.length === 1 ? "" : "s"}`} right={
        <select className="select" value={filterCustomerId} onChange={(e) => setFilterCustomerId(e.target.value)}>
          <option value="">All customers</option>
          {customers.map((c: any) => <option key={c.id} value={c.id}>{c.customer_name}</option>)}
        </select>
      }>
        {filteredRows.length === 0 ? (
          <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
            No mappings to show.
          </div>
        ) : (
          <table className="tbl">
            <thead><tr>
              <th>Customer</th>
              <th>Their part #</th>
              <th>Canonical item</th>
              <th>Source</th>
              <th>Confidence</th>
              <th>Confirmed</th>
              <th>Primary</th>
              <th></th>
            </tr></thead>
            <tbody>
              {filteredRows.map((m: any, i: number) => {
                const c = customers.find((cc: any) => cc.id === m.customer_id);
                const it = items.find((ii: any) => ii.id === m.item_id);
                const cv = m.created_via || "legacy";
                const tone: any = (cv === "manual" || cv === "bulk_import") ? "good"
                  : (cv === "quote_sent" || cv === "llm_suggest" || cv === "quote_accepted") ? "info"
                  : "ghost";
                return (
                  <tr key={i}>
                    <td>{c?.customer_name || m.customer_id.slice(0, 8)}</td>
                    <td className="mono"><span className="pri">{m.customer_part_number}</span></td>
                    <td className="mono-sm">{it?.part_no || m.item_id.slice(0, 8)}</td>
                    <td><Chip k={tone}>{cv.replace(/_/g, " ")}</Chip></td>
                    <td className="mono-sm">{m.confidence_pct != null ? Math.round(Number(m.confidence_pct)) + "%" : "—"}</td>
                    <td className="mono-sm">{m.confirmed_at ? new Date(m.confirmed_at).toISOString().slice(0, 10) : "—"}</td>
                    <td>{m.is_primary ? <Chip k="good">primary</Chip> : "—"}</td>
                    <td className="r"><Btn sm kind="ghost" onClick={() => remove(m)}>delete</Btn></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
};

// Customer terms pack editor (migration 106). Per-customer T&C
// library: MMIL's 15-clause boilerplate becomes a pack with 15
// clauses. Surfaces on the order PDF and on the operator review
// screen when an order is opened for that customer.
export const CustomerTermsPanel: React.FC = () => {
  const [customers, setCustomers] = useState<any[]>([]);
  const [customerId, setCustomerId] = useState("");
  const [packs, setPacks] = useState<any[]>([]);
  const [clauses, setClauses] = useState<any[]>([]);
  const [packDraft, setPackDraft] = useState<any>({ pack_name: "", version: 1, is_active: true });
  const [clauseDraft, setClauseDraft] = useState<any>({ pack_id: "", clause_index: 1, heading: "", body: "", is_blocking: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<any>(null);

  useEffect(() => {
    (async () => {
      try {
        const cs = await adminCrudFetch("/api/customers");
        setCustomers(cs.customers || []);
      } catch (e) { setError(e); } finally { setLoading(false); }
    })();
  }, []);

  const reloadForCustomer = async (cid: string) => {
    if (!cid) return;
    try {
      const r = await adminCrudFetch(`/api/admin/customer_terms?customer_id=${cid}`);
      setPacks(r.packs || []);
      setClauses(r.clauses || []);
    } catch (e) { setError(e); }
  };

  useEffect(() => { if (customerId) reloadForCustomer(customerId); }, [customerId]);

  const savePack = async () => {
    if (!packDraft.pack_name.trim()) { window.notifyWarn?.("Pack name required", "Give the pack a label."); return; }
    try {
      await adminCrudFetch("/api/admin/customer_terms/pack", { method: "POST", body: { ...packDraft, customer_id: customerId } });
      window.notifySuccess?.("Pack saved", packDraft.pack_name);
      setPackDraft({ pack_name: "", version: 1, is_active: true });
      await reloadForCustomer(customerId);
    } catch (e: any) { window.notifyError?.("Could not save", e?.message || String(e)); }
  };

  const saveClause = async () => {
    if (!clauseDraft.pack_id || !clauseDraft.body.trim()) { window.notifyWarn?.("Pack and body required", "Pick a pack and enter the clause text."); return; }
    try {
      await adminCrudFetch("/api/admin/customer_terms/clause", { method: "POST", body: clauseDraft });
      window.notifySuccess?.("Clause saved", `#${clauseDraft.clause_index}`);
      setClauseDraft({ pack_id: clauseDraft.pack_id, clause_index: (clauseDraft.clause_index || 0) + 1, heading: "", body: "", is_blocking: false });
      await reloadForCustomer(customerId);
    } catch (e: any) { window.notifyError?.("Could not save", e?.message || String(e)); }
  };

  if (loading) return <Card><div className="body">Loading customers...</div></Card>;
  if (error) return <Banner kind="bad" icon={Icon.alert} title="Could not load"><span className="mono-sm">{String((error as any)?.message || error)}</span></Banner>;

  return (
    <>
      <Card title="Customer terms packs" eyebrow="MMIL-style T&C boilerplate, per customer">
        <div className="row" style={{ gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div>
            <label className="mono-sm">Customer</label>
            <select className="select" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
              <option value="">Select customer...</option>
              {customers.map((c: any) => <option key={c.id} value={c.id}>{c.customer_name}</option>)}
            </select>
          </div>
        </div>
      </Card>
      {customerId && (
        <>
          <Card title="Add pack" eyebrow="group clauses under a named version">
            <div className="row" style={{ gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
              <div><label className="mono-sm">Pack name</label><input className="input" value={packDraft.pack_name} onChange={(e) => setPackDraft({ ...packDraft, pack_name: e.target.value })} placeholder="e.g., MMIL Standard T&C" /></div>
              <div><label className="mono-sm">Version</label><input className="input mono r" type="number" value={packDraft.version} onChange={(e) => setPackDraft({ ...packDraft, version: Number(e.target.value) })} /></div>
              <Btn sm kind="primary" onClick={savePack}>Add pack</Btn>
            </div>
          </Card>
          {packs.length > 0 && (
            <Card flush>
              <table className="tbl">
                <thead><tr><th>Pack</th><th className="r">Version</th><th className="r">Active</th><th className="r">Clauses</th></tr></thead>
                <tbody>
                  {packs.map((p) => (
                    <tr key={p.id}>
                      <td><span className="pri">{p.pack_name}</span></td>
                      <td className="r mono">{p.version}</td>
                      <td className="r">{p.is_active ? "yes" : "-"}</td>
                      <td className="r">{clauses.filter((c) => c.pack_id === p.id).length}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
          {packs.length > 0 && (
            <Card title="Add clause" eyebrow="one row per numbered paragraph in the customer's T&C">
              <div className="row" style={{ gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
                <div><label className="mono-sm">Pack</label>
                  <select className="select" value={clauseDraft.pack_id} onChange={(e) => setClauseDraft({ ...clauseDraft, pack_id: e.target.value })}>
                    <option value="">Select...</option>
                    {packs.map((p) => <option key={p.id} value={p.id}>{p.pack_name} v{p.version}</option>)}
                  </select>
                </div>
                <div><label className="mono-sm">Clause #</label><input className="input mono r" type="number" value={clauseDraft.clause_index} onChange={(e) => setClauseDraft({ ...clauseDraft, clause_index: Number(e.target.value) })} /></div>
                <div style={{ flex: 1 }}><label className="mono-sm">Heading</label><input className="input" value={clauseDraft.heading} onChange={(e) => setClauseDraft({ ...clauseDraft, heading: e.target.value })} placeholder="e.g., GST input credit endorsement" /></div>
                <label className="mono-sm row" style={{ gap: 6, alignItems: "center" }}>
                  <input type="checkbox" checked={!!clauseDraft.is_blocking} onChange={(e) => setClauseDraft({ ...clauseDraft, is_blocking: e.target.checked })} /> blocking
                </label>
              </div>
              <div style={{ marginTop: 8 }}>
                <label className="mono-sm">Body</label>
                <textarea className="input" rows={3} style={{ width: "100%" }} value={clauseDraft.body} onChange={(e) => setClauseDraft({ ...clauseDraft, body: e.target.value })} />
              </div>
              <div className="row" style={{ justifyContent: "flex-end", marginTop: 8 }}>
                <Btn sm kind="primary" onClick={saveClause}>Add clause</Btn>
              </div>
            </Card>
          )}
          {clauses.length > 0 && (
            <Card flush>
              <table className="tbl">
                <thead><tr><th className="r">#</th><th>Heading</th><th>Body</th><th className="r">Blocking</th></tr></thead>
                <tbody>
                  {clauses.map((c) => (
                    <tr key={c.id}>
                      <td className="r mono">{c.clause_index}</td>
                      <td className="mono-sm"><span className="pri">{c.heading || "-"}</span></td>
                      <td style={{ maxWidth: 480, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.body}</td>
                      <td className="r">{c.is_blocking ? <Chip k="warn">blocking</Chip> : "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </>
      )}
    </>
  );
};

// P2: per-tenant LLM provider selection for the reasoning features routed
// through callLLM. Global default + per-feature overrides. "Default" =
// fall through to the server env / claude.
