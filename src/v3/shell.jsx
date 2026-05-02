// ============================================================
// ANVIL v3 — Application Shell
// ============================================================

const NAV = [
  {
    label: "Workflows",
    items: [
      { id: "home", label: "My Day", icon: Icon.bolt },
      { id: "intake", label: "Inbox", icon: Icon.inbox, badge: { v: "12", k: "live" } },
      { id: "so", label: "Sales Orders", icon: Icon.layers, badge: { v: "47" } },
      { id: "internal", label: "Internal SOs", icon: Icon.cycle },
      { id: "approvals", label: "Approvals", icon: Icon.shieldCheck, badge: { v: "3", k: "warn" } },
    ],
  },
  {
    label: "Sales",
    items: [
      { id: "leads", label: "Leads", icon: Icon.flame },
      { id: "opps", label: "Opportunities", icon: Icon.signal },
      { id: "projects", label: "Projects", icon: Icon.briefcase },
      { id: "shipments", label: "Shipments", icon: Icon.truck },
    ],
  },
  {
    label: "Procurement",
    items: [
      { id: "spo", label: "Source POs", icon: Icon.pkg },
      { id: "spares", label: "Spares Matrix", icon: Icon.layers },
    ],
  },
  {
    label: "Service",
    items: [
      { id: "svc-visits", label: "Service Visits", icon: Icon.wrench },
      { id: "amc", label: "AMC Schedule", icon: Icon.cal },
      { id: "car", label: "CAR Reports", icon: Icon.flag },
    ],
  },
  {
    label: "Finance",
    items: [
      { id: "tally", label: "Tally Sync", icon: Icon.ledger },
      { id: "einvoice", label: "e-Invoice", icon: Icon.doc },
      { id: "cost", label: "Cost & Margin", icon: Icon.cash },
    ],
  },
  {
    label: "Data",
    items: [
      { id: "customers", label: "Customers", icon: Icon.users },
      { id: "items", label: "Item Master", icon: Icon.tag },
      { id: "graph", label: "Master Data Graph", icon: Icon.graph },
      { id: "forecasts", label: "Forecasts", icon: Icon.signal },
    ],
  },
  {
    label: "Quality",
    items: [
      { id: "evals", label: "Eval Suites", icon: Icon.brain },
      { id: "studio", label: "Profile Studio", icon: Icon.diff },
      { id: "anomaly", label: "Anomaly Compute", icon: Icon.alert },
      { id: "duplicates", label: "Duplicates", icon: Icon.layers },
    ],
  },
  {
    label: "Comms & Security",
    items: [
      { id: "comms", label: "Communications", icon: Icon.send },
      { id: "email", label: "Email Triage", icon: Icon.inbox },
      { id: "security", label: "Security", icon: Icon.shield },
    ],
  },
  {
    label: "Admin",
    items: [
      { id: "audit", label: "Audit", icon: Icon.history },
      { id: "admin", label: "Admin Center", icon: Icon.settings },
    ],
  },
];

const ROLES = [
  { id: "engineer", label: "Sales Engineer", short: "ENG" },
  { id: "manager",  label: "Sales Manager",  short: "MGR" },
  { id: "approver", label: "Approver",       short: "APR" },
  { id: "admin",    label: "Admin",          short: "ADM" },
  { id: "operator", label: "Operator",       short: "OPS" },
  { id: "finance",  label: "Finance",        short: "FIN" },
  { id: "viewer",   label: "Viewer",         short: "VWR" },
];

