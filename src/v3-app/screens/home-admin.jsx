import React, { useEffect, useState } from "react";
import { Banner, Btn, Card, Chip, Dot, KPI, KPIRow, Sev, Stream, WSTitle } from "../lib/primitives.jsx";
import { Icon } from "../lib/icons.jsx";

// ============================================================
// ANVIL v3 — Role homes ("My Day")
// ============================================================

// Sales Engineer — intake-led
const HomeEngineer = () => (
  <>
    <WSTitle
      eyebrow="08:42 IST · Tuesday"
      title="Good morning, Rajesh."
      meta="3 SOs in flight · 2 awaiting your action"
      right={<>
        <Btn icon kind="ghost" sm>{Icon.filter}</Btn>
        <Btn kind="primary" sm>{Icon.plus} New SO</Btn>
      </>}
    />

    <div className="ws-content">
      {/* Triage banner */}
      <Banner kind="live" icon={Icon.bolt} title="2 documents waiting on you · oldest 14 min"
              action={<><Btn sm kind="ghost">Snooze all</Btn><Btn sm kind="live">Open queue</Btn></>}>
        <span className="mono-sm">PO from Hyderabad Refractories · 4 line items · OCR confidence 0.91 · ready for extraction.</span>
      </Banner>

      <KPIRow cols={4}>
        <KPI lbl="My queue" v="7" d="2 stale ≥ 24h" dKind="down" live />
        <KPI lbl="Drafts" v="3" d="auto-saved 12:42 IST" />
        <KPI lbl="In approval" v="2" d="V. Suri · 1 expires 18:00" dKind="down" />
        <KPI lbl="Pushed today" v="₹ 12.4 L" d="4 SOs · last 11:08" dKind="up" />
      </KPIRow>

      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 14 }}>
        {/* My Queue */}
        <Card flush>
          <div style={{ padding: "12px 16px", display: "flex", alignItems: "center", gap: 10, borderBottom: "1px solid var(--hairline-2)" }}>
            <span className="h2">My Queue</span>
            <Chip k="live" lg>7 items</Chip>
            <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
              <Chip k="ghost">all</Chip>
              <Chip>spares</Chip>
              <Chip>projects</Chip>
              <Chip>internal</Chip>
            </div>
          </div>
          <table className="tbl">
            <thead><tr>
              <th style={{ width: 22 }}></th>
              <th>Reference</th>
              <th>Customer</th>
              <th>Stage</th>
              <th className="r">Value</th>
              <th className="r">Age</th>
              <th style={{ width: 80 }}></th>
            </tr></thead>
            <tbody>
              {[
                { sev: "high", ref: "PO/HRP/24-7821", cust: "Hyderabad Refractories", stage: "extract", st: "warn", val: "₹ 4,82,400", age: "14m", live: true },
                { sev: "med",  ref: "PO/MGML/HAL-991",  cust: "MG Motor · Halol",     stage: "validate", st: "warn", val: "₹ 8,21,100", age: "1h" },
                { sev: "high", ref: "PO/VST-IND/0021",  cust: "Voestalpine Spec.",     stage: "approval", st: "bad", val: "$ 124,500",  age: "3h" },
                { sev: "low",  ref: "QU/JBM/HSP-3382",  cust: "JBM Auto",              stage: "tally", st: "info", val: "₹ 1,15,200", age: "5h" },
                { sev: "low",  ref: "PO/POSCO/IM-441",  cust: "POSCO Maharashtra",     stage: "intake", st: "info", val: "₹ 2,98,000", age: "1d" },
                { sev: "med",  ref: "PO/RSWM/JOD-09",   cust: "RSWM · Jodhpur",        stage: "validate", st: "warn", val: "₹ 87,400",   age: "2d 3h" },
                { sev: "low",  ref: "QU/STEL/SLM-8821", cust: "Steel Authority",       stage: "intake", st: "info", val: "₹ 12,40,000", age: "2d 6h" },
              ].map((r, i) => (
                <tr key={i} className={r.live ? "row-live" : ""}>
                  <td><Sev k={r.sev} /></td>
                  <td className="mono"><span className="pri">{r.ref}</span></td>
                  <td>{r.cust}</td>
                  <td><Chip k={r.st}>{r.stage}</Chip></td>
                  <td className="r mono">{r.val}</td>
                  <td className="r mono" style={{ color: r.age.includes("d") ? "var(--rust)" : "var(--ink-3)" }}>{r.age}</td>
                  <td><Btn sm>open {Icon.arrowR}</Btn></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        {/* Side column */}
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Card title="What's blocking you" eyebrow="3 blockers">
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div className="finding high">
                <div style={{ flex: 1 }}>
                  <div className="ti">Voestalpine Spec. · margin 9.2% (floor 10%)</div>
                  <div className="mono-sm">Approver V. Suri pending · expires 18:00 IST</div>
                </div>
                <Btn sm>nudge</Btn>
              </div>
              <div className="finding med">
                <div style={{ flex: 1 }}>
                  <div className="ti">MG Motor Halol · GSTIN mismatch (24/27)</div>
                  <div className="mono-sm">Multi-GSTIN customer · choose location</div>
                </div>
                <Btn sm>resolve</Btn>
              </div>
              <div className="finding low">
                <div style={{ flex: 1 }}>
                  <div className="ti">RSWM · 2 days idle in validation</div>
                  <div className="mono-sm">Auto-snoozed Friday EOD</div>
                </div>
                <Btn sm>resume</Btn>
              </div>
            </div>
          </Card>

          <Card title="Live activity" eyebrow="last 30m"
                right={<Btn sm kind="ghost">{Icon.history} log</Btn>}>
            <Stream rows={[
              { t: "12:42", a: "TALLY", m: "OIQTLC-26-1011 voucher <b>posted</b> · ₹ 4,82,400" },
              { t: "12:38", a: "OCR",   m: "PO/HRP/24-7821 extracted · 4 lines · conf <b>0.91</b>" },
              { t: "12:31", a: "CLAUD", m: "Sonnet routed for OIQTHS-26-0021 · cost <b>₹ 18.4</b>" },
              { t: "12:28", a: "FX",    m: "USD/INR 83.42 · forward 30d 83.71" },
              { t: "12:14", a: "EVAL",  m: "Suite <b>spares-extract</b> · pass 47/50" },
              { t: "12:02", a: "AUTH",  m: "V. Suri · approver session · expires 18:00" },
            ]} />
          </Card>
        </div>
      </div>

      <Card title="Pulse · last 7 days" eyebrow="ops health">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 0, alignItems: "end", height: 80, padding: "0 6px" }}>
          {[14, 22, 18, 27, 31, 19, 34].map((v, i) => (
            <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, height: "100%" }}>
              <div style={{ flex: 1, display: "flex", alignItems: "flex-end", width: "100%", justifyContent: "center" }}>
                <div style={{ width: 28, height: `${v * 2}px`, background: i === 6 ? "var(--accent)" : "var(--ink)" }} />
              </div>
              <span className="mono-sm" style={{ fontSize: 10, color: "var(--ink-4)" }}>
                {["mon","tue","wed","thu","fri","sat","tod"][i]}
              </span>
              <span className="mono-sm" style={{ fontSize: 10, fontWeight: 600, color: "var(--ink)" }}>{v}</span>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 18, marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--hairline-2)" }}>
          <span className="mono-sm">7d push throughput · <b style={{ color: "var(--ink)" }}>165</b> SOs · <span style={{ color: "var(--sage)" }}>+18%</span></span>
          <span className="mono-sm">Median cycle · <b style={{ color: "var(--ink)" }}>2h 14m</b> intake → push</span>
          <span className="mono-sm">First-pass pass rate · <b style={{ color: "var(--ink)" }}>78%</b></span>
        </div>
      </Card>
    </div>
  </>
);

