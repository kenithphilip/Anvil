// ============================================================
// ANVIL v3 — wired Spares Matrix
// ============================================================

const SPARES_TABS = [
  { id: "recommend",     label: "Recommend" },
  { id: "kit",           label: "Kit" },
  { id: "opportunities", label: "Opportunities" },
  { id: "obsolete",      label: "Obsolete" },
];

const sparesRows = (resp) => {
  if (!resp) return [];
  if (Array.isArray(resp)) return resp;
  return resp.rows || resp.recommendations || resp.items || resp.opportunities || resp.obsolete || resp.spares || [];
};

const sparesPctOrNum = (n) => {
  if (n == null || Number.isNaN(Number(n))) return "—";
  const v = Number(n);
  if (v >= 0 && v <= 1) return (v * 100).toFixed(0) + "%";
  if (v > 1 && v <= 100) return v.toFixed(0) + "%";
  return v.toLocaleString("en-IN");
};

const WiredSpares = () => {
  const { useState: uM, useEffect: eM, useMemo: mM } = React;
  const [active, setActive] = uM("recommend");
  const [customerId, setCustomerId] = uM("");
  const [months, setMonths] = uM(12);
  const [obsoleteMonths, setObsoleteMonths] = uM(18);

  const [recommend, setRecommend] = uM({ data: null, loading: false, error: null });
  const [kit, setKit] = uM({ data: null, loading: false, error: null });
  const [opps, setOpps] = uM({ data: null, loading: false, error: null });
  const [obsolete, setObsolete] = uM({ data: null, loading: false, error: null });

  const customers = useFetch(() => window.ObaraBackend?.customers?.list?.() || Promise.resolve([]), []);

  const customerList = mM(() => {
    const d = customers.data;
    if (!d) return [];
    if (Array.isArray(d)) return d;
    return d.customers || d.rows || [];
  }, [customers.data]);

  // Default first customer
  eM(() => {
    if (!customerId && customerList.length > 0) {
      setCustomerId(customerList[0].id);
    }
  }, [customerList, customerId]);

  const runRecommend = async () => {
    if (!customerId) return;
    setRecommend({ data: null, loading: true, error: null });
    try {
      const data = await window.ObaraBackend?.spareMatrix?.recommend?.({ customerId });
      setRecommend({ data, loading: false, error: null });
    } catch (err) {
      setRecommend({ data: null, loading: false, error: err });
    }
  };

  const runKit = async () => {
    if (!customerId) return;
    setKit({ data: null, loading: true, error: null });
    try {
      const data = await window.ObaraBackend?.spareMatrix?.kit?.({ customerId, months: Number(months) || 12 });
      setKit({ data, loading: false, error: null });
    } catch (err) {
      setKit({ data: null, loading: false, error: err });
    }
  };

  const runOpps = async () => {
    if (!customerId) return;
    setOpps({ data: null, loading: true, error: null });
    try {
      const data = await window.ObaraBackend?.spareMatrix?.opportunities?.(customerId);
      setOpps({ data, loading: false, error: null });
    } catch (err) {
      setOpps({ data: null, loading: false, error: err });
    }
  };

  const runObsolete = async () => {
    setObsolete({ data: null, loading: true, error: null });
    try {
      const data = await window.ObaraBackend?.spareMatrix?.obsolete?.(Number(obsoleteMonths) || 18);
      setObsolete({ data, loading: false, error: null });
    } catch (err) {
      setObsolete({ data: null, loading: false, error: err });
    }
  };

  // Auto-load obsolete on tab switch
  eM(() => {
    if (active === "obsolete" && obsolete.data == null && !obsolete.loading) {
      runObsolete();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const recRows = mM(() => sparesRows(recommend.data).slice().sort((a, b) =>
    (Number(b.criticality_score) || 0) - (Number(a.criticality_score) || 0)
  ), [recommend.data]);
  const kitRows = mM(() => sparesRows(kit.data), [kit.data]);
  const oppsRows = mM(() => sparesRows(opps.data), [opps.data]);
  const obsRows = mM(() => sparesRows(obsolete.data), [obsolete.data]);

  const customerSelect = (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <label htmlFor="spares-customer" className="mono-sm" style={{ color: "var(--ink-3)" }}>Customer</label>
      <select
        id="spares-customer"
        className="input"
        value={customerId}
        onChange={(ev) => setCustomerId(ev.target.value)}
        style={{ width: 240, height: 30 }}
        disabled={customers.loading}
      >
        {customers.loading ? <option>Loading…</option> :
          customerList.length === 0 ? <option value="">No customers</option> :
          customerList.map((c) => (
            <option key={c.id} value={c.id}>{c.customer_name || c.name || c.id?.slice(0, 8)}</option>
          ))
        }
      </select>
    </div>
  );

  return (
    <>
      <WSTitle
        eyebrow="Procurement · Spares Matrix"
        title="Spares matrix"
        meta="recommend · kit · opportunities · obsolete"
      />
      <WSTabs tabs={SPARES_TABS} active={active} onChange={setActive} />

      <div className="ws-content">
        {customers.error && (
          <Banner kind="bad" icon={Icon.alert} title="Failed to load customers">
            <span className="mono-sm">{String(customers.error.message || customers.error)}</span>
          </Banner>
        )}

        {active === "recommend" && (
          <Card
            title="Recommendations"
            eyebrow="sorted by criticality"
            right={<>
              {customerSelect}
              <Btn sm kind="primary" onClick={runRecommend} disabled={!customerId || recommend.loading}>
                {recommend.loading ? "…" : <>{Icon.cycle} Regenerate</>}
              </Btn>
            </>}
          >
            {recommend.error ? (
              <Banner kind="bad" icon={Icon.alert} title="Recommendation failed">
                <span className="mono-sm">{String(recommend.error.message || recommend.error)}</span>
              </Banner>
            ) : recommend.data == null ? (
              <div className="body" style={{ color: "var(--ink-3)" }}>Pick a customer and click Regenerate.</div>
            ) : recRows.length === 0 ? (
              <div className="body" style={{ color: "var(--ink-3)" }}>No recommendations for this customer.</div>
            ) : (
              <table className="tbl">
                <thead><tr>
                  <th>Part</th>
                  <th>Description</th>
                  <th className="r">Criticality</th>
                  <th className="r">Co-occur</th>
                  <th className="r">Avg qty</th>
                </tr></thead>
                <tbody>
                  {recRows.map((r, i) => (
                    <tr key={r.id || r.part_number || i}>
                      <td className="mono"><span className="pri">{r.part_number || r.sku || r.part || "—"}</span></td>
                      <td>{r.description || r.name || "—"}</td>
                      <td className="r mono">{r.criticality_score != null ? Number(r.criticality_score).toFixed(2) : "—"}</td>
                      <td className="r mono">{sparesPctOrNum(r.co_occurrence || r.co_occur_pct)}</td>
                      <td className="r mono">{r.avg_qty != null ? Number(r.avg_qty).toFixed(1) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        )}

        {active === "kit" && (
          <Card
            title="Kit prediction"
            eyebrow="forecast target qty per part"
            right={<>
              {customerSelect}
              <label htmlFor="spares-months" className="mono-sm" style={{ color: "var(--ink-3)" }}>Months</label>
              <input
                id="spares-months"
                className="input"
                type="number"
                min={1}
                max={36}
                value={months}
                onChange={(ev) => setMonths(ev.target.value)}
                style={{ width: 70, height: 30 }}
              />
              <Btn sm kind="primary" onClick={runKit} disabled={!customerId || kit.loading}>
                {kit.loading ? "…" : <>{Icon.bolt} Predict</>}
              </Btn>
            </>}
          >
            {kit.error ? (
              <Banner kind="bad" icon={Icon.alert} title="Kit prediction failed">
                <span className="mono-sm">{String(kit.error.message || kit.error)}</span>
              </Banner>
            ) : kit.data == null ? (
              <div className="body" style={{ color: "var(--ink-3)" }}>Pick a customer + months and click Predict.</div>
            ) : kitRows.length === 0 ? (
              <div className="body" style={{ color: "var(--ink-3)" }}>No kit prediction available.</div>
            ) : (
              <table className="tbl">
                <thead><tr>
                  <th>Part</th>
                  <th>Description</th>
                  <th className="r">Predicted qty</th>
                  <th className="r">Confidence</th>
                </tr></thead>
                <tbody>
                  {kitRows.map((r, i) => (
                    <tr key={r.id || r.part_number || i}>
                      <td className="mono"><span className="pri">{r.part_number || r.sku || r.part || "—"}</span></td>
                      <td>{r.description || r.name || "—"}</td>
                      <td className="r mono">{r.predicted_qty != null ? Number(r.predicted_qty).toFixed(0) : (r.target_qty != null ? Number(r.target_qty).toFixed(0) : "—")}</td>
                      <td className="r mono">{sparesPctOrNum(r.confidence)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        )}

        {active === "opportunities" && (
          <Card
            title="Opportunities"
            eyebrow="₹ uplift potential"
            right={<>
              {customerSelect}
              <Btn sm kind="primary" onClick={runOpps} disabled={!customerId || opps.loading}>
                {opps.loading ? "…" : <>{Icon.cycle} Refresh</>}
              </Btn>
            </>}
          >
            {opps.error ? (
              <Banner kind="bad" icon={Icon.alert} title="Opportunities failed">
                <span className="mono-sm">{String(opps.error.message || opps.error)}</span>
              </Banner>
            ) : opps.data == null ? (
              <div className="body" style={{ color: "var(--ink-3)" }}>Pick a customer and click Refresh.</div>
            ) : oppsRows.length === 0 ? (
              <div className="body" style={{ color: "var(--ink-3)" }}>No opportunities flagged.</div>
            ) : (
              <table className="tbl">
                <thead><tr>
                  <th>Pattern</th>
                  <th>Suggested part</th>
                  <th className="r">Est ₹/mo</th>
                  <th className="r">Confidence</th>
                </tr></thead>
                <tbody>
                  {oppsRows.map((r, i) => (
                    <tr key={r.id || i}>
                      <td>{r.pattern || r.description || "—"}</td>
                      <td className="mono">{r.suggested_part || r.part_number || r.sku || "—"}</td>
                      <td className="r mono">{r.est_value_inr != null ? fmtINRShort(Number(r.est_value_inr)) : (r.estimated_value_per_month != null ? fmtINRShort(Number(r.estimated_value_per_month)) : "—")}</td>
                      <td className="r mono">{sparesPctOrNum(r.confidence)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        )}

        {active === "obsolete" && (
          <Card
            title="Obsolete / dormant SKUs"
            eyebrow="no-orders threshold"
            right={<>
              <label htmlFor="spares-obs-months" className="mono-sm" style={{ color: "var(--ink-3)" }}>Months</label>
              <input
                id="spares-obs-months"
                className="input"
                type="number"
                min={1}
                max={120}
                value={obsoleteMonths}
                onChange={(ev) => setObsoleteMonths(ev.target.value)}
                style={{ width: 70, height: 30 }}
              />
              <Btn sm kind="primary" onClick={runObsolete} disabled={obsolete.loading}>
                {obsolete.loading ? "…" : <>{Icon.cycle} Refresh</>}
              </Btn>
            </>}
          >
            {obsolete.error ? (
              <Banner kind="bad" icon={Icon.alert} title="Obsolete query failed">
                <span className="mono-sm">{String(obsolete.error.message || obsolete.error)}</span>
              </Banner>
            ) : obsolete.loading ? (
              <div className="body">Loading…</div>
            ) : obsRows.length === 0 ? (
              <div className="body" style={{ color: "var(--ink-3)" }}>No SKUs flagged at this threshold.</div>
            ) : (
              <table className="tbl">
                <thead><tr>
                  <th>SKU</th>
                  <th>Description</th>
                  <th>Last sold</th>
                  <th className="r">On hand</th>
                  <th>Successor</th>
                </tr></thead>
                <tbody>
                  {obsRows.map((r, i) => (
                    <tr key={r.id || r.part_number || i}>
                      <td className="mono"><span className="pri">{r.part_number || r.sku || "—"}</span></td>
                      <td>{r.description || r.name || "—"}</td>
                      <td className="mono-sm">{r.last_sold_at ? new Date(r.last_sold_at).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "2-digit" }) : "—"}</td>
                      <td className="r mono">{r.on_hand != null ? Number(r.on_hand).toLocaleString("en-IN") : "—"}</td>
                      <td className="mono">{r.successor || r.replacement_sku || "—"}</td>
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

window.SparesMatrix = WiredSpares;
