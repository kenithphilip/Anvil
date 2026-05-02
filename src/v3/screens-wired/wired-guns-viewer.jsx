// ============================================================
// ANVIL v3 — wired Guns viewer
// Two-pane: gun list (left) · spec + BOM tree + matrix usage + recent SOs (right)
// Reads via ObaraBackend.bom.list, ObaraBackend.customers.list, ObaraBackend.orders.list.
// Drawing base URL pulled from localStorage["obara:drawing_base_url"]
// (set elsewhere by drawing-link config). Falls back to disabled icon.
// ============================================================

// ─────────────────────────────────────────────────────────────
// Helpers (do not redeclare useFetch/ageLabel — defined in wired-home.jsx)
// ─────────────────────────────────────────────────────────────

// Tolerant array unwrap. Backend returns { rows: [...] } or { customers, orders, … }.
const gvUnwrap = (resp, ...keys) => {
  if (!resp) return [];
  if (Array.isArray(resp)) return resp;
  for (const k of keys) {
    if (Array.isArray(resp[k])) return resp[k];
  }
  if (Array.isArray(resp.rows)) return resp.rows;
  return [];
};

// Hierarchy level for a row. Tolerates legacy "level" / "hierarchy_level" / parsed "L<n>" in notes.
const gvLevelOf = (r) => {
  if (r.hierarchy_level != null && r.hierarchy_level !== "") return Number(r.hierarchy_level);
  if (r.level != null && r.level !== "") return Number(r.level);
  const note = r.notes || r.remarks || "";
  const m1 = note.match(/(?:^|·\s*)L(\d+)/);
  if (m1) return parseInt(m1[1], 10);
  const m2 = note.match(/S:(\d+(?:\s*\.\d+)*)/);
  if (m2) return (m2[1].match(/\./g) || []).length + 1;
  return 1;
};

// Coalesce common column-name variants for child/qty/uom/desc/etc.
const gvChildOf = (r) => r.child_part_no || r.child_part || r.child || r.part_no || "";
const gvParentOf = (r) => r.parent_part_no || r.parent_part || r.parent || r.gun_no || "";
const gvDescOf = (r) => r.description || r.part_name || r.notes || "";
const gvQtyOf = (r) => (r.qty != null ? Number(r.qty) : null);
const gvUomOf = (r) => r.uom || r.unit || "";
const gvDrawingOf = (r) => r.drawing_no || r.drawing || "";
const gvSourceOf = (r) => r.source_country || r.origin || "";
const gvCustomerOf = (r) => r.customer || r.customer_name || r.customer_key || "";
const gvProjectOf = (r) => r.project || r.project_name || r.line_name || "";
const gvUpdatedOf = (r) => r.updated_at || r.created_at || r.last_updated || null;

// Group flat BOM rows into one entry per parent (gun).
const groupGuns = (bomRows) => {
  const map = new Map();
  for (const row of bomRows || []) {
    const gun = (gvParentOf(row) || "").trim();
    if (!gun) continue;
    if (!map.has(gun)) {
      map.set(gun, {
        gun_no: gun,
        customer: gvCustomerOf(row),
        project: gvProjectOf(row),
        source_country: gvSourceOf(row),
        parts: [],
        lastUpdated: null,
      });
    }
    const g = map.get(gun);
    g.parts.push(row);
    if (!g.customer && gvCustomerOf(row)) g.customer = gvCustomerOf(row);
    if (!g.project && gvProjectOf(row)) g.project = gvProjectOf(row);
    if (!g.source_country && gvSourceOf(row)) g.source_country = gvSourceOf(row);
    const u = gvUpdatedOf(row);
    if (u && (!g.lastUpdated || new Date(u) > new Date(g.lastUpdated))) g.lastUpdated = u;
  }
  return Array.from(map.values()).sort((a, b) => a.gun_no.localeCompare(b.gun_no));
};

// Sort BOM rows for tree display: keep import order when possible (seq_no), else fall
// back to the (level, child_part_no) tuple so siblings cluster underneath their parent.
const treeFromBom = (parts) => {
  const indexed = (parts || []).map((p, i) => ({ p, i }));
  indexed.sort((a, b) => {
    const sa = a.p.seq_no, sb = b.p.seq_no;
    if (sa != null && sb != null && sa !== sb) return Number(sa) - Number(sb);
    const la = gvLevelOf(a.p), lb = gvLevelOf(b.p);
    if (la !== lb) return la - lb;
    return (gvChildOf(a.p) || "").localeCompare(gvChildOf(b.p) || "");
  });
  return indexed.map((x) => x.p);
};

