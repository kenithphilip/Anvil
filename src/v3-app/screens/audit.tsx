import React, { useEffect, useState } from "react";
import { useFetch } from "../lib/helpers";
import { Banner, Btn, Card, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { ObaraBackend } from "../lib/api";

// Map audit object_type -> hash route + param so an "open" button on
// each row can navigate to the affected entity. The audit log is
// useless without drill-through: a row tells you "field.override on
// order X at 10:38" but the operator had no way to jump to that
// order. The map below covers every object_type that the API's
// recordAudit() actually emits today.
const AUDIT_ROUTE_FOR_OBJECT: Record<string, (id: string) => string> = {
  order:           (id) => "#/so?id=" + id,
  source_po:       (id) => "#/spo?id=" + id,
  internal_so:     (id) => "#/internal?id=" + id,
  customer:        (id) => "#/customers?id=" + id,
  document:        (id) => "#/documents?id=" + id,
  extraction_run:  (id) => "#/documents?run=" + id,
  shipment:        (id) => "#/shipments?id=" + id,
  einvoice:        (id) => "#/einvoice?id=" + id,
  invoice:         (id) => "#/invoices?id=" + id,
  service_visit:   (id) => "#/svc-visits?id=" + id,
  amc_contract:    (id) => "#/amc?id=" + id,
  car_report:      (id) => "#/car?id=" + id,
  project:         (id) => "#/projects?id=" + id,
  lead:            (id) => "#/leads?id=" + id,
  opportunity:     (id) => "#/opps?id=" + id,
};

const openAuditTarget = (object_type?: string, object_id?: string) => {
  if (!object_type || !object_id) return null;
  const builder = AUDIT_ROUTE_FOR_OBJECT[object_type];
  if (!builder) return null;
  return builder(object_id);
};

// ============================================================
// ANVIL v3 — wired Audit Log
// Wave F · System
// Filter bar + table + CSV / JSON export.
// ============================================================

const auditEventRows = (resp) => {
  if (!resp) return [];
  if (Array.isArray(resp)) return resp;
  if (Array.isArray(resp.events)) return resp.events;
  if (Array.isArray(resp.rows)) return resp.rows;
  return [];
};

const truncId = (id) => {
  if (!id) return "—";
  const s = String(id);
  return s.length > 10 ? s.slice(0, 10) + "…" : s;
};

const detailSummary = (detail) => {
  if (!detail) return "—";
  if (typeof detail === "string") return detail.length > 60 ? detail.slice(0, 60) + "…" : detail;
  try {
    const json = JSON.stringify(detail);
    return json.length > 60 ? json.slice(0, 60) + "…" : json;
  } catch (_) {
    return String(detail);
  }
};

const downloadBlob = (filename, contents, mime) => {
  const blob = new Blob([contents], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

const csvEscape = (v) => {
  if (v == null) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
};

const rowsToCsv = (rows) => {
  const header = ["timestamp", "actor", "action", "object_type", "object_id", "detail"];
  const body = rows.map((r) => [
    r.created_at || "",
    r.actor_email || r.actor_id || r.user_id || "",
    r.action || "",
    r.object_type || "",
    r.object_id || "",
    typeof r.detail === "object" ? JSON.stringify(r.detail) : (r.detail || ""),
  ].map(csvEscape).join(","));
  return [header.join(","), ...body].join("\n");
};

const WiredAudit = () => {
  const list = useFetch(
    () => ObaraBackend?.audit?.list?.({ limit: 200 }) || Promise.resolve({ events: [] }),
    []
  );

  const [actionFilter, setActionFilter] = useState("");
  const [objectTypeFilter, setObjectTypeFilter] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  const allRows = auditEventRows(list.data);

  const filtered = allRows.filter((r) => {
    if (actionFilter && !(r.action || "").toLowerCase().includes(actionFilter.toLowerCase())) return false;
    if (objectTypeFilter && !(r.object_type || "").toLowerCase().includes(objectTypeFilter.toLowerCase())) return false;
    if (fromDate) {
      const t = new Date(r.created_at).getTime();
      if (Number.isNaN(t) || t < new Date(fromDate).getTime()) return false;
    }
    if (toDate) {
      const t = new Date(r.created_at).getTime();
      const toEnd = new Date(toDate).getTime() + 24 * 3600_000;
      if (Number.isNaN(t) || t > toEnd) return false;
    }
    return true;
  });

  const exportCsv = () => {
    // Client-side CSV export. The legacy unified app exposed a
    // `window.runOpsAction("export-audit-csv")` shortcut that filtered
    // server-side; in the Vite v3-app we already have the filtered rows
    // in memory, so we serialize directly.
    downloadBlob(`audit-${new Date().toISOString().slice(0, 10)}.csv`, rowsToCsv(filtered), "text/csv");
  };

  const exportJson = () => {
    downloadBlob(`audit-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(filtered, null, 2), "application/json");
  };

  return (
    <>
      <WSTitle
        eyebrow="System · Audit"
        title="Audit log"
        meta={`${allRows.length} events · ${filtered.length} matching filters`}
        right={<>
          <Btn icon kind="ghost" sm onClick={list.reload} title="Refresh">{Icon.cycle}</Btn>
          <Btn sm kind="ghost" onClick={exportCsv} disabled={filtered.length === 0}>{Icon.download} CSV</Btn>
          <Btn sm kind="ghost" onClick={exportJson} disabled={filtered.length === 0}>{Icon.download} JSON</Btn>
        </>}
      />

      <div className="ws-content">
        {list.error && (
          <Banner kind="bad" icon={Icon.alert} title="Failed to load audit log" action={<Btn sm onClick={list.reload}>Retry</Btn>}>
            <span className="mono-sm">{String(list.error.message || list.error)}</span>
          </Banner>
        )}

        <Card title="Filters" eyebrow="action · object · date">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr auto", gap: 8, alignItems: "end" }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span className="mono-sm" style={{ color: "var(--ink-3)" }}>Action</span>
              <input className="input" value={actionFilter} aria-label="Filter by action"
                placeholder="e.g. order.created"
                onChange={(ev) => setActionFilter(ev.target.value)} style={{ height: 30 }} />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span className="mono-sm" style={{ color: "var(--ink-3)" }}>Object type</span>
              <input className="input" value={objectTypeFilter} aria-label="Filter by object type"
                placeholder="e.g. order"
                onChange={(ev) => setObjectTypeFilter(ev.target.value)} style={{ height: 30 }} />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span className="mono-sm" style={{ color: "var(--ink-3)" }}>From</span>
              <input type="date" className="input" value={fromDate} aria-label="From date"
                onChange={(ev) => setFromDate(ev.target.value)} style={{ height: 30 }} />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span className="mono-sm" style={{ color: "var(--ink-3)" }}>To</span>
              <input type="date" className="input" value={toDate} aria-label="To date"
                onChange={(ev) => setToDate(ev.target.value)} style={{ height: 30 }} />
            </label>
            <Btn sm kind="ghost" onClick={() => { setActionFilter(""); setObjectTypeFilter(""); setFromDate(""); setToDate(""); }}>
              clear
            </Btn>
          </div>
        </Card>

        <Card flush>
          {list.loading ? (
            <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>Loading audit events…</div>
          ) : filtered.length === 0 ? (
            <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
              {allRows.length === 0 ? "No audit events yet." : "No events match the current filters."}
            </div>
          ) : (
            <table className="tbl">
              <thead><tr>
                <th scope="col">Timestamp</th>
                <th scope="col">Actor</th>
                <th scope="col">Action</th>
                <th scope="col">Object type</th>
                <th scope="col">Object id</th>
                <th scope="col">Detail</th>
                <th scope="col" />
              </tr></thead>
              <tbody>
                {filtered.slice(0, 200).map((r, i) => {
                  const target = openAuditTarget(r.object_type, r.object_id);
                  return (
                    <tr key={r.id || i}>
                      <td className="mono-sm">{r.created_at ? new Date(r.created_at).toLocaleString("en-IN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "short" }) : "—"}</td>
                      <td className="mono-sm">{r.actor_email || r.actor_id || r.user_id || "system"}</td>
                      <td className="mono"><span className="pri">{r.action || "—"}</span></td>
                      <td className="mono-sm">{r.object_type || "—"}</td>
                      <td className="mono-sm">{truncId(r.object_id)}</td>
                      <td className="mono-sm" title={typeof r.detail === "object" ? JSON.stringify(r.detail) : String(r.detail || "")}>
                        {detailSummary(r.detail)}
                      </td>
                      <td>
                        {target ? (
                          <Btn sm kind="ghost" onClick={() => { window.location.hash = target; }} title="Open the affected entity">
                            open {Icon.arrowR}
                          </Btn>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {filtered.length > 200 && (
            <div className="mono-sm" style={{ padding: 12, textAlign: "center", color: "var(--ink-3)", borderTop: "1px solid var(--hairline-2)" }}>
              Showing 200 of {filtered.length} matching events · refine the filters.
            </div>
          )}
        </Card>
      </div>
    </>
  );
};


export default WiredAudit;
