// ============================================================
// ANVIL v3 — App router
// Mounts the v3 Shell + a route switch keyed on nav id.
// Reads role from RBAC and filters the sidebar accordingly.
// ============================================================

const { useState, useEffect, useMemo, useCallback, useRef } = React;

const ROUTE_KEY = "obara:v3_route";

// Read a query param from the URL hash (e.g. #/so?id=abc → "abc" for "id").
const hashParam = (key) => {
  try {
    const hash = window.location.hash || "";
    const qpos = hash.indexOf("?");
    if (qpos < 0) return null;
    return new URLSearchParams(hash.slice(qpos + 1)).get(key);
  } catch { return null; }
};

// Map nav id → React component. Each component is a Window-exposed render
// function from the screens-*.jsx files we copied alongside.
const ROUTES = {
  // Workflows. SOs branch: ?id=X opens the workspace, ?new=1 opens intake,
  // otherwise the list.
  home:        () => <HomeRoute />,
  intake:      () => (window.Inbox ? <Inbox /> : <Placeholder name="Inbox" />),
  so:          () => {
    const view = hashParam("view");
    if (view === "history") return window.SOHistory ? <SOHistory /> : <Placeholder name="Sales Order History" />;
    if (hashParam("id")) return window.SOWorkspace ? <SOWorkspace /> : <Placeholder name="Sales Order Workspace" />;
    if (hashParam("new")) return window.SOIntake ? <SOIntake /> : <Placeholder name="New Sales Order" />;
    return window.SOList ? <SOList /> : <Placeholder name="Sales Orders" />;
  },
  internal:    () => (window.InternalSOs ? <InternalSOs /> : <Placeholder name="Internal SOs" />),
  approvals:   () => (window.Approvals ? <Approvals /> : <Placeholder name="Approvals" />),
  // Sales
  leads:       () => (window.Leads ? <Leads /> : <Placeholder name="Leads" />),
  opps:        () => (window.Opportunities ? <Opportunities /> : <Placeholder name="Opportunities" />),
  projects:    () => (window.Projects ? <Projects /> : <Placeholder name="Projects" />),
  shipments:   () => (window.Shipments ? <Shipments /> : <Placeholder name="Shipments" />),
  // Procurement
  spo:         () => (window.SPOList ? <SPOList /> : (window.SourcePOs ? <SourcePOs /> : <Placeholder name="Source POs" />)),
  spares:      () => (window.SparesMatrix ? <SparesMatrix /> : <Placeholder name="Spares Matrix" />),
  // Service
  "svc-visits":() => (window.ServiceVisits ? <ServiceVisits /> : <Placeholder name="Service Visits" />),
  amc:         () => (window.AMCSchedule ? <AMCSchedule /> : <Placeholder name="AMC Schedule" />),
  car:         () => (window.CARReports ? <CARReports /> : <Placeholder name="CAR Reports" />),
  // Finance. Tally branch: ?sub=masters opens TallyMasters,
  // ?sub=reconcile opens TallyReconcile, otherwise default to TallyPush.
  tally:       () => {
    const sub = hashParam("sub");
    if (sub === "masters") return window.TallyMasters ? <TallyMasters /> : <Placeholder name="Tally Masters" />;
    if (sub === "reconcile") return window.TallyReconcile ? <TallyReconcile /> : <Placeholder name="Tally Reconcile" />;
    return window.TallyPush ? <TallyPush /> : <Placeholder name="Tally Sync" />;
  },
  einvoice:    () => (window.EInvoice ? <EInvoice /> : <Placeholder name="e-Invoice" />),
  cost:        () => (window.CostMargin ? <CostMargin /> : <Placeholder name="Cost & Margin" />),
  // Data
  customers:   () => (window.Customers ? <Customers /> : <Placeholder name="Customers" />),
  items:       () => {
    const view = hashParam("view");
    if (view === "import")     return window.BomImport ? <BomImport /> : <Placeholder name="BOM Import" />;
    if (view === "guns")       return window.GunsViewer ? <GunsViewer /> : <Placeholder name="Guns Viewer" />;
    if (view === "equipment")  return window.EquipmentHierarchy ? <EquipmentHierarchy /> : <Placeholder name="Equipment Hierarchy" />;
    if (view === "jbm-import") return window.JbmImporter ? <JbmImporter /> : <Placeholder name="JBM Importer" />;
    return window.Items ? <Items /> : <Placeholder name="Item Master" />;
  },
  graph:       () => (window.MasterDataGraph ? <MasterDataGraph /> : <Placeholder name="Master Data Graph" />),
  forecasts:   () => (window.Forecasts ? <Forecasts /> : <Placeholder name="Forecasts" />),
  // Quality
  evals:       () => (window.EvalSuites ? <EvalSuites /> : <Placeholder name="Eval Suites" />),
  studio:      () => (window.ProfileStudio ? <ProfileStudio /> : <Placeholder name="Profile Studio" />),
  anomaly:     () => (window.Findings ? <Findings /> : <Placeholder name="Anomaly" />),
  duplicates:  () => (window.Duplicates ? <Duplicates /> : <Placeholder name="Duplicates" />),
  // Comms & Security
  comms:       () => (window.Communications ? <Communications /> : <Placeholder name="Communications" />),
  email:       () => (window.EmailTriage ? <EmailTriage /> : <Placeholder name="Email Triage" />),
  security:    () => (window.Security ? <Security /> : <Placeholder name="Security Center" />),
  // Admin
  audit:       () => (window.AuditLog ? <AuditLog /> : <Placeholder name="Audit Log" />),
  admin:       () => (window.AdminCenter ? <AdminCenter /> : <Placeholder name="Admin Center" />),
  // Sign-in / backend connect (no nav entry; reached via header pill or
  // automatic redirect when not signed in)
  connect:     () => (window.BackendConnect ? <BackendConnect /> : <Placeholder name="Backend Connect" />),
  // Onboarding checklist + format guide (reached via Cmd+K or first-run)
  onboarding:  () => (window.Onboarding ? <Onboarding /> : <Placeholder name="Onboarding" />),
  "format-guide": () => (window.FormatGuide ? <FormatGuide /> : <Placeholder name="Format Guide" />),
};

