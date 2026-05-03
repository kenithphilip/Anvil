// App router for the Vite v3 build.
//
// Mounts the Shell (header + sidebar + dock) plus the route switch keyed
// on hash. Reads RBAC role for sidebar filtering and home variant. The
// CmdK palette + Thread drawer overlays sit on top of the main content.

import React, { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Shell } from "./components/Shell";
import { CmdK } from "./components/CmdK";
import { ThreadDrawer } from "./components/ThreadDrawer";
import { Card, WSTitle } from "./lib/primitives";
import { Icon } from "./lib/icons";
import { NAV, ROLES, crumbFor } from "./lib/nav";
import { RBAC } from "./lib/rbac";
import { Prefs } from "./lib/preferences";
import { ObaraBackend } from "./lib/api";
import { ToastStack } from "./lib/toasts";
import { RESOLVERS, ROUTE_IDS, DEFAULT_ROUTE, readHashParams } from "./routes";

const ROUTE_KEY = "obara:v3_route";
const TENANT_KEY = "obara:v3_tenant_code";
const INTENDED_ROUTE_KEY = "obara:v3_intended_route";

const parseRoute = () => {
  const hash = (typeof window !== "undefined" && window.location.hash) || "";
  const id = hash.replace(/^#\/?/, "").split("?")[0];
  if (id && RESOLVERS[id]) return id;
  try { return localStorage.getItem(ROUTE_KEY) || DEFAULT_ROUTE; }
  catch (_) { return DEFAULT_ROUTE; }
};

interface ErrorBoundaryProps { children: React.ReactNode; }
interface ErrorBoundaryState { error: Error | null; }
class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error: Error): ErrorBoundaryState { return { error }; }
  componentDidCatch(error: Error, info: React.ErrorInfo): void { console.error("[v3-app] route crash", error, info); }
  render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="ws ws-no-rail" style={{ padding: 24 }}>
        <WSTitle eyebrow="Error" title="This route crashed" />
        <Card>
          <pre style={{ color: "var(--rust, #c33)", whiteSpace: "pre-wrap", padding: 12 }}>
            {String(this.state.error.stack || this.state.error.message || this.state.error)}
          </pre>
        </Card>
      </div>
    );
  }
}

const Loading: React.FC<{ label: string }> = ({ label }) => (
  <div className="ws ws-no-rail" style={{ padding: 24, color: "var(--ink-3)" }}>
    Loading {label}…
  </div>
);

// Force re-render when RBAC role or prefs change so the sidebar filter +
// theme reflect the new state without a hash change.
const useRerenderOnEvents = (eventNames: string[]): void => {
  const [, force] = useState(0);
  useEffect(() => {
    const bump = () => force((n) => n + 1);
    eventNames.forEach((e) => window.addEventListener(e, bump));
    return () => eventNames.forEach((e) => window.removeEventListener(e, bump));
  }, [eventNames.join("|")]);
};

const promptRole = (): void => {
  const list = RBAC.ROLES.map((r, i) => `${i + 1}. ${r}${r === RBAC.role() ? " (current)" : ""}`).join("\n");
  const pick = window.prompt(`Switch role to:\n${list}\n\nEnter 1-${RBAC.ROLES.length}:`);
  const n = parseInt(pick || "", 10);
  if (!Number.isNaN(n) && n >= 1 && n <= RBAC.ROLES.length) RBAC.setRole(RBAC.ROLES[n - 1]);
};

// Floating bar in the dock area: theme + density + rail collapse.
const ThemeBar: React.FC = () => {
  useRerenderOnEvents(["prefs:change"]);
  const theme = Prefs.theme();
  const density = Prefs.density();
  return (
    <div style={{ position: "fixed", right: 16, bottom: 36, display: "flex", gap: 6, zIndex: 100 }}>
      <button className="head-pill" title="Toggle theme" onClick={() => Prefs.toggleTheme()}>
        {Icon.eye} {theme}
      </button>
      <button className="head-pill" title="Cycle density" onClick={() => {
        const order: Array<"compact" | "normal" | "comfortable"> = ["compact", "normal", "comfortable"];
        const next = order[(order.indexOf(density) + 1) % order.length];
        Prefs.setDensity(next);
      }}>{Icon.layers} {density}</button>
      <button className="head-pill" title="Toggle sidebar" onClick={() => Prefs.toggleRail()}>
        {Icon.arrowL}
      </button>
    </div>
  );
};

