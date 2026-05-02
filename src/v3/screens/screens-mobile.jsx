// ============================================================
// ANVIL v3 — Mobile companion + system states
// ============================================================

// ─────────────────────────────────────────────────────────────
// Mobile · sign-in
// ─────────────────────────────────────────────────────────────
const MobileSignIn = () => (
  <IOSDevice width={360} height={720}>
    <div style={{ padding: "24px 22px", display: "flex", flexDirection: "column", height: "100%", background: "var(--paper)" }}>
      <div style={{ marginTop: 36 }}>
        <div className="h-eyebrow">Anvil · OBARA-IN</div>
        <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: -0.4, marginTop: 6 }}>Sign in</div>
        <div className="mono-sm" style={{ marginTop: 6 }}>magic link · sso · 2FA</div>
      </div>

      <div style={{ marginTop: 28, display: "flex", flexDirection: "column", gap: 10 }}>
        <button style={{ padding: "12px 14px", border: "1px solid var(--ink)", background: "var(--ink)", color: "var(--paper)", fontFamily: "var(--sans)", fontSize: 14, fontWeight: 600, borderRadius: 4 }}>
          Continue with Google · SSO
        </button>
        <div className="mono-sm" style={{ textAlign: "center", color: "var(--ink-4)" }}>or</div>
        <input placeholder="rajesh@obara.in" style={{
          padding: "12px 14px", border: "1px solid var(--hairline-2)", borderRadius: 4,
          fontFamily: "var(--mono)", fontSize: 13,
        }} />
        <button style={{ padding: "12px 14px", border: "1px solid var(--hairline-2)", background: "var(--paper)", fontFamily: "var(--sans)", fontSize: 14, fontWeight: 600, borderRadius: 4 }}>
          Send magic link
        </button>
      </div>

      <div style={{ marginTop: "auto", fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-4)", textAlign: "center", paddingBottom: 12 }}>
        v3.4.1 · build 2641 · OBARA-IN tenant
      </div>
    </div>
  </IOSDevice>
);

// ─────────────────────────────────────────────────────────────
// Mobile · approvals queue (manager on the road)
// ─────────────────────────────────────────────────────────────
const MobileApprovals = () => (
  <IOSDevice width={360} height={720}>
    <div style={{ height: "100%", background: "var(--paper-2)", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--hairline-2)", background: "var(--paper)", display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ width: 22, height: 22, background: "var(--ink)", color: "var(--paper)", display: "grid", placeItems: "center", borderRadius: 3 }}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M3 6h11l-2 4h6v3H8l-2 4H3l2-4H2V9h4l-3-3Z"/></svg>
        </div>
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, lineHeight: 1 }}>Approvals</div>
          <div className="mono-sm" style={{ fontSize: 9 }}>3 pending · V. Suri</div>
        </div>
        <div style={{ marginLeft: "auto", fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-4)" }}>OBARA-IN</div>
      </div>

      <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8, overflow: "auto" }}>
        {[
          { id: "OIQTHS-26-0021", c: "Voestalpine Specialty", v: "$ 124,500", k: "margin-floor", flag: "8.4%", time: "12m" },
          { id: "OIQTLC-26-1015", c: "Hyderabad Refractories", v: "₹ 18.4 L", k: "new-customer", flag: "NEW", time: "32m" },
          { id: "OIQTLC-26-0998", c: "JBM Auto · Plant 2",    v: "₹ 6.2 L",  k: "amend-delta", flag: "+7.1%", time: "1h" },
        ].map((o, i) => (
          <div key={i} style={{ background: "var(--paper)", border: "1px solid var(--hairline-2)", borderRadius: 5, padding: 11 }}>
            <div className="row">
              <span className="mono" style={{ fontSize: 10, color: "var(--ink-3)" }}>{o.id}</span>
              <span className="mono-sm" style={{ marginLeft: "auto", fontSize: 9 }}>{o.time} ago</span>
            </div>
            <div style={{ fontSize: 13.5, fontWeight: 600, marginTop: 2 }}>{o.c}</div>
            <div className="row" style={{ marginTop: 4 }}>
              <span className="mono" style={{ fontSize: 13, fontWeight: 600 }}>{o.v}</span>
              <Chip k="warn" style={{ marginLeft: "auto" }}>{o.k} · {o.flag}</Chip>
            </div>
            <div className="row" style={{ marginTop: 8, gap: 6 }}>
              <Btn sm kind="ghost" full>{Icon.x} reject</Btn>
              <Btn sm kind="primary" full>{Icon.check} approve</Btn>
            </div>
          </div>
        ))}

        <div className="mono-sm" style={{ textAlign: "center", color: "var(--ink-4)", marginTop: 10 }}>End of queue · pull to refresh</div>
      </div>

      {/* tab bar */}
      <div style={{ marginTop: "auto", borderTop: "1px solid var(--hairline-2)", background: "var(--paper)", display: "grid", gridTemplateColumns: "repeat(4, 1fr)", padding: "6px 0" }}>
        {[
          { i: Icon.shieldCheck, l: "Approvals", a: true },
          { i: Icon.layers,      l: "Orders" },
          { i: Icon.bell,        l: "Alerts" },
          { i: Icon.user,        l: "Me" },
        ].map((t, i) => (
          <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, color: t.a ? "var(--ink)" : "var(--ink-4)" }}>
            <span style={{ display: "inline-flex" }}>{t.i}</span>
            <span style={{ fontSize: 9, fontFamily: "var(--mono)", letterSpacing: 0.04 }}>{t.l}</span>
          </div>
        ))}
      </div>
    </div>
  </IOSDevice>
);

