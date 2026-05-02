// ============================================================
// ANVIL v3 — Procurement · Customers · Audit · Inbox
// ============================================================

// ─────────────────────────────────────────────────────────────
// Inbox · global capture point
// ─────────────────────────────────────────────────────────────
const Inbox = () => (
  <>
    <WSTitle
      eyebrow="Workflows · Inbox"
      title="Inbox"
      meta="12 untriaged · email + drag-drop + connectors"
      right={<><Btn sm kind="ghost">{Icon.filter}</Btn><Btn sm kind="primary">{Icon.upload} upload</Btn></>}
    />
    <WSTabs tabs={[
      { id: "all", label: "All", count: 12 },
      { id: "po", label: "Customer POs", count: 5 },
      { id: "rate", label: "Supplier rates", count: 2 },
      { id: "svc", label: "Service emails", count: 3 },
      { id: "pay", label: "Payment advice", count: 1 },
      { id: "spam", label: "Filtered", count: 1 },
    ]} active="all" />

    <div className="ws-content">
      <div style={{ display: "grid", gridTemplateColumns: "1fr 380px", gap: 14 }}>
        <Card flush>
          <table className="tbl">
            <thead><tr>
              <th><input type="checkbox" /></th>
              <th>Source</th>
              <th>Subject / file</th>
              <th>Detected</th>
              <th className="r">Conf</th>
              <th>Age</th>
              <th></th>
            </tr></thead>
            <tbody>
              <tr className="row-live">
                <td><input type="checkbox" defaultChecked /></td>
                <td className="mono-sm">email · purchase@hydrefrac.in</td>
                <td>FW: PO 2024-7821 · cap + tip + hose</td>
                <td><Chip k="info">Customer PO</Chip></td>
                <td className="r mono">0.96</td>
                <td className="mono-sm">8m</td>
                <td><Btn sm kind="primary">promote → SO</Btn></td>
              </tr>
              <tr><td><input type="checkbox" /></td><td className="mono-sm">drop · Rajesh P.</td><td>MGM-PO-Halol.pdf</td><td><Chip k="info">Customer PO</Chip></td><td className="r mono">0.94</td><td className="mono-sm">22m</td><td><Btn sm>open</Btn></td></tr>
              <tr><td><input type="checkbox" /></td><td className="mono-sm">email · k.kobayashi@yokoi.co.jp</td><td>RE: SPO/JP/26/0091 · rate</td><td><Chip>Supplier rate</Chip></td><td className="r mono">0.92</td><td className="mono-sm">42m</td><td><Btn sm>open</Btn></td></tr>
              <tr><td><input type="checkbox" /></td><td className="mono-sm">email · vinod.k@jbmauto.com</td><td>Plant 2 · gun cap shorting</td><td><Chip k="bad">Service · breakdown</Chip></td><td className="r mono">0.94</td><td className="mono-sm">3h</td><td><Btn sm kind="danger">log visit</Btn></td></tr>
              <tr><td><input type="checkbox" /></td><td className="mono-sm">email · accounts@jbm.in</td><td>Payment advice · 3 invoices</td><td><Chip k="plum">Payment</Chip></td><td className="r mono">0.88</td><td className="mono-sm">1h</td><td><Btn sm>match</Btn></td></tr>
              <tr><td><input type="checkbox" /></td><td className="mono-sm">drop · Anjali K.</td><td>JBM-SO-template.xlsx</td><td><Chip>Order template</Chip></td><td className="r mono">0.86</td><td className="mono-sm">5h</td><td><Btn sm>open</Btn></td></tr>
            </tbody>
          </table>
        </Card>

        {/* drop zone */}
        <Card title="Drop zone" eyebrow="PDF · DOCX · XLSX · ZIP">
          <div style={{
            border: "1.5px dashed var(--hairline-3)", borderRadius: 6, padding: "32px 16px",
            textAlign: "center", color: "var(--ink-3)", background: "var(--paper-2)",
          }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-2)" }}>Drop documents here</div>
            <div className="mono-sm" style={{ marginTop: 4 }}>or paste from clipboard · ⌘V</div>
            <Btn sm kind="ghost" style={{ marginTop: 12 }}>{Icon.upload} browse</Btn>
          </div>
          <div className="divider" />
          <div className="mono-sm">
            <Dot k="good" /> ZIP guard · 100 MB cap · no recursion<br />
            <Dot k="good" /> ClamAV · scanned before parse<br />
            <Dot k="good" /> PDF · max 80 pages<br />
            <Dot k="info" /> XLSX · max 12 sheets, parsed first then OCR
          </div>
        </Card>
      </div>
    </div>
  </>
);