// Compose a drawing URL from base + drawing_no. null if either side missing.
const drawingUrlFor = (drawing_no) => {
  const dn = (drawing_no || "").trim();
  if (!dn) return null;
  let base = "";
  try { base = (localStorage.getItem("obara:drawing_base_url") || "").trim(); } catch (_) { /* ignore */ }
  if (!base) return null;
  if (!base.endsWith("/")) base += "/";
  // If the drawing already looks like a URL, just return it as-is.
  if (/^https?:\/\//i.test(dn)) return dn;
  // Append .pdf when no extension is present (legacy convention).
  return base + (/\.[a-z0-9]{2,4}$/i.test(dn) ? dn : dn + ".pdf");
};

// Build a customer-id → name lookup so we can resolve order.customer_id refs.
const buildCustomerLookup = (resp) => {
  const list = gvUnwrap(resp, "customers");
  const byId = {}, byName = {};
  for (const c of list) {
    if (c.id) byId[c.id] = c.customer_name || c.name || c.customer_key || c.id;
    if (c.customer_key) byName[c.customer_key.toLowerCase()] = c.customer_name || c.customer_key;
  }
  return { byId, byName };
};

// ─────────────────────────────────────────────────────────────
// Main viewer
// ─────────────────────────────────────────────────────────────
const WiredGunsViewer = () => {
  const { useState: uS, useMemo: uMemo } = React;

  const bom = useFetch(() => window.ObaraBackend?.bom?.list?.() || Promise.resolve({ rows: [] }), []);
  const customers = useFetch(() => window.ObaraBackend?.customers?.list?.() || Promise.resolve({ customers: [] }), []);
  const orders = useFetch(() => window.ObaraBackend?.orders?.list?.({ limit: 100 }) || Promise.resolve({ orders: [] }), []);

  const [filter, setFilter] = uS("");
  const [selected, setSelected] = uS(null); // gun_no string

  // Resolve customer ID → readable name once.
  const custLookup = uMemo(() => buildCustomerLookup(customers.data), [customers.data]);

  // Group BOM rows once. Tries multiple shapes the API may return.
  const guns = uMemo(() => {
    const rows = gvUnwrap(bom.data, "rows", "bom");
    return groupGuns(rows).map((g) => ({
      ...g,
      customer: g.customer || (custLookup.byId[g.customer_id] || ""),
    }));
  }, [bom.data, custLookup]);

  // Filter the gun list by gun_no / customer / project / contained part_no.
  const filtered = uMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return guns;
    return guns.filter((g) => {
      if ((g.gun_no || "").toLowerCase().includes(q)) return true;
      if ((g.customer || "").toLowerCase().includes(q)) return true;
      if ((g.project || "").toLowerCase().includes(q)) return true;
      // fall back to scanning child part numbers (cheap; filtered already capped by render)
      return g.parts.some((p) => (gvChildOf(p) || "").toLowerCase().includes(q));
    });
  }, [guns, filter]);

  const sel = useMemo(() => guns.find((g) => g.gun_no === selected) || null, [guns, selected]);

  // Auto-select first gun once data lands.
  React.useEffect(() => {
    if (!selected && filtered.length > 0) setSelected(filtered[0].gun_no);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered.length === 0 ? "" : filtered[0]?.gun_no]);

  const titleMeta = bom.loading ? "loading…" : `${guns.length} guns`;

  return (
    <>
      <WSTitle
        eyebrow="Data · Items · Guns"
        title="Guns"
        meta={titleMeta}
        right={<Btn icon kind="ghost" sm onClick={() => { bom.reload(); customers.reload(); orders.reload(); }} title="Refresh">{Icon.cycle}</Btn>}
      />

      <div className="ws-content">
        {bom.error && (
          <Banner kind="bad" icon={Icon.alert} title="Could not load BOMs" action={<Btn sm onClick={bom.reload}>Retry</Btn>}>
            <span className="mono-sm">{String(bom.error.message || bom.error)}</span>
          </Banner>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "320px 1fr", gap: 14 }}>
          <GunsLeftPane
            loading={bom.loading}
            guns={filtered}
            total={guns.length}
            filter={filter}
            onFilter={setFilter}
            selected={selected}
            onSelect={setSelected}
          />
          <GunsRightPane
            gun={sel}
            ordersData={orders.data}
            ordersLoading={orders.loading}
            ordersError={orders.error}
            customerLookup={custLookup}
          />
        </div>
      </div>
    </>
  );
};

