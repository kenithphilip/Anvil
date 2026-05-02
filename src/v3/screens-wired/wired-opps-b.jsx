// ============================================================
// ANVIL v3 — wired Opportunities
// Wave B · Sales pipeline · 11-stage kanban
// Reads via ObaraBackend.sales.listOpportunities (api/sales/opportunities GET)
// ============================================================

const OPP_STAGES = [
  { id: "DISCOVERY",     t: "Discovery",       w: 0.10 },
  { id: "DEMO",          t: "Demo",            w: 0.25 },
  { id: "POC",           t: "PoC",             w: 0.40 },
  { id: "QUOTE",         t: "Quote",           w: 0.55 },
  { id: "NEGOTIATION",   t: "Negotiation",     w: 0.70 },
  { id: "VERBAL",        t: "Verbal",          w: 0.85 },
  { id: "LETTER_OF_INTENT", t: "Letter of intent", w: 0.92 },
  { id: "PO_RECEIVED",   t: "PO received",     w: 0.97 },
  { id: "WON",           t: "Won",             w: 1.00 },
  { id: "LOST",          t: "Lost",            w: 0 },
  { id: "STALLED",       t: "Stalled",         w: 0 },
];

const OPP_STAGE_CHIP = (stage) => {
  if (stage === "WON") return { k: "good", label: "won" };
  if (stage === "LOST") return { k: "bad", label: "lost" };
  if (stage === "STALLED") return { k: "warn", label: "stalled" };
  if (stage === "NEGOTIATION" || stage === "VERBAL") return { k: "live", label: (stage || "").toLowerCase() };
  return { k: "info", label: (stage || "").toLowerCase() };
};

const oppRows = (resp) => {
  if (!resp) return [];
  if (Array.isArray(resp)) return resp;
  if (Array.isArray(resp.opportunities)) return resp.opportunities;
  if (Array.isArray(resp.rows)) return resp.rows;
  return [];
};

const WiredOpportunities = () => {
  const list = useFetch(
    () => window.ObaraBackend?.sales?.listOpportunities?.() || Promise.resolve({ opportunities: [] }),
    []
  );

  if (list.loading) {
    return (
      <div className="ws ws-no-rail">
        <WSTitle eyebrow="Sales · Opportunities" title="Opportunities" meta="loading…" />
        <div className="ws-content"><Card><div className="body">Loading opportunities…</div></Card></div>
      </div>
    );
  }

  if (list.error) {
    return (
      <div className="ws ws-no-rail">
        <WSTitle eyebrow="Sales · Opportunities" title="Opportunities" meta="error" />
        <div className="ws-content">
          <Banner kind="bad" icon={Icon.alert} title="Could not load opportunities"
                  action={<Btn sm onClick={list.reload}>Retry</Btn>}>
            <span className="mono-sm">{String(list.error.message || list.error)}</span>
          </Banner>
        </div>
      </div>
    );
  }

  const rows = oppRows(list.data);
  const total = rows.length;
  const stageMap = OPP_STAGES.reduce((acc, s) => { acc[s.id] = s.w; return acc; }, {});

  const weighted = rows.reduce((sum, r) => {
    const v = Number(r.value) || 0;
    const w = stageMap[r.stage] != null ? stageMap[r.stage] : 0;
    return sum + v * w;
  }, 0);

  const countByStage = (stage) => rows.filter((r) => r.stage === stage).length;
  const discoveryCount = countByStage("DISCOVERY");
  const demoCount = countByStage("DEMO");
  const quoteCount = countByStage("QUOTE");
  const negotCount = countByStage("NEGOTIATION");

  const wonMtd = rows.filter((r) => {
    if (r.stage !== "WON") return false;
    const t = r.closed_at || r.updated_at;
    if (!t) return false;
    const d = new Date(t);
    const now = new Date();
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  });
  const wonValueMtd = wonMtd.reduce((sum, r) => sum + (Number(r.value) || 0), 0);

  // Group rows by stage for the kanban
  const byStage = {};
  for (const stage of OPP_STAGES) byStage[stage.id] = [];
  for (const r of rows) {
    if (byStage[r.stage]) byStage[r.stage].push(r);
    else if (byStage[(r.stage || "").toUpperCase()]) byStage[(r.stage || "").toUpperCase()].push(r);
  }

  return (
    <>
      <WSTitle
        eyebrow="Sales · Opportunities"
        title="Opportunities · 11-stage pipeline"
        meta={`${total} active · weighted ${fmtINRShort(weighted)}`}
        right={<>
          <Btn icon kind="ghost" sm onClick={list.reload} title="Refresh">{Icon.cycle}</Btn>
          <Btn sm kind="primary" onClick={() => window.location.hash = "#/opps?new=1"}>
            {Icon.plus} New opp
          </Btn>
        </>}
      />

      <div className="ws-content">
        <KPIRow cols={5}>
          <KPI lbl="Total" v={String(total)} d="all stages" />
          <KPI lbl="Weighted ₹" v={fmtINRShort(weighted)} d="probability-adjusted" live={weighted > 0} />
          <KPI lbl="Discovery" v={String(discoveryCount)} d={`${demoCount} demo · ${quoteCount} quote`} />
          <KPI lbl="Negotiation" v={String(negotCount)} d="late stage" />
          <KPI lbl="Won · MTD" v={fmtINRShort(wonValueMtd)} d={`${wonMtd.length} closed`} dKind={wonMtd.length ? "up" : ""} />
        </KPIRow>

        {rows.length === 0 ? (
          <Card>
            <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
              No opportunities yet. Promote a lead to start the pipeline.
            </div>
          </Card>
        ) : (
          <div className="kanban" role="list" aria-label="Opportunity pipeline">
            {OPP_STAGES.map((s) => {
              const cards = byStage[s.id] || [];
              const sc = OPP_STAGE_CHIP(s.id);
              return (
                <div className="col" key={s.id} role="listitem">
                  <div className="col-h">
                    <span className="t">{s.t}</span>
                    <span className="c">{cards.length}</span>
                    {s.w > 0 && (
                      <span className="c" style={{ color: "var(--ink-3)" }}>
                        · {Math.round(s.w * 100)}%
                      </span>
                    )}
                  </div>
                  {cards.length === 0 ? (
                    <div className="mono-sm" style={{ color: "var(--ink-4)", padding: "8px 4px" }}>—</div>
                  ) : (
                    cards.map((kard) => {
                      const v = Number(kard.value) || 0;
                      const customer = kard.customer_name || kard.customer || "—";
                      const owner = kard.owner || "—";
                      const created = kard.created_at || kard.updated_at;
                      return (
                        <div
                          className="kard"
                          key={kard.id}
                          tabIndex={0}
                          onClick={() => window.location.hash = `#/opps?id=${kard.id}`}
                          onKeyDown={(ev) => {
                            if (ev.key === "Enter" || ev.key === " ") {
                              ev.preventDefault();
                              window.location.hash = `#/opps?id=${kard.id}`;
                            }
                          }}
                          style={{ cursor: "pointer" }}
                        >
                          <div className="ti">{kard.title || customer}</div>
                          <div className="meta">
                            {customer} · {v ? fmtINRShort(v) : "—"} · {owner}
                          </div>
                          <div className="ft">
                            <Chip k={sc.k}>{sc.label}</Chip>
                            <span className="mono-sm" style={{ marginLeft: "auto", color: "var(--ink-4)" }}>
                              {created ? ageLabel(created) : "—"}
                            </span>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
};

window.Opportunities = WiredOpportunities;
