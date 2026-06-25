import React, { useEffect, useState } from "react";
import { Banner, Btn, Card, Chip, fmtINR } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { ObaraBackend } from "../lib/api";

// Item detail drawer.
//
// Mounts on top of the items list when the operator clicks a row or
// the "new item" button. Renders six tabs that together cover the
// generalized Tally + Obara Item Master schema (migration 105):
//
//   Identification    name, alias, print name, part no, codes
//   Classification    stock group, category, units, lifecycle
//   Tax               GST applicability, HSN, taxability, supply type
//   Inventory         batches, mfg date, cost tracking, neg stock,
//                     order level, opening balance
//   Specifications    drawing, material, gun no, customer project,
//                     feasibility, lifetime, picture, MOQ, remark
//   Customer parts    per-customer part numbers
//   Custom fields     per-tenant configurable field definitions
//
// Each tab posts to its dedicated endpoint, so a partial save in
// one tab does not block another. Reference data (UoM, HSN,
// taxability) is fetched once at open time and re-used across tabs.
//
// The drawer is intentionally form-light: no internal validation
// beyond required-field warnings. The server enforces enums and
// foreign-key relations. The UI mirrors what the Tally screens
// show so operators familiar with TallyPrime feel at home.

type Item = any;
type Ref = {
  uom_options: Array<{ code: string; label: string }>;
  hsn_codes: Array<{ code: string; description: string; default_gst_rate_pct?: number; is_service?: boolean }>;
  taxability_types: Array<{ code: string; label: string }>;
  stock_groups: Array<{ code: string; label: string; parent_code?: string | null }>;
};

const fetchJson = async (path: string, opts?: RequestInit) => {
  const cfg: any = (ObaraBackend as any)?.getConfig?.() || {};
  const session: any = (ObaraBackend as any)?.getSession?.() || null;
  if (!cfg.url) throw new Error("Backend URL not configured");
  const headers: any = { "Content-Type": "application/json", ...(opts?.headers as any || {}) };
  if (session?.access_token) headers["Authorization"] = "Bearer " + session.access_token;
  if (cfg.tenantId) headers["x-obara-tenant"] = cfg.tenantId;
  const url = cfg.url.replace(/\/+$/, "") + path;
  const resp = await fetch(url, { ...opts, headers });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error("HTTP " + resp.status + (text ? ": " + text.slice(0, 200) : ""));
  }
  return resp.json();
};

const TabBtn: React.FC<{ active: boolean; onClick: () => void; children: React.ReactNode }> = ({ active, onClick, children }) => (
  <button
    type="button"
    onClick={onClick}
    style={{
      padding: "8px 12px",
      fontFamily: "var(--mono)",
      fontSize: 11,
      letterSpacing: "0.04em",
      textTransform: "uppercase",
      border: "none",
      borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent",
      background: "transparent",
      color: active ? "var(--ink)" : "var(--ink-3)",
      cursor: "pointer",
      fontWeight: 600,
    }}
  >
    {children}
  </button>
);

const Field: React.FC<{ label: string; children: React.ReactNode; hint?: string; required?: boolean }> = ({ label, children, hint, required }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 12 }}>
    <label className="mono-sm" style={{ color: "var(--ink-3)" }}>
      {label}
      {required && <span style={{ color: "var(--rust)", marginLeft: 4 }}>*</span>}
    </label>
    {children}
    {hint && <span className="mono-sm" style={{ color: "var(--ink-4)", fontSize: 10 }}>{hint}</span>}
  </div>
);

