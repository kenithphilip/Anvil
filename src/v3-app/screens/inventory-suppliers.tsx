// Suppliers + lead-time analytics (S6).
//
// Lists rows from the `suppliers` table with on-time delivery rates
// + lead-time stats. Per-supplier drill-in is a Phase 3.5 follow-up;
// for v1 the table itself is the deliverable.

import React, { useEffect, useState } from "react";
import { Banner, Btn, Card, Chip, KPI, KPIRow, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { ObaraBackend } from "../lib/api";

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

  useEffect(() => {
    let cancelled = false;
    Promise.resolve((ObaraBackend as any)?.inventory?.suppliers?.list?.())
      .then((r: any) => {
        if (cancelled) return;
        setSuppliers({ data: r?.suppliers || [], loading: false, error: null });
      })
      .catch((err: any) => {
        if (cancelled) return;
        setSuppliers({ data: [], loading: false, error: err });
      });
    return () => { cancelled = true; };
  }, []);

  return (
    <>
      <WSTitle eyebrow="Procurement" title="Suppliers" meta={suppliers.data.length + " active"} />
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
    </>
  );
};

export default InventorySuppliersScreen;
