// ============================================================
// ANVIL v3 — Sales Orders
// List · Workspace · Order Mode picker · Reconciliation grid
// ============================================================

// ─────────────────────────────────────────────────────────────
// Sales Orders — list
// ─────────────────────────────────────────────────────────────
const SOList = () => (
  <>
    <WSTitle
      eyebrow="Workflows · Sales Orders"
      title="Sales Orders"
      meta="47 active · 165 last 7d"
      right={<>
        <Btn sm kind="ghost">{Icon.filter} filter</Btn>
        <Btn sm kind="ghost">{Icon.download} export</Btn>
        <Btn sm kind="primary">{Icon.plus} New from PO</Btn>
      </>}
    />
    <WSTabs
      tabs={[
        { id: "all", label: "All", count: 47 },
        { id: "mine", label: "Mine", count: 7 },
        { id: "intake", label: "Intake", count: 4 },
        { id: "extract", label: "Extracting", count: 2 },
        { id: "validate", label: "Validate", count: 6 },
        { id: "approval", label: "Approval", count: 3 },
        { id: "tally", label: "Tally", count: 5 },
        { id: "shipped", label: "Shipped", count: 12 },
        { id: "closed", label: "Closed", count: 8 },
      ]}
      active="all"
    />

    <div className="ws-content">
      <KPIRow cols={5}>
        <KPI lbl="Cycle median" v="2h 14m" d="intake → push" />
        <KPI lbl="First-pass rate" v="78%" d="no manual edits" dKind="up" />
        <KPI lbl="Push success" v="96.2%" d="last 30d" dKind="up" />
        <KPI lbl="₹ pushed · MTD" v="₹ 1.24 Cr" d="165 SOs" />
        <KPI lbl="Avg margin" v="22.4%" d="floor 10% · ceiling 35%" />
      </KPIRow>

      {/* Filter strip */}
      <div className="row gap-sm" style={{ flexWrap: "wrap" }}>
        <Chip k="fill">mode: any</Chip>
        <Chip>customer: any</Chip>
        <Chip>currency: any</Chip>
        <Chip>approver: any</Chip>
        <Chip>status: active</Chip>
        <span style={{ flex: 1 }} />
        <Chip k="ghost">density · comfortable</Chip>
        <Chip k="ghost">{Icon.filterX} clear</Chip>
      </div>

      <Card flush>
        <table className="tbl">
          <thead><tr>
            <th style={{ width: 22 }}></th>
            <th>Reference</th>
            <th>Customer · Location</th>
            <th>Mode</th>
            <th>Stage</th>
            <th className="r">Lines</th>
            <th className="r">Value</th>
            <th className="r">Margin</th>
            <th className="r">Cycle</th>
            <th>Owner</th>
            <th>Updated</th>
          </tr></thead>
          <tbody>
            {[
              { sev: "high", ref: "OIQTHS-26-0021", c: "Voestalpine Spec.", l: "Linz · AT", mode: "PROJECT_HSS", k: "info", st: "approval", sk: "bad", lines: 6, v: "$ 124,500", m: "9.2%", mk: "bad", cyc: "5h 18m", o: "Rajesh P.", u: "2m" },
              { sev: "med",  ref: "OIQTLC-26-1018", c: "JBM Auto", l: "Faridabad · 06", mode: "SPARES_ASSEMBLY", k: "ghost", st: "approval", sk: "warn", lines: 8, v: "₹ 9,80,000", m: "31.4%", mk: "good", cyc: "1h 04m", o: "Anjali K.", u: "8m" },
              { sev: "low",  ref: "OIQTLC-26-1015", c: "Hyderabad Refractories", l: "Hyderabad · 36", mode: "SPARES", k: "ghost", st: "extract", sk: "warn", lines: 4, v: "₹ 4,82,400", m: "28.0%", mk: "good", cyc: "14m", o: "Rajesh P.", u: "14m", live: true },
              { sev: "low",  ref: "OIQTLC-26-1011", c: "MG Motor", l: "Halol · 24", mode: "SPARES", k: "ghost", st: "tally", sk: "info", lines: 12, v: "₹ 8,21,100", m: "24.1%", mk: "good", cyc: "47m", o: "Anjali K.", u: "32m" },
              { sev: "low",  ref: "OFRPRJ-26-0008", c: "Tata Steel", l: "Jamshedpur · 20", mode: "PROJECT_FOR", k: "info", st: "tally", sk: "info", lines: 3, v: "₹ 41,20,000", m: "11.2%", mk: "warn", cyc: "1d 4h", o: "V. Suri",   u: "1h" },
              { sev: "low",  ref: "INT-FOC-26-0014", c: "Obara Internal", l: "Pune · 27", mode: "INTERNAL", k: "plum", st: "shipped", sk: "good", lines: 1, v: "—", m: "—", mk: "ghost", cyc: "—", o: "Operator", u: "2h" },
              { sev: "med",  ref: "OIQTLC-26-1003", c: "POSCO Maharashtra", l: "Pune · 27", mode: "SPARES", k: "ghost", st: "validate", sk: "warn", lines: 5, v: "₹ 2,98,000", m: "26.7%", mk: "good", cyc: "1d", o: "Rajesh P.", u: "3h" },
              { sev: "low",  ref: "OIQTLC-26-0997", c: "Mahindra CIE", l: "Pune · 27", mode: "SPARES", k: "ghost", st: "shipped", sk: "good", lines: 3, v: "₹ 1,20,400", m: "25.0%", mk: "good", cyc: "2h 04m", o: "Anjali K.", u: "5h" },
              { sev: "low",  ref: "OIQTHS-26-0019", c: "Hyundai Motor", l: "Sriperumbudur · 33", mode: "PROJECT_HSS", k: "info", st: "shipped", sk: "good", lines: 9, v: "$ 84,200", m: "12.4%", mk: "good", cyc: "8h 22m", o: "V. Suri", u: "1d" },
              { sev: "low",  ref: "OIQTLC-26-0991", c: "RSWM", l: "Bhilwara · 08", mode: "SPARES", k: "ghost", st: "validate", sk: "warn", lines: 2, v: "₹ 87,400", m: "22.0%", mk: "good", cyc: "2d 3h", o: "Rajesh P.", u: "2d" },
            ].map((r, i) => (
              <tr key={i} className={r.live ? "row-live" : ""}>
                <td><Sev k={r.sev} /></td>
                <td className="mono"><span className="pri">{r.ref}</span></td>
                <td>{r.c}<div className="mono-sm">{r.l}</div></td>
                <td><Chip k={r.k}>{r.mode}</Chip></td>
                <td><Chip k={r.sk}>{r.st}</Chip></td>
                <td className="r mono">{r.lines}</td>
                <td className="r mono">{r.v}</td>
                <td className="r mono" style={{ color: r.mk === "bad" ? "var(--rust)" : r.mk === "warn" ? "var(--amber-2)" : "var(--ink)", fontWeight: 600 }}>{r.m}</td>
                <td className="r mono" style={{ color: r.cyc.includes("d") ? "var(--rust)" : "var(--ink-3)" }}>{r.cyc}</td>
                <td className="mono-sm">{r.o}</td>
                <td className="mono-sm">{r.u}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  </>
);

// ─────────────────────────────────────────────────────────────
// SO Intake — Order mode picker (most-important decision)
// ─────────────────────────────────────────────────────────────
const SOIntake = () => (
  <>
    <WSTitle
      eyebrow="Workflows · Sales Orders · New"
      title="Capture · choose Order Mode"
      meta="step 1 of 6"
      right={<><Btn sm kind="ghost">save draft</Btn><Btn sm kind="primary">continue {Icon.arrowR}</Btn></>}
    />

    <div className="ws-content">
      <Steps current={0} items={["Capture", "Preflight", "Extract", "Validate", "Approve", "Push to Tally"]} />

      <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: 14 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Card title="Order Mode" eyebrow="drives prefix · currency · logistics · margin floor">
            <div className="choice-grid" style={{ "--cols": 2 }}>
              <div className="choice sel">
                <span className="code">SPARES · OIQTLC-** · INR</span>
                <span className="ti">Spares</span>
                <span className="desc">Standard spares to a domestic customer. Margin floor 10%, target 30%. Road logistics. Most common mode (~62%).</span>
              </div>
              <div className="choice">
                <span className="code">SPARES_ASSEMBLY · OIQTLC-** · INR</span>
                <span className="ti">Spares · Assembly</span>
                <span className="desc">Gun modification spares with assembly. Same prefix and floor as SPARES, but assembly service line is mandatory.</span>
              </div>
              <div className="choice">
                <span className="code">PROJECT_FOR · OFRPRJ-** · INR</span>
                <span className="ti">Project · Free On Rail</span>
                <span className="desc">Domestic project with freight inclusive in line price. Forward FX irrelevant. Floor 10%.</span>
              </div>
              <div className="choice">
                <span className="code">PROJECT_HSS · OIQTHS-** · USD</span>
                <span className="ti">Project · CIF Nhava Sheva</span>
                <span className="desc">Hyundai Steel / Voestalpine pattern. Forward FX explicit, USD line items, customs cost band, floor 10%.</span>
              </div>
              <div className="choice">
                <span className="code">INTERNAL · INT-* · FOC</span>
                <span className="ti">Internal · Free of cost</span>
                <span className="desc">Warranty replacement, product trial, expected PO, internal transfer. No margin, no Tally voucher.</span>
              </div>
              <div className="choice">
                <span className="code">— · ASK ME LATER</span>
                <span className="ti">Decide later</span>
                <span className="desc">Capture the documents now and let the OCR + Claude pre-classifier suggest the mode at extraction time.</span>
              </div>
            </div>
          </Card>

          <Card title="Documents" eyebrow="PO required · others optional">
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              {[
                { t: "Customer PO", st: "loaded", n: "PO 2024-7821 · Hyderabad Refractories.pdf · 4 pages · 312 KB", k: "good" },
                { t: "Internal Quote", st: "optional", n: "drag a draft quote here · or generate after extract", k: "ghost" },
                { t: "Price Comparison", st: "optional", n: "drag previous-PO Excel for line-level price drift", k: "ghost" },
                { t: "Drawings / specs", st: "optional", n: "PDF / DWG · stored as evidence, not parsed", k: "ghost" },
              ].map((d, i) => (
                <div key={i} style={{
                  border: d.k === "good" ? "1px solid var(--ink)" : "1px dashed var(--hairline)",
                  borderRadius: 6, padding: 12, background: d.k === "good" ? "var(--paper)" : "var(--paper-2)",
                  display: "flex", flexDirection: "column", gap: 4, minHeight: 84,
                }}>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <span style={{ fontSize: 12.5, fontWeight: 600 }}>{d.t}</span>
                    <Chip k={d.k}>{d.st}</Chip>
                  </div>
                  <span className="mono-sm">{d.n}</span>
                </div>
              ))}
            </div>
            <div className="divider" />
            <div className="row" style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
              <Dot k="good" /> ZIP guards · OK
              <span style={{ marginLeft: 14 }}><Dot k="good" /> ClamAV · clean</span>
              <span style={{ marginLeft: 14 }}><Dot k="info" /> redaction · 3 patterns matched</span>
              <span style={{ marginLeft: "auto" }} className="mono-sm">payload hash · pending extract</span>
            </div>
          </Card>
        </div>

        {/* Right panel — context */}
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Card title="Customer" eyebrow="recognized from PO">
            <div className="row" style={{ marginBottom: 8 }}>
              <div style={{ width: 32, height: 32, background: "var(--ink)", color: "var(--paper)", display: "grid", placeItems: "center", fontFamily: "var(--mono)", fontWeight: 700, fontSize: 12 }}>HR</div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>Hyderabad Refractories Pvt Ltd</div>
                <div className="mono-sm">CUST-IN-0042 · since 2017 · 138 SOs</div>
              </div>
            </div>
            <KV rows={[
              ["GSTIN", "36AAACH1234M1ZQ"],
              ["State", "Telangana · 36"],
              ["Pay terms", "30 days net"],
              ["Margin floor", "10% (default)"],
              ["Format profile", "v3 · 0.96 confidence"],
              ["Last SO", "OIQTLC-26-0987 · 04 Apr"],
              ["YTD value", "₹ 18.4 L · 24 SOs"],
            ]} />
            <div className="divider" />
            <div className="mono-sm">
              <Dot k="info" /> 1 multi-GSTIN customer · resolved from PO billing address
            </div>
          </Card>

          <Card title="Profile match" eyebrow="learning · cached">
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div className="hbar live"><span style={{ width: "96%" }} /></div>
              <div className="row mono-sm">
                <span>profile · HR-spares-v3</span>
                <span style={{ marginLeft: "auto" }}>match 0.96</span>
              </div>
              <div className="row mono-sm" style={{ color: "var(--sage)" }}>
                <Dot k="good" /> haiku route eligible · est ₹ 1.20
              </div>
              <div className="row mono-sm">
                <span style={{ color: "var(--ink-3)" }}>covers · header layout, line table, UoM aliases</span>
              </div>
              <div className="divider" />
              <div className="mono-sm" style={{ color: "var(--ink-3)" }}>
                If pre-classifier confidence drops &lt; 0.85, system auto-falls back to Sonnet and logs to <b>model_routing_log</b>.
              </div>
            </div>
          </Card>

          <Card title="Estimated cost" eyebrow="this SO">
            <div className="row" style={{ alignItems: "baseline", gap: 6 }}>
              <span style={{ fontFamily: "var(--mono)", fontSize: 22, fontWeight: 600 }}>₹ 2.4</span>
              <span className="mono-sm">all-in · OCR + Claude + Tally</span>
            </div>
            <div className="divider" />
            <div className="mono-sm">
              <div className="row"><span>OCR · Mistral · 4 pages</span><span style={{ marginLeft: "auto" }}>₹ 0.80</span></div>
              <div className="row"><span>Pre-classifier · Haiku</span><span style={{ marginLeft: "auto" }}>₹ 1.20</span></div>
              <div className="row"><span>Validation pass</span><span style={{ marginLeft: "auto" }}>₹ 0.40</span></div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  </>
);

// ─────────────────────────────────────────────────────────────
// SO Workspace — the big one
// ─────────────────────────────────────────────────────────────
const SOWorkspace = () => (
  <div className="ws">
    <div className="ws-title" style={{ alignItems: "stretch", flexDirection: "column", gap: 8 }}>
      <div className="row" style={{ width: "100%" }}>
        <div>
          <div className="h-eyebrow">Sales Orders · Workspace</div>
          <div className="row gap-sm" style={{ marginTop: 2 }}>
            <h1>OIQTLC-26-1015</h1>
            <Chip k="info">SPARES</Chip>
            <Chip k="warn">extract</Chip>
            <Chip k="ghost">v3 profile · 0.96</Chip>
            <Chip k="ghost">payload hash a8f2c1…</Chip>
          </div>
        </div>
        <span style={{ flex: 1 }} />
        <Btn sm kind="ghost">{Icon.history} thread</Btn>
        <Btn sm kind="ghost">{Icon.diff} amend</Btn>
        <Btn sm kind="ghost">{Icon.send} email customer</Btn>
        <Btn sm kind="ghost">{Icon.download}</Btn>
        <Btn sm kind="primary">{Icon.shieldCheck} request approval</Btn>
      </div>
      <div className="row mono-sm" style={{ color: "var(--ink-3)" }}>
        Hyderabad Refractories Pvt Ltd · Hyderabad 36
        <span style={{ color: "var(--ink-5)" }}>·</span>
        <span>created 12 Apr 09:14 by Rajesh P.</span>
        <span style={{ color: "var(--ink-5)" }}>·</span>
        <span>last edit 12:38 IST · auto-extract</span>
        <span style={{ marginLeft: "auto" }}>cycle <b style={{ color: "var(--ink)" }}>14m</b></span>
      </div>
    </div>

    <div className="ws-tabs">
      <div className="ws-tab active">Reconciliation<span className="tab-count">3 issues</span></div>
      <div className="ws-tab">Margin cockpit</div>
      <div className="ws-tab">Why<span className="tab-count">12</span></div>
      <div className="ws-tab">Evidence</div>
      <div className="ws-tab">Approval</div>
      <div className="ws-tab">Tally</div>
      <div className="ws-tab">Shipments</div>
      <div className="ws-tab">Activity</div>
    </div>

    <div className="ws-content">
      <Steps current={2} items={["Capture", "Preflight", "Extract", "Validate", "Approve", "Push to Tally"]} />

      {/* Reconciliation grid · the hero panel */}
      <Card flush>
        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--hairline-2)", display: "flex", gap: 10, alignItems: "center" }}>
          <span className="h2">Line reconciliation</span>
          <span className="mono-sm">PO ↔ Quote ↔ Pricecomp · 4 lines · 3 issues</span>
          <span style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
            <span className="mono-sm">view</span>
            <Chip k="fill">side-by-side</Chip>
            <Chip>diff only</Chip>
            <Chip>raw</Chip>
          </span>
        </div>
        <table className="tbl">
          <thead><tr>
            <th style={{ width: 28 }}>#</th>
            <th>Item</th>
            <th>UoM</th>
            <th className="r">Qty · PO</th>
            <th className="r">Qty · Q</th>
            <th className="r">Rate · PO</th>
            <th className="r">Rate · prev</th>
            <th className="r">Δ</th>
            <th className="r">Line ₹</th>
            <th>Evidence</th>
            <th>Issues</th>
          </tr></thead>
          <tbody>
            <tr>
              <td className="mono">1</td>
              <td>
                <div style={{ fontWeight: 600 }}>Robotic spot welding gun · cap</div>
                <div className="mono-sm">SKU OBR-CAP-50A · alias resolved · MUM-CAP-50A</div>
              </td>
              <td>nos</td>
              <td className="r mono">200</td>
              <td className="r mono">200</td>
              <td className="r mono">₹ 1,420</td>
              <td className="r mono">₹ 1,380</td>
              <td className="r mono" style={{ color: "var(--sage)" }}>+2.9%</td>
              <td className="r mono"><span className="pri">₹ 2,84,000</span></td>
              <td className="row gap-sm"><Prov>p1·l4</Prov><Prov>p2·l1</Prov></td>
              <td>—</td>
            </tr>
            <tr className="row-warn">
              <td className="mono">2</td>
              <td>
                <div style={{ fontWeight: 600 }}>Welding tip · ⌀16 mm</div>
                <div className="mono-sm">SKU OBR-TIP-16 · alias TIP_16MM_DIA</div>
              </td>
              <td>nos <span className="mono-sm" style={{ color: "var(--amber-2)" }}>(was «pcs»)</span></td>
              <td className="r mono">400</td>
              <td className="r mono">400</td>
              <td className="r mono">₹ 280</td>
              <td className="r mono">₹ 240</td>
              <td className="r mono" style={{ color: "var(--amber-2)", fontWeight: 600 }}>+16.7%</td>
              <td className="r mono"><span className="pri">₹ 1,12,000</span></td>
              <td className="row gap-sm"><Prov>p2·l3</Prov></td>
              <td><Chip k="warn">price drift</Chip></td>
            </tr>
            <tr className="row-flag">
              <td className="mono">3</td>
              <td>
                <div style={{ fontWeight: 600 }}>Cooling hose assembly · SS</div>
                <div className="mono-sm">SKU OBR-HOSE-SS · multi-alias · check</div>
              </td>
              <td>set</td>
              <td className="r mono" style={{ color: "var(--rust)", fontWeight: 600 }}>30</td>
              <td className="r mono">25</td>
              <td className="r mono">₹ 4,200</td>
              <td className="r mono">₹ 4,200</td>
              <td className="r mono">·</td>
              <td className="r mono"><span className="pri">₹ 1,05,000</span></td>
              <td className="row gap-sm"><Prov>p2·l5</Prov></td>
              <td><Chip k="bad">qty mismatch</Chip></td>
            </tr>
            <tr>
              <td className="mono">4</td>
              <td>
                <div style={{ fontWeight: 600 }}>Calibration kit · annual</div>
                <div className="mono-sm">SKU OBR-CAL-YR · service line</div>
              </td>
              <td>job</td>
              <td className="r mono">1</td>
              <td className="r mono">1</td>
              <td className="r mono">₹ 81,400</td>
              <td className="r mono">₹ 78,200</td>
              <td className="r mono" style={{ color: "var(--sage)" }}>+4.1%</td>
              <td className="r mono"><span className="pri">₹ 81,400</span></td>
              <td className="row gap-sm"><Prov>p3·l2</Prov></td>
              <td>—</td>
            </tr>
          </tbody>
          <tfoot>
            <tr style={{ background: "var(--paper-2)" }}>
              <td colSpan={8} className="r mono" style={{ paddingTop: 10, paddingBottom: 10 }}>
                <span style={{ color: "var(--ink-3)" }}>subtotal · before tax & freight</span>
              </td>
              <td className="r mono"><b style={{ fontSize: 13 }}>₹ 5,82,400</b></td>
              <td colSpan={2}></td>
            </tr>
          </tfoot>
        </table>
      </Card>

      {/* Two-up: Margin cockpit · Why panel */}
      <div style={{ display: "grid", gridTemplateColumns: "1.1fr 1fr", gap: 14 }}>
        <Card title="Margin cockpit" eyebrow="this SO" right={<Btn sm kind="ghost">{Icon.ext} simulator</Btn>}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
            <div>
              <div className="h-eyebrow">Realized margin</div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 32, fontWeight: 500, letterSpacing: "-0.02em", color: "var(--ink)", marginTop: 4 }}>28.0%</div>
              <div className="mono-sm">₹ 1,63,072 on ₹ 5,82,400</div>
              {/* margin band */}
              <div style={{ marginTop: 14, position: "relative", height: 22 }}>
                <div style={{ position: "absolute", inset: 0, background: "var(--paper-3)", borderRadius: 3 }} />
                <div style={{ position: "absolute", left: "10%", top: 0, bottom: 0, width: "1px", background: "var(--rust)" }} />
                <div style={{ position: "absolute", left: "30%", top: 0, bottom: 0, width: "1px", background: "var(--ink-3)" }} />
                <div style={{ position: "absolute", left: "10%", width: "20%", top: 5, bottom: 5, background: "var(--sage-3)", borderRadius: 2 }} />
                <div style={{ position: "absolute", left: "calc(28% - 1px)", top: -4, bottom: -4, width: 3, background: "var(--ink)" }} />
                <div style={{ position: "absolute", left: "10%", top: -16, fontFamily: "var(--mono)", fontSize: 9, color: "var(--rust)" }}>floor · 10%</div>
                <div style={{ position: "absolute", left: "30%", top: -16, fontFamily: "var(--mono)", fontSize: 9, color: "var(--ink-3)" }}>target · 30%</div>
              </div>
            </div>
            <div>
              <div className="h-eyebrow">Cost decomposition</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 5, marginTop: 6 }}>
                {[
                  ["Materials · landed", 51, "₹ 2,97,024"],
                  ["Freight · road", 8,  "₹ 46,592"],
                  ["Customs · GST", 12, "₹ 69,888"],
                  ["Service · calibration", 5, "₹ 29,120"],
                  ["Margin", 28, "₹ 1,63,072", true],
                ].map((r, i) => (
                  <div key={i} className="row mono-sm">
                    <span style={{ minWidth: 130 }}>{r[0]}</span>
                    <div className="hbar" style={{ flex: 1 }}>
                      <span style={{ width: `${r[1]}%`, background: r[3] ? "var(--accent-2)" : "var(--ink)" }} />
                    </div>
                    <span style={{ minWidth: 80, textAlign: "right" }}>{r[2]}</span>
                    <span style={{ minWidth: 36, textAlign: "right", color: "var(--ink-3)" }}>{r[1]}%</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="divider" />
          <div className="mono-sm">
            <Dot k="good" /> within healthy band · auto-approve eligible (delegate cap 25% reached → mgr review)
          </div>
        </Card>

        <Card title="Why · model reasoning" eyebrow="redacted · audit"
              right={<Btn sm kind="ghost">{Icon.ext} routing log</Btn>}>
          <div className="mono-sm" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div className="row gap-sm" style={{ flexWrap: "wrap" }}>
              <Chip>haiku-4.5 · preflight</Chip>
              <Chip>sonnet-4.5 · extraction</Chip>
              <Chip k="ghost">no opus fallback</Chip>
              <span style={{ marginLeft: "auto" }}>cost · ₹ 2.40</span>
            </div>
            <div style={{ background: "var(--paper-3)", padding: 10, borderRadius: 4, lineHeight: 1.55 }}>
              <b style={{ color: "var(--ink)" }}>L2 · Welding tip ⌀16</b> — UoM «pcs» on PO mapped to canonical «nos» via
              alias TIP_16MM_DIA → OBR-TIP-16 (profile HR-spares-v3, weight 0.94). Price ₹ 280 vs prior ₹ 240 (+16.7%) breaches
              soft drift threshold (10%); flagged for review, not blocked. <Prov>cite p2·l3</Prov>
            </div>
            <div style={{ background: "var(--paper-3)", padding: 10, borderRadius: 4, lineHeight: 1.55 }}>
              <b style={{ color: "var(--ink)" }}>L3 · Cooling hose</b> — qty discrepancy: PO «30 sets», earlier quote
              «25 sets». No amendment doc. Confidence 0.72 (below 0.85), <b style={{ color: "var(--rust)" }}>blocking</b>
              until human resolves. <Prov>cite p2·l5</Prov>
            </div>
            <div style={{ background: "var(--paper-3)", padding: 10, borderRadius: 4, lineHeight: 1.55 }}>
              Customer Hyderabad Refractories matched on GSTIN <span className="mono">36AAACH…1ZQ</span>; single billing
              location. Margin floor 10% inherited from <b>SPARES</b> mode. Tally voucher template:
              <span className="mono"> SO/SPARES/HRP</span>.
            </div>
          </div>
        </Card>
      </div>

      {/* Evidence + amendments + activity */}
      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 14 }}>
        <Card flush>
          <div style={{ padding: "12px 16px", display: "flex", alignItems: "center", gap: 10, borderBottom: "1px solid var(--hairline-2)" }}>
            <span className="h2">Evidence · PO 2024-7821</span>
            <span className="mono-sm">page 2 of 4 · OCR confidence 0.93</span>
            <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
              <Btn sm kind="ghost" icon>{Icon.arrowL}</Btn>
              <Btn sm kind="ghost" icon>{Icon.arrowR}</Btn>
              <Btn sm kind="ghost">{Icon.ext} open original</Btn>
            </div>
          </div>
          <div className="doc-surface" style={{ height: 360, margin: 14, position: "relative" }}>
            {/* fake page chrome */}
            <div style={{ position: "absolute", top: 24, left: 24, right: 24, fontFamily: "var(--serif)", fontSize: 13, color: "var(--ink-2)" }}>
              <div style={{ fontFamily: "var(--sans)", fontSize: 11, color: "var(--ink-4)", textTransform: "uppercase", letterSpacing: "0.1em" }}>Hyderabad Refractories Pvt Ltd</div>
              <div style={{ fontWeight: 600, fontSize: 18, marginTop: 4 }}>Purchase Order 2024-7821</div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-4)", marginTop: 2 }}>dated 12 April 2026 · GSTIN 36AAACH1234M1ZQ</div>
              <div style={{ marginTop: 18, padding: "10px 0", borderTop: "1px solid var(--ink-3)", borderBottom: "1px solid var(--ink-3)", fontFamily: "var(--mono)", fontSize: 10, display: "grid", gridTemplateColumns: "30px 1fr 60px 70px 70px 80px", gap: 8 }}>
                <span>#</span><span>Description</span><span style={{ textAlign: "right" }}>Qty</span><span style={{ textAlign: "right" }}>UoM</span><span style={{ textAlign: "right" }}>Rate</span><span style={{ textAlign: "right" }}>Amount</span>
              </div>
              {[
                ["1", "Robotic spot welding gun · cap (50 A)", "200", "nos", "1,420", "2,84,000"],
                ["2", "Welding tip · ⌀16 mm",                 "400", "pcs", "280",   "1,12,000", "warn"],
                ["3", "Cooling hose assembly · SS",           "30",  "set", "4,200", "1,26,000", "flag"],
                ["4", "Calibration kit · annual",             "1",   "job", "81,400","81,400"],
              ].map((r, i) => (
                <div key={i} style={{
                  marginTop: 6, padding: "4px 6px",
                  background: r[6] === "flag" ? "rgba(162,58,31,0.12)" : r[6] === "warn" ? "rgba(181,120,16,0.12)" : "transparent",
                  outline: r[6] ? `1px solid ${r[6] === "flag" ? "var(--rust)" : "var(--amber)"}` : "none",
                  fontFamily: "var(--mono)", fontSize: 10.5,
                  display: "grid", gridTemplateColumns: "30px 1fr 60px 70px 70px 80px", gap: 8,
                  cursor: "pointer", color: "var(--ink)",
                }}>
                  <span>{r[0]}</span><span>{r[1]}</span><span style={{ textAlign: "right" }}>{r[2]}</span><span style={{ textAlign: "right" }}>{r[3]}</span><span style={{ textAlign: "right" }}>{r[4]}</span><span style={{ textAlign: "right" }}>{r[5]}</span>
                </div>
              ))}
            </div>
            <div style={{ position: "absolute", bottom: 12, right: 14, padding: "4px 8px", background: "var(--paper)", border: "1px solid var(--hairline)", borderRadius: 3, fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-3)" }}>
              page 2/4 · zoom 100%
            </div>
          </div>
        </Card>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Card title="Amendments" eyebrow="0 active" right={<Btn sm kind="ghost">+ propose</Btn>}>
            <div className="mono-sm" style={{ color: "var(--ink-3)" }}>No amendments yet. Draft an amendment to change qty, price, or schedule after Tally push.</div>
            <div className="divider" />
            <div className="diff-row">
              <div className="l"><div style={{ color: "var(--ink-4)", textTransform: "uppercase", fontSize: 9, letterSpacing: 0.06 }}>example · L3 qty</div>was <b>30 set</b></div>
              <div className="r"><div style={{ color: "var(--ink-4)", textTransform: "uppercase", fontSize: 9, letterSpacing: 0.06 }}>proposed</div>now <b>25 set</b></div>
            </div>
          </Card>

          <Card title="Activity" eyebrow="14 events" right={<Btn sm kind="ghost">{Icon.history}</Btn>}>
            <Stream rows={[
              { t: "12:42", a: "EVAL", m: "spares-extract suite · pass · drift 0.04" },
              { t: "12:38", a: "OCR",  m: "PO/HRP/24-7821 · 4 pages · conf <b>0.93</b>" },
              { t: "12:31", a: "CLAUDE", m: "extract · sonnet-4.5 · 12.1k tok · ₹ 18.4" },
              { t: "12:18", a: "CLAUDE", m: "preflight · haiku-4.5 · 1.4k tok · ₹ 1.20" },
              { t: "12:14", a: "SCAN", m: "ZIP guards · OK · ClamAV · clean" },
              { t: "12:12", a: "OCR",  m: "Mistral · started" },
              { t: "12:10", a: "USER", m: "Rajesh P. · uploaded PO 2024-7821" },
            ]} />
          </Card>
        </div>
      </div>
    </div>
  </div>
);

Object.assign(window, { SOList, SOIntake, SOWorkspace });
