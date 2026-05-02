// ============================================================
// ANVIL v3 — wired Forecasts
// Wave E · 3 grouping tabs · latest snapshot rows
// ============================================================

const forecastFetch = async () => {
  if (window.ObaraBackend?.forecast?.pipeline) return window.ObaraBackend.forecast.pipeline();
  if (window.ObaraBackend?.forecast?.get) return window.ObaraBackend.forecast.get();
  // Fallback to direct fetch
  const cfg = (() => { try { return JSON.parse(localStorage.getItem("obara:backend_config") || "{}"); } catch (_) { return {}; } })();
  const session = (() => { try { return JSON.parse(localStorage.getItem("obara:backend_session") || "null"); } catch (_) { return null; } })();
  if (!cfg.url) throw new Error("Backend URL not configured");
  const headers = { "Content-Type": "application/json" };
  if (session?.access_token) headers["Authorization"] = "Bearer " + session.access_token;
  if (cfg.tenantId) headers["x-obara-tenant"] = cfg.tenantId;
  const url = cfg.url.replace(/\/+$/, "") + "/api/forecast";
  const resp = await fetch(url, { headers });
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  return resp.json();
};

const fcRowsOf = (resp, key) => {
  if (!resp) return [];
  if (Array.isArray(resp)) return resp;
  if (key && Array.isArray(resp[key])) return resp[key];
  if (Array.isArray(resp.rows)) return resp.rows;
  if (Array.isArray(resp.snapshots)) return resp.snapshots;
  return [];
};