// ─────────────────────────────────────────────────────────────
// Mobile · capture (camera + drop)
// ─────────────────────────────────────────────────────────────
const MobileCapture = () => (
  <IOSDevice width={360} height={720} dark>
    <div style={{ height: "100%", background: "#0c0c0a", color: "#eaeae6", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "12px 16px", display: "flex", alignItems: "center" }}>
        <Btn sm kind="ghost" style={{ color: "#eaeae6", border: "1px solid #2c2c28" }}>{Icon.x}</Btn>
        <div style={{ marginLeft: "auto", fontSize: 12, fontWeight: 600 }}>Capture PO</div>
        <div style={{ marginLeft: "auto" }}><Chip k="live">live</Chip></div>
      </div>

      {/* viewport mock */}
      <div style={{ flex: 1, position: "relative", margin: "0 16px", border: "1.5px solid #3a3a36", borderRadius: 10, overflow: "hidden", background: "#1a1a16" }}>
        {/* paper outline */}
        <div style={{
          position: "absolute", top: "12%", left: "10%", right: "10%", bottom: "20%",
          background: "#f4f3ec", color: "#1a1a16",
          padding: 14, fontFamily: "var(--mono)", fontSize: 8.5, lineHeight: 1.5,
          boxShadow: "0 6px 20px rgba(0,0,0,0.35)",
        }}>
          <div style={{ fontWeight: 700, fontSize: 11 }}>HYDERABAD REFRACTORIES PVT LTD</div>
          <div>GSTIN · 36AAACH1234M1ZQ</div>
          <div style={{ marginTop: 6 }}>PURCHASE ORDER · 2024-7821 · 12 Apr 2026</div>
          <div style={{ marginTop: 8, borderTop: "1px solid #1a1a16", paddingTop: 4 }}>
            <div>1. OBR-TIP-16 · 400 nos · ₹ 280</div>
            <div>2. OBR-CAP-50A · 200 nos · ₹ 1,420</div>
            <div>3. OBR-HOSE-SS · 80 set · ₹ 4,200</div>
            <div>4. OBR-CAL-YR · 1 set · ₹ 18,400</div>
          </div>
          <div style={{ marginTop: 6 }}>delivery · 14 May · CIF Hyd</div>
        </div>
        {/* corner brackets (auto-detected edges) */}
        {[[8, 8], [null, 8, 8], [8, null, null, 8], [null, 8, 8, null]].map((p, i) => (
          <div key={i} style={{
            position: "absolute",
            top: p[0] != null ? p[0] : "auto",
            right: p[1] != null ? p[1] : "auto",
            bottom: p[2] != null ? p[2] : "auto",
            left: p[3] != null ? p[3] : "auto",
            width: 22, height: 22,
            borderTop: i < 2 ? "2px solid var(--accent-2)" : "none",
            borderBottom: i >= 2 ? "2px solid var(--accent-2)" : "none",
            borderLeft: i === 0 || i === 2 ? "2px solid var(--accent-2)" : "none",
            borderRight: i === 1 || i === 3 ? "2px solid var(--accent-2)" : "none",
          }} />
        ))}
        {/* live conf */}
        <div style={{
          position: "absolute", top: 8, left: 8, padding: "2px 6px",
          background: "var(--accent-2)", color: "var(--ink)",
          fontFamily: "var(--mono)", fontSize: 9, fontWeight: 700,
        }}>edge OK · 0.96</div>
      </div>

      {/* meta */}
      <div className="row" style={{ padding: "10px 16px", color: "#9c9c98" }}>
        <span className="mono-sm" style={{ fontSize: 10 }}>tenant · OBARA-IN</span>
        <span className="mono-sm" style={{ fontSize: 10, marginLeft: "auto" }}>uploads/2641 · 4 G</span>
      </div>

      {/* shutter */}
      <div className="row" style={{ padding: "8px 16px 18px", justifyContent: "center", gap: 24 }}>
        <button style={{ width: 38, height: 38, border: "1px solid #3a3a36", borderRadius: 6, background: "transparent", color: "#eaeae6", display: "grid", placeItems: "center" }}>{Icon.upload}</button>
        <button style={{
          width: 64, height: 64, borderRadius: 999, border: "3px solid #eaeae6",
          background: "var(--accent)", color: "var(--ink)", boxShadow: "0 0 0 2px #0c0c0a",
        }}/>
        <button style={{ width: 38, height: 38, border: "1px solid #3a3a36", borderRadius: 6, background: "transparent", color: "#eaeae6", display: "grid", placeItems: "center" }}>{Icon.cycle}</button>
      </div>
    </div>
  </IOSDevice>
);

