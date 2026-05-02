// ============================================================
// ANVIL v3 — wired Findings (anomaly · quality)
// Wave E · 3 status tabs · resolve action
// ============================================================

const findingFetch = async () => {
  const cfg = (() => { try { return JSON.parse(localStorage.getItem("obara:backend_config") || "{}"); } catch (_) { return {}; } })();
  const session = (() => { try { return JSON.parse(localStorage.getItem("obara:backend_session") || "null"); } catch (_) { return null; } })();
  if (!cfg.url) throw new Error("Backend URL not configured");
  const headers = { "Content-Type": "application/json" };
  if (session?.access_token) headers["Authorization"] = "Bearer " + session.access_token;
  if (cfg.tenantId) headers["x-obara-tenant"] = cfg.tenantId;
  const url = cfg.url.replace(/\/+$/, "") + "/api/findings";
  const resp = await fetch(url, { headers });
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  return resp.json();
};

const findingRowsOf = (resp) => {
  if (!resp) return [];
  if (Array.isArray(resp)) return resp;
  if (Array.isArray(resp.findings)) return resp.findings;
  if (Array.isArray(resp.rows)) return resp.rows;
  return [];
};

const SEV_CHIP = (s) => {
  const k = s === "high" ? "bad" : s === "med" ? "warn" : "ghost";
  return <Chip k={k}>{s || "low"}</Chip>;
};

const WiredAnomaly = () => {
  const list = useFetch(findingFetch, []);
  const [tab, setTab] = useStateW("open");
  const [resolving, setResolving] = useStateW(null);
  const [resolveError, setResolveError] = useStateW(null);

  const resolveOne = async (id) => {
    setResolving(id);
    setResolveError(null);
    try {
      await window.ObaraBackend?.findings?.resolve?.(id, true);
      list.reload();
    } catch (err) {
      setResolveError(err);
    } finally {
      setResolving(null);
    }
  };

  if (list.loading) {
    return (
      <div className="ws ws-no-rail">
        <WSTitle eyebrow="Quality · Findings" title="Findings" meta="loading…" />
        <div className="ws-content"><Card><div className="body">Loading findings…</div></Card></div>
      </div>
    );
  }

  if (list.error) {
    return (
      <div className="ws ws-no-rail">
        <WSTitle eyebrow="Quality · Findings" title="Findings" meta="error" />
        <div className="ws-content">
          <Banner kind="bad" icon={Icon.alert} title="Could not load findings"
                  action={<Btn sm onClick={list.reload}>Retry</Btn>}>
            <span className="mono-sm">{String(list.error.message || list.error)}</span>
          </Banner>
        </div>
      </div>
    );
  }

  const all = findingRowsOf(list.data);
  const matchTab = (r) => {
    const status = (r.status || (r.resolved ? "resolved" : r.suppressed ? "suppressed" : "open")).toLowerCase();
    if (tab === "open")       return status !== "resolved" && status !== "suppressed";
    if (tab === "resolved")   return status === "resolved" || r.resolved === true;
    if (tab === "suppressed") return status === "suppressed" || r.suppressed === true;
    return true;
  };
  const filtered = all.filter(matchTab);

  const tabs = [
    { id: "open",       label: "Open",       count: all.filter((r) => !(r.resolved || r.suppressed) && (r.status || "open").toLowerCase() === "open").length },
    { id: "resolved",   label: "Resolved",   count: all.filter((r) => r.resolved === true || (r.status || "").toLowerCase() === "resolved").length },
    { id: "suppressed", label: "Suppressed", count: all.filter((r) => r.suppressed === true || (r.status || "").toLowerCase() === "suppressed").length },
  ];

  return (
    <>
      <WSTitle
        eyebrow="Quality · Findings"
        title="Findings"
        meta={`${all.length} total · ${tabs[0].count} open`}
        right={<>
          <Btn icon kind="ghost" sm onClick={list.reload} title="Refresh">{Icon.cycle}</Btn>
        </>}
      />
      <WSTabs tabs={tabs} active={tab} onChange={setTab} />

      <div className="ws-content">
        {resolveError && (
          <Banner kind="bad" icon={Icon.alert} title="Resolve failed">
            <span className="mono-sm">{String(resolveError.message || resolveError)}</span>
          </Banner>
        )}

        <Card flush>
          {filtered.length === 0 ? (
            <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
              {tab === "open" ? "All clear · no open findings." : `No ${tab} findings.`}
            </div>
          ) : (
            <table className="tbl">
              <thead><tr>
                <th>Order ref</th>
                <th>Field</th>
                <th>Severity</th>
                <th>Suggested fix</th>
                <th>Status</th>
                <th className="r">Age</th>
                <th style={{ width: 110 }}></th>
              </tr></thead>
              <tbody>
                {filtered.slice(0, 200).map((r) => {
                  const status = (r.status || (r.resolved ? "resolved" : r.suppressed ? "suppressed" : "open")).toLowerCase();
                  const sev = (r.severity || r.sev || "low").toLowerCase();
                  const orderRef = r.order_ref || r.po_number || r.quote_number || (r.order_id ? r.order_id.slice(0, 8) : "—");
                  const created = r.created_at || r.detected_at;
                  return (
                    <tr key={r.id}>
                      <td className="mono"><span className="pri">{orderRef}</span></td>
                      <td className="mono-sm">{r.field || r.field_name || "—"}</td>
                      <td>{SEV_CHIP(sev)}</td>
                      <td>{r.suggested_fix || r.suggestion || "—"}</td>
                      <td><Chip k={status === "open" ? "warn" : status === "resolved" ? "good" : "ghost"}>{status}</Chip></td>
                      <td className="r mono">{created ? ageLabel(created) : "—"}</td>
                      <td>
                        {tab === "open" && (
                          <Btn
                            sm
                            disabled={resolving === r.id}
                            onClick={() => resolveOne(r.id)}
                          >
                            {resolving === r.id ? "resolving…" : "resolve"}
                          </Btn>
                        )}
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

window.Findings = WiredAnomaly;