// ─────────────────────────────────────────────────────────────
// Shell: header + sidebar + main + dock
// ─────────────────────────────────────────────────────────────
const Shell = ({
  children, route, onRoute,
  role, onRole, tenant, onTenant,
  onCmdK, onThread,
  crumb, nav,
}) => {
  // Allow callers to pass a filtered nav (e.g. RBAC scoping). Fall back to
  // the in-file NAV constant if no prop is provided.
  const navTree = nav || NAV;
  return (
    <div className="app">
      <header className="app-head">
        <div className="brand">
          <div className="brand-mark">
            {/* anvil mark — angular wedge */}
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" stroke="none">
              <path d="M3 6h11l-2 4h6v3H8l-2 4H3l2-4H2V9h4l-3-3Z"/>
            </svg>
          </div>
          <span className="name">Anvil</span>
        </div>

        <div className="crumb">
          {crumb?.map((c, i) => (
            <React.Fragment key={i}>
              {i > 0 && <span className="crumb-sep">/</span>}
              {i === crumb.length - 1 ? <b>{c}</b> : <span>{c}</span>}
            </React.Fragment>
          ))}
        </div>

        <div className="head-search" onClick={onCmdK}>
          {Icon.search}
          <span>Search orders, customers, items, jobs…</span>
          <kbd>⌘K</kbd>
        </div>

        <div className="head-pill tenant" onClick={onTenant} title="Switch tenant">
          <Dot k="live" />
          {tenant?.code || "OBARA-IN"}
          {Icon.caret}
        </div>

        <div className="head-pill role" onClick={onRole} title="Switch role">
          <span style={{ fontFamily: "var(--mono)", color: "var(--ink-3)" }}>{role?.short || "ENG"}</span>
          <span style={{ borderLeft: "1px solid var(--hairline)", paddingLeft: 8, marginLeft: 2 }}>{role?.label || "Sales Engineer"}</span>
          {Icon.caret}
        </div>

        <button className="head-pill" title="Thread drawer" onClick={onThread}>
          {Icon.history} Thread
        </button>

        <button className="head-pill" title="Notifications" style={{ position: "relative" }}>
          {Icon.bell}
          <span style={{
            position: "absolute", top: 2, right: 4,
            width: 6, height: 6, borderRadius: 999, background: "var(--rust)",
          }} />
        </button>
      </header>

      <aside className="app-side">
        <nav className="nav">
          {navTree.map(group => (
            <div className="nav-section" key={group.label}>
              <div className="nav-section-label">{group.label}</div>
              {group.items.map(item => (
                <div
                  key={item.id}
                  className={`nav-item ${route === item.id ? "active" : ""}`}
                  onClick={() => onRoute?.(item.id)}
                >
                  <span className="nav-icon">{item.icon}</span>
                  <span className="nav-label">{item.label}</span>
                  {item.badge && (
                    <span className={`nav-badge ${item.badge.k || ""}`}>{item.badge.v}</span>
                  )}
                </div>
              ))}
            </div>
          ))}
        </nav>
        <div className="side-foot">
          <div className="av">RP</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, fontFamily: "var(--sans)", color: "var(--ink-2)", fontWeight: 600 }}>
              Rajesh P.
            </div>
            <div style={{ fontSize: 10, fontFamily: "var(--mono)", color: "var(--ink-4)" }}>
              {role?.label || "Sales Engineer"}
            </div>
          </div>
          <button className="btn ghost icon sm">{Icon.settings}</button>
        </div>
      </aside>

      <main className="app-main">{children}</main>

      <footer className="app-dock">
        <span><Dot k="live" /> Live · DB ↔ Vercel</span>
        <span style={{ color: "var(--ink-4)" }}>·</span>
        <span>Tally bridge <span style={{ color: "var(--sage)" }}>online</span> · v6.6.3</span>
        <span style={{ color: "var(--ink-4)" }}>·</span>
        <span>FX cron <span style={{ color: "var(--sage)" }}>04:00 UTC</span> · USD 83.42 · JPY 0.55</span>
        <span style={{ color: "var(--ink-4)" }}>·</span>
        <span>ClamAV <span style={{ color: "var(--sage)" }}>OK</span></span>
        <span style={{ marginLeft: "auto" }}>3 drafts autosaved · 12:42 IST</span>
      </footer>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────