// ─────────────────────────────────────────────────────────────
// Mobile · order detail (read + sign-off)
// ─────────────────────────────────────────────────────────────
const MobileOrderDetail = () => (
  <IOSDevice width={360} height={720}>
    <div style={{ height: "100%", background: "var(--paper-2)", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--hairline-2)", background: "var(--paper)", display: "flex", alignItems: "center", gap: 8 }}>
        <Btn sm kind="ghost">{Icon.arrowL}</Btn>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>OIQTHS-26-0021</div>
          <div className="mono-sm" style={{ fontSize: 9 }}>Voestalpine Specialty · USD</div>
        </div>
        <Chip k="warn" style={{ marginLeft: "auto" }}>L2 pending</Chip>
      </div>

      <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10, overflow: "auto" }}>
        {/* margin cockpit · compact */}
        <Card title="Margin · 8.4%" eyebrow="below floor 10%" style={{ borderColor: "var(--rust)" }}>
          <div className="row" style={{ alignItems: "flex-end", gap: 6 }}>
            <span className="mono" style={{ fontSize: 26, fontWeight: 700, color: "var(--rust)" }}>8.4%</span>
            <span className="mono-sm" style={{ marginBottom: 4 }}>vs 10% floor · −1.6 pts</span>
          </div>
          <div style={{ height: 6, background: "var(--paper-3)", borderRadius: 3, marginTop: 10, position: "relative" }}>
            <div style={{ position: "absolute", left: "60%", top: -2, bottom: -2, width: 1, background: "var(--ink)" }} />
            <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: "50%", background: "var(--rust)", borderRadius: 3 }} />
          </div>
          <div className="row mono-sm" style={{ marginTop: 6 }}>
            <span>floor 10%</span><span style={{ marginLeft: "auto" }}>target 18%</span>
          </div>
        </Card>

        {/* Why */}
        <Card title="Why margin breached" eyebrow="auto · 3 drivers">
          <div className="mono-sm" style={{ lineHeight: 1.6 }}>
            <Dot k="bad" /> EUR/INR forward 30d worse by <b>+1.8%</b><br />
            <Dot k="warn" /> Customer requested <b>30% discount</b> on PCB-VLT line<br />
            <Dot k="warn" /> Air freight quote <b>+ €420</b> over standard sea
          </div>
        </Card>

        {/* lines */}
        <Card title="3 line items" flush>
          {[
            ["OBR-PCB-VLT", "8 · €1,420", "good"],
            ["OBR-WG-2024", "1 · €4,800", "good"],
            ["FREIGHT · air", "1 · €420", "warn"],
          ].map((r, i) => (
            <div key={i} style={{ padding: "8px 12px", borderTop: i ? "1px solid var(--hairline)" : "none", display: "flex", alignItems: "center", gap: 8 }}>
              <span className="mono" style={{ fontSize: 11.5, flex: 1 }}>{r[0]}</span>
              <span className="mono-sm">{r[1]}</span>
              <Dot k={r[2]} />
            </div>
          ))}
        </Card>

        {/* approver actions */}
        <div className="row" style={{ gap: 6, marginTop: 4 }}>
          <Btn kind="ghost" full>{Icon.send} comment</Btn>
          <Btn kind="danger" full>{Icon.x} reject</Btn>
          <Btn kind="primary" full>{Icon.check} approve · 24h</Btn>
        </div>
      </div>
    </div>
  </IOSDevice>
);

