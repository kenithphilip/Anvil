// ============================================================
// ANVIL v3 — Logistics & Service
// Projects · Shipments · Service · CAR · AMC
// ============================================================

// ─────────────────────────────────────────────────────────────
// Project tracker — 14 phases
// ─────────────────────────────────────────────────────────────
const Projects = () => {
  const phases = [
    "Initiation", "Spec freeze", "Quote", "PO received", "Production planning",
    "Materials in", "Sub-assembly", "Final assembly", "FAT · in-works",
    "Pre-dispatch", "Dispatched", "On-site SAT", "Commissioning", "Closure",
  ];
  const projects = [
    {
      ref: "PRJ/HMI/SRP-26-04", c: "Hyundai Motor India · Sriperumbudur",
      mode: "PROJECT_HSS", v: "$ 84,200", phase: 11,
      milestone: "ETA Nhava Sheva 14 May · CIF",
      next: "On-site SAT · 22 May",
    },
    {
      ref: "PRJ/VST/LIN-26-04", c: "Voestalpine Linz · AT",
      mode: "PROJECT_HSS", v: "$ 124,500", phase: 4,
      milestone: "Quote in approval · margin 9.2%",
      next: "PO ETA 24 Apr",
    },
    {
      ref: "PRJ/TST/JAM-26-03", c: "Tata Steel · Jamshedpur",
      mode: "PROJECT_FOR", v: "₹ 41,20,000", phase: 7,
      milestone: "Sub-assembly · L4 ICW pending",
      next: "FAT 6 May",
    },
    {
      ref: "PRJ/MGM/HAL-26-02", c: "MG Motor · Halol",
      mode: "PROJECT_FOR", v: "₹ 18,40,000", phase: 13,
      milestone: "Closure · DAP signed 11 Apr",
      next: "AMC schedule from 12 Apr · 2 yr",
    },
  ];

  return (
    <>
      <WSTitle
        eyebrow="Sales · Projects"
        title="Project tracker"
        meta="14-phase lifecycle · 4 active · 2 due this week"
        right={<><Btn sm kind="ghost">{Icon.filter}</Btn><Btn sm kind="primary">{Icon.plus} New project</Btn></>}
      />
      <div className="ws-content">
        <KPIRow cols={4}>
          <KPI lbl="Active" v="4" d="2 PROJECT_HSS · 2 FOR" />
          <KPI lbl="Pre-dispatch" v="2" d="ETA &lt; 14 days" live />
          <KPI lbl="On-site SAT due" v="1" d="HMI · 22 May" />
          <KPI lbl="Closure · MTD" v="1" d="AMC handoff today" />
        </KPIRow>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {projects.map(p => (
            <Card key={p.ref} flush>
              <div style={{ padding: "14px 16px", display: "flex", gap: 14, alignItems: "flex-start", borderBottom: "1px solid var(--hairline-2)" }}>
                <div>
                  <div className="row gap-sm">
                    <span style={{ fontFamily: "var(--mono)", fontWeight: 600 }}>{p.ref}</span>
                    <Chip k="info">{p.mode}</Chip>
                    <span style={{ fontWeight: 600 }}>· {p.c}</span>
                  </div>
                  <div className="mono-sm" style={{ marginTop: 4 }}>
                    {p.milestone} <span style={{ color: "var(--ink-4)" }}>·</span> next · {p.next}
                  </div>
                </div>
                <span style={{ flex: 1 }} />
                <div className="row gap-sm">
                  <span className="mono-sm">value</span>
                  <span style={{ fontFamily: "var(--mono)", fontWeight: 600 }}>{p.v}</span>
                  <Btn sm>open</Btn>
                </div>
              </div>
              {/* phases */}
              <div style={{ display: "flex", padding: "10px 16px 14px", overflowX: "auto" }}>
                {phases.map((ph, i) => {
                  const done = i < p.phase;
                  const cur = i === p.phase;
                  return (
                    <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "stretch", flex: "1 0 80px", position: "relative", paddingTop: 16 }}>
                      <div style={{
                        position: "absolute", top: 14, left: 0, right: 0, height: 2,
                        background: done ? "var(--ink)" : cur ? "var(--accent-2)" : "var(--hairline)",
                      }} />
                      <div style={{
                        width: 14, height: 14, borderRadius: 999,
                        background: done ? "var(--ink)" : cur ? "var(--accent)" : "var(--paper)",
                        border: cur ? "2px solid var(--accent-2)" : `1px solid ${done ? "var(--ink)" : "var(--hairline)"}`,
                        margin: "0 auto",
                      }} />
                      <div className="mono-sm" style={{
                        marginTop: 8, textAlign: "center", fontSize: 9.5,
                        color: cur ? "var(--ink)" : done ? "var(--ink-2)" : "var(--ink-4)",
                        fontWeight: cur ? 600 : 400,
                      }}>
                        {String(i + 1).padStart(2, "0")} · {ph}
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          ))}
        </div>
      </div>
    </>
  );
};

// ─────────────────────────────────────────────────────────────
// Shipments + POD
// ─────────────────────────────────────────────────────────────
const Shipments = () => (
  <>
    <WSTitle
      eyebrow="Sales · Shipments"
      title="Shipments"
      meta="PLANNED → BOOKED → PICKED → DISPATCHED → IN_TRANSIT → DELIVERED → POD_RECEIVED"
      right={<><Btn sm kind="ghost">{Icon.filter}</Btn><Btn sm kind="primary">{Icon.plus} Schedule shipment</Btn></>}
    />
    <WSTabs tabs={[
      { id: "all", label: "All", count: 22 },
      { id: "plan", label: "Planned", count: 4 },
      { id: "book", label: "Booked", count: 3 },
      { id: "pick", label: "Picked", count: 2 },
      { id: "dis",  label: "Dispatched", count: 5 },
      { id: "trans", label: "In transit", count: 6 },
      { id: "del",  label: "Delivered", count: 1 },
      { id: "pod",  label: "POD received", count: 1 },
    ]} active="all" />

    <div className="ws-content">
      <KPIRow cols={4}>
        <KPI lbl="Avg cycle · door-to-door" v="11.4 d" d="all modes" />
        <KPI lbl="POD lag" v="3.8 d" d="delivered → POD" dKind="down" />
        <KPI lbl="Damage claims · 90d" v="2" d="CAR linked" />
        <KPI lbl="On-time delivery" v="89.4%" d="rolling 30d" dKind="up" />
      </KPIRow>

      <Card flush>
        <table className="tbl">
          <thead><tr>
            <th>Shipment</th><th>Order</th><th>Mode · Incoterm</th><th>Origin → destination</th><th>Carrier</th><th className="r">ETA / arrived</th><th>Status</th><th>POD</th><th></th>
          </tr></thead>
          <tbody>
            <tr className="row-live">
              <td className="mono"><span className="pri">SH-26-0091</span></td>
              <td className="mono">OIQTHS-26-0019</td>
              <td><Chip k="info">CIF · Sea</Chip></td>
              <td>Pune CFS → Nhava Sheva → Sriperumbudur<div className="mono-sm">via MOL Endeavor · BL MAEU 21449</div></td>
              <td className="mono">MOL · road leg Maersk</td>
              <td className="r mono">14 May</td>
              <td><Chip k="warn">in transit</Chip></td>
              <td>—</td>
              <td><Btn sm>track</Btn></td>
            </tr>
            <tr>
              <td className="mono"><span className="pri">SH-26-0090</span></td>
              <td className="mono">OFRPRJ-26-0008</td>
              <td><Chip>FOR · Rail</Chip></td>
              <td>Pune → Jamshedpur<div className="mono-sm">CONCOR · BCN-A wagon</div></td>
              <td className="mono">CONCOR</td>
              <td className="r mono">26 Apr</td>
              <td><Chip k="info">booked</Chip></td>
              <td>—</td>
              <td><Btn sm>track</Btn></td>
            </tr>
            <tr>
              <td className="mono"><span className="pri">SH-26-0088</span></td>
              <td className="mono">OIQTLC-26-1011</td>
              <td><Chip>FOR · Road</Chip></td>
              <td>Pune → Halol<div className="mono-sm">2T Eicher · LR PHL/26/4413</div></td>
              <td className="mono">Safexpress</td>
              <td className="r mono">arrived 11 Apr</td>
              <td><Chip k="good">delivered</Chip></td>
              <td><Chip k="warn">pending</Chip></td>
              <td><Btn sm>upload POD</Btn></td>
            </tr>
            <tr>
              <td className="mono"><span className="pri">SH-26-0084</span></td>
              <td className="mono">OIQTLC-26-0997</td>
              <td><Chip>FOR · Road</Chip></td>
              <td>Pune → Pune (Mahindra CIE)</td>
              <td className="mono">Local · in-house</td>
              <td className="r mono">8 Apr</td>
              <td><Chip k="good">delivered</Chip></td>
              <td><Chip k="good">received</Chip></td>
              <td><Btn sm>view</Btn></td>
            </tr>
            <tr className="row-flag">
              <td className="mono"><span className="pri">SH-26-0080</span></td>
              <td className="mono">OIQTHS-26-0014</td>
              <td><Chip k="info">CIF · Sea</Chip></td>
              <td>Nhava Sheva → Hamburg<div className="mono-sm">claim · 2 cartons damaged</div></td>
              <td className="mono">Hapag-Lloyd</td>
              <td className="r mono">arrived 22 Mar</td>
              <td><Chip k="bad">claim</Chip></td>
              <td><Chip k="good">received</Chip></td>
              <td><Btn sm>open CAR</Btn></td>
            </tr>
          </tbody>
        </table>
      </Card>
    </div>
  </>
);

// ─────────────────────────────────────────────────────────────
// Service · Visits + CAR + AMC
// ─────────────────────────────────────────────────────────────
const ServiceVisits = () => (
  <>
    <WSTitle
      eyebrow="Service · Visits"
      title="Service visits"
      meta="3 active · 2 scheduled this week · 1 escalated"
      right={<><Btn sm kind="ghost">{Icon.filter}</Btn><Btn sm kind="primary">{Icon.plus} Log visit</Btn></>}
    />
    <WSTabs tabs={[
      { id: "active", label: "Active", count: 3 },
      { id: "sched", label: "Scheduled", count: 5 },
      { id: "closed", label: "Closed", count: 41 },
      { id: "amc", label: "AMC visits", count: 18 },
      { id: "br",   label: "Breakdown", count: 2 },
    ]} active="active" />

    <div className="ws-content">
      <KPIRow cols={4}>
        <KPI lbl="MTTR · breakdown" v="14h" d="median 90d" />
        <KPI lbl="First-time fix rate" v="84.2%" d="within 24h" dKind="up" />
        <KPI lbl="Open CARs" v="3" d="2 ≥ 7 days" dKind="down" />
        <KPI lbl="AMC adherence" v="96%" d="94 of 98 visits done in window" live />
      </KPIRow>

      <Card flush>
        <table className="tbl">
          <thead><tr>
            <th style={{ width: 22 }}></th>
            <th>Visit</th>
            <th>Customer · location</th>
            <th>Equipment</th>
            <th>Type</th>
            <th>Engineer</th>
            <th>Started</th>
            <th>Status</th>
            <th></th>
          </tr></thead>
          <tbody>
            <tr className="row-flag">
              <td><Sev k="high" /></td>
              <td className="mono"><span className="pri">SV-26-0184</span></td>
              <td>JBM Auto · Faridabad<div className="mono-sm">06AAACJ4811A1ZN · Plant 2</div></td>
              <td className="mono-sm">OBR-WG-2024 · S/N 7G14<br />gun · cap 50A · install 2024-08</td>
              <td><Chip k="bad">Breakdown</Chip></td>
              <td className="mono-sm">Suresh M.</td>
              <td className="mono-sm">11 Apr · 06:40</td>
              <td><Chip k="warn">on-site</Chip></td>
              <td><Btn sm>open</Btn></td>
            </tr>
            <tr className="row-warn">
              <td><Sev k="med" /></td>
              <td className="mono"><span className="pri">SV-26-0183</span></td>
              <td>POSCO · Pune</td>
              <td className="mono-sm">OBR-WG-2018 · S/N 4N02</td>
              <td><Chip k="info">AMC</Chip></td>
              <td className="mono-sm">Vivek R.</td>
              <td className="mono-sm">11 Apr · 09:00</td>
              <td><Chip k="warn">in progress</Chip></td>
              <td><Btn sm>open</Btn></td>
            </tr>
            <tr>
              <td><Sev k="low" /></td>
              <td className="mono"><span className="pri">SV-26-0181</span></td>
              <td>Mahindra CIE · Pune</td>
              <td className="mono-sm">OBR-WG-2022 · S/N 6P18</td>
              <td><Chip>Audit</Chip></td>
              <td className="mono-sm">Vivek R.</td>
              <td className="mono-sm">10 Apr · 14:30</td>
              <td><Chip k="info">awaiting parts</Chip></td>
              <td><Btn sm>open</Btn></td>
            </tr>
          </tbody>
        </table>
      </Card>

      <div style={{ display: "grid", gridTemplateColumns: "1.1fr 1fr", gap: 14 }}>
        <Card title="SV-26-0184 · JBM Faridabad · Breakdown report" eyebrow="open · 18h elapsed">
          <KV rows={[
            ["Reported by",   "Vinod K. (production)"],
            ["Symptom",       "intermittent shorts · cap holder"],
            ["Last service",  "AMC · 28 Feb · Suresh M."],
            ["Equipment age", "1 yr 8 mo (in warranty)"],
            ["Parts en-route","2× cap holder · INT-WAR-26-0008"],
            ["ETA fix",       "13 Apr · 14:00 IST"],
            ["Customer SLA",  "24h response · 72h fix"],
          ]} />
          <div className="divider" />
          <div className="mono-sm">
            <b style={{ color: "var(--ink)" }}>Findings (in-progress):</b><br />
            – Cap holder thread fatigue, fits within warranty.<br />
            – Same gun model also caused failure at MG Motor Halol on 02 Mar — cluster suspected.<br />
            – CAR draft auto-created · CAR/JBM-26-04 · root cause TBD.
          </div>
        </Card>

        <Card title="Equipment hierarchy" eyebrow="installed base · 312 guns / 84 customers">
          <div className="mono-sm" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div>▸ MG Motor India <span style={{ color: "var(--ink-4)" }}>· 24 guns</span></div>
            <div style={{ paddingLeft: 14 }}>▸ Halol · plant 1 <span style={{ color: "var(--ink-4)" }}>· 14 guns · 2 in warranty</span></div>
            <div style={{ paddingLeft: 14 }}>▸ Halol · plant 2 <span style={{ color: "var(--ink-4)" }}>· 6 guns</span></div>
            <div style={{ paddingLeft: 14 }}>▸ Manesar <span style={{ color: "var(--ink-4)" }}>· 4 guns · GSTIN 06AAACM2289G2ZW</span></div>
            <div style={{ paddingLeft: 28 }}>▸ welding cell A <span style={{ color: "var(--ink-4)" }}>· 4 guns</span></div>
            <div style={{ paddingLeft: 42 }}>▾ <b style={{ color: "var(--ink)" }}>OBR-WG-2024 S/N 6P18</b> · install 2024-08 · AMC active</div>
            <div style={{ paddingLeft: 56, color: "var(--ink-3)" }}>last visit 28 Feb · next AMC 28 May · 2 open spares</div>
          </div>
        </Card>
      </div>
    </div>
  </>
);

const CARReports = () => (
  <>
    <WSTitle
      eyebrow="Service · CAR Reports"
      title="Corrective Action Reports"
      meta="3 open · 2 ≥ 7 days · 1 escalated to Quality"
      right={<><Btn sm kind="ghost">{Icon.download}</Btn><Btn sm kind="primary">{Icon.plus} New CAR</Btn></>}
    />
    <div className="ws-content">
      <KPIRow cols={4}>
        <KPI lbl="Open" v="3" d="2 service · 1 quality" dKind="down" />
        <KPI lbl="Median age · open" v="5.4 d" />
        <KPI lbl="Closed · MTD" v="6" d="containment 100%" />
        <KPI lbl="Top root cause" v="thermal" d="cap fatigue · 4 of 9" />
      </KPIRow>

      <Card flush>
        <table className="tbl">
          <thead><tr>
            <th>CAR #</th><th>Customer</th><th>Equipment</th><th>Stage</th><th>Owner</th><th>Opened</th><th>Cluster</th><th></th>
          </tr></thead>
          <tbody>
            {[
              ["CAR/JBM-26-04", "JBM Auto · Faridabad", "OBR-WG-2024 · S/N 7G14", "Containment", "Suresh M.", "11 Apr", "cap fatigue · 2nd unit", "warn"],
              ["CAR/MGM-26-03", "MG Motor · Halol", "OBR-WG-2024 · S/N 7G19", "Root cause", "Vivek R.", "02 Mar", "cap fatigue · 1st unit", "warn"],
              ["CAR/HND-26-02", "Hyundai · Sriperumbudur", "OBR-WG-2022 · S/N 5T21", "Verification", "V. Suri", "21 Mar", "—", "info"],
              ["CAR/JBM-26-01", "JBM Auto · Faridabad", "OBR-WG-2018 · S/N 4N02", "Closed · effective", "Anjali K.", "10 Feb", "—", "good"],
            ].map((r, i) => (
              <tr key={i}>
                <td className="mono"><span className="pri">{r[0]}</span></td>
                <td>{r[1]}</td>
                <td className="mono-sm">{r[2]}</td>
                <td><Chip k={r[7]}>{r[3]}</Chip></td>
                <td className="mono-sm">{r[4]}</td>
                <td className="mono-sm">{r[5]}</td>
                <td className="mono-sm" style={{ color: r[6].includes("·") ? "var(--rust-2)" : "var(--ink-3)", fontWeight: r[6].includes("·") ? 600 : 400 }}>{r[6]}</td>
                <td><Btn sm>open</Btn></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card title="CAR/JBM-26-04 · 8D template" eyebrow="containment in progress">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
          {[
            { d: "D1", t: "Team", v: "Suresh, Anjali, Quality lead", k: "good" },
            { d: "D2", t: "Problem", v: "Cap holder thread fatigue, intermittent shorts", k: "good" },
            { d: "D3", t: "Containment", v: "Quarantine + replace 2 affected guns at JBM, MG", k: "good" },
            { d: "D4", t: "Root cause", v: "TBD · cluster of 2 within 6 weeks", k: "warn" },
            { d: "D5", t: "Corrective action", v: "—", k: "muted" },
            { d: "D6", t: "Implement", v: "—", k: "muted" },
            { d: "D7", t: "Prevent recurrence", v: "—", k: "muted" },
            { d: "D8", t: "Recognize", v: "—", k: "muted" },
          ].map((s) => (
            <div key={s.d} style={{ padding: 12, border: "1px solid var(--hairline)", borderRadius: 4, background: s.k === "good" ? "var(--sage-3)" : s.k === "warn" ? "var(--amber-3)" : "var(--paper)" }}>
              <div style={{ fontFamily: "var(--mono)", fontSize: 10, fontWeight: 700, color: "var(--ink-4)", letterSpacing: "0.06em" }}>{s.d}</div>
              <div style={{ fontSize: 12, fontWeight: 600, marginTop: 2 }}>{s.t}</div>
              <div className="mono-sm" style={{ marginTop: 6, color: s.k === "muted" ? "var(--ink-4)" : "var(--ink-2)" }}>{s.v}</div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  </>
);

const AMCSchedule = () => {
  const months = ["May", "Jun", "Jul", "Aug", "Sep", "Oct"];
  const customers = [
    { c: "MG Motor · Halol", v: [2, 0, 1, 0, 0, 1] },
    { c: "MG Motor · Manesar", v: [0, 1, 0, 0, 1, 0] },
    { c: "JBM Auto · Faridabad", v: [1, 0, 1, 0, 1, 0] },
    { c: "POSCO · Pune", v: [0, 1, 0, 1, 0, 1] },
    { c: "Mahindra CIE · Pune", v: [1, 0, 0, 1, 0, 0] },
    { c: "Hyundai · Sriperumbudur", v: [0, 0, 1, 0, 1, 0] },
    { c: "RSWM · Bhilwara", v: [1, 0, 0, 0, 1, 0] },
    { c: "Tata Steel · Jamshedpur", v: [0, 1, 0, 0, 0, 1] },
    { c: "Hyderabad Refractories", v: [0, 0, 1, 0, 0, 1] },
  ];
  const max = 2;
  return (
    <>
      <WSTitle
        eyebrow="Service · AMC"
        title="AMC schedule · next 6 months"
        meta="generated by cron 0 6 * * * IST · last 02:00 today · 18 visits queued"
        right={<><Btn sm kind="ghost">{Icon.cycle} regenerate</Btn><Btn sm kind="primary">{Icon.download} export plan</Btn></>}
      />
      <div className="ws-content">
        <Banner kind="info" icon={Icon.cal} title="AMC adherence policy">
          <span className="mono-sm">Visits scheduled within their contracted month count toward adherence. Visits skipped roll into the next month with a SLA flag, and after 2 misses the customer is marked at-risk.</span>
        </Banner>

        <Card title="Heatmap · planned visits" eyebrow="customer × month" flush>
          <table className="tbl">
            <thead><tr>
              <th>Customer</th>
              {months.map(m => <th key={m} style={{ textAlign: "center" }}>{m}</th>)}
              <th className="r">Total</th>
            </tr></thead>
            <tbody>
              {customers.map(r => {
                const total = r.v.reduce((a, b) => a + b, 0);
                return (
                  <tr key={r.c}>
                    <td>{r.c}</td>
                    {r.v.map((n, i) => (
                      <td key={i} style={{ textAlign: "center", padding: 0 }}>
                        <div style={{
                          height: 28, margin: 4,
                          background: n === 0 ? "var(--paper-2)" : n === 1 ? "var(--accent-3)" : "var(--accent)",
                          color: "var(--ink)",
                          fontFamily: "var(--mono)", fontSize: 11, fontWeight: 600,
                          display: "grid", placeItems: "center",
                        }}>
                          {n || ""}
                        </div>
                      </td>
                    ))}
                    <td className="r mono">{total}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <Card title="Top 5 next-30-day visits" eyebrow="route-optimized">
            <table className="tbl">
              <thead><tr><th>Date</th><th>Customer</th><th>Engineer</th><th>Type</th></tr></thead>
              <tbody>
                {[
                  ["12 May", "MG Motor · Halol", "Suresh M.", "AMC"],
                  ["14 May", "Mahindra CIE · Pune", "Vivek R.", "AMC"],
                  ["18 May", "RSWM · Bhilwara", "Suresh M.", "AMC"],
                  ["22 May", "Hyundai · Sriperumbudur", "V. Suri", "On-site SAT"],
                  ["28 May", "JBM Auto · Faridabad", "Vivek R.", "AMC"],
                ].map((r, i) => (
                  <tr key={i}>
                    <td className="mono">{r[0]}</td>
                    <td>{r[1]}</td>
                    <td className="mono-sm">{r[2]}</td>
                    <td><Chip k="info">{r[3]}</Chip></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <Card title="Adherence · last 12 months" eyebrow="94 of 98 in window">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(12, 1fr)", gap: 4, height: 80, alignItems: "end" }}>
              {[96, 100, 100, 92, 98, 100, 86, 100, 96, 98, 100, 96].map((v, i) => (
                <div key={i} style={{ height: `${v}%`, background: v >= 95 ? "var(--ink)" : v >= 88 ? "var(--amber)" : "var(--rust)" }} />
              ))}
            </div>
            <div className="row mono-sm" style={{ marginTop: 8, justifyContent: "space-between", color: "var(--ink-4)" }}>
              {["May","Jun","Jul","Aug","Sep","Oct","Nov","Dec","Jan","Feb","Mar","Apr"].map(m => <span key={m}>{m}</span>)}
            </div>
            <div className="divider" />
            <div className="mono-sm">Nov dip — 3 visits delayed by Diwali holiday calendar; auto-rolled to first 5 working days of Dec.</div>
          </Card>
        </div>
      </div>
    </>
  );
};

Object.assign(window, { Projects, Shipments, ServiceVisits, CARReports, AMCSchedule });