const Placeholder = ({ name }) => (
  <div className="ws ws-no-rail" style={{ padding: 22 }}>
    <WSTitle eyebrow="Coming soon" title={name} meta="this route is wired but the screen has not yet been imported" />
    <div className="ws-content">
      <Card>
        <div className="body">
          This nav id resolves to a screen module that has not been registered yet.
          Implementation continues in Phase 3 of the v3 overhaul. In the meantime
          the underlying API + table for this route already work via the legacy
          shell (see <code>?v3=0</code>).
        </div>
      </Card>
    </div>
  </div>
);

// HomeRoute picks a role-appropriate home.
const HomeRoute = () => {
  const role = window.RBAC?.role() || "sales_engineer";
  if (role === "sales_manager" && window.HomeManager) return <HomeManager />;
  if (role === "admin" && window.HomeAdmin) return <HomeAdmin />;
  if (window.HomeEngineer) return <HomeEngineer />;
  return <Placeholder name="My Day" />;
};

// Build a breadcrumb from the active route id.
const crumbFor = (navId) => {
  const groups = (window.NAV || []).find((g) => g.items.some((i) => i.id === navId));
  const item = groups?.items.find((i) => i.id === navId);
  return groups && item ? ["Anvil", groups.label, item.label] : ["Anvil"];
};

// Forced rerender on RBAC + Prefs change so the Shell + filtered NAV
// reflect the new state.
const useRerenderOnEvents = (eventNames) => {
  const [, force] = useState(0);
  useEffect(() => {
    const bump = () => force((n) => n + 1);
    eventNames.forEach((e) => window.addEventListener(e, bump));
    return () => eventNames.forEach((e) => window.removeEventListener(e, bump));
  }, [eventNames.join("|")]);
};