// ─────────────────────────────────────────────────────────────
// State · empty
// ─────────────────────────────────────────────────────────────
const StateEmpty = () => (
  <>
    <WSTitle eyebrow="Workflows · Sales Orders" title="Sales Orders" meta="0 orders · empty workspace" />
    <div className="ws-content" style={{ display: "grid", placeItems: "center", padding: "80px 0" }}>
      <div style={{ maxWidth: 480, textAlign: "center" }}>
        <div style={{ display: "inline-grid", placeItems: "center", width: 56, height: 56, border: "1.5px dashed var(--hairline-3)", borderRadius: 6, color: "var(--ink-3)" }}>
          {Icon.layers}
        </div>
        <div style={{ fontSize: 18, fontWeight: 600, marginTop: 16 }}>No sales orders yet</div>
        <div className="mono-sm" style={{ marginTop: 8, color: "var(--ink-3)", lineHeight: 1.6 }}>
          Drop a customer PO into the Inbox, or paste from email at <span className="mono">orders@obara.in</span>.
          Anvil will preflight, extract, validate against masters, and queue for your sign-off — usually under
          2 minutes for a 4-line PO.
        </div>
        <div className="row" style={{ justifyContent: "center", gap: 8, marginTop: 18 }}>
          <Btn kind="ghost">{Icon.upload} drop a PO</Btn>
          <Btn kind="primary">{Icon.plus} new sales order</Btn>
        </div>
        <div className="mono-sm" style={{ marginTop: 22, color: "var(--ink-4)" }}>
          or · {Icon.send} forward an email · {Icon.cycle} import from Tally voucher
        </div>
      </div>
    </div>
  </>
);

