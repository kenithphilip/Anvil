// Suppliers + lead-time analytics (S6).
//
// Lists rows from the `suppliers` table with on-time delivery rates
// + lead-time stats. Per-supplier drill-in is a Phase 3.5 follow-up;
// for v1 the table itself is the deliverable.

import React, { useEffect, useState } from "react";
import { Banner, Btn, Card, Chip, KPI, KPIRow, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { AnvilBackend } from "../lib/api";

interface Supplier {
  id: string;
  supplier_code: string;
  supplier_name: string;
  country: string | null;
  default_currency: string | null;
  lead_time_days: number | null;
  lead_time_stddev_days: number | null;
  on_time_delivery_rate_90d: number | null;
  partial_shipment_rate_90d: number | null;
  ordering_cost_override: number | null;
  contact_email: string | null;
  contact_phone: string | null;
}

const fmt = (n: number | null | undefined, suffix = "") =>
  n == null ? "—" : (Math.round(n * 10) / 10).toString() + suffix;

const rateChip = (rate: number | null) => {
  if (rate == null) return <Chip k="info">n/a</Chip>;
  if (rate >= 0.95) return <Chip k="good">{Math.round(rate * 100) + "%"}</Chip>;
  if (rate >= 0.85) return <Chip k="warn">{Math.round(rate * 100) + "%"}</Chip>;
  return <Chip k="bad">{Math.round(rate * 100) + "%"}</Chip>;
};

const InventorySuppliersScreen: React.FC = () => {
  const [suppliers, setSuppliers] = useState<{ data: Supplier[]; loading: boolean; error: any }>({ data: [], loading: true, error: null });
  const [bump, setBump] = useState(0);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<{
    supplier_code: string;
    supplier_name: string;
    country: string;
    default_currency: string;
    lead_time_days: string;
    contact_email: string;
  }>({ supplier_code: "", supplier_name: "", country: "IN", default_currency: "INR", lead_time_days: "", contact_email: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.resolve((AnvilBackend as any)?.inventory?.suppliers?.list?.())
      .then((r: any) => {
        if (cancelled) return;
        setSuppliers({ data: r?.suppliers || [], loading: false, error: null });
      })
      .catch((err: any) => {
        if (cancelled) return;
        setSuppliers({ data: [], loading: false, error: err });
      });
    return () => { cancelled = true; };
  }, [bump]);

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      if (!form.supplier_code || !form.supplier_name) throw new Error("supplier_code + supplier_name required");
      await (AnvilBackend as any)?.inventory?.suppliers?.upsert?.({
        supplier_code: form.supplier_code,
        supplier_name: form.supplier_name,
        country: form.country || null,
        default_currency: form.default_currency || null,
        lead_time_days: form.lead_time_days ? Number(form.lead_time_days) : null,
        contact_email: form.contact_email || null,
      });
      window.notifySuccess?.("Supplier upserted", form.supplier_code);
      setShowCreate(false);
      setForm({ supplier_code: "", supplier_name: "", country: "IN", default_currency: "INR", lead_time_days: "", contact_email: "" });
      setBump((n) => n + 1);
    } catch (e: any) { setErr(String(e?.message || e)); }
    finally { setBusy(false); }
  };

  return (
    <>
      <WSTitle
        eyebrow="Procurement"
        title="Suppliers"
        meta={suppliers.data.length + " active"}
        right={<Btn sm kind="primary" onClick={() => setShowCreate(true)}>New supplier</Btn>}
      />
      <div className="ws-content">
        <KPIRow>
          <KPI lbl="Suppliers"   v={String(suppliers.data.length)} d="on the books" />
          <KPI lbl="Avg lead"    v={fmt(
            suppliers.data.reduce((s, x) => s + (x.lead_time_days || 0), 0) / Math.max(1, suppliers.data.length),
            " days"
          )} d="weighted" />
          <KPI lbl="On-time"     v={fmt(
            (suppliers.data.reduce((s, x) => s + (x.on_time_delivery_rate_90d || 0), 0)
              / Math.max(1, suppliers.data.length)) * 100,
            "%"
          )} d="rolling 90d" />
          <KPI lbl="Partial-ship" v={fmt(
            (suppliers.data.reduce((s, x) => s + (x.partial_shipment_rate_90d || 0), 0)
              / Math.max(1, suppliers.data.length)) * 100,
            "%"
          )} d="rolling 90d" />
        </KPIRow>
        {suppliers.loading ? (
          <Card><div className="body">Loading suppliers…</div></Card>
        ) : suppliers.data.length === 0 ? (
          <Banner kind="info" icon={Icon.info} title="No suppliers yet">
            Suppliers populate via the seed pack
            (<span className="mono">supabase/seed/360_inventory_planning.sql</span>),
            via the migration 087 backfill from
            <span className="mono"> source_pos.supplier</span> text, or
            via this screen's create form (Phase 3.5).
          </Banner>
        ) : (
          <Card flush>
            <table className="tbl">
              <thead><tr>
                <th>Code</th>
                <th>Name</th>
                <th>Country</th>
                <th>Currency</th>
                <th className="r">Lead time</th>
                <th className="r">σ lead</th>
                <th>On-time 90d</th>
                <th>Partial 90d</th>
              </tr></thead>
              <tbody>
                {suppliers.data.map((s) => (
                  <tr key={s.id}>
                    <td className="mono-sm">{s.supplier_code}</td>
                    <td>{s.supplier_name}</td>
                    <td>{s.country || "—"}</td>
                    <td>{s.default_currency || "—"}</td>
                    <td className="r mono">{fmt(s.lead_time_days, " d")}</td>
                    <td className="r mono">{fmt(s.lead_time_stddev_days, " d")}</td>
                    <td>{rateChip(s.on_time_delivery_rate_90d)}</td>
                    <td>{rateChip(s.partial_shipment_rate_90d)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
        <div style={{ marginTop: 16 }}>
          <Btn kind="ghost" onClick={() => (window.location.hash = "#/inventory-planning")}>back to planning</Btn>
        </div>
      </div>

      {showCreate && (
        <div className="modal-backdrop" onClick={() => setShowCreate(false)}>
          <div className="modal" role="dialog" aria-modal="true" onClick={(ev) => ev.stopPropagation()} style={{ maxWidth: 520 }}>
            <div className="modal-h">
              <span className="ti">New supplier</span>
              <Btn icon kind="ghost" sm onClick={() => setShowCreate(false)} aria-label="Close" title="Close (Esc)">{Icon.close}</Btn>
            </div>
            <div className="modal-body" style={{ display: "grid", gap: 10 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <label className="lbl">Supplier code
                  <input type="text" value={form.supplier_code} onChange={(ev) => setForm({ ...form, supplier_code: ev.target.value })} />
                </label>
                <label className="lbl">Country
                  <input type="text" value={form.country} onChange={(ev) => setForm({ ...form, country: ev.target.value })} />
                </label>
              </div>
              <label className="lbl">Supplier name
                <input type="text" value={form.supplier_name} onChange={(ev) => setForm({ ...form, supplier_name: ev.target.value })} />
              </label>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <label className="lbl">Default currency
                  <input type="text" value={form.default_currency} onChange={(ev) => setForm({ ...form, default_currency: ev.target.value })} />
                </label>
                <label className="lbl">Lead time (days)
                  <input type="number" min={0} value={form.lead_time_days} onChange={(ev) => setForm({ ...form, lead_time_days: ev.target.value })} />
                </label>
              </div>
              <label className="lbl">Contact email
                <input type="email" value={form.contact_email} onChange={(ev) => setForm({ ...form, contact_email: ev.target.value })} />
              </label>
              {err && (<Banner kind="bad" icon={Icon.alert} title="Could not save"><span className="mono-sm">{err}</span></Banner>)}
            </div>
            <div className="modal-f">
              <Btn kind="ghost" onClick={() => setShowCreate(false)}>Cancel</Btn>
              <Btn kind="primary" disabled={busy} onClick={submit}>{busy ? "Saving…" : "Save"}</Btn>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default InventorySuppliersScreen;