// ─────────────────────────────────────────────────────────────
// Left pane (search + list)
// ─────────────────────────────────────────────────────────────
const GunsLeftPane = ({ loading, guns, total, filter, onFilter, selected, onSelect }) => {
  return (
    <Card flush style={{ alignSelf: "flex-start", position: "sticky", top: 12 }}>
      <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--hairline-2)" }}>
        <input
          className="input"
          placeholder="search gun_no / customer / project / part…"
          value={filter}
          onChange={(ev) => onFilter(ev.target.value)}
          style={{ width: "100%", height: 30 }}
          aria-label="Filter guns"
        />
      </div>
      <div style={{ maxHeight: "calc(100vh - 220px)", overflowY: "auto" }}>
        {loading ? (
          <div className="body" style={{ padding: 18, color: "var(--ink-3)" }}>Loading…</div>
        ) : total === 0 ? (
          <div className="body" style={{ padding: 18, color: "var(--ink-3)", textAlign: "center" }}>
            No guns yet. Run BOM Import to load guns.
          </div>
        ) : guns.length === 0 ? (
          <div className="body" style={{ padding: 18, color: "var(--ink-3)", textAlign: "center" }}>
            No guns match <span className="mono">{filter}</span>.
            <br />
            <a onClick={() => onFilter("")} style={{ color: "var(--ink)", cursor: "pointer", textDecoration: "underline" }}>clear</a>
          </div>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {guns.slice(0, 250).map((g) => {
              const isSel = g.gun_no === selected;
              return (
                <li key={g.gun_no} style={{ borderBottom: "1px solid var(--hairline-3)" }}>
                  <button
                    type="button"
                    onClick={() => onSelect(g.gun_no)}
                    aria-current={isSel ? "true" : undefined}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      padding: "10px 12px",
                      border: 0,
                      background: isSel ? "var(--paper-4)" : "transparent",
                      color: "inherit",
                      cursor: "pointer",
                      font: "inherit",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                      <span className="mono pri" style={{ fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                        {g.gun_no}
                      </span>
                      <Chip k="ghost">{g.parts.length}</Chip>
                    </div>
                    <div className="mono-sm" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {g.customer || "—"}
                    </div>
                    <div className="mono-sm" style={{ color: "var(--ink-4)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "flex", justifyContent: "space-between", gap: 6 }}>
                      <span>{g.project || "—"}</span>
                      {g.lastUpdated && <span>{ageLabel(g.lastUpdated)}</span>}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {guns.length > 250 && (
          <div className="mono-sm" style={{ padding: 10, textAlign: "center", color: "var(--ink-3)", borderTop: "1px solid var(--hairline-2)" }}>
            Showing 250 of {guns.length}.
          </div>
        )}
      </div>
    </Card>
  );
};

// ─────────────────────────────────────────────────────────────
// Right pane (spec + BOM tree + matrix usage + recent SOs)
// ─────────────────────────────────────────────────────────────
const GunsRightPane = ({ gun, ordersData, ordersLoading, ordersError, customerLookup }) => {
  if (!gun) {
    return <Card><div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>Select a gun on the left.</div></Card>;
  }

  const treeRows = useMemo(() => treeFromBom(gun.parts), [gun.parts]);
  const totalParts = treeRows.length;
  const totalQty = treeRows.reduce((sum, r) => sum + (gvQtyOf(r) || 0), 0);

  // Distinct part_no set for SO filter & matrix usage detection.
  const partSet = useMemo(() => {
    const s = new Set();
    for (const r of gun.parts) {
      const c = (gvChildOf(r) || "").trim().toUpperCase();
      if (c) s.add(c);
    }
    s.add((gun.gun_no || "").trim().toUpperCase());
    return s;
  }, [gun]);

  // Matrix usage: scan order results for spare-matrix tags referencing this gun.
  // We deliberately keep this pattern lenient — the legacy spare-matrix linkage stores
  // gun references in a few different shapes (matrix.gunNumber, spare.gun_no, etc).
  const matrixUsage = useMemo(() => {
    const out = [];
    const seen = new Set();
    const orders = gvUnwrap(ordersData, "orders");
    for (const o of orders) {
      const matrices = o.result?.spareMatrices || o.result?.matrices || [];
      if (!Array.isArray(matrices)) continue;
      for (const m of matrices) {
        const gunRef = (m.gun_no || m.gunNumber || m.gun || "").toUpperCase();
        if (!gunRef || gunRef !== gun.gun_no.toUpperCase()) continue;
        const cust = m.customer_name || m.customer || (o.customer_id && customerLookup.byId[o.customer_id]) || o.customer?.customer_name || "—";
        const proj = m.project || m.project_name || m.line_name || "—";
        const col = m.column || m.spare_column || m.col || "—";
        const key = `${o.id}::${cust}::${proj}::${col}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ orderId: o.id, customer: cust, project: proj, column: col });
      }
    }
    return out;
  }, [ordersData, gun, customerLookup]);

  // Recent SOs that reference any part in this gun.
  const recentSOs = useMemo(() => {
    const orders = gvUnwrap(ordersData, "orders");
    const matches = [];
    for (const o of orders) {
      const lines = o.result?.salesOrder?.lineItems || o.result?.lineItems || [];
      const hits = [];
      for (const ln of lines) {
        const pn = String(ln.partNo || ln.part_no || ln.obara_part_no || ln.canonical_part_no || "").trim().toUpperCase();
        if (!pn) continue;
        if (partSet.has(pn)) hits.push(pn);
      }
      if (hits.length === 0) continue;
      matches.push({
        order: o,
        hits,
        customer: o.customer?.customer_name || customerLookup.byId[o.customer_id] || (o.customer_id ? o.customer_id.slice(0, 8) : "—"),
        when: o.updated_at || o.created_at,
      });
    }
    return matches
      .sort((a, b) => new Date(b.when || 0) - new Date(a.when || 0))
      .slice(0, 12);
  }, [ordersData, partSet, customerLookup]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Spec card */}
      <Card title={gun.gun_no} eyebrow="Gun · spec">
        <KV rows={[
          ["Gun #", <span className="mono pri">{gun.gun_no}</span>],
          ["Customer", gun.customer || "—"],
          ["Project / line", gun.project || "—"],
          ["Last seen", gun.lastUpdated ? `${new Date(gun.lastUpdated).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })} · ${ageLabel(gun.lastUpdated)}` : "—"],
          ["Source country", gun.source_country || "—"],
          ["Total parts", `${totalParts}${totalQty ? ` · qty ${totalQty.toLocaleString("en-IN")}` : ""}`],
        ]} />
      </Card>

      {/* BOM tree */}
      <Card title="BOM Tree" eyebrow={`${totalParts} item${totalParts === 1 ? "" : "s"}`} flush>
        {totalParts === 0 ? (
          <div className="body" style={{ padding: 18, color: "var(--ink-3)" }}>No BOM rows captured for this gun.</div>
        ) : (
          <table className="tbl">
            <thead><tr>
              <th style={{ width: 36 }} className="r">#</th>
              <th style={{ width: 28 }}>Lv</th>
              <th>Part #</th>
              <th>Description</th>
              <th className="r" style={{ width: 60 }}>Qty</th>
              <th style={{ width: 50 }}>UOM</th>
              <th style={{ width: 72 }}>Drawing</th>
            </tr></thead>
            <tbody>
              {treeRows.map((r, i) => {
                const lv = gvLevelOf(r);
                const indent = Math.max(0, (lv - 1)) * 14;
                const drawing = gvDrawingOf(r);
                const url = drawingUrlFor(drawing);
                return (
                  <tr key={r.id || `${gun.gun_no}-${i}`}>
                    <td className="r mono-sm" style={{ color: "var(--ink-4)" }}>{r.seq_no != null ? r.seq_no : (i + 1)}</td>
                    <td><Chip k={lv === 1 ? "info" : lv === 2 ? "warn" : "ghost"}>L{lv}</Chip></td>
                    <td className="mono" style={{ paddingLeft: 10 + indent }}>
                      <span className="pri">{gvChildOf(r) || "—"}</span>
                    </td>
                    <td style={{ maxWidth: 360, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {gvDescOf(r) || "—"}
                    </td>
                    <td className="r mono">{gvQtyOf(r) != null ? gvQtyOf(r).toLocaleString("en-IN") : "—"}</td>
                    <td className="mono-sm">{gvUomOf(r) || "—"}</td>
                    <td>
                      {drawing ? (
                        url ? (
                          <a href={url} target="_blank" rel="noopener noreferrer" title={`Open ${drawing}`} className="mono-sm" style={{ color: "var(--ink)", textDecoration: "underline" }}>
                            {Icon.doc} {drawing}
                          </a>
                        ) : (
                          <span className="mono-sm" title="Drawing base URL not configured" style={{ color: "var(--ink-4)", display: "inline-flex", alignItems: "center", gap: 4 }}>
                            {Icon.doc} {drawing}
                          </span>
                        )
                      ) : (
                        <span className="mono-sm" style={{ color: "var(--ink-5)" }}>—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      {/* Matrix usage */}
      <Card title="Matrix usage" eyebrow={matrixUsage.length ? `${matrixUsage.length} reference${matrixUsage.length === 1 ? "" : "s"}` : "no references"}>
        {matrixUsage.length === 0 ? (
          <div className="body" style={{ color: "var(--ink-3)" }}>
            Not referenced in any spare matrix yet.
            <a onClick={() => window.location.hash = "#/spares"} style={{ color: "var(--ink)", cursor: "pointer", textDecoration: "underline", marginLeft: 6 }}>Open Spares Matrix →</a>
          </div>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {matrixUsage.map((m, i) => (
              <button
                key={`${m.orderId}-${i}`}
                type="button"
                onClick={() => { window.location.hash = `#/spares?gun=${encodeURIComponent(gun.gun_no)}&order=${encodeURIComponent(m.orderId || "")}`; }}
                className="chip info lg"
                style={{ cursor: "pointer", border: "1px solid var(--hairline)", display: "inline-flex", alignItems: "center", gap: 6 }}
                title="Jump to this spare matrix"
              >
                <span className="mono-sm">{m.customer}</span>
                <span style={{ color: "var(--ink-4)" }}>·</span>
                <span className="mono-sm">{m.project}</span>
                <span style={{ color: "var(--ink-4)" }}>·</span>
                <span className="mono-sm pri">{m.column}</span>
                <span>{Icon.arrowR}</span>
              </button>
            ))}
          </div>
        )}
      </Card>

      {/* Recent SOs */}
      <Card title="Recent SOs" eyebrow={ordersLoading ? "loading…" : `${recentSOs.length} match${recentSOs.length === 1 ? "" : "es"}`} flush>
        {ordersError ? (
          <div className="body" style={{ padding: 14, color: "var(--bad)" }}>
            <span className="mono-sm">{String(ordersError.message || ordersError)}</span>
          </div>
        ) : ordersLoading ? (
          <div className="body" style={{ padding: 18 }}>Loading orders…</div>
        ) : recentSOs.length === 0 ? (
          <div className="body" style={{ padding: 18, color: "var(--ink-3)" }}>
            No recent sales orders reference any part in this gun.
          </div>
        ) : (
          <table className="tbl">
            <thead><tr>
              <th>Reference</th>
              <th>Customer</th>
              <th>Stage</th>
              <th className="r">Hits</th>
              <th className="r">Age</th>
              <th style={{ width: 76 }}></th>
            </tr></thead>
            <tbody>
              {recentSOs.map((m) => {
                const st = stageOf(m.order.status);
                return (
                  <tr key={m.order.id}>
                    <td className="mono"><span className="pri">{m.order.po_number || m.order.quote_number || "draft"}</span></td>
                    <td>{m.customer}</td>
                    <td><Chip k={st.k}>{st.label}</Chip></td>
                    <td className="r mono" title={m.hits.join(", ")}>{m.hits.length}</td>
                    <td className="r mono">{ageLabel(m.when)}</td>
                    <td><Btn sm onClick={() => window.location.hash = `#/so?id=${m.order.id}`}>open {Icon.arrowR}</Btn></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
};

window.GunsViewer = WiredGunsViewer;
