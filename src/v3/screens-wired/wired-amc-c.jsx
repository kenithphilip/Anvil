// ============================================================
// ANVIL v3 — wired AMC Schedule
// ============================================================

const AMC_STATUS_CHIP = {
  ACTIVE:    { label: "active",    k: "good" },
  EXPIRING:  { label: "expiring",  k: "warn" },
  EXPIRED:   { label: "expired",   k: "bad" },
  PAUSED:    { label: "paused",    k: "warn" },
  CANCELLED: { label: "cancelled", k: "ghost" },
};

const amcFmtDate = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "2-digit" });
};

const amcFetchFallback = async (path) => {
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

const amcDaysBetween = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor((d.getTime() - Date.now()) / 86400000);
};

const WiredAMC = () => {
  const { useState: uA } = React;
  const [bumpA, setBumpA] = uA(0);
  const [generating, setGenerating] = uA(false);
  const [genErr, setGenErr] = uA(null);
  const [genOk, setGenOk] = uA(null);

  const amc = useFetch(() => {
    if (typeof window.ObaraBackend?.service?.listAmcSchedules === "function") {
      return window.ObaraBackend.service.listAmcSchedules();
    }
    if (typeof window.ObaraBackend?.service?.amc?.list === "function") {
      return window.ObaraBackend.service.amc.list();
    }
    return amcFetchFallback("/api/service/amc");
  }, [bumpA]);

  const rows = (() => {
    const d = amc.data;
    if (!d) return [];
    if (Array.isArray(d)) return d;
    return d.rows || d.schedules || d.amc || [];
  })();

  // KPIs
  const activeCount = rows.filter((r) => (r.status || "ACTIVE").toUpperCase() === "ACTIVE").length;
  const visitsDue30 = rows.filter((r) => {
    const days = amcDaysBetween(r.next_visit_date);
    return days != null && days >= 0 && days <= 30;
  }).length;
  const expiring90 = rows.filter((r) => {
    const days = amcDaysBetween(r.period_end || r.end_date || r.expires_at);
    return days != null && days >= 0 && days <= 90;
  }).length;

  // Value MTD: sum of completed visit values this month, fall back to amc value
  const startOfMonth = new Date(); startOfMonth.setDate(1); startOfMonth.setHours(0, 0, 0, 0);
  const valueMTD = rows.reduce((sum, r) => {
    const ts = r.value_mtd != null ? Number(r.value_mtd) : null;
    if (ts != null) return sum + ts;
    const last = r.last_visit_at ? new Date(r.last_visit_at) : null;
    if (last && last >= startOfMonth) return sum + (Number(r.value_inr) || Number(r.amc_value) || 0);
    return sum;
  }, 0);

  const canGenerate = window.RBAC?.canDo?.("amc.generate_visits");

  const generateVisits = async () => {
    setGenerating(true);
    setGenErr(null);
    setGenOk(null);
    try {
      const cfg = JSON.parse(localStorage.getItem("obara:backend_config") || "{}");
      if (!cfg.url) throw new Error("Backend URL not configured");
      const session = JSON.parse(localStorage.getItem("obara:backend_session") || "null");
      const headers = { "Content-Type": "application/json" };
      if (session?.access_token) headers["Authorization"] = "Bearer " + session.access_token;
      if (cfg.tenantId) headers["x-obara-tenant"] = cfg.tenantId;
      const resp = await fetch(cfg.url.replace(/\/+$/, "") + "/api/service/amc_cron", { method: "POST", headers });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const data = await resp.json();
      setGenOk(data);
      setBumpA((n) => n + 1);
    } catch (err) {
      setGenErr(err);
    } finally {
      setGenerating(false);
    }
  };

  if (amc.loading) {
    return (
      <div className="ws ws-no-rail">
        <WSTitle eyebrow="loading" title="AMC schedule" />
        <div className="ws-content"><Card><div className="body">Loading AMC contracts…</div></Card></div>
      </div>
    );
  }

  if (amc.error) {
    return (
      <div className="ws ws-no-rail">
        <WSTitle eyebrow="error" title="Could not load AMC" />
        <div className="ws-content">
          <Banner kind="bad" icon={Icon.alert} title="Backend unreachable" action={<Btn sm onClick={amc.reload}>Retry</Btn>}>
            <span className="mono-sm">{String(amc.error.message || amc.error)}</span>
          </Banner>
        </div>
      </div>
    );
  }

  return (
    <>
      <WSTitle
        eyebrow="Service · AMC"
        title="AMC schedule"
        meta={`${rows.length} contracts · ${activeCount} active`}
        right={<>
          <Btn icon kind="ghost" sm onClick={() => setBumpA((n) => n + 1)} title="Refresh">{Icon.cycle}</Btn>
          {canGenerate && (
            <Btn sm kind="primary" disabled={generating} onClick={generateVisits} title="Run AMC cron to generate due visits">
              {generating ? "Generating…" : <>{Icon.bolt} Generate visits</>}
            </Btn>
          )}
        </>}
      />

      <div className="ws-content">
        {genErr && (
          <Banner kind="bad" icon={Icon.alert} title="Generate visits failed">
            <span className="mono-sm">{String(genErr.message || genErr)}</span>
          </Banner>
        )}
        {genOk && (
          <Banner kind="good" icon={Icon.check} title="Visits generated">
            <span className="mono-sm">
              {genOk.generated != null ? `${genOk.generated} visit(s) created` : "AMC cron run complete"}
            </span>
          </Banner>
        )}

        <KPIRow cols={4}>
          <KPI lbl="Active AMCs" v={String(activeCount)} d={`${rows.length} total`} />
          <KPI lbl="Visits due 30d" v={String(visitsDue30)} d="next month" live={visitsDue30 > 0} />
          <KPI lbl="Expiring 90d" v={String(expiring90)} d="renew window" dKind={expiring90 > 0 ? "down" : ""} />
          <KPI lbl="Value MTD" v={fmtINRShort(valueMTD)} d="completed visits" dKind={valueMTD > 0 ? "up" : ""} />
        </KPIRow>

        <Card flush>
          <table className="tbl">
            <thead><tr>
              <th>AMC number</th>
              <th>Customer</th>
              <th>Period</th>
              <th>Frequency</th>
              <th>Next visit</th>
              <th className="r">Visits done</th>
              <th>Status</th>
              <th></th>
            </tr></thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td colSpan={8} className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
                  No AMC contracts yet.
                </td></tr>
              ) : rows.map((r) => {
                const status = (r.status || "ACTIVE").toUpperCase();
                const chip = AMC_STATUS_CHIP[status] || { label: status.toLowerCase(), k: "ghost" };
                const amcNum = r.amc_number || r.contract_number || r.id?.slice(0, 8) || "—";
                const period = r.period_start && r.period_end
                  ? `${amcFmtDate(r.period_start)} → ${amcFmtDate(r.period_end)}`
                  : (r.start_date && r.end_date ? `${amcFmtDate(r.start_date)} → ${amcFmtDate(r.end_date)}` : "—");
                return (
                  <tr key={r.id || amcNum}>
                    <td className="mono"><span className="pri">{amcNum}</span></td>
                    <td>{r.customer_name || r.customer?.customer_name || r.customer_id?.slice(0, 8) || "—"}</td>
                    <td className="mono-sm">{period}</td>
                    <td className="mono-sm">{r.frequency || r.visit_frequency || "—"}</td>
                    <td className="mono-sm">{amcFmtDate(r.next_visit_date)}</td>
                    <td className="r mono">{r.visits_completed != null ? `${r.visits_completed}${r.visits_total != null ? ` / ${r.visits_total}` : ""}` : "—"}</td>
                    <td><Chip k={chip.k}>{chip.label}</Chip></td>
                    <td><Btn sm onClick={() => window.location.hash = `#/service/amc?id=${r.id}`}>open {Icon.arrowR}</Btn></td>
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

window.AMCSchedule = WiredAMC;