// ─────────────────────────────────────────────────────────────
// State · system error · Tally bridge down
// ─────────────────────────────────────────────────────────────
const StateError = () => (
  <>
    <WSTitle eyebrow="Workflows · My Day" title="System status · degraded" meta="Tally bridge offline since 11:32 IST" />
    <div className="ws-content">
      <Banner kind="bad" icon={Icon.alert} title="Tally bridge offline · 1h 12m"
              action={<><Btn sm kind="ghost">{Icon.history} status page</Btn><Btn sm kind="danger">{Icon.cycle} retry</Btn></>}>
        <span className="mono-sm">
          Connection refused at <span className="mono">tcp://obara-tally.local:9000</span>.
          Last successful heartbeat at <b>11:32 IST</b>. Vouchers will queue locally and replay automatically once the bridge is back.
        </span>
      </Banner>

      <KPIRow cols={4}>
        <KPI lbl="Pushes queued" v="14" d="held locally · safe" />
        <KPI lbl="Last successful push" v="11:31 IST" d="OIQTLC-26-1014" />
        <KPI lbl="Read paths" v="OK" d="masters cached · 4h" />
        <KPI lbl="Customer-facing" v="OK" d="extract + validate up" />
      </KPIRow>

      <Card title="What's still working" eyebrow="green-path">
        <div className="mono-sm" style={{ lineHeight: 1.7 }}>
          <Dot k="good" /> Inbox / capture / extract / validate / approval — all online<br />
          <Dot k="good" /> e-Invoice queue — held but not blocked<br />
          <Dot k="good" /> Reads against cached Tally masters (last refresh 11:30) — fully usable<br />
          <Dot k="warn" /> Voucher push to Tally — <b>queued locally</b>, will replay in order<br />
          <Dot k="warn" /> Reconciliation grid — last block stale; will refresh on bridge recovery
        </div>
      </Card>

      <Card title="Recent bridge events" flush>
        <table className="tbl">
          <thead><tr><th>Time</th><th>Event</th><th>Detail</th></tr></thead>
          <tbody>
            <tr><td className="mono">12:44</td><td><Chip k="bad">CONN_REFUSED</Chip></td><td className="mono-sm">retry #18 · backoff 32s</td></tr>
            <tr><td className="mono">12:14</td><td><Chip k="bad">CONN_REFUSED</Chip></td><td className="mono-sm">retry #12 · backoff 16s</td></tr>
            <tr><td className="mono">11:32</td><td><Chip k="warn">DISCONNECT</Chip></td><td className="mono-sm">last successful heartbeat</td></tr>
            <tr><td className="mono">11:31</td><td><Chip k="good">PUSH_OK</Chip></td><td className="mono-sm">SO/SPARES/HRP-2640 · ack 8af2c1…</td></tr>
          </tbody>
        </table>
      </Card>
    </div>
  </>
);

// ─────────────────────────────────────────────────────────────
// State · offline · local queue (dark)
// ─────────────────────────────────────────────────────────────
const StateOffline = () => (
  <>
    <WSTitle eyebrow="Workflows · Sales Orders" title="You're offline · local queue" meta="3 drafts cached · auto-sync on reconnect" />
    <div className="ws-content">
      <Banner kind="info" icon={Icon.globe} title="Offline mode active"
              action={<Btn sm kind="ghost">{Icon.cycle} retry now</Btn>}>
        <span className="mono-sm">
          Anvil PWA detected no connectivity. Edits are stored encrypted on this device and will sync once the network is back. No
          server pushes will fire until then.
        </span>
      </Banner>

      <Card title="Local queue · 3 drafts" flush>
        <table className="tbl">
          <thead><tr><th>Draft</th><th>Customer</th><th>Status</th><th>Stored</th><th>Will push</th></tr></thead>
          <tbody>
            <tr><td className="mono"><span className="pri">offline-d-2641</span></td><td>JBM Auto · Plant 2</td><td><Chip>extracted · 4 lines</Chip></td><td className="mono-sm">12:38 · 4.2 KB</td><td className="mono-sm">on reconnect</td></tr>
            <tr><td className="mono"><span className="pri">offline-d-2640</span></td><td>RSWM Bhilwara</td><td><Chip k="warn">awaiting masters</Chip></td><td className="mono-sm">12:14 · 3.1 KB</td><td className="mono-sm">on reconnect + sync</td></tr>
            <tr><td className="mono"><span className="pri">offline-d-2639</span></td><td>Hyderabad Refractories</td><td><Chip k="info">approved · L1</Chip></td><td className="mono-sm">11:48 · 5.8 KB</td><td className="mono-sm">on reconnect</td></tr>
          </tbody>
        </table>
      </Card>

      <Card title="Cached for offline use" eyebrow="last refresh 12:14 IST · 28m ago">
        <div className="mono-sm" style={{ lineHeight: 1.7 }}>
          <Dot k="good" /> Customer master · 84 records<br />
          <Dot k="good" /> Item master · 1,284 records<br />
          <Dot k="good" /> UoM aliases · 62<br />
          <Dot k="good" /> Profile cache · HR-spares-v3 · MGM-spares-v2<br />
          <Dot k="warn" /> FX rates · stale (last 04:00 UTC) · will refresh on reconnect
        </div>
      </Card>
    </div>
  </>
);

Object.assign(window, { MobileSignIn, MobileApprovals, MobileCapture, MobileOrderDetail, StateEmpty, StateError, StateOffline });