export const ItemDetailDrawer: React.FC<{
  item: Item | null;
  onClose: () => void;
  onSaved?: () => void;
  // Guard rail (2026-06): item-master edits are admin-only. When false the
  // drawer is a read-only viewer (inputs + save + satellite actions
  // disabled). Defaults true so existing callers are unaffected.
  canEdit?: boolean;
}> = ({ item, onClose, onSaved, canEdit = true }) => {
  const isNew = !item || !item.id;
  const [tab, setTab] = useState<"id" | "class" | "tax" | "inv" | "spec" | "customers" | "used" | "custom">("id");
  // "Used in orders" tab data (backlog #15). Lazy-loaded the first
  // time the operator opens the tab so the drawer's initial open isn't
  // slowed by the reverse order scan.
  const [usage, setUsage] = useState<{ rows: any[]; meta: any } | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageErr, setUsageErr] = useState<any>(null);
  const [draft, setDraft] = useState<Item>(item ? { ...item } : { lifecycle: "ACTIVE", type_of_supply: "GOODS", gst_applicable: true });
  const [spec, setSpec] = useState<any>(null);
  const [customerParts, setCustomerParts] = useState<any[]>([]);
  const [customers, setCustomers] = useState<any[]>([]);
  const [fieldDefs, setFieldDefs] = useState<any[]>([]);
  const [fieldValues, setFieldValues] = useState<Record<string, any>>({});
  const [ref, setRef] = useState<Ref | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<any>(null);

  // Load reference data + per-item satellites once on open.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [r, defs, custs] = await Promise.all([
          fetchJson("/api/admin/item_reference"),
          fetchJson("/api/admin/item_field_definitions"),
          fetchJson("/api/customers"),
        ]);
        if (cancelled) return;
        setRef(r);
        setFieldDefs((defs.definitions || []).filter((d: any) => d.is_active));
        setCustomers((custs.customers || []));
      } catch (e) {
        if (!cancelled) setErr(e);
      }
      if (item?.id) {
        try {
          const [s, cp, fv, defsAgain] = await Promise.all([
            fetchJson("/api/admin/item_specifications?item_id=" + item.id),
            fetchJson("/api/admin/item_customer_parts?item_id=" + item.id),
            fetchJson("/api/admin/item_field_values?item_id=" + item.id),
            fetchJson("/api/admin/item_field_definitions"),
          ]);
          if (cancelled) return;
          setSpec(s.spec || {});
          setCustomerParts(cp.mappings || []);
          const valuesMap: Record<string, any> = {};
          for (const v of fv.values || []) {
            const def = ((defsAgain && defsAgain.definitions) || []).find((d: any) => d.field_key === v.field_key);
            if (!def) continue;
            switch (def.field_type) {
              case "number": valuesMap[v.field_key] = v.value_number; break;
              case "boolean": valuesMap[v.field_key] = v.value_boolean; break;
              case "date": valuesMap[v.field_key] = v.value_date; break;
              default: valuesMap[v.field_key] = v.value_text; break;
            }
          }
          setFieldValues(valuesMap);
        } catch (e) {
          if (!cancelled) setErr(e);
        }
      } else {
        setSpec({});
      }
    })();
    return () => { cancelled = true; };
  }, [item?.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Lazy-load the "Used in orders" data on first open of that tab.
  useEffect(() => {
    if (tab !== "used" || !item?.id || usage || usageLoading) return;
    let cancelled = false;
    setUsageLoading(true);
    setUsageErr(null);
    fetchJson("/api/admin/item_usage?item_id=" + item.id)
      .then((d) => { if (!cancelled) setUsage({ rows: d.usage || [], meta: d }); })
      .catch((e) => { if (!cancelled) setUsageErr(e); })
      .finally(() => { if (!cancelled) setUsageLoading(false); });
    return () => { cancelled = true; };
  }, [tab, item?.id, usage, usageLoading]);

  const setField = (k: string, v: any) => setDraft((d: Item) => ({ ...d, [k]: v }));
  const setSpecField = (k: string, v: any) => setSpec((d: any) => ({ ...(d || {}), [k]: v }));

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      const savedItem = await fetchJson("/api/admin/item_master", {
        method: "POST",
        body: JSON.stringify(draft),
      });
      const itemId = savedItem?.item?.id;
      if (itemId) {
        // Specifications upsert (1-to-1).
        if (spec && Object.keys(spec).length > 0) {
          await fetchJson("/api/admin/item_specifications", {
            method: "POST",
            body: JSON.stringify({ ...spec, item_id: itemId }),
          });
        }
        // Custom-field values bulk upsert.
        if (Object.keys(fieldValues).length > 0) {
          await fetchJson("/api/admin/item_field_values", {
            method: "POST",
            body: JSON.stringify({ item_id: itemId, values: fieldValues }),
          });
        }
      }
      onSaved?.();
      onClose();
    } catch (e: any) {
      setErr(e);
      window.notifyError?.("Save failed", e?.message || String(e));
    } finally {
      setSaving(false);
    }
  };

  const addCustomerPart = async (row: { customer_id: string; customer_part_number: string; customer_part_description?: string }) => {
    if (!item?.id) {
      window.notifyWarn?.("Save item first", "Customer-part mappings need a persisted item.");
      return;
    }
    try {
      await fetchJson("/api/admin/item_customer_parts", {
        method: "POST",
        body: JSON.stringify({ item_id: item.id, ...row }),
      });
      const refreshed = await fetchJson("/api/admin/item_customer_parts?item_id=" + item.id);
      setCustomerParts(refreshed.mappings || []);
      window.notifySuccess?.("Customer part added", row.customer_part_number);
    } catch (e: any) {
      window.notifyError?.("Could not add mapping", e?.message || String(e));
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Item detail"
      style={{ position: "fixed", inset: 0, background: "rgba(8,10,12,0.55)", display: "flex", justifyContent: "flex-end", zIndex: 200 }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(900px, 100vw)",
          height: "100vh",
          background: "var(--bg)",
          borderLeft: "1px solid var(--line)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Header */}
        <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ flex: 1 }}>
            <div className="mono-sm" style={{ color: "var(--ink-3)" }}>Master . Item</div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>
              {isNew ? "New item" : (draft.part_no || "Item")}
              {!isNew && draft.alias && <span style={{ marginLeft: 8, color: "var(--ink-3)", fontSize: 12 }}>(alias: {draft.alias})</span>}
            </div>
          </div>
          {draft.lifecycle && <Chip k={draft.lifecycle === "ACTIVE" ? "good" : "ghost"}>{String(draft.lifecycle).toLowerCase()}</Chip>}
          {!canEdit && <Chip k="ghost">read-only</Chip>}
          <Btn sm kind="ghost" onClick={onClose}>close</Btn>
        </div>

        {!canEdit && (
          <div style={{ padding: "10px 18px 0" }}>
            <Banner kind="info" icon={Icon.lock} title="Read-only">
              <span className="mono-sm">Admin access is required to edit the item master.</span>
            </Banner>
          </div>
        )}

        {err && (
          <div style={{ padding: "10px 18px" }}>
            <Banner kind="bad" icon={Icon.alert} title="Error">
              <span className="mono-sm">{String(err.message || err)}</span>
            </Banner>
          </div>
        )}

        {/* Tabs */}
        <div style={{ display: "flex", gap: 2, padding: "0 18px", borderBottom: "1px solid var(--line)", overflowX: "auto" }}>
          <TabBtn active={tab === "id"} onClick={() => setTab("id")}>Identification</TabBtn>
          <TabBtn active={tab === "class"} onClick={() => setTab("class")}>Classification</TabBtn>
          <TabBtn active={tab === "tax"} onClick={() => setTab("tax")}>Tax</TabBtn>
          <TabBtn active={tab === "inv"} onClick={() => setTab("inv")}>Inventory</TabBtn>
          <TabBtn active={tab === "spec"} onClick={() => setTab("spec")}>Specifications</TabBtn>
          <TabBtn active={tab === "customers"} onClick={() => setTab("customers")}>Used by these customers</TabBtn>
          {!isNew && <TabBtn active={tab === "used"} onClick={() => setTab("used")}>Used in orders</TabBtn>}
          <TabBtn active={tab === "custom"} onClick={() => setTab("custom")}>Custom fields</TabBtn>
        </div>

        {/* Body. fieldset(disabled) makes the whole form read-only for
            non-admins in one shot - inputs, selects and satellite action
            buttons all go inert. Tabs + Close live outside it. */}
        <fieldset disabled={!canEdit} style={{ flex: 1, overflowY: "auto", padding: 18, display: "flex", flexDirection: "column", gap: 8, border: 0, margin: 0, minInlineSize: 0 }}>
          {tab === "id" && (
            <>
              <Field label="Part number" required>
                <input className="input" value={draft.part_no || ""} disabled={!!draft.alteration_locked && !isNew} onChange={(e) => setField("part_no", e.target.value)} />
              </Field>
              <Field label="Description"><input className="input" value={draft.description || ""} onChange={(e) => setField("description", e.target.value)} /></Field>
              <Field label="Alias" hint="Tally calls this (alias). Optional alternate name.">
                <input className="input" value={draft.alias || ""} onChange={(e) => setField("alias", e.target.value)} />
              </Field>
              <Field label="Print / export name" hint="Shown on customer invoices when different from internal name">
                <input className="input" value={draft.print_name || ""} onChange={(e) => setField("print_name", e.target.value)} />
              </Field>
              <Field label="Specification code" hint="Per-tenant spec identifier (e.g., OIPN036906)">
                <input className="input mono" value={draft.specification_code || ""} onChange={(e) => setField("specification_code", e.target.value)} />
              </Field>
              <div className="row" style={{ gap: 16, flexWrap: "wrap" }}>
                <Field label="Verify item">
                  <input type="checkbox" checked={!!draft.verify_item} onChange={(e) => setField("verify_item", e.target.checked)} />
                </Field>
                <Field label="Approve item">
                  <input type="checkbox" checked={!!draft.approve_item} onChange={(e) => setField("approve_item", e.target.checked)} />
                </Field>
                <Field label="Alteration locked" hint="Block future edits to identification fields">
                  <input type="checkbox" checked={!!draft.alteration_locked} onChange={(e) => setField("alteration_locked", e.target.checked)} />
                </Field>
                {/* Tally Yes/No flags (migration 107). Visible-tab
                    drivers: when true, the Specifications and
                    Custom-fields tabs render; when false, they hide. */}
                <Field label="Specification details" hint="Tally Yes/No. Show engineering tab.">
                  <input type="checkbox" checked={!!draft.specification_details} onChange={(e) => setField("specification_details", e.target.checked)} />
                </Field>
                <Field label="Other details" hint="Tally Yes/No. Show custom fields tab.">
                  <input type="checkbox" checked={!!draft.other_details} onChange={(e) => setField("other_details", e.target.checked)} />
                </Field>
              </div>
              <Field label="Effective date">
                <input className="input mono" type="date" value={draft.effective_date || ""} onChange={(e) => setField("effective_date", e.target.value)} />
              </Field>
            </>
          )}

          {tab === "class" && (
            <>
              <Field label="Stock group" hint="Tally calls this Under. Pick or type a new group.">
                <input className="input" list="anvil-stock-groups" value={draft.stock_group || ""} onChange={(e) => setField("stock_group", e.target.value)} />
                <datalist id="anvil-stock-groups">
                  {(ref?.stock_groups || []).map((g) => <option key={g.code} value={g.code}>{g.label}</option>)}
                  <option value="Primary" />
                  <option value="Imported for Trading" />
                  <option value="Raw Material" />
                  <option value="Finished Goods" />
                </datalist>
              </Field>
              <Field label="Category"><input className="input" value={draft.category || ""} onChange={(e) => setField("category", e.target.value)} placeholder="e.g., ATD Parts" /></Field>
              <Field label="Sub-category"><input className="input" value={draft.sub_category || ""} onChange={(e) => setField("sub_category", e.target.value)} /></Field>
              <Field label="Item group"><input className="input" value={draft.item_group || ""} onChange={(e) => setField("item_group", e.target.value)} /></Field>
              <Field label="Item sub-group"><input className="input" value={draft.item_sub_group || ""} onChange={(e) => setField("item_sub_group", e.target.value)} /></Field>
              <Field label="Unit of measure (UoM)">
                <select className="select" value={draft.uom || ""} onChange={(e) => setField("uom", e.target.value)}>
                  <option value="">Not Applicable</option>
                  {(ref?.uom_options || []).map((u) => <option key={u.code} value={u.code}>{u.code} . {u.label}</option>)}
                </select>
              </Field>
              <Field label="Source country">
                <input className="input mono" maxLength={2} placeholder="IN, KR, JP, ..." value={draft.source_country || ""} onChange={(e) => setField("source_country", e.target.value.toUpperCase())} />
              </Field>
              <Field label="Source currency">
                <input className="input mono" maxLength={3} placeholder="INR, USD, JPY, ..." value={draft.source_currency || ""} onChange={(e) => setField("source_currency", e.target.value.toUpperCase())} />
              </Field>
              <Field label="Lifecycle">
                <select className="select" value={draft.lifecycle || "ACTIVE"} onChange={(e) => setField("lifecycle", e.target.value)}>
                  <option value="ACTIVE">Active</option>
                  <option value="NEW">New</option>
                  <option value="TRIAL">Trial</option>
                  <option value="OBSOLETE">Obsolete</option>
                  <option value="DISCONTINUED">Discontinued</option>
                </select>
              </Field>
              {/* Hyundai-PO style per-line attributes (migration 107).
                  Defaults that flow onto order line items unless the
                  inbound PO overrides them. */}
              <div className="row" style={{ gap: 16, flexWrap: "wrap" }}>
                <Field label="Inspection required (default)" hint="Default for inbound PO line items">
                  <input type="checkbox" checked={!!draft.inspection_required} onChange={(e) => setField("inspection_required", e.target.checked)} />
                </Field>
                <Field label="Maker (default)" hint="Brand / supplier name shown on the PO line">
                  <input className="input" value={draft.maker || ""} onChange={(e) => setField("maker", e.target.value)} placeholder="e.g., OBARA" />
                </Field>
              </div>
            </>
          )}

          {tab === "tax" && (
            <>
              <Field label="GST applicability">
                <select className="select" value={draft.gst_applicable === false ? "no" : "yes"} onChange={(e) => setField("gst_applicable", e.target.value === "yes")}>
                  <option value="yes">Applicable</option>
                  <option value="no">Not applicable</option>
                </select>
              </Field>
              {/* Tally HSN/SAC source enum (migration 107). Mirrors
                  the Tally form's three-state fallback so operators
                  can express "use the company-level default" without
                  duplicating the HSN code on every item. */}
              <Field label="HSN / SAC details source" hint="Tally three-state fallback">
                <select className="select" value={draft.hsn_source || ""} onChange={(e) => setField("hsn_source", e.target.value || null)}>
                  <option value="">Not set</option>
                  <option value="specify">Specify (use HSN below)</option>
                  <option value="as_per_company">As per company default</option>
                  <option value="not_available">Not available</option>
                </select>
              </Field>
              <Field label="HSN / SAC code" hint="Type to search the global reference table">
                <input className="input mono" list="anvil-hsn-codes" value={draft.hsn_sac || ""} onChange={(e) => setField("hsn_sac", e.target.value)} />
                <datalist id="anvil-hsn-codes">
                  {(ref?.hsn_codes || []).map((h) => <option key={h.code} value={h.code}>{h.description}</option>)}
                </datalist>
              </Field>
              <Field label="GST rate details source" hint="Tally three-state fallback">
                <select className="select" value={draft.gst_rate_source || ""} onChange={(e) => setField("gst_rate_source", e.target.value || null)}>
                  <option value="">Not set</option>
                  <option value="specify">Specify (use rates below)</option>
                  <option value="as_per_company">As per company default</option>
                  <option value="not_available">Not available</option>
                </select>
              </Field>
              <Field label="Taxability type">
                <select className="select" value={draft.taxability_type || ""} onChange={(e) => setField("taxability_type", e.target.value || null)}>
                  <option value="">Not set</option>
                  {(ref?.taxability_types || []).map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}
                </select>
              </Field>
              <Field label="Type of supply">
                <select className="select" value={draft.type_of_supply || "GOODS"} onChange={(e) => setField("type_of_supply", e.target.value)}>
                  <option value="GOODS">Goods</option>
                  <option value="SERVICES">Services</option>
                </select>
              </Field>
              <div className="row" style={{ gap: 16 }}>
                <Field label="SGST %"><input className="input mono r" type="number" step="0.01" value={draft.sgst_rate ?? ""} onChange={(e) => setField("sgst_rate", e.target.value === "" ? null : Number(e.target.value))} /></Field>
                <Field label="CGST %"><input className="input mono r" type="number" step="0.01" value={draft.cgst_rate ?? ""} onChange={(e) => setField("cgst_rate", e.target.value === "" ? null : Number(e.target.value))} /></Field>
                <Field label="IGST %"><input className="input mono r" type="number" step="0.01" value={draft.igst_rate ?? ""} onChange={(e) => setField("igst_rate", e.target.value === "" ? null : Number(e.target.value))} /></Field>
              </div>
              <Field label="Rate of duty %"><input className="input mono r" type="number" step="0.01" value={draft.rate_of_duty_pct ?? ""} onChange={(e) => setField("rate_of_duty_pct", e.target.value === "" ? null : Number(e.target.value))} /></Field>
            </>
          )}

          {tab === "inv" && (
            <>
              <div className="row" style={{ gap: 16, flexWrap: "wrap" }}>
                <Field label="Maintain in batches"><input type="checkbox" checked={!!draft.maintain_batches} onChange={(e) => setField("maintain_batches", e.target.checked)} /></Field>
                <Field label="Track date of manufacturing"><input type="checkbox" checked={!!draft.track_mfg_date} onChange={(e) => setField("track_mfg_date", e.target.checked)} /></Field>
                <Field label="Capture documents"><input type="checkbox" checked={!!draft.capture_documents} onChange={(e) => setField("capture_documents", e.target.checked)} /></Field>
                <Field label="Enable cost tracking"><input type="checkbox" checked={!!draft.enable_cost_tracking} onChange={(e) => setField("enable_cost_tracking", e.target.checked)} /></Field>
                <Field label="Disable negative stock"><input type="checkbox" checked={!!draft.disable_negative_stock} onChange={(e) => setField("disable_negative_stock", e.target.checked)} /></Field>
              </div>
              <Field label="Order level"><input className="input mono r" type="number" step="1" value={draft.order_level ?? ""} onChange={(e) => setField("order_level", e.target.value === "" ? null : Number(e.target.value))} /></Field>
              <Field label="Minimum inventory"><input className="input mono r" type="number" step="1" value={draft.min_inventory ?? ""} onChange={(e) => setField("min_inventory", e.target.value === "" ? null : Number(e.target.value))} /></Field>
              <Field label="Minimum order qty (MOQ)"><input className="input mono r" type="number" step="1" value={draft.moq ?? ""} onChange={(e) => setField("moq", e.target.value === "" ? null : Number(e.target.value))} /></Field>
              <Field label="Pack size"><input className="input mono r" type="number" step="1" value={draft.pack_size ?? ""} onChange={(e) => setField("pack_size", e.target.value === "" ? null : Number(e.target.value))} /></Field>
              <Field label="Default lead days"><input className="input mono r" type="number" step="1" value={draft.default_lead_days ?? ""} onChange={(e) => setField("default_lead_days", e.target.value === "" ? null : Number(e.target.value))} /></Field>
              <Card title="Opening balance" eyebrow="Migration-time inventory snapshot">
                <div className="row" style={{ gap: 16, flexWrap: "wrap" }}>
                  <Field label="Quantity"><input className="input mono r" type="number" step="1" value={draft.opening_qty ?? ""} onChange={(e) => setField("opening_qty", e.target.value === "" ? null : Number(e.target.value))} /></Field>
                  <Field label="Rate"><input className="input mono r" type="number" step="0.01" value={draft.opening_rate ?? ""} onChange={(e) => setField("opening_rate", e.target.value === "" ? null : Number(e.target.value))} /></Field>
                  <Field label="Per"><input className="input mono" value={draft.opening_per || ""} onChange={(e) => setField("opening_per", e.target.value)} placeholder="NO, KG, ..." /></Field>
                  <Field label="Value"><input className="input mono r" type="number" step="0.01" value={draft.opening_value ?? ""} onChange={(e) => setField("opening_value", e.target.value === "" ? null : Number(e.target.value))} /></Field>
                </div>
                {draft.opening_qty && draft.opening_rate && !draft.opening_value && (
                  <div className="mono-sm" style={{ color: "var(--ink-3)" }}>
                    Computed value: {fmtINR(Number(draft.opening_qty) * Number(draft.opening_rate))}
                  </div>
                )}
              </Card>
            </>
          )}

          {tab === "spec" && (
            <>
              <Field label="Technical description"><textarea className="input" rows={3} value={spec?.technical_description || ""} onChange={(e) => setSpecField("technical_description", e.target.value)} /></Field>
              <div className="row" style={{ gap: 16 }}>
                <Field label="Drawing number"><input className="input mono" value={spec?.drawing_number || ""} onChange={(e) => setSpecField("drawing_number", e.target.value)} /></Field>
                <Field label="Alternate part number"><input className="input mono" value={spec?.alternate_part_number || ""} onChange={(e) => setSpecField("alternate_part_number", e.target.value)} /></Field>
              </div>
              <div className="row" style={{ gap: 16 }}>
                <Field label="Gun number"><input className="input mono" value={spec?.gun_number || ""} onChange={(e) => setSpecField("gun_number", e.target.value)} /></Field>
                <Field label="Customer project"><input className="input" value={spec?.customer_project || ""} onChange={(e) => setSpecField("customer_project", e.target.value)} /></Field>
              </div>
              <div className="row" style={{ gap: 16 }}>
                <Field label="Source country"><input className="input mono" maxLength={2} value={spec?.source_country || ""} onChange={(e) => setSpecField("source_country", e.target.value.toUpperCase())} /></Field>
                <Field label="Material"><input className="input" value={spec?.material || ""} onChange={(e) => setSpecField("material", e.target.value)} /></Field>
              </div>
              <div className="row" style={{ gap: 16 }}>
                <Field label="Drawing available"><input type="checkbox" checked={!!spec?.drawing_available} onChange={(e) => setSpecField("drawing_available", e.target.checked)} /></Field>
                <Field label="MFG feasibility">
                  <select className="select" value={spec?.mfg_feasibility || ""} onChange={(e) => setSpecField("mfg_feasibility", e.target.value)}>
                    <option value="">Not set</option>
                    <option value="yes">Yes</option>
                    <option value="no">No</option>
                    <option value="tbd">TBD</option>
                  </select>
                </Field>
                <Field label="Specified life time"><input className="input" value={spec?.specified_life_time || ""} onChange={(e) => setSpecField("specified_life_time", e.target.value)} placeholder="e.g., 5 years, 10,000 cycles" /></Field>
              </div>
              <Field label="Picture URL"><input className="input mono" value={spec?.picture_url || ""} onChange={(e) => setSpecField("picture_url", e.target.value)} placeholder="https://..." /></Field>
              <div className="row" style={{ gap: 16 }}>
                <Field label="Minimum order qty"><input className="input mono r" type="number" step="1" value={spec?.minimum_order_qty ?? ""} onChange={(e) => setSpecField("minimum_order_qty", e.target.value === "" ? null : Number(e.target.value))} /></Field>
                <Field label="Minimum inventory"><input className="input mono r" type="number" step="1" value={spec?.minimum_inventory ?? ""} onChange={(e) => setSpecField("minimum_inventory", e.target.value === "" ? null : Number(e.target.value))} /></Field>
              </div>
              <Field label="Remark"><textarea className="input" rows={3} value={spec?.remark || ""} onChange={(e) => setSpecField("remark", e.target.value)} /></Field>
            </>
          )}

          {tab === "customers" && (
            <CustomerPartsTab item={item} customers={customers} mappings={customerParts} onAdd={addCustomerPart} onRefresh={async () => {
              if (!item?.id) return;
              const refreshed = await fetchJson("/api/admin/item_customer_parts?item_id=" + item.id);
              setCustomerParts(refreshed.mappings || []);
            }} />
          )}

          {tab === "used" && (
            <UsedInOrdersTab
              loading={usageLoading}
              err={usageErr}
              rows={usage?.rows || []}
              meta={usage?.meta || null}
              itemCreatedAt={item?.created_at || null}
            />
          )}

          {tab === "custom" && (
            <CustomFieldsTab definitions={fieldDefs} values={fieldValues} setValues={setFieldValues} />
          )}
        </fieldset>

        {/* Footer */}
        <div style={{ padding: 14, borderTop: "1px solid var(--line)", display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Btn sm kind="ghost" onClick={onClose}>{canEdit ? "Cancel" : "Close"}</Btn>
          {canEdit && (
            <Btn sm kind="primary" disabled={saving || !draft.part_no} onClick={save}>
              {saving ? "Saving..." : (isNew ? "Create item" : "Save changes")}
            </Btn>
          )}
        </div>
      </div>
    </div>
  );
};

// "Used in orders" tab: read-only list of orders/drafts whose line
// items reference this item, newest first, plus the item's own
// created-at so the operator sees how long it has existed.
const UsedInOrdersTab: React.FC<{
  loading: boolean;
  err: any;
  rows: any[];
  meta: any;
  itemCreatedAt: string | null;
}> = ({ loading, err, rows, meta, itemCreatedAt }) => {
  const fmtDate = (iso: string | null) => {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  };
  const STATUS_K: Record<string, string> = {
    DRAFT: "ghost", PENDING_REVIEW: "warn", PENDING_APPROVAL: "warn",
    APPROVED: "good", EXPORTED_TO_TALLY: "info", RECONCILED: "good",
    CANCELLED: "ghost", BLOCKED: "bad", DUPLICATE: "warn",
  };
  if (loading) return <div className="mono-sm" style={{ color: "var(--ink-3)", padding: 8 }}>Scanning orders…</div>;
  if (err) return <div className="mono-sm" style={{ color: "var(--rust)", padding: 8 }}>Could not load usage: {String(err.message || err)}</div>;
  return (
    <div>
      <div className="mono-sm" style={{ color: "var(--ink-3)", marginBottom: 10, display: "flex", gap: 14, flexWrap: "wrap" }}>
        <span>Item created <b style={{ color: "var(--ink)" }}>{fmtDate(itemCreatedAt)}</b></span>
        <span>·</span>
        <span>{meta?.order_count ?? rows.length} order{(meta?.order_count ?? rows.length) === 1 ? "" : "s"}</span>
        {typeof meta?.total_qty === "number" && meta.total_qty > 0 && (
          <><span>·</span><span>{meta.total_qty} total qty</span></>
        )}
        {meta?.scan_capped && <span style={{ color: "var(--amber)" }}>· showing most recent {meta.scanned}</span>}
      </div>
      {rows.length === 0 ? (
        <div className="body" style={{ padding: 18, textAlign: "center", color: "var(--ink-3)" }}>
          This item has not been referenced by any order yet.
        </div>
      ) : (
        <table className="tbl" style={{ fontSize: 12 }}>
          <thead><tr>
            <th>Reference</th>
            <th>Customer</th>
            <th>Status</th>
            <th className="r">Qty</th>
            <th className="r">Date</th>
            <th></th>
          </tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.order_id}>
                <td className="mono"><span className="pri">{r.po_number || r.quote_number || (r.order_id ? r.order_id.slice(0, 8) : "draft")}</span></td>
                <td>{r.customer_name || "—"}</td>
                <td><Chip k={(STATUS_K[r.status] as any) || "ghost"}>{(r.status || "").toLowerCase() || "—"}</Chip></td>
                <td className="r mono">{r.total_qty || "—"}{r.line_count > 1 ? <span style={{ color: "var(--ink-4)" }}> ·{r.line_count}ln</span> : null}</td>
                <td className="r mono-sm">{fmtDate(r.po_date || r.created_at)}</td>
                <td className="r">
                  <Btn sm kind="ghost" onClick={() => { window.location.hash = `#/so?id=${r.order_id}`; }}>open</Btn>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};

const CustomerPartsTab: React.FC<{
  item: any;
  customers: any[];
  mappings: any[];
  onAdd: (row: { customer_id: string; customer_part_number: string; customer_part_description?: string }) => void;
  onRefresh: () => void;
}> = ({ item, customers, mappings, onAdd, onRefresh }) => {
  const [custId, setCustId] = useState("");
  const [partNo, setPartNo] = useState("");
  const [desc, setDesc] = useState("");

  if (!item?.id) {
    return <Banner kind="info" icon={Icon.info} title="Save item first">
      <span className="mono-sm">Customer-part mappings need a persisted item. Create the item, then come back to this tab.</span>
    </Banner>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Card title="Add a customer part" eyebrow="customer-specific part number">
        <div className="row" style={{ gap: 8, alignItems: "flex-end" }}>
          <Field label="Customer">
            <select className="select" value={custId} onChange={(e) => setCustId(e.target.value)}>
              <option value="">Select...</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.customer_name}</option>)}
            </select>
          </Field>
          <Field label="Their part number"><input className="input mono" value={partNo} onChange={(e) => setPartNo(e.target.value)} placeholder="e.g., CH-DZ-010505" /></Field>
          <Field label="Description (optional)"><input className="input" value={desc} onChange={(e) => setDesc(e.target.value)} /></Field>
          <Btn sm kind="primary" disabled={!custId || !partNo} onClick={async () => {
            await onAdd({ customer_id: custId, customer_part_number: partNo.trim(), customer_part_description: desc || undefined });
            setPartNo(""); setDesc("");
          }}>Add</Btn>
        </div>
      </Card>
      <Card flush>
        {mappings.length === 0 ? (
          <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>No customer part mappings yet.</div>
        ) : (
          <table className="tbl">
            <thead><tr>
              <th>Customer</th>
              <th>Their part #</th>
              <th>Description</th>
              <th>Source</th>
              <th>Confidence</th>
              <th>Confirmed</th>
              <th>Primary</th>
              <th>Valid</th>
            </tr></thead>
            <tbody>
              {mappings.map((m, i) => {
                const c = customers.find((cc: any) => cc.id === m.customer_id);
                // Soft-enum chip palette: explicit human action
                // (manual / bulk_import) reads as `good`; learning
                // sources (quote / llm) read as `info`; legacy as
                // `ghost`.
                const sourceTone: Record<string, "good" | "info" | "ghost"> = {
                  manual: "good",
                  bulk_import: "good",
                  quote_sent: "info",
                  quote_accepted: "info",
                  llm_suggest: "info",
                  cross_customer: "ghost",
                  legacy: "ghost",
                };
                const cv = m.created_via || "legacy";
                const tone = sourceTone[cv] || "ghost";
                const confLabel = m.confidence_pct != null
                  ? Math.round(Number(m.confidence_pct)) + "%"
                  : "-";
                const confirmedAt = m.confirmed_at
                  ? new Date(m.confirmed_at).toISOString().slice(0, 10)
                  : "-";
                return (
                  <tr key={i}>
                    <td>{c?.customer_name || m.customer_id.slice(0, 8)}</td>
                    <td className="mono"><span className="pri">{m.customer_part_number}</span></td>
                    <td>{m.customer_part_description || "-"}</td>
                    <td><Chip k={tone}>{cv.replace(/_/g, " ")}</Chip></td>
                    <td className="mono-sm">{confLabel}</td>
                    <td className="mono-sm">{confirmedAt}</td>
                    <td>{m.is_primary ? <Chip k="good">primary</Chip> : "-"}</td>
                    <td className="mono-sm">
                      {m.valid_from ? new Date(m.valid_from).toISOString().slice(0, 10) : ""}
                      {m.valid_to ? " - " + new Date(m.valid_to).toISOString().slice(0, 10) : ""}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
};

const CustomFieldsTab: React.FC<{
  definitions: any[];
  values: Record<string, any>;
  setValues: (next: Record<string, any>) => void;
}> = ({ definitions, values, setValues }) => {
  if (definitions.length === 0) {
    return <Banner kind="info" icon={Icon.info} title="No custom fields defined">
      <span className="mono-sm">An admin can define custom item fields under Admin . Item fields. They appear here once published.</span>
    </Banner>;
  }
  // Group by field_group for readability.
  const groups: Record<string, any[]> = {};
  for (const d of definitions) {
    const g = d.field_group || "custom";
    if (!groups[g]) groups[g] = [];
    groups[g].push(d);
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {Object.entries(groups).map(([g, defs]) => (
        <Card key={g} title={g.toUpperCase()} eyebrow={`${defs.length} field${defs.length === 1 ? "" : "s"}`}>
          {defs.map((d) => (
            <Field key={d.field_key} label={d.field_label} required={d.field_required}>
              {d.field_type === "boolean" ? (
                <input type="checkbox" checked={!!values[d.field_key]} onChange={(e) => setValues({ ...values, [d.field_key]: e.target.checked })} />
              ) : d.field_type === "select" ? (
                <select className="select" value={values[d.field_key] || ""} onChange={(e) => setValues({ ...values, [d.field_key]: e.target.value })}>
                  <option value="">{d.field_default ? `(default: ${d.field_default})` : "Select..."}</option>
                  {(d.field_options || []).map((opt: any, i: number) => (
                    <option key={i} value={opt.value || opt}>{opt.label || opt.value || opt}</option>
                  ))}
                </select>
              ) : d.field_type === "number" ? (
                <input className="input mono r" type="number" step="any" value={values[d.field_key] ?? ""} onChange={(e) => setValues({ ...values, [d.field_key]: e.target.value === "" ? null : Number(e.target.value) })} />
              ) : d.field_type === "date" ? (
                <input className="input mono" type="date" value={values[d.field_key] || ""} onChange={(e) => setValues({ ...values, [d.field_key]: e.target.value })} />
              ) : (
                <input className="input" value={values[d.field_key] ?? ""} onChange={(e) => setValues({ ...values, [d.field_key]: e.target.value })} />
              )}
            </Field>
          ))}
        </Card>
      ))}
    </div>
  );
};

export default ItemDetailDrawer;