const App = () => {
  useRerenderOnEvents(["rbac:change", "prefs:change", "popstate", "hashchange"]);

  // Route state: read from URL hash if present, otherwise localStorage,
  // default to home. Strips any query params so #/so?id=X resolves to "so".
  const [route, setRoute] = useState(() => {
    const hash = (window.location.hash || "").replace(/^#\/?/, "");
    const id = hash.split("?")[0];
    if (id && ROUTES[id]) return id;
    try { return localStorage.getItem(ROUTE_KEY) || "home"; } catch { return "home"; }
  });

  // Keep route in sync with URL on hashchange (deep-link navigation).
  useEffect(() => {
    const onHash = () => {
      const hash = (window.location.hash || "").replace(/^#\/?/, "");
      const id = hash.split("?")[0];
      if (id && ROUTES[id] && id !== route) setRoute(id);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [route]);

  const onRoute = useCallback((id) => {
    if (!ROUTES[id]) return;
    if (window.RBAC && !window.RBAC.canRead(id)) {
      console.warn(`[v3] role ${window.RBAC.role()} cannot access ${id}`);
      return;
    }
    setRoute(id);
    try { localStorage.setItem(ROUTE_KEY, id); } catch (_) {}
    try { window.history.replaceState(null, "", `#/${id}`); } catch (_) {}
  }, []);

  // First-load: if backend isn't configured, route to the sign-in screen
  // so the user has an obvious next step. Skip when already on /connect.
  // We remember the intended route in localStorage so post-sign-in we
  // can drop the user back where they were trying to go (instead of
  // leaving them on /connect after a successful auth).
  useEffect(() => {
    const ready = !!(window.ObaraBackend?.isReady?.());
    const cfg = window.ObaraBackend?.getConfig?.() || {};
    const hasUrl = !!cfg.url;
    if (!ready && !hasUrl && route !== "connect") {
      try {
        // Save where the user was trying to go, so /connect can return them.
        const hash = window.location.hash || "#/home";
        localStorage.setItem("obara:v3_intended_route", hash);
      } catch (_) {}
      onRoute("connect");
    }
    // run once after mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cross-tab session detection: when auth/callback.html in another tab
  // writes obara:backend_session, this tab picks it up and refreshes its
  // view of "is signed in". Combined with the post-sign-in nav in
  // BackendConnect, the user gets a coherent flow even when the magic
  // link opens in a new tab.
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key !== "obara:backend_session") return;
      try {
        const next = e.newValue ? JSON.parse(e.newValue) : null;
        if (window.ObaraBackend?.setSession) window.ObaraBackend.setSession(next);
        if (next?.access_token) {
          window.notifySuccess?.("Signed in", "Session received from another tab.");
          // Route to last intended route (if any) or home.
          let target = "home";
          try {
            const stored = localStorage.getItem("obara:v3_intended_route");
            if (stored) {
              const id = stored.replace(/^#\/?/, "").split("?")[0];
              if (ROUTES[id] && id !== "connect") target = id;
              localStorage.removeItem("obara:v3_intended_route");
            }
          } catch (_) {}
          onRoute(target);
        }
      } catch (_) {}
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [onRoute]);

  // Cmd+K + Thread overlays
  const [cmdkOpen, setCmdk] = useState(false);
  const [threadOpen, setThread] = useState(false);

  // Keyboard shortcut: Cmd+K / Ctrl+K opens the palette
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdk((v) => !v);
      }
      if (e.key === "Escape") {
        setCmdk(false);
        setThread(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Build a role-filtered NAV
  const NAV_FILTERED = useMemo(() => {
    if (!window.RBAC || !window.NAV) return window.NAV || [];
    return window.RBAC.filterNav(window.NAV);
  }, [window.RBAC?.role(), window.NAV]);

  // If the current route is no longer accessible (role change), bounce to home
  useEffect(() => {
    if (!window.RBAC) return;
    if (!window.RBAC.canRead(route)) onRoute("home");
  }, [route, onRoute]);

  const role = window.RBAC?.role() || "sales_engineer";
  const roleObj = (window.ROLES || []).find((r) => r.id === role.split("_")[0]) ||
                  { id: role, label: role.replace(/_/g, " "), short: role.slice(0, 3).toUpperCase() };

  const Active = ROUTES[route] || (() => <Placeholder name="Unknown route" />);

  return (
    <>
      <ShellInner
        route={route}
        onRoute={onRoute}
        navFiltered={NAV_FILTERED}
        role={roleObj}
        onRoleChange={() => setCmdk(false) || promptRole()}
        onCmdK={() => setCmdk(true)}
        onThread={() => setThread(true)}
        crumb={crumbFor(route)}
      >
        <Active />
      </ShellInner>
      {window.CmdK && <CmdK open={cmdkOpen} onClose={() => setCmdk(false)} onJump={(id) => { onRoute(id); setCmdk(false); }} />}
      {window.ThreadDrawer && <ThreadDrawer open={threadOpen} onClose={() => setThread(false)} />}
      {window.ToastStack && <ToastStack />}
    </>
  );
};

// Tiny role-picker that reuses the head-pill drop. Phase 4 replaces this
// with a proper dropdown panel anchored to the role pill.
function promptRole() {
  const roles = (window.RBAC?.ROLES) || [];
  const cur = window.RBAC?.role();
  const list = roles.map((r, i) => `${i + 1}. ${r}${r === cur ? " (current)" : ""}`).join("\n");
  const pick = window.prompt(`Switch role to:\n${list}\n\nEnter 1-${roles.length}:`);
  const n = parseInt(pick, 10);
  if (!isNaN(n) && n >= 1 && n <= roles.length) window.RBAC.setRole(roles[n - 1]);
}

// Wrap the design-system Shell with theme + density + tenant pills.
// We don't modify shell.jsx itself so future v3 design-system updates can
// drop in cleanly; this is a thin adapter layer.
const ShellInner = ({ children, route, onRoute, navFiltered, role, onRoleChange, onCmdK, onThread, crumb }) => {
  const tenant = { code: localStorage.getItem("obara:v3_tenant_code") || "OBARA-IN" };
  return (
    <Shell
      route={route}
      onRoute={onRoute}
      role={role}
      onRole={onRoleChange}
      tenant={tenant}
      onTenant={() => onRoute("connect")}
      onCmdK={onCmdK}
      onThread={onThread}
      crumb={crumb}
      nav={navFiltered}
    >
      <ThemeBar />
      {children}
    </Shell>
  );
};

// Floating bar in the dock area: theme toggle + density + rail collapse.
const ThemeBar = () => {
  const [, force] = useState(0);
  useEffect(() => {
    const onChange = () => force((n) => n + 1);
    window.addEventListener("prefs:change", onChange);
    return () => window.removeEventListener("prefs:change", onChange);
  }, []);
  const theme = window.Prefs?.theme() || "dark";
  const density = window.Prefs?.density() || "normal";
  return (
    <div style={{ position: "fixed", right: 16, bottom: 36, display: "flex", gap: 6, zIndex: 100 }}>
      <button className="head-pill" title="Toggle theme" onClick={() => window.Prefs.toggleTheme()}>
        {theme === "dark" ? Icon.eye : Icon.eye} {theme}
      </button>
      <button className="head-pill" title="Cycle density" onClick={() => {
        const order = ["compact", "normal", "comfortable"];
        const next = order[(order.indexOf(density) + 1) % order.length];
        window.Prefs.setDensity(next);
      }}>{Icon.layers} {density}</button>
      <button className="head-pill" title="Toggle sidebar" onClick={() => window.Prefs.toggleRail()}>
        {Icon.arrowL}
      </button>
    </div>
  );
};

// Mount when this file loads; the host HTML provides the #v3-root div.
window.AnvilV3 = { App };
const root = document.getElementById("v3-root");
if (root && typeof ReactDOM !== "undefined") {
  if (ReactDOM.createRoot) ReactDOM.createRoot(root).render(<App />);
  else ReactDOM.render(<App />, root);
}
