// ============================================================
// ANVIL v3 — wired Security
// Wave F · Admin
// Redaction rules · Injection tests · Routing log.
// Admin-only.
// ============================================================

const SECURITY_TABS = [
  { id: "redactions", label: "Redaction rules" },
  { id: "injection",  label: "Injection tests" },
  { id: "routing",    label: "Routing log" },
];

const securityRows = (resp, key) => {
  if (!resp) return [];
  if (Array.isArray(resp)) return resp;
  if (Array.isArray(resp[key])) return resp[key];
  if (Array.isArray(resp.rows)) return resp.rows;
  return [];
};

const WiredSecurity = () => {
  const isAdmin = !!(window.RBAC && window.RBAC.isAdmin && window.RBAC.isAdmin());

  const [active, setActive] = useStateW("redactions");
  const [busy, setBusy] = useStateW(false);
  const [flash, setFlash] = useStateW(null);
  const [editForm, setEditForm] = useStateW({ name: "", pattern: "", replacement: "", scope: "outbound" });
  const [injectResults, setInjectResults] = useStateW(null);

  const redactions = useFetch(
    () => window.ObaraBackend?.security?.listRedactions?.() || Promise.resolve({ redactions: [] }),
    []
  );
  const routing = useFetch(
    () => window.ObaraBackend?.security?.routingLog?.(100) || Promise.resolve({ rows: [] }),
    []
  );

  if (!isAdmin) {
    return (
      <div className="ws ws-no-rail">
        <WSTitle eyebrow="Security" title="Restricted" meta="admin only" />
        <div className="ws-content">
          <Banner kind="warn" icon={Icon.lock} title="Insufficient permissions">
            <span className="mono-sm">The Security console is admin-only. Switch to an admin role to view redaction rules, injection tests, and routing logs.</span>
          </Banner>
        </div>
      </div>
    );
  }

  const redactionRows = securityRows(redactions.data, "redactions");
  const routingRows = securityRows(routing.data, "rows");

  const onSaveRedaction = async (ev) => {
    ev.preventDefault();
    if (!editForm.name || !editForm.pattern) {
      setFlash({ kind: "bad", msg: "Name and pattern required" });
      return;
    }
    setBusy(true); setFlash(null);
    try {
      await window.ObaraBackend?.security?.upsertRedaction?.({
        name: editForm.name,
        pattern: editForm.pattern,
        replacement: editForm.replacement || `[${editForm.name.toUpperCase()}-####]`,
        scope: editForm.scope,
      });
      setFlash({ kind: "good", msg: `Saved rule "${editForm.name}"` });
      setEditForm({ name: "", pattern: "", replacement: "", scope: "outbound" });
      redactions.reload();
    } catch (err) {
      setFlash({ kind: "bad", msg: String(err.message || err) });
    } finally {
      setBusy(false);
    }
  };

  const runInjection = async () => {
    setBusy(true); setFlash(null);
    try {
      const result = await window.ObaraBackend?.security?.runInjectionTest?.();
      setInjectResults(result);
      setFlash({ kind: "good", msg: "Injection bench complete" });
    } catch (err) {
      setFlash({ kind: "bad", msg: String(err.message || err) });
    } finally {
      setBusy(false);
    }
  };

  const injectCases = injectResults
    ? (Array.isArray(injectResults) ? injectResults : (injectResults.cases || injectResults.results || []))
    : [];

  return (
    <>
      <WSTitle
        eyebrow="Comms & Security · Security"
        title="Security"
        meta={`${redactionRows.length} redactions · ${routingRows.length} routing entries`}
        right={<>
          <Btn icon kind="ghost" sm onClick={() => { redactions.reload(); routing.reload(); }} title="Refresh">{Icon.cycle}</Btn>
        </>}
      />
      <WSTabs
        tabs={SECURITY_TABS}
        active={active}
        onChange={setActive}
      />

      <div className="ws-content">
        {flash && (
          <Banner kind={flash.kind} icon={flash.kind === "bad" ? Icon.alert : Icon.check} title={flash.kind === "bad" ? "Action failed" : "Action complete"}>
            <span className="mono-sm">{flash.msg}</span>
          </Banner>
        )}

        {active === "redactions" && (
          <>
            {redactions.error && (
              <Banner kind="bad" icon={Icon.alert} title="Failed to load redaction rules" action={<Btn sm onClick={redactions.reload}>Retry</Btn>}>
                <span className="mono-sm">{String(redactions.error.message || redactions.error)}</span>
              </Banner>
            )}
            <Card title="Redaction rules" eyebrow="active for tenant">
              {redactions.loading ? (
                <div className="body" style={{ color: "var(--ink-3)" }}>Loading rules…</div>
              ) : redactionRows.length === 0 ? (
                <div className="body" style={{ color: "var(--ink-3)" }}>No redaction rules yet. Add the first one below.</div>
              ) : (
                <table className="tbl">
                  <thead><tr>
                    <th scope="col">Name</th>
                    <th scope="col">Pattern</th>
                    <th scope="col">Replacement</th>
                    <th scope="col">Scope</th>
                  </tr></thead>
                  <tbody>
                    {redactionRows.map((r, i) => (
                      <tr key={r.id || i}>
                        <td><span className="pri">{r.name}</span></td>
                        <td className="mono-sm">{r.pattern}</td>
                        <td className="mono-sm">{r.replacement || "—"}</td>
                        <td><Chip k="ghost">{r.scope || "outbound"}</Chip></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>

            <Card title="Add / edit rule" eyebrow="upsert by name">
              <form onSubmit={onSaveRedaction} style={{ display: "grid", gridTemplateColumns: "1fr 2fr 1fr 1fr auto", gap: 8, alignItems: "end" }}>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span className="mono-sm" style={{ color: "var(--ink-3)" }}>Name</span>
                  <input className="input" value={editForm.name} aria-label="Rule name" required style={{ height: 30 }}
                    onChange={(ev) => setEditForm((f) => ({ ...f, name: ev.target.value }))} />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span className="mono-sm" style={{ color: "var(--ink-3)" }}>Pattern (regex)</span>
                  <input className="input" value={editForm.pattern} aria-label="Pattern" required style={{ height: 30 }}
                    onChange={(ev) => setEditForm((f) => ({ ...f, pattern: ev.target.value }))} />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span className="mono-sm" style={{ color: "var(--ink-3)" }}>Replacement</span>
                  <input className="input" value={editForm.replacement} aria-label="Replacement" style={{ height: 30 }}
                    onChange={(ev) => setEditForm((f) => ({ ...f, replacement: ev.target.value }))} />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span className="mono-sm" style={{ color: "var(--ink-3)" }}>Scope</span>
                  <select className="input" value={editForm.scope} aria-label="Scope" style={{ height: 30 }}
                    onChange={(ev) => setEditForm((f) => ({ ...f, scope: ev.target.value }))}>
                    <option value="outbound">outbound</option>
                    <option value="inbound">inbound</option>
                    <option value="both">both</option>
                  </select>
                </label>
                <Btn type="submit" kind="primary" sm disabled={busy}>{busy ? "saving…" : "save"}</Btn>
              </form>
            </Card>
          </>
        )}

        {active === "injection" && (
          <Card
            title="Prompt-injection bench"
            eyebrow="run all cases"
            right={<Btn sm kind="primary" disabled={busy} onClick={runInjection}>{busy ? "running…" : <>{Icon.bolt} run all</>}</Btn>}
          >
            {!injectResults ? (
              <div className="body" style={{ color: "var(--ink-3)" }}>
                Click <b>run all</b> to execute the injection test suite.
              </div>
            ) : injectCases.length === 0 ? (
              <div className="body" style={{ color: "var(--ink-3)" }}>Bench ran but returned no cases.</div>
            ) : (
              <table className="tbl">
                <thead><tr>
                  <th scope="col">Case</th>
                  <th scope="col">Vector</th>
                  <th scope="col">Result</th>
                  <th scope="col">Detail</th>
                </tr></thead>
                <tbody>
                  {injectCases.map((c, i) => {
                    const passed = c.passed === true || c.status === "pass" || c.result === "pass";
                    return (
                      <tr key={c.id || i}>
                        <td className="mono">{c.id || c.case_id || `T-${i+1}`}</td>
                        <td className="mono-sm">{c.vector || c.kind || "—"}</td>
                        <td><Chip k={passed ? "good" : "bad"}>{passed ? "PASS" : "FAIL"}</Chip></td>
                        <td className="mono-sm">{c.detail || c.message || c.note || "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </Card>
        )}

        {active === "routing" && (
          <>
            {routing.error && (
              <Banner kind="bad" icon={Icon.alert} title="Failed to load routing log" action={<Btn sm onClick={routing.reload}>Retry</Btn>}>
                <span className="mono-sm">{String(routing.error.message || routing.error)}</span>
              </Banner>
            )}
            <Card flush>
              {routing.loading ? (
                <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>Loading routing log…</div>
              ) : routingRows.length === 0 ? (
                <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>No routing entries yet.</div>
              ) : (
                <table className="tbl">
                  <thead><tr>
                    <th scope="col">When</th>
                    <th scope="col">Primary model</th>
                    <th scope="col">Status</th>
                    <th scope="col" className="r">Confidence</th>
                    <th scope="col">Fallback</th>
                    <th scope="col">Reason</th>
                  </tr></thead>
                  <tbody>
                    {routingRows.slice(0, 100).map((r, i) => {
                      const conf = r.primary_confidence != null ? r.primary_confidence : r.confidence;
                      const status = r.primary_status || r.status || "—";
                      return (
                        <tr key={r.id || i}>
                          <td className="mono-sm">{r.created_at ? new Date(r.created_at).toLocaleString("en-IN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "short" }) : "—"}</td>
                          <td className="mono">{r.primary_model || "—"}</td>
                          <td><Chip k={status === "ok" ? "good" : status === "fallback" ? "warn" : "ghost"}>{status}</Chip></td>
                          <td className="r mono">{conf != null ? Number(conf).toFixed(2) : "—"}</td>
                          <td className="mono">{r.fallback_model || "—"}</td>
                          <td className="mono-sm">{r.fallback_reason || "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </Card>
          </>
        )}
      </div>
    </>
  );
};

window.Security = WiredSecurity;