// Cmd+K palette
// ─────────────────────────────────────────────────────────────
const CmdK = ({ open, onClose, onJump }) => {
  if (!open) return null;
  const groups = [
    {
      label: "Recent threads",
      items: [
        { ic: Icon.layers, t: "OIQTLC-26-1015 · Hyderabad Refractories · 4 line items", m: "↵ open" },
        { ic: Icon.layers, t: "OIQTHS-26-0021 · Voestalpine Spec. · USD 124,500", m: "↵ open" },
        { ic: Icon.pkg,    t: "SPO/JP/26/0091 · Yokoi Manufacturing · ETA 14 May", m: "↵ open" },
      ],
    },
    {
      label: "Jump to",
      items: [
        { ic: Icon.bolt,   t: "My Day", m: "G H" },
        { ic: Icon.inbox,  t: "Inbox · 12 new", m: "G I" },
        { ic: Icon.layers, t: "Sales Orders", m: "G S" },
        { ic: Icon.flame,  t: "Leads", m: "G L" },
        { ic: Icon.signal, t: "Opportunities pipeline", m: "G O" },
        { ic: Icon.ledger, t: "Tally sync queue", m: "G T" },
        { ic: Icon.brain,  t: "Eval suites", m: "G E" },
        { ic: Icon.settings, t: "Admin Center", m: "G A" },
      ],
    },
    {
      label: "Actions",
      items: [
        { ic: Icon.plus, t: "Create Sales Order from PO upload", m: "C O" },
        { ic: Icon.plus, t: "Create Lead", m: "C L" },
        { ic: Icon.plus, t: "Log Service Visit", m: "C V" },
        { ic: Icon.plus, t: "Add Customer Format Profile", m: "C P" },
        { ic: Icon.send, t: "Send missing-doc nudge", m: "C N" },
      ],
    },
  ];
  return (
    <div className="cmdk-bg" onClick={onClose}>
      <div className="cmdk" onClick={(e) => e.stopPropagation()}>
        <div className="cmdk-input">
          {Icon.search}
          <input autoFocus placeholder="Search orders, jump to module, run action…" />
          <kbd style={{ fontFamily: "var(--mono)", fontSize: 10, padding: "2px 5px", border: "1px solid var(--hairline)", borderRadius: 2, color: "var(--ink-3)" }}>esc</kbd>
        </div>
        <div className="cmdk-list">
          {groups.map(g => (
            <div key={g.label}>
              <div className="cmdk-group">{g.label}</div>
              {g.items.map((it, i) => (
                <div key={i} className={`cmdk-row ${i === 0 && g.label === "Recent threads" ? "active" : ""}`}>
                  <span className="ic">{it.ic}</span>
                  <span>{it.t}</span>
                  <span className="meta">{it.m}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────
// Thread drawer — overlays the main content
// ─────────────────────────────────────────────────────────────
const ThreadDrawer = ({ open, onClose }) => {
  if (!open) return null;
  return (
    <div className="cmdk-bg" style={{ padding: 0, alignItems: "stretch", justifyItems: "end" }} onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-h">
          <div>
            <div className="h-eyebrow">Thread · OIQTLC-26-1015</div>
            <div className="h2" style={{ marginTop: 2 }}>Hyderabad Refractories Pvt Ltd</div>
          </div>
          <button className="btn icon sm ghost" style={{ marginLeft: "auto" }} onClick={onClose}>{Icon.x}</button>
        </div>
        <div style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 10, overflow: "auto", flex: 1 }}>
          {[
            { k: "PO", t: "PO 2024-7821 · Hyderabad Refractories", d: "uploaded · 12 Apr 09:14", c: "good" },
            { k: "QU", t: "Quote OIQTLC-26-1015", d: "drafted · 12 Apr 10:22", c: "good" },
            { k: "VA", t: "Validation · 2 findings", d: "12 Apr 10:24 · auto", c: "warn" },
            { k: "AP", t: "Approval · margin 28% under floor", d: "pending · sent to V. Suri", c: "warn" },
            { k: "TA", t: "Tally push", d: "queued · payload hash a8f2c1…", c: "info" },
            { k: "SP", t: "Source PO · Yokoi Manufacturing JP", d: "drafted · 13 Apr 11:00", c: "info" },
            { k: "SH", t: "Shipment · Nhava Sheva → Hyderabad", d: "ETA 14 May · CIF", c: "info" },
            { k: "EI", t: "e-Invoice IRN", d: "PENDING_GSTN · since 10:30", c: "warn" },
          ].map((s, i) => (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "32px 1fr auto", gap: 10, alignItems: "start", padding: 10, border: "1px solid var(--hairline)", borderRadius: 6, background: "var(--paper)" }}>
              <div style={{
                width: 28, height: 28, display: "grid", placeItems: "center",
                background: "var(--paper-3)",
                borderRadius: 4, fontFamily: "var(--mono)", fontSize: 10, fontWeight: 700, color: "var(--ink)"
              }}>{s.k}</div>
              <div>
                <div style={{ fontSize: 12.5, fontWeight: 600 }}>{s.t}</div>
                <div className="mono-sm">{s.d}</div>
              </div>
              <Chip k={s.c}>{s.k.toLowerCase()}</Chip>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

Object.assign(window, { Shell, CmdK, ThreadDrawer, NAV, ROLES });
