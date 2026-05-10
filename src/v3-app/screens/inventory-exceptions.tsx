// Inventory Exceptions feed (S3).
//
// Lists inventory_exceptions with severity-coded chips and ack /
// resolve / suppress actions. Filters by status and severity.

import React, { useEffect, useMemo, useState } from "react";
import { Banner, Btn, Card, Chip, KPI, KPIRow, WSTabs, WSTitle, Stream } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { ObaraBackend } from "../lib/api";

const SEV_TONE: Record<string, "good" | "info" | "warn" | "bad"> = {
  info: "info", warn: "warn", bad: "bad", critical: "bad",
};

const KIND_LABEL: Record<string, string> = {
  stockout_imminent:    "stockout imminent",
  below_reorder_point:  "below reorder point",
  supplier_delay:       "supplier delay",
  demand_spike:         "demand spike",
  forecast_drift:       "forecast drift",
  allocation_overrun:   "allocation overrun",
  no_default_supplier:  "no default supplier",
  negative_position:    "negative position",
  erp_mismatch:         "ERP mismatch",
};

const InventoryExceptionsScreen: React.FC = () => {
  const [tab, setTab] = useState("open");
  const [exceptions, setExceptions] = useState<{ data: any[]; loading: boolean; error: any }>({ data: [], loading: true, error: null });
  const [bump, setBump] = useState(0);

  useEffect(() => {
    let cancelled = false;
    Promise.resolve(ObaraBackend?.inventory?.exceptions?.list?.({ status: tab }))
      .then((r: any) => { if (!cancelled) setExceptions({ data: r?.exceptions || [], loading: false, error: null }); })
      .catch((err: any) => { if (!cancelled) setExceptions({ data: [], loading: false, error: err }); });
    return () => { cancelled = true; };
  }, [tab, bump]);

  const counts = useMemo(() => {
    const out: Record<string, number> = { critical: 0, bad: 0, warn: 0, info: 0 };
    for (const e of exceptions.data) out[e.severity] = (out[e.severity] || 0) + 1;
    return out;
  }, [exceptions.data]);

  const onAction = async (action: "ack" | "resolve" | "suppress", id: string) => {
    try {
      const note = action !== "ack" ? (prompt(action + " note (optional):") || null) : null;
      const fn = (ObaraBackend as any)?.inventory?.exceptions?.[action];
      await (action === "ack" ? fn?.(id) : fn?.(id, note));
      window.notifySuccess?.("Exception " + action + "'d", id.slice(0, 8));
      setBump((n) => n + 1);
    } catch (err: any) {
      window.notifyError?.(action + " failed", err?.message || String(err));
    }
  };

  return (
    <>
      <WSTitle eyebrow="Procurement" title="Stock Exceptions" meta={exceptions.data.length + " in view"} />
      <div className="ws-content">
        <KPIRow>
          <KPI lbl="Critical" v={String(counts.critical || 0)} d="open" />
          <KPI lbl="High"     v={String(counts.bad || 0)} d="bad severity" />
          <KPI lbl="Warn"     v={String(counts.warn || 0)} d="watch" />
          <KPI lbl="Info"     v={String(counts.info || 0)} d="advisory" />
        </KPIRow>
        <WSTabs
          tabs={[
            { id: "open",         label: "Open" },
            { id: "acknowledged", label: "Acknowledged" },
            { id: "resolved",     label: "Resolved" },
            { id: "suppressed",   label: "Suppressed" },
            { id: "all",          label: "All" },
          ]}
          active={tab}
          onChange={setTab}
        />
        {exceptions.loading ? (
          <Card><div className="body">Loading exceptions…</div></Card>
        ) : exceptions.data.length === 0 ? (
          <Banner kind="good" icon={Icon.check} title="Clean">
            No {tab} exceptions. The engine writes exceptions when a stockout
            looks imminent, a supplier slips ETA, or ERP sources disagree.
          </Banner>
        ) : (
          <Card flush>
            <table className="tbl">
              <thead><tr>
                <th>When</th>
                <th>Severity</th>
                <th>Kind</th>
                <th>Item</th>
                <th>Detail</th>
                <th></th>
              </tr></thead>
              <tbody>
                {exceptions.data.map((e) => (
                  <tr key={e.id}>
                    <td className="mono-sm">{new Date(e.created_at).toLocaleString("en-IN", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</td>
                    <td><Chip k={SEV_TONE[e.severity] || "info"}>{e.severity}</Chip></td>
                    <td>{KIND_LABEL[e.exception_kind] || e.exception_kind}</td>
                    <td>
                      {e.part_no ? (
                        <a className="link" href={"#/inventory-item?part_no=" + encodeURIComponent(e.part_no)}>{e.part_no}</a>
                      ) : <span style={{ color: "var(--ink-3)" }}>—</span>}
                    </td>
                    <td className="mono-sm" style={{ maxWidth: 380, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {JSON.stringify(e.detail).slice(0, 160)}
                    </td>
                    <td className="row gap-sm">
                      {e.status === "open" && (
                        <Btn sm kind="ghost" onClick={() => onAction("ack", e.id)}>ack</Btn>
                      )}
                      {(e.status === "open" || e.status === "acknowledged") && (
                        <>
                          <Btn sm kind="ghost" onClick={() => onAction("resolve", e.id)}>resolve</Btn>
                          <Btn sm kind="ghost" onClick={() => onAction("suppress", e.id)}>suppress</Btn>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </div>
    </>
  );
};

export default InventoryExceptionsScreen;