// ─────────────────────────────────────────────────────────────
// Source POs (procurement)
// ─────────────────────────────────────────────────────────────
const SourcePOs = () => (
  <>
    <WSTitle
      eyebrow="Procurement · Source POs"
      title="Source POs"
      meta="9 active · 3 overdue · ₹ 38.4 L open"
      right={<><Btn sm kind="ghost">{Icon.filter}</Btn><Btn sm kind="primary">{Icon.plus} New SPO</Btn></>}
    />
    <div className="ws-content">
      <KPIRow cols={4}>
        <KPI lbl="Active" v="9" d="JP · IN · AT" />
        <KPI lbl="On-time supplier rate" v="86%" d="rolling 90d" />
        <KPI lbl="Overdue" v="3" d="oldest 12 d" dKind="down" />
        <KPI lbl="Avg lead time" v="38 d" d="weighted by ₹" />
      </KPIRow>

      <Card flush>
        <table className="tbl">
          <thead><tr>
            <th>SPO</th><th>Supplier</th><th>For SO</th><th>Item</th><th className="r">Qty</th><th className="r">Rate</th><th>ETA</th><th>Status</th><th></th>
          </tr></thead>
          <tbody>
            <tr className="row-live"><td className="mono"><span className="pri">SPO/JP/26/0091</span></td><td>Yokoi Manufacturing · JP</td><td className="mono">OIQTLC-26-1015</td><td>Welding tip ⌀16</td><td className="r mono">400</td><td className="r mono">JPY 412</td><td className="mono">14 May</td><td><Chip k="warn">in transit</Chip></td><td><Btn sm>track</Btn></td></tr>
            <tr><td className="mono"><span className="pri">SPO/JP/26/0089</span></td><td>Yokoi Manufacturing · JP</td><td className="mono">OIQTHS-26-0019</td><td>Gun assembly · OBR-WG-2024</td><td className="r mono">24</td><td className="r mono">JPY 412k</td><td className="mono">26 May</td><td><Chip k="info">booked</Chip></td><td><Btn sm>view</Btn></td></tr>
            <tr className="row-flag"><td className="mono"><span className="pri">SPO/AT/26/0014</span></td><td>Voestalpine · AT</td><td className="mono">OIQTHS-26-0014</td><td>Spares · electronic PCB</td><td className="r mono">8</td><td className="r mono">EUR 1,420</td><td className="mono" style={{ color: "var(--rust)" }}>overdue 12 d</td><td><Chip k="bad">delayed</Chip></td><td><Btn sm kind="danger">escalate</Btn></td></tr>
            <tr><td className="mono"><span className="pri">SPO/IN/26/0144</span></td><td>MUM Cap Co · domestic</td><td className="mono">OIQTLC-26-1015</td><td>Cap holder 50A</td><td className="r mono">200</td><td className="r mono">₹ 1,420</td><td className="mono">22 Apr</td><td><Chip k="good">received</Chip></td><td><Btn sm>view</Btn></td></tr>
          </tbody>
        </table>
      </Card>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <Card title="Supplier scorecards" eyebrow="A/B/C grades">
          <table className="tbl">
            <thead><tr><th>Supplier</th><th>Grade</th><th className="r">On-time</th><th className="r">Defect</th><th className="r">₹ YTD</th><th>Trend</th></tr></thead>
            <tbody>
              <tr><td>Yokoi Manufacturing JP</td><td><Chip k="good">A</Chip></td><td className="r mono">94%</td><td className="r mono">0.4%</td><td className="r mono">¥ 38.4 M</td><td className="mono-sm" style={{ color: "var(--sage)" }}>↑ 2pp · 90d</td></tr>
              <tr><td>MUM Cap Co</td><td><Chip k="good">A</Chip></td><td className="r mono">92%</td><td className="r mono">1.2%</td><td className="r mono">₹ 18 L</td><td className="mono-sm">flat</td></tr>
              <tr><td>Voestalpine AT</td><td><Chip k="warn">B</Chip></td><td className="r mono">68%</td><td className="r mono">0.8%</td><td className="r mono">€ 412k</td><td className="mono-sm" style={{ color: "var(--rust)" }}>↓ 8pp · 90d</td></tr>
              <tr><td>Pune Hose Works</td><td><Chip>C</Chip></td><td className="r mono">81%</td><td className="r mono">3.1%</td><td className="r mono">₹ 6.2 L</td><td className="mono-sm">flat</td></tr>
            </tbody>
          </table>
        </Card>

        <Card title="Price drift · last 6 months" eyebrow="weighted ₹ paid">
          <table className="tbl">
            <thead><tr><th>Item</th><th className="r">Avg ₹</th><th className="r">Δ vs Q4</th><th>Trend</th></tr></thead>
            <tbody>
              <tr><td className="mono">OBR-TIP-16</td><td className="r mono">₹ 280</td><td className="r mono" style={{ color: "var(--amber-2)" }}>+16.7%</td><td className="mono-sm">JPY weakness drives ↑</td></tr>
              <tr><td className="mono">OBR-CAP-50A</td><td className="r mono">₹ 1,420</td><td className="r mono" style={{ color: "var(--sage)" }}>+2.9%</td><td className="mono-sm">domestic · stable</td></tr>
              <tr><td className="mono">OBR-HOSE-SS</td><td className="r mono">₹ 4,200</td><td className="r mono">flat</td><td className="mono-sm">single-vendor lock</td></tr>
              <tr><td className="mono">OBR-PCB-VLT</td><td className="r mono">€ 1,420</td><td className="r mono" style={{ color: "var(--amber-2)" }}>+8.4%</td><td className="mono-sm">EUR · supply constraint</td></tr>
            </tbody>
          </table>
        </Card>
      </div>
    </div>
  </>
);

