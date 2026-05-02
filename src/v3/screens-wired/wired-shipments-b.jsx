// ============================================================
// ANVIL v3 — wired Shipments
// Wave B · Sales · Logistics tracker
// Reads via ObaraBackend.sales.listShipments (api/sales/shipments GET)
// ============================================================

const SHIPMENT_TABS = [
  { id: "all",          label: "All",          match: () => true },
  { id: "PLANNED",      label: "Planned",      match: (s) => s.status === "PLANNED" },
  { id: "READY",        label: "Ready",        match: (s) => s.status === "READY" },
  { id: "IN_TRANSIT",   label: "In transit",   match: (s) => s.status === "IN_TRANSIT" },
  { id: "AT_PORT",      label: "At port",      match: (s) => s.status === "AT_PORT" || s.status === "CLEARED" },
  { id: "DELIVERED",    label: "Delivered",    match: (s) => s.status === "DELIVERED" },
  { id: "POD_RECEIVED", label: "POD received", match: (s) => s.status === "POD_RECEIVED" },
  { id: "EXCEPTION",    label: "Exception",    match: (s) => s.status === "EXCEPTION" },
];

const SHIPMENT_STATUS_CHIP = (s) => {
  const map = {
    PLANNED:      { k: "ghost", label: "planned" },
    READY:        { k: "info",  label: "ready" },
    IN_TRANSIT:   { k: "warn",  label: "in transit" },
    AT_PORT:      { k: "warn",  label: "at port" },
    CLEARED:      { k: "info",  label: "cleared" },
    DELIVERED:    { k: "good",  label: "delivered" },
    POD_RECEIVED: { k: "good",  label: "POD received" },
    EXCEPTION:    { k: "bad",   label: "exception" },
  };
  return map[s] || { k: "ghost", label: (s || "—").toLowerCase() };
};

const SHIPMENT_MODE_CHIP = (m) => {
  const map = {
    sea:     { k: "info",  label: "sea" },
    air:     { k: "live",  label: "air" },
    road:    { k: "ghost", label: "road" },
    courier: { k: "plum",  label: "courier" },
  };
  const key = (m || "").toLowerCase();
  return map[key] || { k: "ghost", label: m || "—" };
};

const shipmentRows = (resp) => {
  if (!resp) return [];
  if (Array.isArray(resp)) return resp;
  if (Array.isArray(resp.shipments)) return resp.shipments;
  if (Array.isArray(resp.rows)) return resp.rows;
  return [];
};

const WiredShipments = () => {
  const list = useFetch(
    () => window.ObaraBackend?.sales?.listShipments?.() || Promise.resolve({ shipments: [] }),
    []
  );
  const [active, setActive] = useStateW("all");

  if (list.loading) {
    return (
      <div className="ws ws-no-rail">
        <WSTitle eyebrow="Sales · Shipments" title="Shipments" meta="loading…" />
        <div className="ws-content"><Card><div className="body">Loading shipments…</div></Card></div>
      </div>
    );
  }

  if (list.error) {
    return (
      <div className="ws ws-no-rail">
        <WSTitle eyebrow="Sales · Shipments" title="Shipments" meta="error" />
        <div className="ws-content">
          <Banner kind="bad" icon={Icon.alert} title="Could not load shipments"
                  action={<Btn sm onClick={list.reload}>Retry</Btn>}>
            <span className="mono-sm">{String(list.error.message || list.error)}</span>
          </Banner>
        </div>
      </div>
    );
  }

  const rows = shipmentRows(list.data);
  const total = rows.length;

  const counts = Object.fromEntries(
    SHIPMENT_TABS.map((t) => [t.id, rows.filter(t.match).length])
  );

  const matcher = SHIPMENT_TABS.find((t) => t.id === active)?.match || (() => true);
  const filtered = rows.filter(matcher);

  const tabsForRender = SHIPMENT_TABS.map((t) => ({
    id: t.id,
    label: t.label,
    count: counts[t.id],
  }));

  return (
    <>
      <WSTitle
        eyebrow="Sales · Shipments"
        title="Shipments"
        meta={`${total} total · ${counts.IN_TRANSIT || 0} in transit · ${counts.EXCEPTION || 0} exceptions`}
        right={<>
          <Btn icon kind="ghost" sm onClick={list.reload} title="Refresh">{Icon.cycle}</Btn>
          <Btn sm kind="primary" onClick={() => window.location.hash = "#/shipments?new=1"}>
            {Icon.plus} Schedule shipment
          </Btn>
        </>}
      />
      <WSTabs tabs={tabsForRender} active={active} onChange={setActive} />

      <div className="ws-content">
        <Card flush>
          {filtered.length === 0 ? (
            <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
              {active === "all"
                ? "No shipments yet. Schedule one when an order is ready to dispatch."
                : <>No shipments in this view. <a onClick={() => setActive("all")} style={{ color: "var(--ink)", cursor: "pointer", textDecoration: "underline" }}>show all</a></>}
            </div>
          ) : (
            <table className="tbl">
              <thead><tr>
                <th>Shipment #</th>
                <th>Mode</th>
                <th>Carrier</th>
                <th>Vessel · flight</th>
                <th>Route</th>
                <th>ETA</th>
                <th>Status</th>
              </tr></thead>
              <tbody>
                {filtered.slice(0, 200).map((r) => {
                  const sc = SHIPMENT_STATUS_CHIP(r.status);
                  const mc = SHIPMENT_MODE_CHIP(r.mode);
                  const vesselFlight = r.vessel_name || r.flight_number || r.vehicle_number || "—";
                  const pol = r.port_of_loading || r.origin || "—";
                  const pod = r.port_of_discharge || r.destination || "—";
                  return (
                    <tr
                      key={r.id}
                      tabIndex={0}
                      onClick={() => window.location.hash = `#/shipments?id=${r.id}`}
                      onKeyDown={(ev) => {
                        if (ev.key === "Enter" || ev.key === " ") {
                          ev.preventDefault();
                          window.location.hash = `#/shipments?id=${r.id}`;
                        }
                      }}
                      style={{ cursor: "pointer" }}
                    >
                      <td className="mono"><span className="pri">{r.shipment_number || r.number || (r.id ? r.id.slice(0, 12) : "—")}</span></td>
                      <td><Chip k={mc.k}>{mc.label}</Chip></td>
                      <td className="mono-sm">{r.carrier || "—"}</td>
                      <td className="mono-sm">{vesselFlight}</td>
                      <td className="mono-sm">{pol} → {pod}</td>
                      <td className="mono-sm">{r.eta || "—"}</td>
                      <td><Chip k={sc.k}>{sc.label}</Chip></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {filtered.length > 200 && (
            <div className="mono-sm" style={{ padding: 12, textAlign: "center", color: "var(--ink-3)", borderTop: "1px solid var(--hairline-2)" }}>
              Showing 200 of {filtered.length} shipments. Switch tabs to narrow.
            </div>
          )}
        </Card>
      </div>
    </>
  );
};

window.Shipments = WiredShipments;