const WiredForecasts = () => {
  const [tab, setTab] = useStateW("territory");
  const data = useFetch(forecastFetch, []);

  const tabs = [
    { id: "territory", label: "By territory" },
    { id: "type",      label: "By customer type" },
    { id: "mode",      label: "By order mode" },
  ];

  if (data.loading) {
    return (
      <div className="ws ws-no-rail">
        <WSTitle eyebrow="Forecast" title="Forecasts" meta="loading…" />
        <div className="ws-content"><Card><div className="body">Loading forecasts…</div></Card></div>
      </div>
    );
  }

  if (data.error) {
    return (
      <div className="ws ws-no-rail">
        <WSTitle eyebrow="Forecast" title="Forecasts" meta="error" />
        <div className="ws-content">
          <Banner kind="bad" icon={Icon.alert} title="Could not load forecasts"
                  action={<Btn sm onClick={data.reload}>Retry</Btn>}>
            <span className="mono-sm">{String(data.error.message || data.error)}</span>
          </Banner>
        </div>
      </div>
    );
  }

  const payload = data.data || {};
  // Pull latest snapshot per grouping. The backend may return one of several shapes.
  const allRows = fcRowsOf(payload, "snapshots");
  const latest = (groupKey) => {
    const filtered = allRows.filter((r) => r.grouping === groupKey || r.group === groupKey || r.dimension === groupKey);
    if (!filtered.length) return [];
    // Sort desc by snapshot_at then take rows with the same most-recent snapshot timestamp.
    const sorted = filtered.slice().sort((a, b) => new Date(b.snapshot_at || b.created_at || 0) - new Date(a.snapshot_at || a.created_at || 0));
    const pivot = sorted[0].snapshot_at || sorted[0].created_at;
    return sorted.filter((r) => (r.snapshot_at || r.created_at) === pivot);
  };

  // Common shape: payload.byTerritory etc.
  const territoryRows = Array.isArray(payload.byTerritory) ? payload.byTerritory : Array.isArray(payload.territory) ? payload.territory : latest("territory");
  const typeRows = Array.isArray(payload.byCustomerType) ? payload.byCustomerType : Array.isArray(payload.customerType) ? payload.customerType : latest("customer_type");
  const modeRows = Array.isArray(payload.byOrderMode) ? payload.byOrderMode : Array.isArray(payload.orderMode) ? payload.orderMode : latest("order_mode");

  const snapshotAt = payload.snapshot_at || payload.snapshotAt || (allRows[0] && (allRows[0].snapshot_at || allRows[0].created_at)) || null;

  return (
    <>
      <WSTitle
        eyebrow="Forecast"
        title="Forecasts"
        meta={snapshotAt ? `latest snapshot · ${ageLabel(snapshotAt)} ago` : "no snapshot yet"}
        right={<>
          <Btn icon kind="ghost" sm onClick={data.reload} title="Refresh">{Icon.cycle}</Btn>
          <Btn sm kind="primary" onClick={() => window.ObaraBackend?.forecast?.snapshot?.().then(() => data.reload())}>{Icon.bolt} new snapshot</Btn>
        </>}
      />
      <WSTabs tabs={tabs} active={tab} onChange={setTab} />

      <div className="ws-content">
        {tab === "territory" && (
          <Card flush>
            {territoryRows.length === 0 ? (
              <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>No territory rows in latest snapshot.</div>
            ) : (
              <table className="tbl">
                <thead><tr>
                  <th>Territory</th>
                  <th className="r">Pipeline value</th>
                  <th className="r">Booked</th>
                  <th className="r">Win rate</th>
                  <th className="r">Updated</th>
                </tr></thead>
                <tbody>
                  {territoryRows.slice(0, 200).map((r, i) => (
                    <tr key={r.id || i}>
                      <td><span className="pri">{r.territory || r.region || r.label || r.key || "—"}</span></td>
                      <td className="r mono">{r.pipeline != null ? fmtINRShort(Number(r.pipeline)) : (r.value != null ? fmtINRShort(Number(r.value)) : "—")}</td>
                      <td className="r mono">{r.booked != null ? fmtINRShort(Number(r.booked)) : "—"}</td>
                      <td className="r mono">{r.win_rate != null ? `${(Number(r.win_rate) * 100).toFixed(0)}%` : "—"}</td>
                      <td className="r mono">{r.snapshot_at ? ageLabel(r.snapshot_at) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        )}

        {tab === "type" && (
          <Card flush>
            {typeRows.length === 0 ? (
              <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>No customer-type rows in latest snapshot.</div>
            ) : (
              <table className="tbl">
                <thead><tr>
                  <th>Customer type</th>
                  <th className="r">Accounts</th>
                  <th className="r">Pipeline value</th>
                  <th className="r">Booked</th>
                  <th className="r">Updated</th>
                </tr></thead>
                <tbody>
                  {typeRows.slice(0, 200).map((r, i) => (
                    <tr key={r.id || i}>
                      <td><Chip k={r.customer_type === "AUTO_OEM" ? "info" : r.customer_type === "TIER_ONE" ? "warn" : "ghost"}>{(r.customer_type || r.type || r.label || "—").toLowerCase()}</Chip></td>
                      <td className="r mono">{r.accounts != null ? Number(r.accounts).toLocaleString("en-IN") : "—"}</td>
                      <td className="r mono">{r.pipeline != null ? fmtINRShort(Number(r.pipeline)) : (r.value != null ? fmtINRShort(Number(r.value)) : "—")}</td>
                      <td className="r mono">{r.booked != null ? fmtINRShort(Number(r.booked)) : "—"}</td>
                      <td className="r mono">{r.snapshot_at ? ageLabel(r.snapshot_at) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        )}

        {tab === "mode" && (
          <Card flush>
            {modeRows.length === 0 ? (
              <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>No order-mode rows in latest snapshot.</div>
            ) : (
              <table className="tbl">
                <thead><tr>
                  <th>Mode</th>
                  <th className="r">Orders</th>
                  <th className="r">Value</th>
                  <th className="r">Avg cycle</th>
                  <th className="r">Updated</th>
                </tr></thead>
                <tbody>
                  {modeRows.slice(0, 200).map((r, i) => (
                    <tr key={r.id || i}>
                      <td><Chip k={r.order_mode === "INTERNAL" ? "plum" : (r.order_mode || "").startsWith("PROJECT") ? "info" : "ghost"}>{r.order_mode || r.mode || r.label || "—"}</Chip></td>
                      <td className="r mono">{r.orders != null ? Number(r.orders).toLocaleString("en-IN") : "—"}</td>
                      <td className="r mono">{r.value != null ? fmtINRShort(Number(r.value)) : "—"}</td>
                      <td className="r mono">{r.avg_cycle_days != null ? `${Number(r.avg_cycle_days).toFixed(0)}d` : "—"}</td>
                      <td className="r mono">{r.snapshot_at ? ageLabel(r.snapshot_at) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        )}
      </div>
    </>
  );
};

window.Forecasts = WiredForecasts;