// Sales Manager — approvals + margin cockpit
const HomeManager = () => (
  <>
    <WSTitle
      eyebrow="08:42 IST · Tuesday · Manager view"
      title="Approval queue clear by 18:00."
      meta="3 awaiting your decision · 1 expires in 5h 18m"
      right={<>
        <Btn sm kind="ghost">{Icon.download} export</Btn>
        <Btn sm kind="primary">{Icon.shieldCheck} bulk approve eligible</Btn>
      </>}
    />

    <div className="ws-content">
      <KPIRow cols={5}>
        <KPI lbl="Awaiting me" v="3" d="₹ 24.7 L exposure" live />
        <KPI lbl="Avg margin · MTD" v="22.4%" d="floor 10% · ceiling 35%" dKind="up" />
        <KPI lbl="Floor breaches" v="2" d="this week · both PROJECT_HSS" dKind="down" />
        <KPI lbl="Pipeline · qualified+" v="₹ 1.42 Cr" d="11 opps · 4 stages" />
        <KPI lbl="Eval drift" v="0.07" d="↑ from 0.04 · within band" />
      </KPIRow>

      <Card flush>
        <div style={{ padding: "12px 16px", display: "flex", alignItems: "center", gap: 10, borderBottom: "1px solid var(--hairline-2)" }}>
          <span className="h2">Approval queue</span>
          <Chip k="warn" lg>1 expires 18:00</Chip>
          <div style={{ marginLeft: "auto" }}>
            <span className="mono-sm">policy: margin&lt;floor · qty&gt;contract · NEW_CUST · USD&gt;10k</span>
          </div>
        </div>
        <table className="tbl">
          <thead><tr>
            <th>Order</th>
            <th>Customer</th>
            <th>Mode</th>
            <th>Why</th>
            <th className="r">Value</th>
            <th className="r">Margin</th>
            <th className="r">Expires</th>
            <th></th>
          </tr></thead>
          <tbody>
            <tr className="row-flag">
              <td className="mono"><span className="pri">OIQTHS-26-0021</span></td>
              <td>Voestalpine Specialty Tubes</td>
              <td><Chip k="info">PROJECT_HSS</Chip></td>
              <td>
                <div className="mono-sm" style={{ color: "var(--rust-2)", fontWeight: 600 }}>margin 9.2% &lt; 10% floor</div>
                <div className="mono-sm">+ NEW_CUST · USD 124,500 &gt; 10k</div>
              </td>
              <td className="r mono">$ 124,500</td>
              <td className="r mono" style={{ color: "var(--rust)", fontWeight: 600 }}>9.2%</td>
              <td className="r mono" style={{ color: "var(--rust)", fontWeight: 600 }}>5h 18m</td>
              <td><div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}><Btn sm>review</Btn><Btn sm kind="primary">approve</Btn></div></td>
            </tr>
            <tr className="row-warn">
              <td className="mono"><span className="pri">OIQTLC-26-1018</span></td>
              <td>JBM Auto · Faridabad</td>
              <td><Chip>SPARES_ASSEMBLY</Chip></td>
              <td><div className="mono-sm">qty 480 &gt; contract 200</div></td>
              <td className="r mono">₹ 9,80,000</td>
              <td className="r mono">31.4%</td>
              <td className="r mono">2d 4h</td>
              <td><div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}><Btn sm>review</Btn><Btn sm kind="primary">approve</Btn></div></td>
            </tr>
            <tr>
              <td className="mono"><span className="pri">OIQTLC-26-1015</span></td>
              <td>Hyderabad Refractories</td>
              <td><Chip>SPARES</Chip></td>
              <td><div className="mono-sm">margin 28% &gt; 25% delegate cap</div></td>
              <td className="r mono">₹ 4,82,400</td>
              <td className="r mono">28.0%</td>
              <td className="r mono">3d</td>
              <td><div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}><Btn sm>review</Btn><Btn sm kind="primary">approve</Btn></div></td>
            </tr>
          </tbody>
        </table>
      </Card>

      <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: 14 }}>
        <Card title="Margin cockpit · MTD" eyebrow="₹ ledger"
              right={<Btn sm kind="ghost">{Icon.ext} cost & margin</Btn>}>
          {/* fake bars showing SO margin distribution */}
          <div style={{ height: 130, display: "flex", alignItems: "flex-end", gap: 2, padding: "10px 0", borderBottom: "1px solid var(--hairline-2)" }}>
            {[18,22,17,28,31,9,12,24,30,21,33,28,29,22,18,15,33,25,22,12,21,28,31,17,9,24,28,30,22,18].map((v, i) => (
              <div key={i} style={{
                flex: 1, height: `${v * 3}px`,
                background: v < 10 ? "var(--rust)" : v < 15 ? "var(--amber)" : "var(--ink)",
                position: "relative",
              }} />
            ))}
          </div>
          <div style={{ display: "flex", gap: 14, marginTop: 10, fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--ink-3)" }}>
            <span><span className="dot" style={{ background: "var(--rust)" }} /> below floor · 2</span>
            <span><span className="dot" style={{ background: "var(--amber)" }} /> below target · 4</span>
            <span><span className="dot" style={{ background: "var(--ink)" }} /> healthy · 24</span>
            <span style={{ marginLeft: "auto" }}>median 22.1% · σ 6.3</span>
          </div>
          <div className="divider" />
          <div className="mono-sm">
            Project margin band shifted <b style={{ color: "var(--rust)" }}>−2.1pp</b> w/w driven by yen-led FX on
            two PROJECT_HSS orders. <a style={{ color: "var(--ink)", textDecoration: "underline", cursor: "pointer" }}>Open simulator →</a>
          </div>
        </Card>

        <Card title="Pipeline · Opportunities" eyebrow="weighted ₹ 71.4 L"
              right={<Btn sm kind="ghost">{Icon.ext} pipeline</Btn>}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {[
              { s: "Discovery",      n: 4, w: 0.10, v: "₹ 24 L", ww: "₹ 2.4 L" },
              { s: "Demo",           n: 3, w: 0.25, v: "₹ 38 L", ww: "₹ 9.5 L" },
              { s: "PoC",            n: 2, w: 0.40, v: "₹ 22 L", ww: "₹ 8.8 L" },
              { s: "Quote",          n: 5, w: 0.55, v: "₹ 64 L", ww: "₹ 35.2 L" },
              { s: "Negotiation",    n: 2, w: 0.70, v: "₹ 22 L", ww: "₹ 15.4 L" },
              { s: "Won (MTD)",      n: 4, w: 1.00, v: "₹ 12 L", ww: "₹ 12 L", k: "good" },
            ].map(r => (
              <div key={r.s} style={{ display: "grid", gridTemplateColumns: "120px 1fr 70px 80px", gap: 10, alignItems: "center" }}>
                <div style={{ fontSize: 11.5, fontWeight: 500 }}>{r.s} <span className="mono-sm">· {r.n}</span></div>
                <div className={`hbar ${r.k === "good" ? "live" : ""}`}><span style={{ width: `${r.w * 100}%` }} /></div>
                <div className="mono-sm" style={{ textAlign: "right" }}>{r.v}</div>
                <div className="mono" style={{ textAlign: "right", fontSize: 11, fontWeight: 600 }}>{r.ww}</div>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  </>
);

// Admin — system health
const HomeAdmin = () => (
  <>
    <WSTitle
      eyebrow="08:42 IST · System Operations"
      title="System nominal · 1 advisory."
      meta="6 tenants · 47 active members · 12.4k requests last 24h"
      right={<>
        <Btn sm kind="ghost">{Icon.download} backup now</Btn>
        <Btn sm kind="primary">{Icon.settings} admin center</Btn>
      </>}
    />
    <div className="ws-content">
      <Banner kind="warn" icon={Icon.alert} title="Eval suite drift · spares-extract"
              action={<Btn sm>{Icon.brain} open eval</Btn>}>
        <span className="mono-sm">Field <b>uom_canonical</b> accuracy fell from 0.96 → 0.91 over 14 days. Profile drift <b>0.07</b> against baseline. Suggested: re-tune `unit_aliases` for Hyderabad Refractories.</span>
      </Banner>

      <KPIRow cols={6}>
        <KPI lbl="Tally bridge" v="online" d="last sync 8s ago" live />
        <KPI lbl="ClamAV" v="OK" d="defs 2026-04-29" />
        <KPI lbl="DB · pgbouncer" v="42 / 200" d="conn pool" />
        <KPI lbl="Mistral OCR" v="0.94" d="avg conf · 24h" />
        <KPI lbl="Claude routing" v="₹ 11.40" d="median ₹/SO · 24h" dKind="up" />
        <KPI lbl="FX freshness" v="9h 12m" d="next cron 04:00 UTC" />
      </KPIRow>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <Card title="Tenants" eyebrow="6 active" right={<Btn sm kind="ghost">{Icon.plus} provision</Btn>}>
          <table className="tbl">
            <thead><tr><th>Code</th><th>Members</th><th className="r">SOs · 7d</th><th className="r">Eval</th><th></th></tr></thead>
            <tbody>
              {[
                ["OBARA-IN", "31", "165", "0.94", "ok"],
                ["OBARA-LK", "8", "22", "0.91", "ok"],
                ["OBARA-NP", "4", "9", "0.89", "warn"],
                ["OBARA-MX", "2", "0", "—", "muted"],
                ["DEMO-SBX", "2", "—", "—", "muted"],
              ].map((r, i) => (
                <tr key={i}>
                  <td className="mono"><span className="pri">{r[0]}</span></td>
                  <td>{r[1]}</td>
                  <td className="r mono">{r[2]}</td>
                  <td className="r mono">{r[3]}</td>
                  <td><Chip k={r[4] === "ok" ? "good" : r[4] === "warn" ? "warn" : "ghost"}>{r[4]}</Chip></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <Card title="Cron & schedules" eyebrow="vercel.json">
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {[
              { t: "FX rates · Frankfurter", s: "0 4 * * * UTC", l: "12h ago · OK", k: "good" },
              { t: "AMC schedule generator", s: "0 6 * * * IST", l: "2h ago · 14 visits queued", k: "good" },
              { t: "Audit pack export", s: "0 2 * * 1 UTC", l: "Mon · OK · 18 MB", k: "good" },
              { t: "Eval suite · spares-extract", s: "0 */6 * * *", l: "30m ago · drift 0.07", k: "warn" },
              { t: "Backup · supabase pgdump", s: "0 1 * * * UTC", l: "11h ago · 412 MB", k: "good" },
            ].map((r, i) => (
              <div key={i} style={{ display: "flex", gap: 10, alignItems: "center", padding: "8px 10px", border: "1px solid var(--hairline)", borderRadius: 4 }}>
                <Dot k={r.k === "good" ? "good" : "warn"} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, fontWeight: 600 }}>{r.t}</div>
                  <div className="mono-sm">{r.l}</div>
                </div>
                <span className="mono-sm">{r.s}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card title="Model routing log · last 24h" eyebrow="claude-haiku/sonnet/opus"
            right={<Btn sm kind="ghost">{Icon.ext} routing settings</Btn>}>
        <table className="tbl">
          <thead><tr>
            <th>Time</th><th>Order</th><th>Stage</th><th>Picked</th><th className="r">Conf</th><th className="r">Tokens</th><th className="r">Cost ₹</th><th>Fallback</th>
          </tr></thead>
          <tbody>
            {[
              ["12:42", "OIQTLC-26-1015", "preflight", "haiku-4.5", "0.96", "1.4k", "₹ 1.20", "—"],
              ["12:31", "OIQTHS-26-0021", "extraction", "sonnet-4.5", "0.88", "12.1k", "₹ 18.40", "—"],
              ["12:18", "OIQTHS-26-0021", "validation", "opus-4", "0.91", "8.2k", "₹ 41.20", "↑ from sonnet (conf 0.71)"],
              ["12:09", "OIQTLC-26-1011", "extraction", "sonnet-4.5", "0.92", "9.8k", "₹ 14.10", "—"],
              ["11:58", "OIQTLC-26-1011", "preflight", "haiku-4.5", "0.97", "1.2k", "₹ 0.92", "—"],
              ["11:42", "QU/STEL/SLM-8821", "extraction", "haiku-4.5", "0.94", "1.8k", "₹ 1.41", "cache · profile match"],
            ].map((r, i) => (
              <tr key={i}>
                <td className="mono">{r[0]}</td>
                <td className="mono"><span className="pri">{r[1]}</span></td>
                <td>{r[2]}</td>
                <td className="mono">{r[3]}</td>
                <td className="r mono">{r[4]}</td>
                <td className="r mono">{r[5]}</td>
                <td className="r mono">{r[6]}</td>
                <td className="mono-sm" style={{ color: r[7].includes("↑") ? "var(--amber-2)" : "var(--ink-3)" }}>{r[7]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  </>
);


export default HomeAdmin;
