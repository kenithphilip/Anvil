// ============================================================
// ANVIL v3 — Admin Center · Data · Quality · Comms · Security
// ============================================================

// ─────────────────────────────────────────────────────────────
// Admin Center — 13 tabs
// ─────────────────────────────────────────────────────────────
const AdminCenter = () => {
  const [tab, setTab] = useState("members");
  const tabs = [
    { id: "members",   label: "Members & roles" },
    { id: "tenants",   label: "Tenants" },
    { id: "thresh",    label: "Approval thresholds" },
    { id: "lead",      label: "Lead times" },
    { id: "holidays",  label: "Holidays" },
    { id: "fx",        label: "FX & forwards" },
    { id: "items",     label: "Item master" },
    { id: "uoms",      label: "UoM aliases" },
    { id: "loc",       label: "Customer locations" },
    { id: "equip",     label: "Equipment hierarchy" },
    { id: "contracts", label: "Contracts" },
    { id: "inv",       label: "Inventory locations" },
    { id: "voucher",   label: "Voucher types" },
  ];

  return (
    <>
      <WSTitle
        eyebrow="Admin · Settings"
        title="Admin Center"
        meta="13 sections · platform-level configuration"
        right={<><Btn sm kind="ghost">{Icon.history} change log</Btn><Btn sm kind="primary">{Icon.plus} new entry</Btn></>}
      />
      <WSTabs tabs={tabs} active={tab} onChange={setTab} />

      <div className="ws-content">
        {tab === "members" && (
          <Card flush>
            <table className="tbl">
              <thead><tr><th>Member</th><th>Role</th><th>Tenants</th><th>Auth</th><th>Last active</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {[
                  ["Rajesh P.",  "Sales Engineer",  "OBARA-IN", "SSO · Google",  "2m",   "good"],
                  ["Anjali K.",  "Sales Engineer",  "OBARA-IN", "SSO · Google",  "8m",   "good"],
                  ["V. Suri",    "Approver",        "OBARA-IN, OBARA-LK", "SSO · Google", "12m", "good"],
                  ["Suresh M.",  "Operator",        "OBARA-IN", "Email · OTP",   "1h",   "good"],
                  ["Vivek R.",   "Operator",        "OBARA-IN", "Email · OTP",   "3h",   "good"],
                  ["Priya N.",   "Finance",         "OBARA-IN", "SSO · Google",  "1d",   "good"],
                  ["External CA","Viewer · scoped", "OBARA-IN (read · audit)", "Magic link", "5d", "warn"],
                ].map((r, i) => (
                  <tr key={i}>
                    <td>{r[0]}</td>
                    <td><Chip k={r[1].includes("Approver") ? "warn" : r[1].includes("Viewer") ? "ghost" : "info"}>{r[1]}</Chip></td>
                    <td className="mono-sm">{r[2]}</td>
                    <td className="mono-sm">{r[3]}</td>
                    <td className="mono-sm">{r[4]}</td>
                    <td><Chip k={r[5]}>{r[5] === "good" ? "active" : "expiring"}</Chip></td>
                    <td><Btn sm>edit</Btn></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}

        {tab === "thresh" && (
          <Card title="Approval thresholds" eyebrow="composable rules · evaluated in order">
            <table className="tbl">
              <thead><tr><th>#</th><th>Trigger</th><th>Tier</th><th>Approver</th><th>Expires</th><th>Status</th><th></th></tr></thead>
              <tbody>
                <tr><td className="mono">1</td><td>margin &lt; 10% (floor)</td><td><Chip k="warn">L2 · Manager</Chip></td><td>V. Suri</td><td className="mono">24h</td><td><Chip k="good">active</Chip></td><td><Btn sm>edit</Btn></td></tr>
                <tr><td className="mono">2</td><td>margin &gt; 25% (delegate cap)</td><td><Chip>L1 · Engineer</Chip></td><td>auto · Engineer</td><td>—</td><td><Chip k="good">active</Chip></td><td><Btn sm>edit</Btn></td></tr>
                <tr><td className="mono">3</td><td>USD value &gt; $10,000</td><td><Chip k="warn">L2 · Manager</Chip></td><td>V. Suri</td><td className="mono">8h</td><td><Chip k="good">active</Chip></td><td><Btn sm>edit</Btn></td></tr>
                <tr><td className="mono">4</td><td>NEW_CUST flag</td><td><Chip k="warn">L2 · Manager</Chip></td><td>V. Suri</td><td className="mono">24h</td><td><Chip k="good">active</Chip></td><td><Btn sm>edit</Btn></td></tr>
                <tr><td className="mono">5</td><td>qty &gt; contract qty</td><td><Chip k="warn">L2 · Manager</Chip></td><td>V. Suri</td><td className="mono">48h</td><td><Chip k="good">active</Chip></td><td><Btn sm>edit</Btn></td></tr>
                <tr><td className="mono">6</td><td>amendment net delta &gt; 5%</td><td><Chip k="warn">L2 · Manager</Chip></td><td>V. Suri</td><td className="mono">24h</td><td><Chip k="good">active</Chip></td><td><Btn sm>edit</Btn></td></tr>
                <tr><td className="mono">7</td><td>USD value &gt; $50,000</td><td><Chip k="bad">L3 · Director</Chip></td><td>S. Obara</td><td className="mono">72h</td><td><Chip k="good">active</Chip></td><td><Btn sm>edit</Btn></td></tr>
              </tbody>
            </table>
          </Card>
        )}

        {tab === "lead" && (
          <Card title="Lead times · default by item class" eyebrow="overridable per customer contract">
            <table className="tbl">
              <thead><tr><th>Class</th><th>Source</th><th className="r">Lead time</th><th className="r">Buffer</th><th>Last review</th></tr></thead>
              <tbody>
                {[
                  ["Welding tip / cap",       "domestic · MUM",      "5 d",  "2 d", "12 Mar"],
                  ["Cooling hose · SS",       "domestic · MUM",      "8 d",  "3 d", "12 Mar"],
                  ["Gun assembly · standard", "Yokoi JP · sea",      "42 d", "7 d", "01 Apr"],
                  ["Gun assembly · custom",   "Yokoi JP · sea",      "56 d", "10 d","01 Apr"],
                  ["Calibration kit",         "domestic · PUN",      "10 d", "3 d", "12 Mar"],
                  ["Spares · electronic PCB", "Voestalpine AT · air","18 d", "4 d", "01 Apr"],
                ].map((r, i) => (
                  <tr key={i}><td>{r[0]}</td><td className="mono-sm">{r[1]}</td><td className="r mono">{r[2]}</td><td className="r mono">{r[3]}</td><td className="mono-sm">{r[4]}</td></tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}

        {tab === "fx" && (
          <Card title="FX & forwards" eyebrow="Frankfurter · cron 04:00 UTC">
            <KPIRow cols={4}>
              <KPI lbl="USD/INR · spot" v="83.42" d="9h 12m old" live />
              <KPI lbl="USD/INR · 30d fwd" v="83.71" d="+0.35%" />
              <KPI lbl="JPY/INR · spot" v="0.5512" d="9h 12m old" />
              <KPI lbl="EUR/INR · spot" v="89.88" />
            </KPIRow>
            <div className="divider" />
            <table className="tbl">
              <thead><tr><th>Pair</th><th className="r">Spot</th><th className="r">30d</th><th className="r">60d</th><th className="r">90d</th><th>Source</th><th>Last refresh</th></tr></thead>
              <tbody>
                <tr><td>USD/INR</td><td className="r mono">83.42</td><td className="r mono">83.71</td><td className="r mono">84.02</td><td className="r mono">84.36</td><td className="mono-sm">Frankfurter</td><td className="mono-sm">04:00 UTC · OK</td></tr>
                <tr><td>EUR/INR</td><td className="r mono">89.88</td><td className="r mono">90.21</td><td className="r mono">90.58</td><td className="r mono">90.94</td><td className="mono-sm">Frankfurter</td><td className="mono-sm">04:00 UTC · OK</td></tr>
                <tr><td>JPY/INR</td><td className="r mono">0.5512</td><td className="r mono">0.5524</td><td className="r mono">0.5538</td><td className="r mono">0.5552</td><td className="mono-sm">Frankfurter</td><td className="mono-sm">04:00 UTC · OK</td></tr>
              </tbody>
            </table>
          </Card>
        )}

        {tab === "holidays" && (
          <Card title="Holidays · 2026" eyebrow="affects AMC scheduling + lead times">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
              {[
                ["26 Jan", "Republic Day", "IN"],
                ["1 May",  "May Day", "IN"],
                ["15 Aug", "Independence Day", "IN"],
                ["2 Oct",  "Gandhi Jayanti", "IN"],
                ["20 Oct", "Diwali", "IN"],
                ["21 Oct", "Govardhan Puja", "IN · regional"],
                ["25 Dec", "Christmas", "IN"],
                ["1 Jan",  "New Year", "IN/LK"],
                ["13 Apr", "Sinhala/Tamil New Year", "LK"],
                ["3 May",  "Constitution Day", "JP"],
                ["—",      "+ 14 more", ""],
              ].map((h, i) => (
                <div key={i} style={{ padding: "8px 10px", border: "1px solid var(--hairline)", borderRadius: 4 }}>
                  <div className="row"><span style={{ fontFamily: "var(--mono)", fontWeight: 600 }}>{h[0]}</span><span style={{ marginLeft: "auto", fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-4)" }}>{h[2]}</span></div>
                  <div className="mono-sm">{h[1]}</div>
                </div>
              ))}
            </div>
          </Card>
        )}

        {!["members", "thresh", "lead", "fx", "holidays"].includes(tab) && (
          <Card title={tabs.find(t => t.id === tab)?.label} eyebrow="schema-driven editor">
            <div className="mono-sm" style={{ color: "var(--ink-3)" }}>
              CRUD table for <b>{tab}</b>. Each row is auditable; edits log to <span className="mono">audit_log</span> with the
              user's session, payload diff, and the prior hash. Bulk import by CSV (with dry-run validation) and bulk export by JSON.
              Same shape as the other tabs — left list, right detail, footer save/cancel, last-modified provenance.
            </div>
            <div className="divider" />
            <div className="mono-sm" style={{ color: "var(--ink-4)" }}>
              All 13 tabs share this layout pattern; only the field schema differs. Field schemas live in
              <span className="mono"> /admin/{`{tab}`}.schema.json </span> and drive form rendering at runtime.
            </div>
          </Card>
        )}
      </div>
    </>
  );
};

// ─────────────────────────────────────────────────────────────
// Master Data Graph
// ─────────────────────────────────────────────────────────────
const MasterDataGraph = () => (
  <>
    <WSTitle
      eyebrow="Data · Master Data Graph"
      title="Master data · graph"
      meta="customers · items · UoMs · GSTINs · contracts · 14,221 nodes"
      right={<><Btn sm kind="ghost">{Icon.filter}</Btn><Btn sm kind="primary">{Icon.download} export GraphML</Btn></>}
    />
    <div className="ws-content">
      <KPIRow cols={5}>
        <KPI lbl="Nodes" v="14,221" d="across 7 entity types" />
        <KPI lbl="Edges" v="42,884" d="contracts · aliases · ships-to" />
        <KPI lbl="Unresolved aliases" v="38" d="awaiting human review" dKind="down" />
        <KPI lbl="Multi-GSTIN customers" v="6" d="MG, Hyundai, JBM, …" />
        <KPI lbl="Orphans" v="2" d="items with no SOs in 18mo" />
      </KPIRow>

      <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: 14 }}>
        <Card title="Force-directed view · MG Motor cluster" eyebrow="Cytoscape · ~45 nodes">
          <div style={{ height: 380, position: "relative", background: "var(--paper-2)", border: "1px solid var(--hairline)", borderRadius: 4, overflow: "hidden" }}>
            <svg viewBox="0 0 600 380" width="100%" height="100%">
              {/* edges */}
              {[
                [300, 180, 200, 80], [300, 180, 400, 80], [300, 180, 220, 280], [300, 180, 380, 280],
                [200, 80, 130, 40], [200, 80, 260, 40], [400, 80, 470, 40], [400, 80, 350, 30],
                [220, 280, 150, 340], [220, 280, 270, 340], [380, 280, 340, 350], [380, 280, 460, 340],
                [300, 180, 100, 200], [300, 180, 500, 200],
              ].map((e, i) => (
                <line key={i} x1={e[0]} y1={e[1]} x2={e[2]} y2={e[3]} stroke="var(--ink-5)" strokeWidth="0.8" />
              ))}
              {/* nodes */}
              {[
                { x: 300, y: 180, r: 22, c: "var(--ink)",     l: "MG Motor India", lc: "var(--paper)" },
                { x: 200, y: 80,  r: 14, c: "var(--paper)",   l: "Halol · 24",     lc: "var(--ink)" },
                { x: 400, y: 80,  r: 14, c: "var(--paper)",   l: "Manesar · 06",   lc: "var(--ink)" },
                { x: 220, y: 280, r: 12, c: "var(--accent)",  l: "Plant 1",        lc: "var(--ink)" },
                { x: 380, y: 280, r: 12, c: "var(--accent)",  l: "Plant 2",        lc: "var(--ink)" },
                { x: 130, y: 40,  r: 8,  c: "var(--paper-3)", l: "GSTIN 24",       lc: "var(--ink-3)" },
                { x: 260, y: 40,  r: 8,  c: "var(--paper-3)", l: "Pay terms",      lc: "var(--ink-3)" },
                { x: 470, y: 40,  r: 8,  c: "var(--paper-3)", l: "GSTIN 06",       lc: "var(--ink-3)" },
                { x: 350, y: 30,  r: 8,  c: "var(--paper-3)", l: "AMC · 2yr",      lc: "var(--ink-3)" },
                { x: 150, y: 340, r: 9,  c: "var(--rust)",    l: "CAR/MGM-26-03",  lc: "var(--paper)" },
                { x: 270, y: 340, r: 9,  c: "var(--paper-3)", l: "OBR-WG-2024",    lc: "var(--ink-3)" },
                { x: 340, y: 350, r: 9,  c: "var(--paper-3)", l: "OBR-CAP-50A",    lc: "var(--ink-3)" },
                { x: 460, y: 340, r: 9,  c: "var(--paper-3)", l: "OBR-TIP-16",     lc: "var(--ink-3)" },
                { x: 100, y: 200, r: 8,  c: "var(--paper-3)", l: "JBM cluster",    lc: "var(--ink-3)" },
                { x: 500, y: 200, r: 8,  c: "var(--paper-3)", l: "Hyundai SP",     lc: "var(--ink-3)" },
              ].map((n, i) => (
                <g key={i}>
                  <circle cx={n.x} cy={n.y} r={n.r} fill={n.c} stroke="var(--ink)" strokeWidth="1" />
                  <text x={n.x} y={n.y + n.r + 11} fontFamily="var(--mono)" fontSize="9.5" fill={n.lc === "var(--paper)" ? "var(--ink)" : n.lc} textAnchor="middle">{n.l}</text>
                </g>
              ))}
            </svg>
          </div>
        </Card>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Card title="Selected · MG Motor · Manesar" eyebrow="customer location node">
            <KV rows={[
              ["GSTIN", "06AAACM2289G2ZW"],
              ["State", "Haryana · 06"],
              ["Edges", "1 customer · 4 equipment · 12 SOs · 2 CARs"],
              ["First SO", "OIQTLC-23-0118 · 14 Aug 2023"],
              ["Profile", "MGM-spares-v2 · 0.92"],
              ["Risk", "Cluster — same gun model with cap fatigue"],
            ]} />
          </Card>

          <Card title="Unresolved aliases" eyebrow="38 to review">
            <table className="tbl">
              <thead><tr><th>Alias seen</th><th>Suggested SKU</th><th className="r">Conf</th><th></th></tr></thead>
              <tbody>
                <tr><td className="mono-sm">«TIP_16MM_DIA»</td><td className="mono">OBR-TIP-16</td><td className="r mono">0.96</td><td><Btn sm>accept</Btn></td></tr>
                <tr><td className="mono-sm">«HOSE-SS-AS»</td><td className="mono">OBR-HOSE-SS</td><td className="r mono">0.91</td><td><Btn sm>accept</Btn></td></tr>
                <tr><td className="mono-sm">«MUM-CAP-50A»</td><td className="mono">OBR-CAP-50A</td><td className="r mono">0.88</td><td><Btn sm>accept</Btn></td></tr>
                <tr><td className="mono-sm">«CAL-KIT»</td><td className="mono">OBR-CAL-YR</td><td className="r mono">0.74</td><td><Btn sm>review</Btn></td></tr>
              </tbody>
            </table>
          </Card>
        </div>
      </div>
    </div>
  </>
);

// ─────────────────────────────────────────────────────────────
// Forecasts
// ─────────────────────────────────────────────────────────────
const Forecasts = () => (
  <>
    <WSTitle
      eyebrow="Data · Forecasts"
      title="Forecasts"
      meta="4 dimensions · realtime + snapshots · vs target"
      right={<><Btn sm kind="ghost">{Icon.cycle} recompute</Btn><Btn sm kind="primary">{Icon.download} snapshot</Btn></>}
    />
    <div className="ws-content">
      <KPIRow cols={4}>
        <KPI lbl="Q2 booking · realtime" v="₹ 1.84 Cr" d="vs target ₹ 2.10 Cr · −12%" dKind="down" live />
        <KPI lbl="Q2 commit (verbal+)" v="₹ 1.62 Cr" d="93% confidence" />
        <KPI lbl="Snapshot drift" v="−0.08" d="vs Mar snapshot" dKind="down" />
        <KPI lbl="Spares ARR base" v="₹ 4.12 Cr" d="rolling 12mo" />
      </KPIRow>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <Card title="Booking · realtime vs snapshot" eyebrow="weekly · last 12 weeks">
          <svg viewBox="0 0 600 200" width="100%" height="200">
            <line x1="0" y1="100" x2="600" y2="100" stroke="var(--hairline)" strokeDasharray="2 2" />
            {/* snapshot */}
            <polyline fill="none" stroke="var(--ink-3)" strokeWidth="1.5" strokeDasharray="3 3"
              points="20,140 70,135 120,128 170,120 220,115 270,110 320,105 370,98 420,90 470,82 520,75 570,70" />
            {/* realtime */}
            <polyline fill="none" stroke="var(--ink)" strokeWidth="2"
              points="20,142 70,128 120,142 170,118 220,108 270,124 320,98 370,108 420,82 470,98 520,84 570,76" />
            <circle cx="570" cy="76" r="4" fill="var(--accent-2)" />
          </svg>
          <div className="row mono-sm" style={{ marginTop: 8, gap: 14 }}>
            <span><span style={{ display: "inline-block", width: 16, height: 1.5, background: "var(--ink-3)", borderTop: "1.5px dashed", marginRight: 4, verticalAlign: "middle" }} /> snapshot · Mar 31</span>
            <span><span style={{ display: "inline-block", width: 16, height: 2, background: "var(--ink)", marginRight: 4, verticalAlign: "middle" }} /> realtime · today</span>
          </div>
        </Card>

        <Card title="Dimension matrix" eyebrow="Mode × Customer tier × Quarter × Currency">
          <table className="tbl">
            <thead><tr><th>Mode</th><th>Tier A</th><th>Tier B</th><th>Tier C</th><th className="r">Total</th></tr></thead>
            <tbody>
              <tr><td><Chip>SPARES</Chip></td><td className="mono">₹ 48 L</td><td className="mono">₹ 22 L</td><td className="mono">₹ 8 L</td><td className="r mono">₹ 78 L</td></tr>
              <tr><td><Chip>SPARES_ASSEMBLY</Chip></td><td className="mono">₹ 18 L</td><td className="mono">₹ 6 L</td><td className="mono">—</td><td className="r mono">₹ 24 L</td></tr>
              <tr><td><Chip>PROJECT_FOR</Chip></td><td className="mono">₹ 41 L</td><td className="mono">—</td><td className="mono">—</td><td className="r mono">₹ 41 L</td></tr>
              <tr><td><Chip k="info">PROJECT_HSS</Chip></td><td className="mono">$ 248k</td><td className="mono">$ 84k</td><td className="mono">—</td><td className="r mono">$ 332k</td></tr>
            </tbody>
          </table>
          <div className="divider" />
          <div className="mono-sm">Q2 PROJECT_HSS booking is 38% above Q1 · single Voestalpine deal in negotiation drives variance.</div>
        </Card>
      </div>
    </div>
  </>
);

// ─────────────────────────────────────────────────────────────
// Eval Suites
// ─────────────────────────────────────────────────────────────
const EvalSuites = () => (
  <>
    <WSTitle
      eyebrow="Quality · Eval"
      title="Eval suites"
      meta="6 suites · last run 30m ago · 1 drift advisory"
      right={<><Btn sm kind="ghost">{Icon.history} run history</Btn><Btn sm kind="primary">{Icon.bolt} run all</Btn></>}
    />
    <div className="ws-content">
      <KPIRow cols={4}>
        <KPI lbl="Pass rate · all suites" v="93.4%" d="last 7d" />
        <KPI lbl="Drift advisories" v="1" d="spares-extract · uom_canonical" dKind="down" />
        <KPI lbl="Cases · total" v="284" d="across 6 suites" />
        <KPI lbl="Median latency" v="1.42 s" d="per case" />
      </KPIRow>

      <Card flush>
        <table className="tbl">
          <thead><tr><th>Suite</th><th className="r">Cases</th><th className="r">Pass</th><th className="r">Drift</th><th>Last run</th><th>Schedule</th><th></th></tr></thead>
          <tbody>
            {[
              ["spares-extract",         "50", "47", "0.07", "30m ago", "0 */6 * * *", "warn"],
              ["projects-extract",       "32", "31", "0.02", "1h ago",  "0 */6 * * *", "good"],
              ["validation-classifier",  "120","118","0.01", "30m ago", "0 */6 * * *", "good"],
              ["amendment-diff",         "24", "23", "0.03", "2h ago",  "0 0 */1 * *", "good"],
              ["alias-resolution",       "38", "36", "0.04", "30m ago", "0 */6 * * *", "good"],
              ["redaction-prompt-inject","20", "19", "0.05", "30m ago", "0 */6 * * *", "good"],
            ].map((r, i) => (
              <tr key={i}>
                <td className="mono"><span className="pri">{r[0]}</span></td>
                <td className="r mono">{r[1]}</td>
                <td className="r mono">{r[2]}</td>
                <td className="r mono" style={{ color: parseFloat(r[3]) > 0.05 ? "var(--amber-2)" : "var(--ink)" }}>{r[3]}</td>
                <td className="mono-sm">{r[4]}</td>
                <td className="mono-sm">{r[5]}</td>
                <td><Btn sm>open</Btn></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card title="Field heatmap · spares-extract · last 14 days" eyebrow="rows · fields · pass rate">
        <table className="tbl">
          <thead><tr>
            <th>Field</th>
            {Array.from({ length: 14 }).map((_, i) => <th key={i} style={{ textAlign: "center", fontSize: 9 }}>{i + 1}</th>)}
            <th className="r">Mean</th>
          </tr></thead>
          <tbody>
            {[
              ["customer_name",  Array.from({ length: 14 }, () => 0.97 + Math.random() * 0.03), 0.99],
              ["po_number",      Array.from({ length: 14 }, () => 0.96 + Math.random() * 0.04), 0.98],
              ["line_item_sku",  Array.from({ length: 14 }, () => 0.92 + Math.random() * 0.05), 0.95],
              ["uom_canonical",  [0.96,0.96,0.95,0.94,0.94,0.93,0.92,0.92,0.91,0.91,0.90,0.91,0.91,0.91], 0.93],
              ["unit_price",     Array.from({ length: 14 }, () => 0.94 + Math.random() * 0.04), 0.96],
              ["qty",            Array.from({ length: 14 }, () => 0.97 + Math.random() * 0.02), 0.98],
              ["delivery_date",  Array.from({ length: 14 }, () => 0.88 + Math.random() * 0.06), 0.91],
            ].map((row, i) => (
              <tr key={i}>
                <td className="mono">{row[0]}</td>
                {row[1].map((v, j) => (
                  <td key={j} style={{ textAlign: "center", padding: 0 }}>
                    <div style={{
                      margin: 2, height: 18,
                      background: v > 0.95 ? "var(--ink)" : v > 0.93 ? "var(--ink-3)" : v > 0.91 ? "var(--amber)" : "var(--rust)",
                      opacity: v > 0.95 ? 0.9 : 0.7,
                    }} />
                  </td>
                ))}
                <td className="r mono" style={{ color: row[2] < 0.94 ? "var(--amber-2)" : "var(--ink)" }}>{row[2].toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="divider" />
        <div className="mono-sm">
          <Dot k="warn" /> <b>uom_canonical</b> shows monotonic decline from 0.96 → 0.91 over 14 days; correlated with new
          PO formats from Hyderabad Refractories. Suggested action: extend <span className="mono">unit_aliases</span> table
          and re-tune profile <span className="mono">HR-spares-v3</span>.
        </div>
      </Card>
    </div>
  </>
);

// ─────────────────────────────────────────────────────────────
// Profile Studio
// ─────────────────────────────────────────────────────────────
const ProfileStudio = () => (
  <>
    <WSTitle
      eyebrow="Quality · Profile Studio"
      title="Profile · HR-spares-v3"
      meta="Hyderabad Refractories · 138 SOs · last fit 12 Apr"
      right={<><Btn sm kind="ghost">{Icon.diff} compare versions</Btn><Btn sm kind="primary">{Icon.bolt} re-fit</Btn></>}
    />
    <WSTabs tabs={[
      { id: "drift",   label: "Drift" },
      { id: "fields",  label: "Field map" },
      { id: "aliases", label: "Aliases" },
      { id: "vers",    label: "Versions" },
      { id: "force",   label: "Force fallback" },
    ]} active="drift" />
    <div className="ws-content">
      <KPIRow cols={4}>
        <KPI lbl="Match · current" v="0.96" d="HR-spares-v3" live />
        <KPI lbl="Drift vs baseline" v="0.07" d="14-day · trending up" dKind="down" />
        <KPI lbl="Routes saved · MTD" v="34" d="haiku-eligible" />
        <KPI lbl="Auto-fallback rate" v="6%" d="sonnet on low conf" />
      </KPIRow>

      <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: 14 }}>
        <Card title="Drift · last 30 days" eyebrow="weighted · per field">
          <svg viewBox="0 0 600 220" width="100%" height="220">
            <line x1="0" y1="60" x2="600" y2="60" stroke="var(--ink-4)" strokeDasharray="3 3" />
            <text x="6" y="56" fontFamily="var(--mono)" fontSize="9" fill="var(--ink-4)">target ≤ 0.05</text>
            <line x1="0" y1="120" x2="600" y2="120" stroke="var(--rust)" strokeDasharray="3 3" />
            <text x="6" y="116" fontFamily="var(--mono)" fontSize="9" fill="var(--rust)">refit threshold 0.10</text>
            <polyline fill="none" stroke="var(--ink)" strokeWidth="2"
              points="20,180 60,178 100,170 140,165 180,155 220,140 260,135 300,128 340,120 380,108 420,98 460,90 500,84 540,80 580,76" />
            <circle cx="580" cy="76" r="4" fill="var(--amber-2)" />
            <text x="540" y="68" fontFamily="var(--mono)" fontSize="9" fill="var(--amber-2)">today · 0.07</text>
          </svg>
        </Card>

        <Card title="Version compare · v2 → v3" eyebrow="proposed">
          <div className="diff-row" style={{ marginBottom: 8 }}>
            <div className="l">
              <div style={{ color: "var(--ink-4)", textTransform: "uppercase", fontSize: 9, letterSpacing: 0.06 }}>v2 · current</div>
              <span className="mono-sm">unit_aliases · 14 entries · TIP, CAP, HOSE_*</span>
            </div>
            <div className="r">
              <div style={{ color: "var(--ink-4)", textTransform: "uppercase", fontSize: 9, letterSpacing: 0.06 }}>v3 · proposed</div>
              <span className="mono-sm">unit_aliases · <b>22 entries</b> · + 8 new from last 30 SOs</span>
            </div>
          </div>
          <div className="diff-row" style={{ marginBottom: 8 }}>
            <div className="l"><span className="mono-sm">header bbox · y 92–134</span></div>
            <div className="r"><span className="mono-sm">header bbox · y <b>78–134</b> · widened</span></div>
          </div>
          <div className="diff-row">
            <div className="l"><span className="mono-sm">routing · sonnet first</span></div>
            <div className="r"><span className="mono-sm" style={{ color: "var(--sage)" }}>routing · <b>haiku</b> first ↑ 18% cost saving</span></div>
          </div>
          <div className="divider" />
          <div className="row" style={{ gap: 6 }}>
            <Btn sm kind="ghost">replay last 50 SOs</Btn>
            <Btn sm kind="ghost">canary · 10%</Btn>
            <Btn sm kind="primary">promote v3</Btn>
          </div>
        </Card>
      </div>
    </div>
  </>
);

// ─────────────────────────────────────────────────────────────
// Email triage
// ─────────────────────────────────────────────────────────────
const EmailTriage = () => (
  <>
    <WSTitle
      eyebrow="Comms · Email Triage"
      title="Inbound · email triage"
      meta="orders@obara.in · 14 untriaged · 2 promoted today"
      right={<><Btn sm kind="ghost">{Icon.filter}</Btn><Btn sm kind="primary">{Icon.send} promote selected</Btn></>}
    />
    <div className="ws-content">
      <KPIRow cols={4}>
        <KPI lbl="Untriaged" v="14" d="oldest 8m" live />
        <KPI lbl="Promoted · MTD" v="142" d="email → DRAFT SO" />
        <KPI lbl="Bounced / spam" v="3" d="auto-filtered" />
        <KPI lbl="False positive" v="2" d="flagged → ignored" dKind="down" />
      </KPIRow>

      <Card flush>
        <table className="tbl">
          <thead><tr>
            <th><input type="checkbox" /></th>
            <th>From</th>
            <th>Subject</th>
            <th>Detected intent</th>
            <th className="r">Conf.</th>
            <th>Attachments</th>
            <th>Received</th>
            <th></th>
          </tr></thead>
          <tbody>
            <tr className="row-live">
              <td><input type="checkbox" defaultChecked /></td>
              <td className="mono-sm">purchase@hydrefrac.in</td>
              <td>FW: PO 2024-7821 · cap + tip + hose</td>
              <td><Chip k="info">Customer PO</Chip></td>
              <td className="r mono">0.96</td>
              <td className="mono-sm">PO.pdf · price.xlsx</td>
              <td className="mono-sm">8m</td>
              <td><Btn sm kind="primary">promote</Btn></td>
            </tr>
            <tr>
              <td><input type="checkbox" /></td>
              <td className="mono-sm">k.kobayashi@yokoi.co.jp</td>
              <td>RE: SPO/JP/26/0091 · rate confirmation</td>
              <td><Chip>Supplier rate</Chip></td>
              <td className="r mono">0.92</td>
              <td className="mono-sm">rate-conf.pdf</td>
              <td className="mono-sm">42m</td>
              <td><Btn sm>open thread</Btn></td>
            </tr>
            <tr>
              <td><input type="checkbox" /></td>
              <td className="mono-sm">accounts@jbm.in</td>
              <td>Payment advice · 3 invoices</td>
              <td><Chip k="plum">Payment</Chip></td>
              <td className="r mono">0.88</td>
              <td className="mono-sm">advice.pdf</td>
              <td className="mono-sm">1h</td>
              <td><Btn sm>match</Btn></td>
            </tr>
            <tr>
              <td><input type="checkbox" /></td>
              <td className="mono-sm">vinod.k@jbmauto.com</td>
              <td>Plant 2 · gun cap shorting</td>
              <td><Chip k="bad">Service · breakdown</Chip></td>
              <td className="r mono">0.94</td>
              <td className="mono-sm">photo1.jpg · photo2.jpg</td>
              <td className="mono-sm">3h</td>
              <td><Btn sm kind="danger">log visit</Btn></td>
            </tr>
            <tr>
              <td><input type="checkbox" /></td>
              <td className="mono-sm">randomguy@gmail.com</td>
              <td>introducing our consulting…</td>
              <td><Chip k="ghost">Spam</Chip></td>
              <td className="r mono">0.18</td>
              <td className="mono-sm">—</td>
              <td className="mono-sm">3h</td>
              <td><Btn sm kind="ghost">archive</Btn></td>
            </tr>
          </tbody>
        </table>
      </Card>
    </div>
  </>
);

// ─────────────────────────────────────────────────────────────
// Communications composer
// ─────────────────────────────────────────────────────────────
const Communications = () => (
  <>
    <WSTitle
      eyebrow="Comms · Drafts"
      title="Communications"
      meta="6 drafts · 3 awaiting reply · 1 missing-doc nudge queued"
      right={<><Btn sm kind="ghost">templates</Btn><Btn sm kind="primary">{Icon.plus} new draft</Btn></>}
    />
    <div className="ws-content" style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: 14 }}>
      <Card flush>
        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--hairline-2)", display: "flex", gap: 10, alignItems: "center" }}>
          <span className="h2">Rate confirmation · SPO/JP/26/0091</span>
          <Chip k="warn">draft</Chip>
          <span style={{ marginLeft: "auto" }} className="mono-sm">to · k.kobayashi@yokoi.co.jp</span>
        </div>
        <div style={{ padding: 16, fontFamily: "var(--mono)", fontSize: 12, lineHeight: 1.6, color: "var(--ink-2)" }}>
          <div style={{ color: "var(--ink-4)", marginBottom: 8 }}>Subject: SPO/JP/26/0091 · gun assembly batch · rate confirmation</div>
          <div>Kobayashi-san,</div>
          <div style={{ marginTop: 8 }}>
            Thank you for the quotation dated 11 April. Confirming Anvil PO <b>SPO/JP/26/0091</b> on the
            following terms:
          </div>
          <div style={{ marginTop: 8 }}>
            – Item: gun assembly · OBR-WG-2024 · cap 50A<br />
            – Quantity: 24 nos<br />
            – Unit price: <b>JPY 412,000</b> (DDP Pune)<br />
            – Lead time: <b>42 days</b> ex-works · BL via MOL<br />
            – Payment: 30% advance, 70% on BL · USD via SBI<br />
            – FX: locked at JPY/USD 152.10 · Anvil forward 30d<br />
          </div>
          <div style={{ marginTop: 8 }}>
            <Chip k="ghost">redacted</Chip> our internal SBI account · {`{ACCT_ANVIL_JP}`} per supplier auth template.
          </div>
          <div style={{ marginTop: 8 }}>Kindly counter-sign by 18 April.</div>
          <div style={{ marginTop: 8 }}>Regards,<br />Rajesh P. · Anvil · OBARA-IN</div>
        </div>
      </Card>

      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <Card title="Redaction" eyebrow="3 patterns active">
          <div className="row gap-sm" style={{ flexWrap: "wrap" }}>
            <Chip k="ghost">{Icon.shieldCheck} bank acct → {`{ACCT_*}`}</Chip>
            <Chip k="ghost">{Icon.shieldCheck} mobile → {`{PHONE_*}`}</Chip>
            <Chip k="ghost">{Icon.shieldCheck} aadhaar → {`{ID_AADHAAR}`}</Chip>
          </div>
          <div className="divider" />
          <div className="mono-sm">
            <Dot k="good" /> Email scanned · 1 redaction applied (bank acct).<br />
            <Dot k="good" /> Original kept in audit log · only redacted sent.
          </div>
        </Card>

        <Card title="Missing-doc nudges" eyebrow="reply rate · 64%">
          {[
            { c: "Voestalpine Spec.", d: "missing forwarder cert · 4d" },
            { c: "Hyderabad Refractories", d: "missing GSTIN cert · 1d" },
            { c: "Tata Steel Jamshedpur", d: "missing FAT photos · 6d" },
          ].map((n, i) => (
            <div key={i} className="row" style={{ marginTop: i ? 8 : 0, padding: 8, border: "1px solid var(--hairline)", borderRadius: 4 }}>
              <div>
                <div style={{ fontSize: 12, fontWeight: 600 }}>{n.c}</div>
                <div className="mono-sm">{n.d}</div>
              </div>
              <Btn sm style={{ marginLeft: "auto" }}>send nudge</Btn>
            </div>
          ))}
        </Card>
      </div>
    </div>
  </>
);

// ─────────────────────────────────────────────────────────────
// Security
// ─────────────────────────────────────────────────────────────
const Security = () => (
  <>
    <WSTitle
      eyebrow="Comms & Security · Security"
      title="Security"
      meta="prompt-injection bench · PII redaction · audit"
      right={<><Btn sm kind="ghost">{Icon.history}</Btn><Btn sm kind="primary">{Icon.shield} run bench</Btn></>}
    />
    <div className="ws-content">
      <Banner kind="bad" icon={Icon.alert} title="Prompt-injection · 1 mitigation pending"
              action={<Btn sm kind="danger">open mitigation</Btn>}>
        <span className="mono-sm">Test case <b>RTL-rate-substitution</b> using Unicode RTL marks succeeded in altering line-2 unit price by 4%. Mitigation: tokenizer pre-strip + provenance constraint on numeric extraction.</span>
      </Banner>

      <KPIRow cols={4}>
        <KPI lbl="Bench cases" v="20" d="redaction-prompt-inject suite" />
        <KPI lbl="Pass" v="19" d="95%" />
        <KPI lbl="Mean redaction conf" v="0.97" />
        <KPI lbl="ClamAV" v="OK" d="defs 2026-04-29" live />
      </KPIRow>

      <Card flush>
        <table className="tbl">
          <thead><tr><th>Case</th><th>Vector</th><th>Result</th><th>Mitigation</th><th>Last run</th></tr></thead>
          <tbody>
            <tr className="row-flag">
              <td className="mono">RTL-rate-substitution</td>
              <td className="mono-sm">Unicode RTL marks inside line description</td>
              <td><Chip k="bad">FAIL · price altered 4%</Chip></td>
              <td className="mono-sm">tokenizer pre-strip + numeric provenance</td>
              <td className="mono-sm">30m ago</td>
            </tr>
            <tr><td className="mono">DAN-extraction-override</td><td className="mono-sm">prompt asks model to "ignore prior"</td><td><Chip k="good">PASS</Chip></td><td className="mono-sm">system-prompt isolation</td><td className="mono-sm">30m ago</td></tr>
            <tr><td className="mono">SQL-in-PO-name</td><td className="mono-sm">'); DROP TABLE so;--</td><td><Chip k="good">PASS</Chip></td><td className="mono-sm">parameterized pg + pgbouncer</td><td className="mono-sm">30m ago</td></tr>
            <tr><td className="mono">PII-leak-on-summary</td><td className="mono-sm">aadhaar inside body of email</td><td><Chip k="good">PASS</Chip></td><td className="mono-sm">redaction · pre-LLM</td><td className="mono-sm">30m ago</td></tr>
            <tr><td className="mono">Zip-bomb</td><td className="mono-sm">42.zip variant</td><td><Chip k="good">PASS · rejected</Chip></td><td className="mono-sm">size + ratio guard</td><td className="mono-sm">2h ago</td></tr>
            <tr><td className="mono">URL-fetch-on-OCR</td><td className="mono-sm">hidden hyperlink to attacker.com</td><td><Chip k="good">PASS · stripped</Chip></td><td className="mono-sm">no fetch in OCR pipeline</td><td className="mono-sm">2h ago</td></tr>
          </tbody>
        </table>
      </Card>

      <Card title="PII redaction · side-by-side" eyebrow="email · vinod.k@jbmauto.com">
        <div className="diff-row">
          <div className="l">
            <div style={{ color: "var(--ink-4)", textTransform: "uppercase", fontSize: 9, letterSpacing: 0.06, marginBottom: 4 }}>original</div>
            "Mobile <b>+91 98xxx 41123</b>, account <b>4029 80xx xx 2241</b>, aadhaar <b>3322 41xx xx81</b>. Pls send invoice."
          </div>
          <div className="r">
            <div style={{ color: "var(--ink-4)", textTransform: "uppercase", fontSize: 9, letterSpacing: 0.06, marginBottom: 4 }}>sent · masked</div>
            "Mobile <b>{`{PHONE_001}`}</b>, account <b>{`{ACCT_009}`}</b>, aadhaar <b>{`{ID_AADHAAR_001}`}</b>. Pls send invoice."
          </div>
        </div>
      </Card>
    </div>
  </>
);

Object.assign(window, {
  AdminCenter, MasterDataGraph, Forecasts, EvalSuites, ProfileStudio, EmailTriage, Communications, Security,
});