export default function App() {
  useRerenderOnEvents(["rbac:change", "prefs:change", "popstate", "hashchange"]);

  const [route, setRoute] = useState(parseRoute);
  const [cmdkOpen, setCmdk] = useState(false);
  const [threadOpen, setThread] = useState(false);

  const onRoute = useCallback((id: string) => {
    if (!RESOLVERS[id]) return;
    if (!RBAC.canRead(id)) {
      console.warn(`[v3-app] role ${RBAC.role()} cannot access ${id}`);
      return;
    }
    setRoute(id);
    try { localStorage.setItem(ROUTE_KEY, id); } catch (_) {}
    try { window.history.replaceState(null, "", `#/${id}`); } catch (_) {}
  }, []);

  // Hash-change keeps the route in sync with deep links.
  useEffect(() => {
    const onHash = () => {
      const id = (window.location.hash || "").replace(/^#\/?/, "").split("?")[0];
      if (id && RESOLVERS[id] && id !== route) setRoute(id);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [route]);

  // First-load: redirect to /connect if backend isn't configured. Save
  // intended route so /connect can return the user there post-sign-in.
  useEffect(() => {
    const ready = !!ObaraBackend?.isReady?.();
    const cfg = ObaraBackend?.getConfig?.() || {};
    const hasUrl = !!cfg.url;
    if (!ready && !hasUrl && route !== "connect") {
      try {
        localStorage.setItem(INTENDED_ROUTE_KEY, window.location.hash || "#/home");
      } catch (_) {}
      onRoute("connect");
    }
    // run once after mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cross-tab session detection (magic-link flow opens auth/callback in a
  // separate tab). When the other tab writes the session, this tab picks
  // it up and routes to the user's intended destination.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== "obara:backend_session") return;
      try {
        const next = e.newValue ? JSON.parse(e.newValue) : null;
        ObaraBackend?.setSession?.(next);
        if (next?.access_token) {
          let target = "home";
          try {
            const stored = localStorage.getItem(INTENDED_ROUTE_KEY);
            if (stored) {
              const id = stored.replace(/^#\/?/, "").split("?")[0];
              if (RESOLVERS[id] && id !== "connect") target = id;
              localStorage.removeItem(INTENDED_ROUTE_KEY);
            }
          } catch (_) {}
          onRoute(target);
        }
      } catch (_) {}
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [onRoute]);

  // Cmd+K + Esc shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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

  const navFiltered = useMemo(() => RBAC.filterNav(NAV), [RBAC.role()]);

  // Bounce to home if the current route is no longer accessible.
  useEffect(() => {
    if (!RBAC.canRead(route)) onRoute("home");
  }, [route, onRoute]);

  const role = RBAC.role();
  const roleObj = ROLES.find((r) => r.id === role.split("_")[0]) ||
                  { id: role, label: role.replace(/_/g, " "), short: role.slice(0, 3).toUpperCase() };

  const tenant = { code: (() => {
    try { return localStorage.getItem(TENANT_KEY) || "OBARA-IN"; }
    catch (_) { return "OBARA-IN"; }
  })() };

  // Resolve the active screen. resolver returns a lazy component; key the
  // Suspense boundary by the screen identity so route changes remount.
  const resolver = RESOLVERS[route] || RESOLVERS[DEFAULT_ROUTE];
  const Active = resolver({ params: readHashParams(), role });

  return (
    <>
      <a className="skip-link" href="#main">Skip to main content</a>
      <Shell
        route={route}
        onRoute={onRoute}
        role={roleObj}
        onRole={() => promptRole()}
        tenant={tenant}
        onTenant={() => onRoute("connect")}
        onCmdK={() => setCmdk(true)}
        onThread={() => setThread(true)}
        crumb={crumbFor(route)}
        nav={navFiltered}
      >
        <ThemeBar />
        <ErrorBoundary key={route}>
          <Suspense fallback={<Loading label={route} />}>
            {Active ? <Active /> : <NotFound id={route} />}
          </Suspense>
        </ErrorBoundary>
      </Shell>
      <CmdK open={cmdkOpen} onClose={() => setCmdk(false)} onJump={(id) => { onRoute(id); setCmdk(false); }} />
      <ThreadDrawer open={threadOpen} onClose={() => setThread(false)} />
      <ToastStack />
    </>
  );
}

const NotFound: React.FC<{ id: string }> = ({ id }) => (
  <div className="ws ws-no-rail" style={{ padding: 24 }}>
    <WSTitle eyebrow="Unknown route" title={String(id)} />
    <Card>
      <div className="body" style={{ padding: 16 }}>
        Available routes:
        <ul className="mono-sm">
          {ROUTE_IDS.map((r) => <li key={r}><a href={`#/${r}`}>{r}</a></li>)}
        </ul>
      </div>
    </Card>
  </div>
);
