// ============================================================
// ANVIL v3 — wired Master Data Graph
// Wave E · Stats + strongest connections list
// Cytoscape integration deferred to Phase 4.
// ============================================================

const WiredGraph = () => {
  const graph = useFetch(
    () => window.ObaraBackend?.masterData?.graph?.() || Promise.resolve({ nodes: [], edges: [] }),
    []
  );

  if (graph.loading) {
    return (
      <div className="ws ws-no-rail">
        <WSTitle eyebrow="Master · Graph" title="Master data graph" meta="loading…" />
        <div className="ws-content"><Card><div className="body">Loading graph…</div></Card></div>
      </div>
    );
  }

  if (graph.error) {
    return (
      <div className="ws ws-no-rail">
        <WSTitle eyebrow="Master · Graph" title="Master data graph" meta="error" />
        <div className="ws-content">
          <Banner kind="bad" icon={Icon.alert} title="Could not load graph"
                  action={<Btn sm onClick={graph.reload}>Retry</Btn>}>
            <span className="mono-sm">{String(graph.error.message || graph.error)}</span>
          </Banner>
        </div>
      </div>
    );
  }

  const data = graph.data || {};
  const nodes = Array.isArray(data.nodes) ? data.nodes : [];
  const edges = Array.isArray(data.edges) ? data.edges : [];

  const countByType = (t) =>
    nodes.filter((n) => (n.type || n.kind || n.entity_type) === t).length;
  const customers = countByType("customer");
  const orders = countByType("order");
  const parts = countByType("part") || countByType("item");
  const connections = edges.length;

  // Sort edges by score / weight desc
  const strongest = edges
    .slice()
    .sort((a, b) => (Number(b.score || b.weight || 0)) - (Number(a.score || a.weight || 0)))
    .slice(0, 25);

  return (
    <>
      <WSTitle
        eyebrow="Master · Graph"
        title="Master data graph"
        meta={`${nodes.length} nodes · ${edges.length} edges · graph view in Phase 4`}
        right={<>
          <Btn icon kind="ghost" sm onClick={graph.reload} title="Refresh">{Icon.cycle}</Btn>
        </>}
      />

      <div className="ws-content">
        <KPIRow cols={4}>
          <KPI lbl="Customers" v={String(customers)} d="entity nodes" />
          <KPI lbl="Orders" v={String(orders)} d="transactional nodes" />
          <KPI lbl="Parts" v={String(parts)} d="item nodes" />
          <KPI lbl="Connections" v={String(connections)} d="edges in graph" />
        </KPIRow>

        <Card title="Strongest connections" eyebrow="ranked by score · top 25">
          {strongest.length === 0 ? (
            <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
              No connections in the graph yet.
            </div>
          ) : (
            <table className="tbl">
              <thead><tr>
                <th>From</th>
                <th>Relation</th>
                <th>To</th>
                <th className="r">Score</th>
              </tr></thead>
              <tbody>
                {strongest.map((e, i) => (
                  <tr key={i}>
                    <td className="mono-sm"><span className="pri">{e.source_label || e.from_label || e.source || e.from || "—"}</span></td>
                    <td><Chip k="info">{e.label || e.relation || e.kind || "—"}</Chip></td>
                    <td className="mono-sm">{e.target_label || e.to_label || e.target || e.to || "—"}</td>
                    <td className="r mono">{e.score != null ? Number(e.score).toFixed(2) : (e.weight != null ? Number(e.weight).toFixed(2) : "—")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Graph rendering · deferred" eyebrow="Phase 4">
          <div className="mono-sm" style={{ color: "var(--ink-3)" }}>
            Force-directed view via Cytoscape will land in the next wave. For now this screen is read-only and renders
            node statistics and the strongest edges from <span className="mono">/api/master_data/graph</span>.
          </div>
        </Card>
      </div>
    </>
  );
};

window.MasterDataGraph = WiredGraph;
