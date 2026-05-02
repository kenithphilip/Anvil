// ============================================================
// ANVIL v3 — wired Eval Suites
// Wave E · KPI row · recent runs · field heatmap
// ============================================================

const evalRowsOf = (resp, key) => {
  if (!resp) return [];
  if (Array.isArray(resp)) return resp;
  if (key && Array.isArray(resp[key])) return resp[key];
  if (Array.isArray(resp.rows)) return resp.rows;
  return [];
};

const WiredEvals = () => {
  const dash = useFetch(
    () => window.ObaraBackend?.eval?.dashboard?.() || window.ObaraBackend?.evalExt?.dashboard?.() || Promise.resolve({}),
    []
  );

  if (dash.loading) {
    return (
      <div className="ws ws-no-rail">
        <WSTitle eyebrow="Quality · Eval" title="Eval suites" meta="loading…" />
        <div className="ws-content"><Card><div className="body">Loading dashboard…</div></Card></div>
      </div>
    );
  }

  if (dash.error) {
    return (
      <div className="ws ws-no-rail">
        <WSTitle eyebrow="Quality · Eval" title="Eval suites" meta="error" />
        <div className="ws-content">
          <Banner kind="bad" icon={Icon.alert} title="Could not load eval dashboard"
                  action={<Btn sm onClick={dash.reload}>Retry</Btn>}>
            <span className="mono-sm">{String(dash.error.message || dash.error)}</span>
          </Banner>
        </div>
      </div>
    );
  }

  const data = dash.data || {};
  const runs = evalRowsOf(data.runs || data.recent || data, "runs");
  const fields = evalRowsOf(data.fields || data.heatmap, "fields");

  // KPIs
  const last30 = runs.slice(0, 30);
  const passCount = last30.filter((r) => (r.status || "").toUpperCase() === "PASS" || r.passed === true).length;
  const passRate = last30.length ? (passCount / last30.length) : null;

  const accuracies = last30.map((r) => Number(r.accuracy ?? r.score ?? 0)).filter((n) => !Number.isNaN(n) && n > 0);
  const avgAccuracy = accuracies.length ? (accuracies.reduce((s, n) => s + n, 0) / accuracies.length) : null;

  const drift = data.drift != null ? Number(data.drift) : (data.drift_score != null ? Number(data.drift_score) : null);

  // Field heatmap: top 20 by failure rate
  const ranked = fields
    .slice()
    .map((f) => {
      const fail = f.failure_rate != null ? Number(f.failure_rate) : (f.pass_rate != null ? 1 - Number(f.pass_rate) : null);
      return { ...f, _failure: fail };
    })
    .filter((f) => f._failure != null)
    .sort((a, b) => b._failure - a._failure)
    .slice(0, 20);

  return (
    <>
      <WSTitle
        eyebrow="Quality · Eval"
        title="Eval suites"
        meta={`${runs.length} run${runs.length === 1 ? "" : "s"} · last 30 windowed`}
        right={<>
          <Btn icon kind="ghost" sm onClick={dash.reload} title="Refresh">{Icon.cycle}</Btn>
          <Btn sm kind="primary" onClick={() => window.location.hash = "#/evals"}>{Icon.bolt} run suite</Btn>
        </>}
      />

      <div className="ws-content">
        <KPIRow cols={4}>
          <KPI lbl="Pass rate · last 30" v={passRate != null ? `${(passRate * 100).toFixed(1)}%` : "—"} d={`${passCount}/${last30.length} runs`} dKind={passRate != null && passRate < 0.9 ? "down" : "up"} />
          <KPI lbl="Recent runs" v={String(runs.length)} d="all suites" />
          <KPI lbl="Avg accuracy" v={avgAccuracy != null ? avgAccuracy.toFixed(3) : "—"} d="weighted" />
          <KPI lbl="Drift" v={drift != null ? drift.toFixed(2) : "—"} d="vs baseline" dKind={drift != null && drift > 0.05 ? "down" : ""} />
        </KPIRow>

        <Card title="Recent runs" eyebrow="last 30 across suites" flush>
          {runs.length === 0 ? (
            <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>No eval runs yet.</div>
          ) : (
            <table className="tbl">
              <thead><tr>
                <th>Suite</th>
                <th>Started</th>
                <th>Status</th>
                <th className="r">Duration</th>
                <th className="r">Pass</th>
                <th className="r">Fail</th>
              </tr></thead>
              <tbody>
                {runs.slice(0, 50).map((r) => {
                  const status = (r.status || "").toUpperCase();
                  const k = status === "PASS" || r.passed === true ? "good" : status === "FAIL" || r.passed === false ? "bad" : status === "RUNNING" ? "live" : "ghost";
                  return (
                    <tr key={r.id || r.run_id}>
                      <td className="mono"><span className="pri">{r.suite || r.suite_name || "—"}</span></td>
                      <td className="mono-sm">{r.started_at ? ageLabel(r.started_at) : (r.created_at ? ageLabel(r.created_at) : "—")}</td>
                      <td><Chip k={k}>{(r.status || (r.passed === true ? "pass" : r.passed === false ? "fail" : "—")).toLowerCase()}</Chip></td>
                      <td className="r mono">{r.duration_ms != null ? `${Number(r.duration_ms).toLocaleString("en-IN")} ms` : "—"}</td>
                      <td className="r mono">{r.pass_count != null ? r.pass_count : "—"}</td>
                      <td className="r mono">{r.fail_count != null ? r.fail_count : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Field heatmap · top 20" eyebrow="ranked by failure rate">
          {ranked.length === 0 ? (
            <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>No field-level signal yet.</div>
          ) : (
            <table className="tbl">
              <thead><tr>
                <th>Field</th>
                <th className="r">Failure rate</th>
                <th className="r">Cases</th>
                <th>Bar</th>
              </tr></thead>
              <tbody>
                {ranked.map((f) => (
                  <tr key={f.field || f.name}>
                    <td className="mono"><span className="pri">{f.field || f.name || "—"}</span></td>
                    <td className="r mono" style={{ color: f._failure > 0.1 ? "var(--rust)" : f._failure > 0.05 ? "var(--amber-2)" : "var(--ink)" }}>
                      {(f._failure * 100).toFixed(1)}%
                    </td>
                    <td className="r mono">{f.cases != null ? f.cases : (f.case_count != null ? f.case_count : "—")}</td>
                    <td>
                      <div style={{ height: 8, background: "var(--paper-2)", border: "1px solid var(--hairline)" }}>
                        <div style={{ height: "100%", width: `${Math.min(100, f._failure * 100)}%`, background: f._failure > 0.1 ? "var(--rust)" : "var(--amber-2)" }} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </>
  );
};

window.EvalSuites = WiredEvals;
