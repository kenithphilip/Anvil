// ============================================================
// ANVIL v3 — wired Internal SOs
// FOC · Warranty · Trial · Expected PO · Internal Transfer
// ============================================================

const WiredInternalSOs = () => {
  const { useState: u, useEffect: e } = React;
  const [state, setState] = u({ data: null, loading: true, error: null });
  const [bump, setBump] = u(0);

  e(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    const thunk = window.ObaraBackend?.sales?.listInternalSos
      ? window.ObaraBackend.sales.listInternalSos()
      : (async () => {
          // Fallback: direct fetch if the client wrapper is missing.
          const cfg = JSON.parse(localStorage.getItem("obara:backend_config") || "{}");
          const session = JSON.parse(localStorage.getItem("obara:backend_session") || "null");
          if (!cfg.url) throw new Error("Backend URL not configured");
          const headers = { "Content-Type": "application/json" };
          if (session?.access_token) headers["Authorization"] = "Bearer " + session.access_token;
          if (cfg.tenantId) headers["x-obara-tenant"] = cfg.tenantId;
          const resp = await fetch(cfg.url.replace(/\/+$/, "") + "/api/sales/internal_so", { headers });
          if (!resp.ok) throw new Error("HTTP " + resp.status);
          return resp.json();
        })();
    Promise.resolve(thunk)
      .then((data) => { if (!cancelled) setState({ data, loading: false, error: null }); })
      .catch((error) => { if (!cancelled) setState({ data: null, loading: false, error }); });
    return () => { cancelled = true; };
  }, [bump]);

  if (state.loading) {
    return (
      <>
        <WSTitle eyebrow="Workflows · Internal SOs" title="Internal Sales Orders" meta="loading…" />
        <div className="ws-content"><Card><div className="body">Loading internal SOs…</div></Card></div>
      </>
    );
  }

  if (state.error) {
    return (
      <>
        <WSTitle eyebrow="Workflows · Internal SOs" title="Internal Sales Orders" meta="error" />
        <div className="ws-content">
          <Banner kind="bad" icon={Icon.alert} title="Could not load internal SOs"
                  action={<Btn sm onClick={() => setBump((n) => n + 1)}>retry</Btn>}>
            <span className="mono-sm">{String(state.error.message || state.error)}</span>
          </Banner>
        </div>
      </>
    );
  }

  const list = state.data?.internalSos || (Array.isArray(state.data) ? state.data : []);
  const counts = {
    foc: list.filter((r) => r.iso_type === "FOC_SUPPLY").length,
    warranty: list.filter((r) => r.iso_type === "WARRANTY_REPLACEMENT").length,
    trial: list.filter((r) => r.iso_type === "PRODUCT_TRIAL").length,
    transfer: list.filter((r) => r.iso_type === "INTERNAL_TRANSFER").length,
    expected: list.filter((r) => r.iso_type === "EXPECTED_PO").length,
  };

  const typeChip = (t) => {
    const map = {
      FOC_SUPPLY:           { k: "plum",  l: "FOC" },
      WARRANTY_REPLACEMENT: { k: "warn",  l: "Warranty" },
      PRODUCT_TRIAL:        { k: "info",  l: "Trial" },
      EXPECTED_PO:          { k: "ghost", l: "Expected PO" },
      INTERNAL_TRANSFER:    { k: "plum",  l: "Transfer" },
    };
    return map[t] || { k: "ghost", l: t || "—" };
  };

  const statusChip = (s) => {
    const map = {
      DRAFT: { k: "ghost", l: "draft" },
      PENDING_APPROVAL: { k: "warn", l: "pending" },
      APPROVED: { k: "info", l: "approved" },
      DISPATCHED: { k: "warn", l: "in transit" },
      CLOSED: { k: "good", l: "closed" },
      CANCELLED: { k: "ghost", l: "cancelled" },
    };
    return map[s] || { k: "ghost", l: (s || "").toLowerCase() };
  };

  return (
    <>
      <WSTitle
        eyebrow="Workflows · Internal SOs"
        title="Internal Sales Orders"
        meta="FOC · Warranty · Trial · Expected PO · Transfer"
        right={<>
          <Btn icon kind="ghost" sm onClick={() => setBump((n) => n + 1)} title="Refresh">{Icon.cycle}</Btn>
        </>}
      />

      <div className="ws-content">
        <KPIRow cols={5}>
          <KPI lbl="Total internal" v={String(list.length)} d="all types" />
          <KPI lbl="FOC supply" v={String(counts.foc)} d="zero revenue" />
          <KPI lbl="Warranty" v={String(counts.warranty)} d="CAR-linked" dKind={counts.warranty ? "down" : ""} />
          <KPI lbl="Trial" v={String(counts.trial)} d="PoC + demo" />
          <KPI lbl="Transfer" v={String(counts.transfer)} d="inter-tenant" />
        </KPIRow>

        <Banner kind="info" icon={Icon.info} title="Internal SOs do not push to Tally">
          <span className="mono-sm">FOC and Trial generate stock issue notes; Warranty cross-references CAR reports; Transfer becomes inter-tenant; Expected PO converts when the PO arrives. None create voucher revenue.</span>
        </Banner>

        <Card flush>
          {list.length === 0 ? (
            <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
              No internal sales orders yet. Create one from the SO intake by picking the INTERNAL mode.
            </div>
          ) : (
            <table className="tbl">
              <thead><tr>
                <th>Reference</th>
                <th>Type</th>
                <th>Counterparty</th>
                <th className="r">Lines</th>
                <th>Status</th>
                <th className="r">Age</th>
                <th>Owner</th>
              </tr></thead>
              <tbody>
                {list.slice(0, 200).map((r) => {
                  const tc = typeChip(r.iso_type);
                  const sc = statusChip(r.status);
                  const lineCount = (r.lines || []).length;
                  return (
                    <tr key={r.id} onClick={() => window.location.hash = `#/internal?id=${r.id}`} style={{ cursor: "pointer" }}>
                      <td className="mono"><span className="pri">{r.iso_number || r.id.slice(0, 12)}</span></td>
                      <td><Chip k={tc.k}>{tc.l}</Chip></td>
                      <td>{r.customer_name || r.vendor_name || (r.customer_id ? r.customer_id.slice(0, 8) : "—")}</td>
                      <td className="r mono">{lineCount || "—"}</td>
                      <td><Chip k={sc.k}>{sc.l}</Chip></td>
                      <td className="r mono">{ageLabel(r.created_at)}</td>
                      <td className="mono-sm">{r.requested_person || "—"}</td>
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

window.InternalSOs = WiredInternalSOs;
