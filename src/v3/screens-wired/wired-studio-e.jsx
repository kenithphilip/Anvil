// ============================================================
// ANVIL v3 — wired Profile Studio
// Wave E · Customer dropdown + version history with rollback
// ============================================================

const studioRowsOf = (resp, key) => {
  if (!resp) return [];
  if (Array.isArray(resp)) return resp;
  if (key && Array.isArray(resp[key])) return resp[key];
  if (Array.isArray(resp.rows)) return resp.rows;
  if (Array.isArray(resp.versions)) return resp.versions;
  return [];
};

const WiredStudio = () => {
  const customers = useFetch(
    () => window.ObaraBackend?.customers?.list?.() || Promise.resolve({ customers: [] }),
    []
  );
  const [customerId, setCustomerId] = useStateW("");
  const [versions, setVersions] = useStateW({ data: null, loading: false, error: null });
  const [rollingBack, setRollingBack] = useStateW(null);
  const [rollbackError, setRollbackError] = useStateW(null);

  const loadVersions = (id) => {
    if (!id) {
      setVersions({ data: null, loading: false, error: null });
      return;
    }
    setVersions({ data: null, loading: true, error: null });
    setRollbackError(null);
    Promise.resolve(window.ObaraBackend?.profileVersions?.list?.(id) || { versions: [] })
      .then((data) => setVersions({ data, loading: false, error: null }))
      .catch((err) => setVersions({ data: null, loading: false, error: err }));
  };

  const onPickCustomer = (id) => {
    setCustomerId(id);
    loadVersions(id);
  };

  const doRollback = async (versionId) => {
    if (!versionId) return;
    setRollingBack(versionId);
    setRollbackError(null);
    try {
      await window.ObaraBackend?.profileVersions?.rollback?.(versionId);
      loadVersions(customerId);
    } catch (err) {
      setRollbackError(err);
    } finally {
      setRollingBack(null);
    }
  };

  if (customers.loading) {
    return (
      <div className="ws ws-no-rail">
        <WSTitle eyebrow="Quality · Profile Studio" title="Profile Studio" meta="loading customers…" />
        <div className="ws-content"><Card><div className="body">Loading customers…</div></Card></div>
      </div>
    );
  }

  if (customers.error) {
    return (
      <div className="ws ws-no-rail">
        <WSTitle eyebrow="Quality · Profile Studio" title="Profile Studio" meta="error" />
        <div className="ws-content">
          <Banner kind="bad" icon={Icon.alert} title="Could not load customers"
                  action={<Btn sm onClick={customers.reload}>Retry</Btn>}>
            <span className="mono-sm">{String(customers.error.message || customers.error)}</span>
          </Banner>
        </div>
      </div>
    );
  }

  const customerList = (() => {
    const d = customers.data;
    if (!d) return [];
    if (Array.isArray(d)) return d;
    if (Array.isArray(d.customers)) return d.customers;
    if (Array.isArray(d.rows)) return d.rows;
    return [];
  })();

  const versionRows = studioRowsOf(versions.data, "versions")
    .slice()
    .sort((a, b) => {
      const ta = new Date(a.created_at || 0).getTime();
      const tb = new Date(b.created_at || 0).getTime();
      return tb - ta;
    });

  const selectedCustomer = customerList.find((c) => (c.id || c.customer_key) === customerId);

  return (
    <>
      <WSTitle
        eyebrow="Quality · Profile Studio"
        title="Profile Studio"
        meta={selectedCustomer ? `${selectedCustomer.customer_name || selectedCustomer.customer_key}` : "pick a customer to view versions"}
        right={<>
          <select
            className="input"
            style={{ minWidth: 240, height: 28 }}
            value={customerId}
            onChange={(ev) => onPickCustomer(ev.target.value)}
            aria-label="Pick customer"
          >
            <option value="">— select customer —</option>
            {customerList.map((c) => (
              <option key={c.id || c.customer_key} value={c.id || c.customer_key}>
                {c.customer_name || c.customer_key || (c.id ? c.id.slice(0, 8) : "—")}
              </option>
            ))}
          </select>
        </>}
      />

      <div className="ws-content">
        {!customerId && (
          <Card>
            <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
              Select a customer above to view profile versions.
            </div>
          </Card>
        )}

        {customerId && versions.loading && (
          <Card><div className="body">Loading versions…</div></Card>
        )}

        {customerId && versions.error && (
          <Banner kind="bad" icon={Icon.alert} title="Could not load profile versions"
                  action={<Btn sm onClick={() => loadVersions(customerId)}>Retry</Btn>}>
            <span className="mono-sm">{String(versions.error.message || versions.error)}</span>
          </Banner>
        )}

        {customerId && !versions.loading && !versions.error && versionRows.length === 0 && (
          <Card>
            <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
              No profile versions yet for this customer.
            </div>
          </Card>
        )}

        {rollbackError && (
          <Banner kind="bad" icon={Icon.alert} title="Rollback failed">
            <span className="mono-sm">{String(rollbackError.message || rollbackError)}</span>
          </Banner>
        )}

        {customerId && versionRows.length > 0 && (
          <Card title="Version history" eyebrow={`${versionRows.length} versions · newest first`} flush>
            <table className="tbl">
              <thead><tr>
                <th>Version</th>
                <th>Created</th>
                <th>Author</th>
                <th>Fingerprint</th>
                <th></th>
                <th style={{ width: 130 }}></th>
              </tr></thead>
              <tbody>
                {versionRows.map((v) => {
                  const fp = typeof v.fingerprint === "string" ? v.fingerprint : (v.fingerprint ? JSON.stringify(v.fingerprint) : "");
                  const fpPreview = fp ? (fp.length > 52 ? fp.slice(0, 52) + "…" : fp) : "—";
                  const isCurrent = v.is_current || v.current === true;
                  return (
                    <tr key={v.id}>
                      <td className="mono"><span className="pri">v{v.version_no || v.version || "—"}</span></td>
                      <td className="mono-sm">{v.created_at ? `${new Date(v.created_at).toLocaleDateString("en-IN")} · ${ageLabel(v.created_at)}` : "—"}</td>
                      <td className="mono-sm">{v.created_by || v.author || "—"}</td>
                      <td className="mono-sm" title={fp}>{fpPreview}</td>
                      <td>{isCurrent ? <Chip k="good">current</Chip> : null}</td>
                      <td>
                        {!isCurrent && (
                          <Btn
                            sm
                            disabled={rollingBack === v.id}
                            onClick={() => doRollback(v.id)}
                          >
                            {rollingBack === v.id ? "rolling…" : "rollback"}
                          </Btn>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        )}
      </div>
    </>
  );
};

window.ProfileStudio = WiredStudio;