// ─────────────────────────────────────────────────────────────
// Spares matrix
// ─────────────────────────────────────────────────────────────
const SparesMatrix = () => {
  const primaries = ["OBR-WG-2018", "OBR-WG-2022", "OBR-WG-2024", "OBR-WG-2026"];
  const spares = ["TIP-16", "TIP-20", "CAP-50A", "CAP-65A", "HOSE-SS", "CAL-YR", "PCB-VLT"];
  const data = {
    "TIP-16":   [0.92, 0.88, 0.96, 0.84],
    "TIP-20":   [0.42, 0.78, 0.62, 0.94],
    "CAP-50A":  [0.84, 0.72, 0.92, 0.46],
    "CAP-65A":  [0.18, 0.34, 0.48, 0.88],
    "HOSE-SS":  [0.74, 0.78, 0.82, 0.76],
    "CAL-YR":   [0.92, 0.94, 0.96, 0.94],
    "PCB-VLT":  [0.04, 0.18, 0.42, 0.86],
  };
  return (
    <>
      <WSTitle
        eyebrow="Procurement · Spares Matrix"
        title="Spares · co-occurrence matrix"
        meta="primary × spare · last 24 months · 312 guns / 84 customers"
        right={<><Btn sm kind="ghost">{Icon.download}</Btn><Btn sm kind="primary">{Icon.bolt} re-bundle suggestions</Btn></>}
      />
      <div className="ws-content">
        <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 14 }}>
          <Card title="Co-occurrence · heatmap" eyebrow="darker = stronger pairing">
            <table className="tbl">
              <thead>
                <tr><th></th>{primaries.map(p => <th key={p} style={{ textAlign: "center", fontFamily: "var(--mono)", fontSize: 10 }}>{p}</th>)}</tr>
              </thead>
              <tbody>
                {spares.map(s => (
                  <tr key={s}>
                    <td className="mono">{s}</td>
                    {data[s].map((v, i) => (
                      <td key={i} style={{ textAlign: "center", padding: 0 }}>
                        <div style={{
                          margin: 4, height: 30, display: "grid", placeItems: "center",
                          background: `rgba(20,18,16,${v})`, color: v > 0.5 ? "var(--paper)" : "var(--ink)",
                          fontFamily: "var(--mono)", fontSize: 10, fontWeight: 600,
                        }}>{Math.round(v * 100)}</div>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <Card title="Top opportunities" eyebrow="₹ uplift potential">
            <table className="tbl">
              <thead><tr><th>Bundle</th><th className="r">Attach</th><th className="r">₹ uplift</th></tr></thead>
              <tbody>
                <tr><td>OBR-WG-2024 + TIP-16</td><td className="r mono">96%</td><td className="r mono" style={{ color: "var(--accent-2)", fontWeight: 600 }}>₹ 18 L</td></tr>
                <tr><td>OBR-WG-2026 + PCB-VLT</td><td className="r mono">86%</td><td className="r mono" style={{ color: "var(--accent-2)", fontWeight: 600 }}>₹ 12.4 L</td></tr>
                <tr><td>OBR-WG-2024 + CAP-50A</td><td className="r mono">92%</td><td className="r mono">₹ 8.4 L</td></tr>
                <tr><td>Any-WG + CAL-YR</td><td className="r mono">94%</td><td className="r mono">₹ 6.2 L</td></tr>
              </tbody>
            </table>
            <div className="divider" />
            <div className="mono-sm" style={{ color: "var(--ink-3)" }}>Auto-suggested at SO line entry when primary equipment matches.</div>
          </Card>
        </div>

        <Card title="Obsolete / EOL" eyebrow="migration plans">
          <table className="tbl">
            <thead><tr><th>Item</th><th>Status</th><th>Replacement</th><th className="r">Active customers</th><th>Last shipped</th><th></th></tr></thead>
            <tbody>
              <tr><td className="mono">OBR-WG-2018</td><td><Chip k="warn">EOL · 2026-12</Chip></td><td className="mono">OBR-WG-2024</td><td className="r mono">14</td><td className="mono-sm">Mar 2026</td><td><Btn sm>plan</Btn></td></tr>
              <tr><td className="mono">OBR-PCB-V1</td><td><Chip k="bad">obsolete</Chip></td><td className="mono">OBR-PCB-VLT</td><td className="r mono">2</td><td className="mono-sm">Sep 2024</td><td><Btn sm>plan</Btn></td></tr>
              <tr><td className="mono">OBR-CAL-LEG</td><td><Chip k="warn">last buy 2026-09</Chip></td><td className="mono">OBR-CAL-YR</td><td className="r mono">8</td><td className="mono-sm">Jan 2026</td><td><Btn sm>plan</Btn></td></tr>
            </tbody>
          </table>
        </Card>
      </div>
    </>
  );
};

// ─────────────────────────────────────────────────────────────
// Customers
// ─────────────────────────────────────────────────────────────
const Customers = () => (
  <>
    <WSTitle
      eyebrow="Data · Customers"
      title="Customers"
      meta="84 customers · 138 locations · 6 multi-GSTIN"
      right={<><Btn sm kind="ghost">{Icon.filter}</Btn><Btn sm kind="primary">{Icon.plus} New customer</Btn></>}
    />
    <div className="ws-content">
      <Card flush>
        <table className="tbl">
          <thead><tr><th>Customer</th><th>State · GSTIN</th><th>Industry</th><th className="r">YTD ₹</th><th className="r">SOs</th><th>Profile</th><th>Risk</th><th></th></tr></thead>
          <tbody>
            <tr><td><span className="pri">Hyderabad Refractories</span></td><td className="mono-sm">36 · 36AAACH1234M1ZQ</td><td>Refractories</td><td className="r mono">₹ 18.4 L</td><td className="r mono">24</td><td className="mono-sm">HR-spares-v3 · 0.96</td><td><Chip k="good">low</Chip></td><td><Btn sm>open</Btn></td></tr>
            <tr><td><span className="pri">MG Motor India</span> · multi</td><td className="mono-sm">24 + 06 · 2 GSTINs</td><td>Auto · OEM</td><td className="r mono">₹ 64 L</td><td className="r mono">42</td><td className="mono-sm">MGM-spares-v2 · 0.92</td><td><Chip k="warn">CAR cluster</Chip></td><td><Btn sm>open</Btn></td></tr>
            <tr><td><span className="pri">JBM Auto</span></td><td className="mono-sm">06 · 06AAACJ4811A1ZN</td><td>Auto · tier 1</td><td className="r mono">₹ 38 L</td><td className="r mono">31</td><td className="mono-sm">JBM-spares-v3 · 0.95</td><td><Chip k="warn">breakdown</Chip></td><td><Btn sm>open</Btn></td></tr>
            <tr><td><span className="pri">Voestalpine Specialty</span></td><td className="mono-sm">AT · foreign</td><td>Steel · specialty</td><td className="r mono">$ 124k</td><td className="r mono">3</td><td className="mono-sm">VST-projects · pending</td><td><Chip k="bad">NEW · margin breach</Chip></td><td><Btn sm>open</Btn></td></tr>
            <tr><td><span className="pri">Hyundai Motor India</span></td><td className="mono-sm">33 · multi</td><td>Auto · OEM</td><td className="r mono">$ 84k</td><td className="r mono">9</td><td className="mono-sm">HMI-projects-v1 · 0.91</td><td><Chip k="good">low</Chip></td><td><Btn sm>open</Btn></td></tr>
            <tr><td><span className="pri">RSWM</span></td><td className="mono-sm">08 · 08AAACR1185R1ZA</td><td>Textiles</td><td className="r mono">₹ 8.7 L</td><td className="r mono">14</td><td className="mono-sm">RSWM-spares-v1 · 0.88</td><td><Chip k="good">low</Chip></td><td><Btn sm>open</Btn></td></tr>
          </tbody>
        </table>
      </Card>
    </div>
  </>
);

// ─────────────────────────────────────────────────────────────
// Audit
// ─────────────────────────────────────────────────────────────
const Audit = () => (
  <>
    <WSTitle
      eyebrow="Admin · Audit"
      title="Audit log"
      meta="immutable · hash-chained · last 7 days · 18,422 events"
      right={<><Btn sm kind="ghost">{Icon.filter}</Btn><Btn sm kind="primary">{Icon.download} export pack</Btn></>}
    />
    <div className="ws-content">
      <Banner kind="info" icon={Icon.lock} title="Hash chain integrity OK"
              action={<Btn sm kind="ghost">verify</Btn>}>
        <span className="mono-sm">Latest block #91241 · prev hash 8af2c1b… · root cron last verified at 02:00 IST.</span>
      </Banner>

      <KPIRow cols={4}>
        <KPI lbl="Events · 7d" v="18,422" />
        <KPI lbl="Unique actors" v="42" d="incl. cron + bridge" />
        <KPI lbl="Approvals" v="68" d="auto 41 · manual 27" />
        <KPI lbl="Hash breaks" v="0" d="immutable OK" live />
      </KPIRow>

      <Card flush>
        <table className="tbl">
          <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Object</th><th>Hash</th><th>Prev</th></tr></thead>
          <tbody>
            <tr><td className="mono">12:42:18</td><td className="mono-sm">tally-bridge</td><td className="mono-sm">VOUCHER_PUSH_OK</td><td className="mono">SO/SPARES/HRP-2641</td><td className="mono-sm">a8f2c1…</td><td className="mono-sm">e4b212…</td></tr>
            <tr><td className="mono">12:42:14</td><td className="mono-sm">Rajesh P.</td><td className="mono-sm">PUSH_REQUEST</td><td className="mono">OIQTLC-26-1015</td><td className="mono-sm">e4b212…</td><td className="mono-sm">71c008…</td></tr>
            <tr><td className="mono">12:38:42</td><td className="mono-sm">claude-sonnet-4.5</td><td className="mono-sm">EXTRACT_OK</td><td className="mono">PO/HRP/24-7821</td><td className="mono-sm">71c008…</td><td className="mono-sm">02ab33…</td></tr>
            <tr><td className="mono">12:31:09</td><td className="mono-sm">V. Suri</td><td className="mono-sm">APPROVE_MARGIN_FLOOR</td><td className="mono">OIQTHS-26-0021</td><td className="mono-sm">02ab33…</td><td className="mono-sm">88d1c2…</td></tr>
            <tr><td className="mono">12:18:21</td><td className="mono-sm">cron · fx</td><td className="mono-sm">FX_REFRESH_OK</td><td className="mono-sm">USD/INR · EUR/INR · JPY/INR</td><td className="mono-sm">88d1c2…</td><td className="mono-sm">f0421e…</td></tr>
            <tr><td className="mono">12:14:08</td><td className="mono-sm">cron · eval</td><td className="mono-sm">EVAL_DRIFT_DETECTED</td><td className="mono">spares-extract · uom_canonical</td><td className="mono-sm">f0421e…</td><td className="mono-sm">b22914…</td></tr>
          </tbody>
        </table>
      </Card>
    </div>
  </>
);

// ─────────────────────────────────────────────────────────────
// JBM importer (lightweight)
// ─────────────────────────────────────────────────────────────
const Items = () => (
  <>
    <WSTitle
      eyebrow="Data · Item Master"
      title="Item Master"
      meta="1,284 items · 28 UoMs · 62 aliases"
      right={<><Btn sm kind="ghost">{Icon.upload} bulk import</Btn><Btn sm kind="primary">{Icon.plus} new item</Btn></>}
    />
    <div className="ws-content">
      <Card flush>
        <table className="tbl">
          <thead><tr><th>SKU</th><th>Description</th><th>UoM</th><th>HSN</th><th className="r">List ₹</th><th>Aliases</th><th>Last drift</th></tr></thead>
          <tbody>
            <tr><td className="mono"><span className="pri">OBR-TIP-16</span></td><td>Welding tip · ⌀16 mm</td><td>nos</td><td className="mono">8311</td><td className="r mono">₹ 280</td><td className="mono-sm">«TIP_16MM_DIA», «WT16»</td><td className="mono-sm" style={{ color: "var(--amber-2)" }}>+16.7%</td></tr>
            <tr><td className="mono"><span className="pri">OBR-CAP-50A</span></td><td>Cap holder · 50A</td><td>nos</td><td className="mono">8311</td><td className="r mono">₹ 1,420</td><td className="mono-sm">«MUM-CAP-50A»</td><td className="mono-sm" style={{ color: "var(--sage)" }}>+2.9%</td></tr>
            <tr><td className="mono"><span className="pri">OBR-HOSE-SS</span></td><td>Cooling hose · SS</td><td>set</td><td className="mono">7307</td><td className="r mono">₹ 4,200</td><td className="mono-sm">«HOSE-SS-AS»</td><td className="mono-sm">flat</td></tr>
            <tr><td className="mono"><span className="pri">OBR-WG-2024</span></td><td>Spot welding gun · 2024</td><td>nos</td><td className="mono">8515</td><td className="r mono">₹ 4.8 L</td><td className="mono-sm">—</td><td className="mono-sm">flat</td></tr>
            <tr><td className="mono"><span className="pri">OBR-PCB-VLT</span></td><td>Voltage controller PCB</td><td>nos</td><td className="mono">8537</td><td className="r mono">€ 1,420</td><td className="mono-sm">«VLT-PCB», «PCB-V2»</td><td className="mono-sm" style={{ color: "var(--amber-2)" }}>+8.4%</td></tr>
          </tbody>
        </table>
      </Card>
    </div>
  </>
);

Object.assign(window, { Inbox, SourcePOs, SparesMatrix, Customers, Audit, Items });
