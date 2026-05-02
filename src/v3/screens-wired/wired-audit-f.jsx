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
    () => window.ObaraBackend?.audit?.list?.({ limit: 200 }) || Promise.resolve({ events: [] }),
    []
  );

  const [actionFilter, setActionFilter] = useStateW("");
  const [objectTypeFilter, setObjectTypeFilter] = useStateW("");
  const [fromDate, setFromDate] = useStateW("");
  const [toDate, setToDate] = useStateW("");

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
    if (typeof window.runOpsAction === "function") {
      try {
        const result = window.runOpsAction("export-audit-csv");
        if (result) return;
      } catch (_) { /* fall through to client-side */ }
    }
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
              </tr></thead>
              <tbody>
                {filtered.slice(0, 200).map((r, i) => (
                  <tr key={r.id || i}>
                    <td className="mono-sm">{r.created_at ? new Date(r.created_at).toLocaleString("en-IN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "short" }) : "—"}</td>
                    <td className="mono-sm">{r.actor_email || r.actor_id || r.user_id || "system"}</td>
                    <td className="mono"><span className="pri">{r.action || "—"}</span></td>
                    <td className="mono-sm">{r.object_type || "—"}</td>
                    <td className="mono-sm">{truncId(r.object_id)}</td>
                    <td className="mono-sm" title={typeof r.detail === "object" ? JSON.stringify(r.detail) : String(r.detail || "")}>
                      {detailSummary(r.detail)}
                    </td>
                  </tr>
                ))}
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

window.AuditLog = WiredAudit;
