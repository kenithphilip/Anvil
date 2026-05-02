// ============================================================
// ANVIL v3 — wired Service Visits
// ============================================================

const SVC_VISIT_TABS = [
  { id: "scheduled",   label: "Scheduled",   match: (s) => ["SCHEDULED", "PLANNED", "BOOKED"].includes(s) },
  { id: "in_progress", label: "In progress", match: (s) => ["IN_PROGRESS", "ON_SITE", "ACTIVE"].includes(s) },
  { id: "completed",   label: "Completed",   match: (s) => ["COMPLETED", "CLOSED", "DONE"].includes(s) },
];

const SVC_VISIT_STATUS_CHIP = {
  SCHEDULED:    { label: "scheduled",   k: "info" },
  PLANNED:      { label: "planned",     k: "info" },
  BOOKED:       { label: "booked",      k: "info" },
  IN_PROGRESS:  { label: "in progress", k: "warn" },
  ON_SITE:      { label: "on site",     k: "warn" },
  ACTIVE:       { label: "active",      k: "warn" },
  AWAITING:     { label: "awaiting",    k: "warn" },
  COMPLETED:    { label: "completed",   k: "good" },
  CLOSED:       { label: "closed",      k: "good" },
  DONE:         { label: "done",        k: "good" },
  CANCELLED:    { label: "cancelled",   k: "ghost" },
};

const svcVisitFmtDateTime = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
};

const svcVisitFetchFallback = async () => {
  const cfg = JSON.parse(localStorage.getItem("obara:backend_config") || "{}");
  if (!cfg.url) return [];
  const session = JSON.parse(localStorage.getItem("obara:backend_session") || "null");
  const headers = { "Content-Type": "application/json" };
  if (session?.access_token) headers["Authorization"] = "Bearer " + session.access_token;
  if (cfg.tenantId) headers["x-obara-tenant"] = cfg.tenantId;
  const resp = await fetch(cfg.url.replace(/\/+$/, "") + "/api/service/visits", { headers });
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  return resp.json();
};

const WiredServiceVisits = () => {
  const { useState: uV } = React;
  const [active, setActive] = uV("scheduled");

  const visits = useFetch(() => {
    if (typeof window.ObaraBackend?.service?.listVisits === "function") {
      return window.ObaraBackend.service.listVisits();
    }
    return svcVisitFetchFallback();
  }, []);

  const rows = (() => {
    const d = visits.data;
    if (!d) return [];
    if (Array.isArray(d)) return d;
    return d.rows || d.visits || [];
  })();

  const counts = Object.fromEntries(SVC_VISIT_TABS.map((t) => [t.id, rows.filter((v) => t.match(v.status)).length]));
  const filtered = rows.filter((v) => SVC_VISIT_TABS.find((t) => t.id === active)?.match(v.status));

  if (visits.loading) {
    return (
      <div className="ws ws-no-rail">
        <WSTitle eyebrow="loading" title="Service visits" />
        <div className="ws-content"><Card><div className="body">Loading visits…</div></Card></div>
      </div>
    );
  }

  if (visits.error) {
    return (
      <div className="ws ws-no-rail">
        <WSTitle eyebrow="error" title="Could not load service visits" />
        <div className="ws-content">
          <Banner kind="bad" icon={Icon.alert} title="Backend unreachable" action={<Btn sm onClick={visits.reload}>Retry</Btn>}>
            <span className="mono-sm">{String(visits.error.message || visits.error)}</span>
          </Banner>
        </div>
      </div>
    );
  }

  return (
    <>
      <WSTitle
        eyebrow="Service · Visits"
        title="Service visits"
        meta={`${rows.length} total · ${counts.in_progress || 0} active`}
        right={<>
          <Btn icon kind="ghost" sm onClick={visits.reload} title="Refresh">{Icon.cycle}</Btn>
          <Btn sm kind="primary" onClick={() => window.location.hash = "#/service/visits?new=1"}>{Icon.plus} Log visit</Btn>
        </>}
      />
      <WSTabs
        tabs={SVC_VISIT_TABS.map((t) => ({ id: t.id, label: t.label, count: counts[t.id] }))}
        active={active}
        onChange={setActive}
      />

      <div className="ws-content">
        <Card flush>
          <table className="tbl">
            <thead><tr>
              <th>Visit number</th>
              <th>Customer</th>
              <th>Equipment</th>
              <th>Scheduled</th>
              <th>Status</th>
              <th>Technician</th>
              <th></th>
            </tr></thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={7} className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
                  No visits in this tab.
                </td></tr>
              ) : filtered.map((v) => {
                const chip = SVC_VISIT_STATUS_CHIP[v.status] || { label: (v.status || "—").toLowerCase(), k: "ghost" };
                const visitNum = v.visit_number || v.number || v.id?.slice(0, 8) || "—";
                return (
                  <tr key={v.id || visitNum}>
                    <td className="mono"><span className="pri">{visitNum}</span></td>
                    <td>{v.customer_name || v.customer?.customer_name || v.customer_id?.slice(0, 8) || "—"}</td>
                    <td className="mono-sm">{v.equipment_label || v.equipment?.label || v.equipment_serial || v.equipment_id?.slice(0, 8) || "—"}</td>
                    <td className="mono-sm">{svcVisitFmtDateTime(v.scheduled_at || v.scheduled_for || v.start_at)}</td>
                    <td><Chip k={chip.k}>{chip.label}</Chip></td>
                    <td className="mono-sm">{v.technician_name || v.technician?.name || v.assigned_to_name || v.engineer || "—"}</td>
                    <td><Btn sm onClick={() => window.location.hash = `#/service/visits?id=${v.id}`}>open {Icon.arrowR}</Btn></td>
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

window.ServiceVisits = WiredServiceVisits;
