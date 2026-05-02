// @ts-nocheck — converted screen, types follow in a focused TS pass
import React, { useEffect, useState } from "react";
import { useFetch } from "../lib/helpers";
import { Banner, Btn, Card, Chip, WSTabs, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";

// ============================================================
// ANVIL v3 — wired CAR Reports (Corrective Action Reports)
// ============================================================

const CAR_TABS = [
  { id: "open",          label: "Open",          match: (s) => ["OPEN", "DRAFT", "CONTAINMENT"].includes(s) },
  { id: "investigating", label: "Investigating", match: (s) => ["INVESTIGATING", "ROOT_CAUSE", "VERIFICATION"].includes(s) },
  { id: "resolved",      label: "Resolved",      match: (s) => ["RESOLVED", "EFFECTIVE"].includes(s) },
  { id: "closed",        label: "Closed",        match: (s) => ["CLOSED", "CANCELLED"].includes(s) },
];

const CAR_STATUS_CHIP = {
  OPEN:           { label: "open",          k: "warn" },
  DRAFT:          { label: "draft",         k: "ghost" },
  CONTAINMENT:    { label: "containment",   k: "warn" },
  INVESTIGATING:  { label: "investigating", k: "warn" },
  ROOT_CAUSE:     { label: "root cause",    k: "warn" },
  VERIFICATION:   { label: "verification",  k: "info" },
  RESOLVED:       { label: "resolved",      k: "good" },
  EFFECTIVE:      { label: "effective",     k: "good" },
  CLOSED:         { label: "closed",        k: "ghost" },
  CANCELLED:      { label: "cancelled",     k: "ghost" },
};

const CAR_SEVERITY_CHIP = {
  CRITICAL: { label: "critical", k: "bad" },
  HIGH:     { label: "high",     k: "bad" },
  MED:      { label: "med",      k: "warn" },
  MEDIUM:   { label: "medium",   k: "warn" },
  LOW:      { label: "low",      k: "info" },
};

const carFmtDate = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "2-digit" });
};

const carFetchPath = async (path) => {
  const cfg = JSON.parse(localStorage.getItem("obara:backend_config") || "{}");
  if (!cfg.url) return [];
  const session = JSON.parse(localStorage.getItem("obara:backend_session") || "null");
  const headers = { "Content-Type": "application/json" };
  if (session?.access_token) headers["Authorization"] = "Bearer " + session.access_token;
  if (cfg.tenantId) headers["x-obara-tenant"] = cfg.tenantId;
  const resp = await fetch(cfg.url.replace(/\/+$/, "") + path, { headers });
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  return resp.json();
};

const WiredCAR = () => {
  const { useState: uC } = React;
  const [active, setActive] = uC("open");

  const cars = useFetch(() => carFetchPath("/api/service/car_reports"), []);
  const closures = useFetch(() => carFetchPath("/api/service/closure_reports"), []);

  const carRows = (() => {
    const d = cars.data;
    if (!d) return [];
    if (Array.isArray(d)) return d;
    return d.rows || d.car_reports || d.reports || [];
  })();

  const closureRows = (() => {
    const d = closures.data;
    if (!d) return [];
    if (Array.isArray(d)) return d;
    return d.rows || d.closure_reports || d.reports || [];
  })();

  // Build closure index by car id for quick lookup
  const closuresByCar = {};
  closureRows.forEach((cl) => {
    const k = cl.car_report_id || cl.car_id;
    if (k) closuresByCar[k] = cl;
  });

  const counts = Object.fromEntries(CAR_TABS.map((t) => [t.id, carRows.filter((c) => t.match((c.status || "").toUpperCase())).length]));
  const filtered = carRows.filter((c) => CAR_TABS.find((t) => t.id === active)?.match((c.status || "").toUpperCase()));

  if (cars.loading) {
    return (
      <div className="ws ws-no-rail">
        <WSTitle eyebrow="loading" title="CAR reports" />
        <div className="ws-content"><Card><div className="body">Loading CAR reports…</div></Card></div>
      </div>
    );
  }

  if (cars.error) {
    return (
      <div className="ws ws-no-rail">
        <WSTitle eyebrow="error" title="Could not load CAR reports" />
        <div className="ws-content">
          <Banner kind="bad" icon={Icon.alert} title="Backend unreachable" action={<Btn sm onClick={cars.reload}>Retry</Btn>}>
            <span className="mono-sm">{String(cars.error.message || cars.error)}</span>
          </Banner>
        </div>
      </div>
    );
  }

  return (
    <>
      <WSTitle
        eyebrow="Service · CAR Reports"
        title="Corrective Action Reports"
        meta={`${carRows.length} total · ${counts.open || 0} open · ${closureRows.length} closures`}
        right={<>
          <Btn icon kind="ghost" sm onClick={cars.reload} title="Refresh">{Icon.cycle}</Btn>
          <Btn sm kind="primary" onClick={() => window.location.hash = "#/service/car?new=1"}>{Icon.plus} New CAR</Btn>
        </>}
      />
      <WSTabs
        tabs={CAR_TABS.map((t) => ({ id: t.id, label: t.label, count: counts[t.id] }))}
        active={active}
        onChange={setActive}
      />

      <div className="ws-content">
        {closures.error && (
          <Banner kind="warn" icon={Icon.alert} title="Closure reports failed to load">
            <span className="mono-sm">{String(closures.error.message || closures.error)}</span>
          </Banner>
        )}

        <Card flush>
          <table className="tbl">
            <thead><tr>
              <th>CAR number</th>
              <th>Customer</th>
              <th>Equipment</th>
              <th>Raised</th>
              <th>Severity</th>
              <th>Status</th>
              <th>Owner</th>
              <th></th>
            </tr></thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={8} className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
                  No CAR reports in this tab.
                </td></tr>
              ) : filtered.map((c) => {
                const status = (c.status || "OPEN").toUpperCase();
                const sev = (c.severity || "MED").toUpperCase();
                const chip = CAR_STATUS_CHIP[status] || { label: status.toLowerCase(), k: "ghost" };
                const sevChip = CAR_SEVERITY_CHIP[sev] || { label: sev.toLowerCase(), k: "ghost" };
                const carNum = c.car_number || c.number || c.id?.slice(0, 8) || "—";
                const closure = closuresByCar[c.id];
                return (
                  <tr key={c.id || carNum}>
                    <td className="mono">
                      <span className="pri">{carNum}</span>
                      {closure && <span className="mono-sm" style={{ marginLeft: 6, color: "var(--ink-4)" }} title="Closure filed">·closed</span>}
                    </td>
                    <td>{c.customer_name || c.customer?.customer_name || c.customer_id?.slice(0, 8) || "—"}</td>
                    <td className="mono-sm">{c.equipment_label || c.equipment?.label || c.equipment_serial || c.equipment_id?.slice(0, 8) || "—"}</td>
                    <td className="mono-sm">{carFmtDate(c.raised_at || c.opened_at || c.created_at)}</td>
                    <td><Chip k={sevChip.k}>{sevChip.label}</Chip></td>
                    <td><Chip k={chip.k}>{chip.label}</Chip></td>
                    <td className="mono-sm">{c.owner_name || c.owner?.name || c.assigned_to_name || "—"}</td>
                    <td><Btn sm onClick={() => window.location.hash = `#/service/car?id=${c.id}`}>open {Icon.arrowR}</Btn></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      </div>
    </>
  );
};


export default WiredCAR;
