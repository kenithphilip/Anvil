// ============================================================
// ANVIL v3 — Tally · e-Invoice · Cost & Margin
// ============================================================

const TallyMasters = () => (
  <>
    <WSTitle
      eyebrow="Finance · Tally"
      title="Tally · masters"
      meta="ledgers · stock items · units · groups"
      right={<>
        <Btn sm kind="ghost">{Icon.cycle} sync now</Btn>
        <Btn sm kind="primary">{Icon.diff} compare with Anvil</Btn>
      </>}
    />
    <WSTabs tabs={[
      { id: "led", label: "Ledgers", count: 412 },
      { id: "items", label: "Stock items", count: 1284 },
      { id: "uoms", label: "Units", count: 28 },
      { id: "groups", label: "Groups", count: 18 },
      { id: "vouchers", label: "Voucher types", count: 7 },
    ]} active="led" />

    <div className="ws-content">
      <Banner kind="live" icon={Icon.cycle} title="Bridge online · v6.6.3 · last sync 8s ago"
              action={<Btn sm kind="ghost">routing settings</Btn>}>
        <span className="mono-sm">Tally HTTP bridge at <b>tally-bridge://10.0.4.12:9000</b> · 412 ledgers, 1284 items, 28 UoMs in cache. Push voucher type · <b>Sales Order · OBARA-IN</b>.</span>
      </Banner>

      <KPIRow cols={4}>
        <KPI lbl="In Anvil only" v="14" d="ledgers · 8 items" dKind="up" />
        <KPI lbl="In Tally only" v="9" d="dormant · review" />
        <KPI lbl="Mismatched" v="3" d="ledger group changed" dKind="down" />
        <KPI lbl="Last sync" v="8s" d="success" live />
      </KPIRow>

      <Card flush>
        <table className="tbl">
          <thead><tr>
            <th style={{ width: 22 }}></th>
            <th>Ledger</th>
            <th>Group · Anvil</th>
            <th>Group · Tally</th>
            <th>GSTIN</th>
            <th>State</th>
            <th>Last used</th>
            <th></th>
          </tr></thead>
          <tbody>
            {[
              ["good", "Hyderabad Refractories Pvt Ltd", "Sundry Debtors", "Sundry Debtors", "36AAACH1234M1ZQ", "36 · Telangana", "12 Apr"],
              ["warn", "MG Motor India Pvt Ltd · Halol", "Sundry Debtors", "—", "24AAACM2289G1ZX", "24 · Gujarat", "10 Apr · only Anvil"],
              ["warn", "MG Motor India Pvt Ltd · Manesar", "Sundry Debtors", "—", "06AAACM2289G2ZW", "06 · Haryana", "—"],
              ["bad",  "Voestalpine Specialty Tubes", "Foreign Debtors", "Sundry Debtors", "—", "—", "12 Apr · group mismatch"],
              ["good", "JBM Auto · Faridabad", "Sundry Debtors", "Sundry Debtors", "06AAACJ4811A1ZN", "06 · Haryana", "8 Apr"],
              ["good", "RSWM · Bhilwara", "Sundry Debtors", "Sundry Debtors", "08AAACR1185R1ZA", "08 · Rajasthan", "30 Mar"],
            ].map((r, i) => (
              <tr key={i} className={r[0] === "bad" ? "row-flag" : r[0] === "warn" ? "row-warn" : ""}>
                <td><Dot k={r[0]} /></td>
                <td><span className="pri">{r[1]}</span></td>
                <td className="mono">{r[2]}</td>
                <td className="mono">{r[3]}</td>
                <td className="mono">{r[4]}</td>
                <td className="mono">{r[5]}</td>
                <td className="mono-sm">{r[6]}</td>
                <td><Btn sm>{r[0] === "good" ? "view" : "resolve"}</Btn></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  </>
);

const TallyPush = () => (
  <>
    <WSTitle
      eyebrow="Finance · Tally"
      title="Push queue"
      meta="5 vouchers · 2 amendments · 3 retries"
      right={<>
        <Btn sm kind="ghost">{Icon.history} history</Btn>
        <Btn sm kind="primary">{Icon.send} push selected</Btn>
      </>}
    />
    <div className="ws-content">
      <KPIRow cols={4}>
        <KPI lbl="Pending push" v="5" d="oldest 12m" />
        <KPI lbl="Amendments" v="2" d="1 needs payload re-hash" dKind="down" />
        <KPI lbl="Failed · retry" v="3" d="last err: HTTP 502" dKind="down" />
        <KPI lbl="Pushed today" v="32" d="₹ 24.4 L" live />
      </KPIRow>

      <Card title="Push queue" eyebrow="ordered by age" flush>
        <table className="tbl">
          <thead><tr>
            <th><input type="checkbox" /></th>
            <th>Voucher</th>
            <th>Order</th>
            <th>Type</th>
            <th>Hash</th>
            <th className="r">Lines</th>
            <th className="r">Amount</th>
            <th>Status</th>
            <th>Notes</th>
            <th></th>
          </tr></thead>
          <tbody>
            <tr className="row-live">
              <td><input type="checkbox" defaultChecked /></td>
              <td className="mono"><span className="pri">SO/SPARES/HRP-2641</span></td>
              <td className="mono">OIQTLC-26-1015</td>
              <td><Chip k="info">Sales Order</Chip></td>
              <td className="mono-sm">a8f2c1…</td>
              <td className="r mono">4</td>
              <td className="r mono">₹ 5,82,400</td>
              <td><Chip k="warn">queued</Chip></td>
              <td className="mono-sm">approved 11:42 · payload hash matched</td>
              <td><Btn sm>push</Btn></td>
            </tr>
            <tr>
              <td><input type="checkbox" /></td>
              <td className="mono"><span className="pri">SO/PROJECT_FOR/TST-0008</span></td>
              <td className="mono">OFRPRJ-26-0008</td>
              <td><Chip k="info">Sales Order</Chip></td>
              <td className="mono-sm">3b1e4a…</td>
              <td className="r mono">3</td>
              <td className="r mono">₹ 41,20,000</td>
              <td><Chip k="warn">queued</Chip></td>
              <td className="mono-sm">tax breakdown verified · waiting for window</td>
              <td><Btn sm>push</Btn></td>
            </tr>
            <tr className="row-flag">
              <td><input type="checkbox" /></td>
              <td className="mono"><span className="pri">SO/SPARES/MGM-1011</span></td>
              <td className="mono">OIQTLC-26-1011</td>
              <td><Chip k="info">Sales Order</Chip></td>
              <td className="mono-sm">9c0d22…</td>
              <td className="r mono">12</td>
              <td className="r mono">₹ 8,21,100</td>
              <td><Chip k="bad">failed · retry 2/3</Chip></td>
              <td className="mono-sm" style={{ color: "var(--rust-2)" }}>Tally returned «duplicate voucher number» — try regenerating</td>
              <td><Btn sm kind="danger">retry</Btn></td>
            </tr>
            <tr>
              <td><input type="checkbox" /></td>
              <td className="mono"><span className="pri">CR/REC/HRP-26-04-12</span></td>
              <td className="mono">OIQTLC-26-1015</td>
              <td><Chip k="plum">Receipt</Chip></td>
              <td className="mono-sm">f4a72b…</td>
              <td className="r mono">1</td>
              <td className="r mono">₹ 2,90,000</td>
              <td><Chip>queued</Chip></td>
              <td className="mono-sm">advance · 50% on confirmation</td>
              <td><Btn sm>push</Btn></td>
            </tr>
            <tr className="row-warn">
              <td><input type="checkbox" /></td>
              <td className="mono"><span className="pri">AM/SO/SPARES/HRP-2638</span></td>
              <td className="mono">OIQTLC-26-1009</td>
              <td><Chip k="warn">Amendment</Chip></td>
              <td className="mono-sm">e21c0b…</td>
              <td className="r mono">2 changed</td>
              <td className="r mono">+ ₹ 12,400</td>
              <td><Chip k="warn">re-hash needed</Chip></td>
              <td className="mono-sm">L2 qty 200 → 220 · L3 rate 4,200 → 4,400</td>
              <td><Btn sm>open</Btn></td>
            </tr>
          </tbody>
        </table>
      </Card>

      <Card title="Amendment diff · AM/SO/SPARES/HRP-2638" eyebrow="re-hash + push">
        <div className="diff-row" style={{ marginBottom: 8 }}>
          <div className="l">
            <div style={{ color: "var(--ink-4)", textTransform: "uppercase", fontSize: 9, letterSpacing: 0.06 }}>before · hash 1a72cd…</div>
            L2 · Welding tip ⌀16 · qty <b>200</b> · rate <b>₹ 280</b> · ₹ <b>56,000</b>
          </div>
          <div className="r">
            <div style={{ color: "var(--ink-4)", textTransform: "uppercase", fontSize: 9, letterSpacing: 0.06 }}>after · hash e21c0b…</div>
            L2 · Welding tip ⌀16 · qty <b>220</b> · rate <b>₹ 280</b> · ₹ <b>61,600</b>
          </div>
        </div>
        <div className="diff-row">
          <div className="l">L3 · Cooling hose · rate <b>₹ 4,200</b> · ₹ <b>1,26,000</b></div>
          <div className="r">L3 · Cooling hose · rate <b>₹ 4,400</b> · ₹ <b>1,32,000</b></div>
        </div>
        <div className="divider" />
        <div className="row" style={{ alignItems: "center" }}>
          <div className="mono-sm">Net delta · <b style={{ color: "var(--ink)" }}>+ ₹ 12,400</b> · margin band unchanged · approver auto-cleared (≤ 5%)</div>
          <span style={{ flex: 1 }} />
          <Btn sm kind="ghost">view audit trail</Btn>
          <Btn sm kind="primary">re-hash + push</Btn>
        </div>
      </Card>
    </div>
  </>
);

const TallyReconcile = () => (
  <>
    <WSTitle
      eyebrow="Finance · Tally"
      title="Reconciliation · April 2026"
      meta="32 in Anvil · 31 in Tally · 1 difference"
      right={<>
        <Btn sm kind="ghost">{Icon.cal} change month</Btn>
        <Btn sm kind="primary">{Icon.download} audit pack</Btn>
      </>}
    />
    <div className="ws-content">
      <KPIRow cols={4}>
        <KPI lbl="Match rate" v="96.9%" d="31 of 32" dKind="up" live />
        <KPI lbl="Anvil ₹" v="₹ 24.4 L" />
        <KPI lbl="Tally ₹" v="₹ 24.3 L" />
        <KPI lbl="Δ" v="₹ 12,400" d="1 amendment lagging" dKind="down" />
      </KPIRow>

      <Card title="Mismatches" eyebrow="1 row">
        <table className="tbl">
          <thead><tr>
            <th>Voucher</th><th>Order</th><th className="r">Anvil ₹</th><th className="r">Tally ₹</th><th className="r">Δ</th><th>Reason</th><th></th>
          </tr></thead>
          <tbody>
            <tr className="row-warn">
              <td className="mono"><span className="pri">AM/SO/SPARES/HRP-2638</span></td>
              <td className="mono">OIQTLC-26-1009</td>
              <td className="r mono">₹ 1,93,600</td>
              <td className="r mono">₹ 1,81,200</td>
              <td className="r mono" style={{ color: "var(--amber-2)", fontWeight: 600 }}>+ ₹ 12,400</td>
              <td className="mono-sm">amendment not yet pushed · in queue</td>
              <td><Btn sm>resolve</Btn></td>
            </tr>
          </tbody>
        </table>
      </Card>
    </div>
  </>
);

// ─────────────────────────────────────────────────────────────
// e-Invoice
// ─────────────────────────────────────────────────────────────
const EInvoice = () => (
  <>
    <WSTitle
      eyebrow="Finance · e-Invoice"
      title="GSTN · IRN queue"
      meta="DRAFT → PENDING_GSTN → GENERATED · cancel within 24h"
      right={<><Btn sm kind="ghost">{Icon.cal} window</Btn><Btn sm kind="primary">{Icon.send} generate selected</Btn></>}
    />
    <div className="ws-content">
      <KPIRow cols={4}>
        <KPI lbl="Drafts" v="6" d="awaiting GSTIN/HSN check" />
        <KPI lbl="Pending GSTN" v="2" d="oldest 1h 12m" dKind="down" />
        <KPI lbl="Generated" v="412" d="MTD" live />
        <KPI lbl="Cancel-eligible" v="3" d="≤ 24h window" />
      </KPIRow>

      <Card flush>
        <table className="tbl">
          <thead><tr>
            <th>Invoice</th><th>Buyer · GSTIN</th><th>Status</th><th>IRN</th><th>QR</th><th className="r">Amount</th><th>Generated</th><th>Cancel by</th><th></th>
          </tr></thead>
          <tbody>
            <tr>
              <td className="mono"><span className="pri">INV/SO/HRP-2641</span></td>
              <td>Hyderabad Refractories<div className="mono-sm">36AAACH1234M1ZQ</div></td>
              <td><Chip k="warn">PENDING_GSTN</Chip></td>
              <td className="mono-sm">requested 10:30</td>
              <td>—</td>
              <td className="r mono">₹ 5,82,400</td>
              <td className="mono-sm">—</td>
              <td className="mono-sm">—</td>
              <td><Btn sm>poll</Btn></td>
            </tr>
            <tr className="row-live">
              <td className="mono"><span className="pri">INV/SO/MGM-1011</span></td>
              <td>MG Motor · Halol<div className="mono-sm">24AAACM2289G1ZX</div></td>
              <td><Chip k="good">GENERATED</Chip></td>
              <td className="mono-sm">a8c12d…471x</td>
              <td><div style={{ width: 24, height: 24, background: "var(--ink)", display: "grid", placeItems: "center", color: "var(--paper)", fontSize: 10 }}>QR</div></td>
              <td className="r mono">₹ 8,21,100</td>
              <td className="mono-sm">11:42 · today</td>
              <td className="mono-sm" style={{ color: "var(--amber-2)" }}>22h 18m</td>
              <td><Btn sm kind="ghost">cancel</Btn></td>
            </tr>
            <tr>
              <td className="mono"><span className="pri">INV/SO/JBM-1018</span></td>
              <td>JBM Auto · Faridabad<div className="mono-sm">06AAACJ4811A1ZN</div></td>
              <td><Chip k="good">GENERATED</Chip></td>
              <td className="mono-sm">d04e91…22az</td>
              <td><div style={{ width: 24, height: 24, background: "var(--ink)", display: "grid", placeItems: "center", color: "var(--paper)", fontSize: 10 }}>QR</div></td>
              <td className="r mono">₹ 9,80,000</td>
              <td className="mono-sm">8 Apr · 14:18</td>
              <td className="mono-sm" style={{ color: "var(--ink-4)" }}>expired</td>
              <td><Btn sm kind="ghost">credit note</Btn></td>
            </tr>
          </tbody>
        </table>
      </Card>

      <Banner kind="info" icon={Icon.info} title="Cancel-within-24h policy">
        <span className="mono-sm">An e-Invoice can be cancelled at GSTN within 24h of generation. After that, the only correction is a Credit Note. The 24h window starts at GSTN ack, not Anvil queue time. The dock countdown reflects GSTN ack time.</span>
      </Banner>
    </div>
  </>
);

// ─────────────────────────────────────────────────────────────
// Cost & Margin · simulator + history
// ─────────────────────────────────────────────────────────────
const CostMargin = () => (
  <>
    <WSTitle
      eyebrow="Finance · Cost & Margin"
      title="Cost & margin"
      meta="₹/SO simulator · margin history · floor breaches"
      right={<><Btn sm kind="ghost">{Icon.download}</Btn><Btn sm kind="primary">{Icon.settings} policy</Btn></>}
    />
    <WSTabs tabs={[
      { id: "sim", label: "Simulator" },
      { id: "hist", label: "Margin history" },
      { id: "policy", label: "Policy" },
      { id: "fx", label: "FX & forwards" },
    ]} active="sim" />

    <div className="ws-content">
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <Card title="₹/SO simulator" eyebrow="what-if">
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {[
              ["Profile cache hit rate", 78, "%", 0, 100],
              ["Manual review rate",     12, "%", 0, 100],
              ["Realtime extraction share", 22, "%", 0, 100],
              ["Avg pages per PO", 3.4, "p", 1, 12],
              ["Volume · SOs/month", 600, "", 50, 2000],
            ].map((r, i) => (
              <div key={i}>
                <div className="row mono-sm">
                  <span style={{ minWidth: 180 }}>{r[0]}</span>
                  <input type="range" min={r[3]} max={r[4]} defaultValue={r[1]} style={{ flex: 1, accentColor: "var(--ink)" }} />
                  <span style={{ minWidth: 60, textAlign: "right", fontWeight: 600, color: "var(--ink)" }}>{r[1]}{r[2]}</span>
                </div>
              </div>
            ))}
          </div>
          <div className="divider" />
          <div className="row" style={{ alignItems: "baseline", gap: 6 }}>
            <span style={{ fontFamily: "var(--mono)", fontSize: 28, fontWeight: 500 }}>₹ 11.40</span>
            <span className="mono-sm">median ₹/SO · all-in</span>
            <span style={{ marginLeft: "auto" }} className="mono-sm">vs baseline ₹ 14.20 · <span style={{ color: "var(--sage)" }}>−19.7%</span></span>
          </div>
          <div className="divider" />
          <table className="tbl">
            <thead><tr><th>Component</th><th className="r">₹/SO</th><th className="r">Δ baseline</th><th>Sensitivity</th></tr></thead>
            <tbody>
              <tr><td>Mistral OCR</td><td className="r mono">₹ 2.40</td><td className="r mono" style={{ color: "var(--ink-3)" }}>—</td><td className="mono-sm">∂ pages</td></tr>
              <tr><td>Claude · Haiku</td><td className="r mono">₹ 1.10</td><td className="r mono" style={{ color: "var(--sage)" }}>−18%</td><td className="mono-sm">∂ cache hit</td></tr>
              <tr><td>Claude · Sonnet</td><td className="r mono">₹ 6.20</td><td className="r mono" style={{ color: "var(--sage)" }}>−24%</td><td className="mono-sm">∂ realtime share</td></tr>
              <tr><td>Claude · Opus fallback</td><td className="r mono">₹ 0.80</td><td className="r mono" style={{ color: "var(--sage)" }}>−42%</td><td className="mono-sm">∂ confidence floor</td></tr>
              <tr><td>Tally bridge ops</td><td className="r mono">₹ 0.50</td><td className="r mono" style={{ color: "var(--ink-3)" }}>—</td><td className="mono-sm">flat</td></tr>
              <tr><td>Manual review labour</td><td className="r mono">₹ 0.40</td><td className="r mono" style={{ color: "var(--sage)" }}>−66%</td><td className="mono-sm">∂ review rate</td></tr>
            </tbody>
          </table>
        </Card>

        <Card title="Margin history · 12 mo" eyebrow="weighted ₹">
          <div style={{ height: 180, position: "relative", padding: "10px 0", borderBottom: "1px solid var(--hairline-2)" }}>
            {/* simple line chart */}
            <svg viewBox="0 0 600 180" width="100%" height="100%" preserveAspectRatio="none">
              <line x1="0" y1="120" x2="600" y2="120" stroke="var(--rust)" strokeDasharray="3 3" />
              <text x="6" y="116" fontFamily="var(--mono)" fontSize="9" fill="var(--rust)">floor 10%</text>
              <line x1="0" y1="60" x2="600" y2="60" stroke="var(--ink-4)" strokeDasharray="3 3" />
              <text x="6" y="56" fontFamily="var(--mono)" fontSize="9" fill="var(--ink-4)">target 30%</text>
              <polyline fill="none" stroke="var(--ink)" strokeWidth="2"
                points="20,72 70,68 120,80 170,90 220,72 270,60 320,75 370,110 420,85 470,68 520,72 570,55" />
              <circle cx="370" cy="110" r="4" fill="var(--rust)" />
              <text x="378" y="106" fontFamily="var(--mono)" fontSize="9" fill="var(--rust)">breach · Jan</text>
              <circle cx="570" cy="55" r="4" fill="var(--accent-2)" />
              <text x="540" y="46" fontFamily="var(--mono)" fontSize="9" fill="var(--ink)">today 22.4%</text>
            </svg>
          </div>
          <div className="row mono-sm" style={{ marginTop: 8, justifyContent: "space-between" }}>
            {["May","Jun","Jul","Aug","Sep","Oct","Nov","Dec","Jan","Feb","Mar","Apr"].map(m => <span key={m}>{m}</span>)}
          </div>
          <div className="divider" />
          <div className="mono-sm" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div><Dot k="bad" /> Jan breach: 2 PROJECT_HSS at 8.4%, 8.9% · forward FX missed by ₹ 1.20 vs spot</div>
            <div><Dot k="good" /> Apr 22.4% · cache + sonnet routing + drift-aware approval</div>
          </div>
        </Card>
      </div>
    </div>
  </>
);

// ─────────────────────────────────────────────────────────────
// Approvals queue (manager-centric, but shareable)
// ─────────────────────────────────────────────────────────────
const Approvals = () => (
  <>
    <WSTitle
      eyebrow="Workflows · Approvals"
      title="Approvals"
      meta="3 awaiting · 1 expires 18:00"
      right={<><Btn sm kind="ghost">{Icon.history}</Btn><Btn sm kind="primary">{Icon.shieldCheck} bulk approve eligible</Btn></>}
    />
    <WSTabs tabs={[
      { id: "queue", label: "Queue", count: 3 },
      { id: "policy", label: "Policy" },
      { id: "delegation", label: "Delegation" },
      { id: "history", label: "History" },
    ]} active="queue" />

    <div className="ws-content">
      <Card flush>
        {[
          {
            ref: "OIQTHS-26-0021", c: "Voestalpine Specialty Tubes", mode: "PROJECT_HSS",
            v: "$ 124,500", m: "9.2%", reasons: ["margin 9.2% < 10% floor", "NEW_CUST", "USD value > $10k"],
            sev: "high", expires: "5h 18m", reqBy: "Rajesh P.",
          },
          {
            ref: "OIQTLC-26-1018", c: "JBM Auto · Faridabad", mode: "SPARES_ASSEMBLY",
            v: "₹ 9,80,000", m: "31.4%", reasons: ["qty 480 > contract 200"],
            sev: "med", expires: "2d 4h", reqBy: "Anjali K.",
          },
          {
            ref: "OIQTLC-26-1015", c: "Hyderabad Refractories", mode: "SPARES",
            v: "₹ 4,82,400", m: "28.0%", reasons: ["margin 28% > 25% delegate cap"],
            sev: "low", expires: "3d", reqBy: "Rajesh P.",
          },
        ].map((r, i) => (
          <div key={i} style={{ padding: "16px 18px", borderBottom: "1px solid var(--hairline-2)", display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 16, alignItems: "flex-start" }}>
            <Sev k={r.sev} />
            <div>
              <div className="row gap-sm">
                <span style={{ fontFamily: "var(--mono)", fontWeight: 600 }}>{r.ref}</span>
                <Chip k="info">{r.mode}</Chip>
                <span style={{ fontWeight: 600 }}>· {r.c}</span>
                <span style={{ marginLeft: "auto" }} className="mono-sm">requested by {r.reqBy} · expires <b style={{ color: r.expires.includes("h") ? "var(--rust)" : "var(--ink-3)" }}>{r.expires}</b></span>
              </div>
              <div className="row gap-sm" style={{ marginTop: 6, color: "var(--ink-2)" }}>
                {r.reasons.map(reason => <Chip key={reason} k="warn">{reason}</Chip>)}
              </div>
              <div className="row" style={{ marginTop: 10 }}>
                <span className="mono-sm">value <b style={{ color: "var(--ink)" }}>{r.v}</b></span>
                <span style={{ width: 14 }} />
                <span className="mono-sm">margin <b style={{ color: r.m.includes("9.") ? "var(--rust)" : "var(--ink)" }}>{r.m}</b></span>
                <span style={{ flex: 1 }} />
                <Btn sm kind="ghost">view margin cockpit</Btn>
                <Btn sm kind="ghost">view why panel</Btn>
                <Btn sm>request changes</Btn>
                <Btn sm kind="primary">{Icon.check} approve</Btn>
              </div>
            </div>
            <div style={{ borderLeft: "1px dashed var(--hairline)", paddingLeft: 14, minWidth: 180 }}>
              <div className="h-eyebrow">policy match</div>
              <div className="mono-sm" style={{ marginTop: 4 }}>
                tier <b>L2 · Manager</b><br />
                threshold <b>$ 10,000</b> &middot; ₹ 5L<br />
                delegate <b>V. Suri</b><br />
                expires per <b>tenant policy</b>
              </div>
            </div>
          </div>
        ))}
      </Card>
    </div>
  </>
);

// ─────────────────────────────────────────────────────────────
// Sales pipeline · Leads + Opportunities + Lost reasons
// ─────────────────────────────────────────────────────────────
const Leads = () => (
  <>
    <WSTitle
      eyebrow="Sales · Leads"
      title="Leads"
      meta="34 active · 12 new this week"
      right={<><Btn sm kind="ghost">{Icon.filter}</Btn><Btn sm kind="primary">{Icon.plus} New lead</Btn></>}
    />
    <WSTabs tabs={[
      { id: "all", label: "All", count: 34 },
      { id: "new", label: "New", count: 12 },
      { id: "qual", label: "Qualifying", count: 9 },
      { id: "promo", label: "Promoted", count: 8 },
      { id: "lost", label: "Lost", count: 5 },
    ]} active="all" />

    <div className="ws-content">
      <KPIRow cols={4}>
        <KPI lbl="New this week" v="12" d="+ 4 vs last" dKind="up" />
        <KPI lbl="Qualifying age" v="3.2 d" d="median" />
        <KPI lbl="Conv. → opp" v="38%" d="rolling 60d" />
        <KPI lbl="Lost · top reason" v="42%" d="price · 12 leads" dKind="down" />
      </KPIRow>

      <Card flush>
        <table className="tbl">
          <thead><tr>
            <th>Lead</th><th>Source</th><th>Industry</th><th>Owner</th><th>Stage</th><th className="r">Est. value</th><th>Last touch</th><th></th>
          </tr></thead>
          <tbody>
            {[
              ["Kumar Iron & Steel", "Inbound · website", "Steel · long products", "Anjali K.", "Qualifying", "₹ 12 L", "yesterday", "warn"],
              ["Bharat Wagon · Kapurthala", "Referral · JBM Auto", "Rail · wagons", "Rajesh P.", "New", "₹ 38 L", "2h", "live"],
              ["Sona Comstar · Manesar", "Trade show · IMTEX", "Auto · driveline", "V. Suri", "Promoted → opp", "₹ 64 L", "3d", "good"],
              ["Indian Oil · Panipat", "Cold outreach", "Oil & gas · refineries", "Anjali K.", "Qualifying", "₹ 1.2 Cr", "5d", "warn"],
              ["Reliance Industries", "Inbound · contact form", "Petchem", "Rajesh P.", "Qualifying", "₹ 84 L", "1w", "warn"],
              ["Hero MotoCorp · Neemrana", "Re-engagement", "Auto · 2-wheeler", "V. Suri", "New", "₹ 28 L", "today", "live"],
              ["Larsen & Toubro · Hazira", "Partner · Voltas", "Heavy eng", "Anjali K.", "Lost", "—", "2w", "bad"],
            ].map((r, i) => (
              <tr key={i}>
                <td><span className="pri">{r[0]}</span></td>
                <td className="mono-sm">{r[1]}</td>
                <td className="mono-sm">{r[2]}</td>
                <td className="mono-sm">{r[3]}</td>
                <td><Chip k={r[7]}>{r[4]}</Chip></td>
                <td className="r mono">{r[5]}</td>
                <td className="mono-sm">{r[6]}</td>
                <td><Btn sm>open</Btn></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  </>
);

const Opportunities = () => {
  const cols = [
    { id: "discovery", t: "Discovery", c: 4, w: 0.10 },
    { id: "demo",      t: "Demo", c: 3, w: 0.25 },
    { id: "poc",       t: "PoC", c: 2, w: 0.40 },
    { id: "quote",     t: "Quote", c: 5, w: 0.55 },
    { id: "negot",     t: "Negotiation", c: 2, w: 0.70 },
    { id: "verbal",    t: "Verbal", c: 1, w: 0.85 },
    { id: "lo",        t: "Letter of intent", c: 1, w: 0.92 },
    { id: "po",        t: "PO received", c: 2, w: 0.97 },
    { id: "won",       t: "Won", c: 4, w: 1.00 },
    { id: "lost",      t: "Lost", c: 2, w: 0 },
    { id: "stalled",   t: "Stalled", c: 1, w: 0 },
  ];
  const cards = {
    discovery: [
      { ti: "Indian Oil Panipat · gun upgrade", v: "₹ 1.2 Cr", o: "Anjali", c: "warn" },
      { ti: "Reliance Hazira · trial line", v: "₹ 84 L", o: "Rajesh", c: "info" },
    ],
    demo: [
      { ti: "Sona Comstar · drive shaft welds", v: "₹ 64 L", o: "V. Suri", c: "info" },
    ],
    poc: [
      { ti: "Hero Neemrana · cap modification", v: "₹ 22 L", o: "Anjali", c: "warn" },
    ],
    quote: [
      { ti: "Hyundai Motor · 2-line CIF", v: "$ 84,200", o: "V. Suri", c: "live" },
      { ti: "JBM · gun assembly batch", v: "₹ 9.8 L", o: "Anjali", c: "info" },
      { ti: "Tata Steel Jamshedpur", v: "₹ 41.2 L", o: "Rajesh", c: "info" },
    ],
    negot: [
      { ti: "Voestalpine Linz · Q2 frame", v: "$ 124,500", o: "V. Suri", c: "bad" },
    ],
    verbal: [
      { ti: "POSCO Maharashtra · annual", v: "₹ 2.98 L · ARR", o: "Rajesh", c: "good" },
    ],
    lo: [
      { ti: "Mahindra CIE · spares contract", v: "₹ 18 L", o: "Anjali", c: "good" },
    ],
    po: [
      { ti: "Hyderabad Refractories", v: "₹ 4.82 L", o: "Rajesh", c: "live" },
    ],
    won: [
      { ti: "MG Motor Halol · PO 991", v: "₹ 8.21 L", o: "Anjali", c: "good" },
      { ti: "RSWM Bhilwara · spares", v: "₹ 87 K", o: "Rajesh", c: "good" },
    ],
    lost: [
      { ti: "L&T Hazira", v: "—", o: "Anjali", c: "bad" },
    ],
    stalled: [
      { ti: "Bharat Forge · Pune (4w idle)", v: "₹ 22 L", o: "V. Suri", c: "warn" },
    ],
  };

  return (
    <>
      <WSTitle
        eyebrow="Sales · Opportunities"
        title="Opportunities · 11-stage pipeline"
        meta="₹ 2.84 Cr total · weighted ₹ 71.4 L"
        right={<><Btn sm kind="ghost">{Icon.filter}</Btn><Btn sm kind="primary">{Icon.plus} New opp</Btn></>}
      />
      <div className="ws-content">
        <KPIRow cols={5}>
          <KPI lbl="Active" v="20" d="across 9 stages" />
          <KPI lbl="Weighted" v="₹ 71.4 L" d="against ₹ 2.84 Cr total" live />
          <KPI lbl="Coverage · 4× quota" v="2.7×" d="qtr · target 4×" dKind="down" />
          <KPI lbl="Win rate · qtr" v="28.6%" d="20 qual / 7 won" />
          <KPI lbl="Median age" v="38 d" d="discovery → close" />
        </KPIRow>

        <div className="kanban">
          {cols.map(c => (
            <div className="col" key={c.id}>
              <div className="col-h">
                <span className="t">{c.t}</span>
                <span className="c">{c.c}</span>
                {c.w > 0 && <span className="c" style={{ color: "var(--ink-3)" }}>· {Math.round(c.w * 100)}%</span>}
              </div>
              {(cards[c.id] || []).map((kard, i) => (
                <div className="kard" key={i}>
                  <div className="ti">{kard.ti}</div>
                  <div className="meta">{kard.v} · {kard.o}</div>
                  <div className="ft">
                    <Chip k={kard.c} >{c.id === "lost" ? "lost" : c.id === "won" ? "won" : c.t.toLowerCase().slice(0, 6)}</Chip>
                  </div>
                </div>
              ))}
              {(cards[c.id] || []).length === 0 && <div className="mono-sm" style={{ color: "var(--ink-4)", padding: "8px 4px" }}>—</div>}
            </div>
          ))}
        </div>

        <Card title="Lost-reason taxonomy · last 90d" eyebrow="conversion debrief">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14 }}>
            {[
              { l: "Price", n: 12, p: 42, ex: "incumbent vendor 8–12% lower" },
              { l: "Lead time", n: 6, p: 21, ex: "needed 4 wk; we quoted 7" },
              { l: "Spec mismatch", n: 4, p: 14, ex: "thicker tip variant" },
              { l: "Internal hold", n: 3, p: 11, ex: "capex deferred" },
              { l: "No decision", n: 2, p: 7, ex: "vendor count locked" },
              { l: "Compliance", n: 1, p: 3, ex: "EU CE markings" },
              { l: "Other", n: 1, p: 3, ex: "—" },
            ].map((r, i) => (
              <div key={i} style={{ padding: 12, border: "1px solid var(--hairline)", borderRadius: 4 }}>
                <div className="row">
                  <span style={{ fontWeight: 600 }}>{r.l}</span>
                  <span style={{ marginLeft: "auto", fontFamily: "var(--mono)", fontSize: 11, color: "var(--ink-3)" }}>{r.n} · {r.p}%</span>
                </div>
                <div className="hbar" style={{ marginTop: 8 }}><span style={{ width: `${r.p}%` }} /></div>
                <div className="mono-sm" style={{ marginTop: 6 }}>{r.ex}</div>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </>
  );
};

// ─────────────────────────────────────────────────────────────
// Internal SOs (5 types)
// ─────────────────────────────────────────────────────────────
const InternalSOs = () => (
  <>
    <WSTitle
      eyebrow="Workflows · Internal SOs"
      title="Internal Sales Orders"
      meta="FOC · Warranty · Trial · Expected PO · Transfer"
      right={<><Btn sm kind="ghost">{Icon.filter}</Btn><Btn sm kind="primary">{Icon.plus} New internal SO</Btn></>}
    />
    <WSTabs tabs={[
      { id: "all", label: "All", count: 18 },
      { id: "foc", label: "FOC supply", count: 4 },
      { id: "war", label: "Warranty", count: 6 },
      { id: "tri", label: "Trial", count: 3 },
      { id: "exp", label: "Expected PO", count: 3 },
      { id: "tr",  label: "Transfer", count: 2 },
    ]} active="all" />

    <div className="ws-content">
      <Banner kind="info" icon={Icon.info} title="Internal SOs do not push to Tally"
              action={<Btn sm kind="ghost">policy</Btn>}>
        <span className="mono-sm">FOC and Trial generate stock issue notes; Warranty cross-references CAR reports; Transfer becomes inter-tenant; Expected PO converts when the PO arrives. None create voucher revenue.</span>
      </Banner>

      <Card flush>
        <table className="tbl">
          <thead><tr>
            <th>Reference</th><th>Type</th><th>Counterparty</th><th>Reason · link</th><th>Owner</th><th className="r">Stock value</th><th>Status</th><th>Created</th><th></th>
          </tr></thead>
          <tbody>
            <tr>
              <td className="mono"><span className="pri">INT-FOC-26-0014</span></td>
              <td><Chip k="plum">FOC</Chip></td>
              <td>Hero MotoCorp · Neemrana</td>
              <td className="mono-sm">demo line · trade show IMTEX</td>
              <td className="mono-sm">Anjali K.</td>
              <td className="r mono">₹ 1,42,000</td>
              <td><Chip k="good">shipped</Chip></td>
              <td className="mono-sm">2 Apr</td>
              <td><Btn sm>view</Btn></td>
            </tr>
            <tr>
              <td className="mono"><span className="pri">INT-WAR-26-0008</span></td>
              <td><Chip k="warn">Warranty</Chip></td>
              <td>JBM Auto · Faridabad</td>
              <td className="mono-sm">CAR/JBM-26-04 · gun cap fatigue</td>
              <td className="mono-sm">Rajesh P.</td>
              <td className="r mono">₹ 28,400</td>
              <td><Chip k="warn">in transit</Chip></td>
              <td className="mono-sm">5 Apr</td>
              <td><Btn sm>view</Btn></td>
            </tr>
            <tr>
              <td className="mono"><span className="pri">INT-TRI-26-0003</span></td>
              <td><Chip k="info">Trial</Chip></td>
              <td>Sona Comstar · Manesar</td>
              <td className="mono-sm">PoC · drive shaft welds</td>
              <td className="mono-sm">V. Suri</td>
              <td className="r mono">₹ 84,000</td>
              <td><Chip>scheduled</Chip></td>
              <td className="mono-sm">8 Apr</td>
              <td><Btn sm>view</Btn></td>
            </tr>
            <tr>
              <td className="mono"><span className="pri">INT-EXP-26-0002</span></td>
              <td><Chip>Expected PO</Chip></td>
              <td>Mahindra CIE · Pune</td>
              <td className="mono-sm">verbal commit · PO ETA 22 Apr</td>
              <td className="mono-sm">Anjali K.</td>
              <td className="r mono">₹ 1,18,000</td>
              <td><Chip k="warn">awaiting PO</Chip></td>
              <td className="mono-sm">10 Apr</td>
              <td><Btn sm>view</Btn></td>
            </tr>
            <tr>
              <td className="mono"><span className="pri">INT-TR-26-0001</span></td>
              <td><Chip k="plum">Transfer</Chip></td>
              <td>OBARA-IN → OBARA-LK</td>
              <td className="mono-sm">stock balancing · Q2 plan</td>
              <td className="mono-sm">Operator</td>
              <td className="r mono">₹ 4,12,000</td>
              <td><Chip k="good">closed</Chip></td>
              <td className="mono-sm">1 Apr</td>
              <td><Btn sm>view</Btn></td>
            </tr>
          </tbody>
        </table>
      </Card>
    </div>
  </>
);

Object.assign(window, {
  TallyMasters, TallyPush, TallyReconcile, EInvoice, CostMargin, Approvals, Leads, Opportunities, InternalSOs,
});
