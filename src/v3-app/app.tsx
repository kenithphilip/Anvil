// App router for the Vite v3 build.
//
// Mounts the Shell (header + sidebar + dock) plus the route switch keyed
// on hash. Reads RBAC role for sidebar filtering and home variant. The
// CmdK palette + Thread drawer overlays sit on top of the main content.

import React, { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Shell } from "./components/Shell";
import { MobileShell } from "./components/MobileShell";
import { useViewport } from "./lib/viewport";
import { CmdK } from "./components/CmdK";
import { ThreadDrawer } from "./components/ThreadDrawer";
import { Card, WSTitle } from "./lib/primitives";
import { Icon } from "./lib/icons";
import { NAV, ROLES, crumbFor } from "./lib/nav";
import { RBAC } from "./lib/rbac";
import { Prefs } from "./lib/preferences";
import { ObaraBackend } from "./lib/api";
import { ToastStack } from "./lib/toasts";
import { useShellTelemetry } from "./lib/telemetry";
import { RESOLVERS, ROUTE_IDS, DEFAULT_ROUTE, readHashParams } from "./routes";

// localStorage keys live under the canonical `anvil:` prefix; the
// helper falls back to `obara:` for users who signed in pre-rebrand.
import { lsGet, lsSet, lsRemove, lsKey, lsLegacyKey } from "./lib/storage-keys";

const ROUTE_KEY_SUFFIX = "v3_route";
const TENANT_KEY_SUFFIX = "v3_tenant_code";
const INTENDED_ROUTE_KEY_SUFFIX = "v3_intended_route";

const parseRoute = () => {
  const hash = (typeof window !== "undefined" && window.location.hash) || "";
  const id = hash.replace(/^#\/?/, "").split("?")[0];
  if (id && RESOLVERS[id]) return id;
  try { return lsGet(ROUTE_KEY_SUFFIX) || DEFAULT_ROUTE; }
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

// Build the dropdown payload for the role pill. Each option carries the
// canonical role id (what RBAC.setRole expects), a human-readable label,
// and a short tag rendered on the right of the menu row. We look up by
// full id; the old "split('_')[0]" fallback collided sales_engineer
// with sales_manager and rendered both as "SAL".
const buildRoleOptions = (): Array<{ id: string; label: string; short: string }> =>
  RBAC.ROLES.map((id) => {
    const meta = ROLES.find((r) => r.id === id);
    return {
      id,
      label: meta?.label || id.replace(/_/g, " "),
      short: meta?.short || id.slice(0, 3).toUpperCase(),
    };
  });

// Shared sign-out helper. Clears the Supabase session, removes any
// cached auth profile / tenant / intended-route keys, and bounces the
// visitor back to the marketing landing. Exposed so the ThemeBar
// (every authenticated page) and the connect screen agree on what
// "signed out" means.
export const signOutAndRedirect = (): void => {
  try {
    ObaraBackend?.setSession?.(null);
    lsRemove("auth_profile");
    lsRemove(INTENDED_ROUTE_KEY_SUFFIX);
  } catch (_) {
    // Storage may be unavailable (private mode, locked-down browsers);
    // we still want the in-memory session cleared, which the call
    // above accomplishes before throwing.
  }
  // Redirect to the marketing landing rather than /signin so a
  // signed-out visitor can re-discover the product before
  // re-entering. The hash change triggers App's hashchange listener
  // and unmounts the Shell.
  if (typeof window !== "undefined") {
    window.location.hash = "#/landing";
    // Soft-reload after a microtask so any in-flight fetches see the
    // null session immediately and don't race the route change.
    setTimeout(() => { try { window.location.reload(); } catch (_) {} }, 0);
  }
};

// Floating bar in the dock area: theme + density + rail collapse +
// sign-out. The bar is `position: fixed` so it follows the visitor
// across screens; `.app-main { padding-bottom }` keeps page content
// above it (otherwise the bottom rows of forms / tables disappear
// under the floating buttons).
const ThemeBar: React.FC = () => {
  useRerenderOnEvents(["prefs:change"]);
  const theme = Prefs.theme();
  const density = Prefs.density();
  return (
    <div className="theme-bar" style={{ position: "fixed", right: 16, bottom: 36, display: "flex", gap: 6, zIndex: 100 }}>
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
      <button
        className="head-pill"
        title="Sign out"
        aria-label="Sign out"
        onClick={() => {
          if (typeof window !== "undefined" && window.confirm?.("Sign out of Anvil?") === false) return;
          signOutAndRedirect();
        }}
      >
        {Icon.logout} sign out
      </button>
    </div>
  );
};

/*
 * Auth gate.
 *
 * Returns true only when there is an access token AND it has not
 * expired. Visitors without a session never see the Shell, the
 * sidebar, or any data screen; they get the marketing Landing page
 * instead. The check re-runs on every render of App so a token
 * stale-out (cron, refresh failure, manual signout) immediately
 * bounces the visitor out of authenticated UI.
 *
 * The previous behaviour redirected to /connect only when the
 * backend URL was unset, leaving authenticated-looking but actually
 * anonymous users free to render screens that returned 401s on
 * every fetch. The hard gate below closes that hole.
 */
const isSessionValid = (): boolean => {
  try {
    const session = ObaraBackend?.getSession?.();
    if (!session?.access_token) return false;
    const expiresAt = Number(session.expires_at || 0);
    if (expiresAt && expiresAt < Math.floor(Date.now() / 1000)) return false;
    return true;
  } catch (_) {
    return false;
  }
};

const LandingScreen = React.lazy(() => import("./screens/landing"));
const SignInScreen = React.lazy(() => import("./screens/signin"));
const ResetPasswordScreen = React.lazy(() => import("./screens/reset-password"));

// Route ids that the pre-auth surface must serve. Without this the
// auth gate would clobber e.g. /reset (the password-recovery
// landing) by always rendering Landing. The `signin` route hosts
// the sign-in / sign-up / magic-link form (extracted from the old
// inline-auth landing into its own dedicated screen).
const PRE_AUTH_ROUTES = new Set(["reset", "signin"]);

export default function App() {
  useRerenderOnEvents(["rbac:change", "prefs:change", "popstate", "hashchange"]);

  const [route, setRoute] = useState(parseRoute);
  const [cmdkOpen, setCmdk] = useState(false);
  const [threadOpen, setThread] = useState(false);
  // Recompute on every render so token expiry, cross-tab sign-in,
  // and explicit sign-out propagate without a manual reload.
  const authed = isSessionValid();

  // When the storage event reports a fresh session in another tab,
  // force a re-render here so the gate flips to authenticated.
  useEffect(() => {
    const onChange = () => { setRoute((r) => r); };
    window.addEventListener("storage", onChange);
    window.addEventListener("anvil:session", onChange as EventListener);
    return () => {
      window.removeEventListener("storage", onChange);
      window.removeEventListener("anvil:session", onChange as EventListener);
    };
  }, []);

  const onRoute = useCallback((id: string) => {
    if (!RESOLVERS[id]) return;
    if (!RBAC.canRead(id)) {
      console.warn(`[v3-app] role ${RBAC.role()} cannot access ${id}`);
      return;
    }
    setRoute(id);
    lsSet(ROUTE_KEY_SUFFIX, id);
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

  // Snapshot the intended route on first load so the post-auth
  // redirect can hop the user back where they were trying to go.
  // Hard auth gating happens just before render (see `authed` /
  // `Landing` branch below); this hook only persists the intent.
  useEffect(() => {
    try {
      const here = window.location.hash || "";
      if (here && here !== "#/landing" && here !== "#/signin" && here !== "#/connect" && here !== "#/" && here !== "#") {
        lsSet(INTENDED_ROUTE_KEY_SUFFIX, here);
      }
    } catch (_) { /* swallow */ }
    // run once after mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // After sign-in (any flow), make sure we have a cached profile so the
  // shell avatar shows the real display name. The magic-link callback
  // page only writes access_token / refresh_token / expires_at, so for
  // those users we round-trip /api/auth/profile here. Idempotent: skips
  // when the cache is already populated or when the user is anonymous.
  useEffect(() => {
    const session = ObaraBackend?.getSession?.();
    if (!session?.access_token) return;
    let cached = null;
    try { cached = JSON.parse(lsGet("auth_profile") || "null"); } catch (_) {}
    if (cached?.user?.email) return;
    let cancelled = false;
    Promise.resolve(ObaraBackend?.auth?.getProfile?.())
      .then((p: any) => {
        if (cancelled || !p) return;
        lsSet("auth_profile", JSON.stringify(p));
        // Force a re-render so telemetry picks up the new cache.
        window.dispatchEvent(new Event("prefs:change"));
      })
      .catch(() => { /* surfacing 401 is handled elsewhere */ });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cross-tab session detection (magic-link flow opens auth/callback in a
  // separate tab). When the other tab writes the session, this tab picks
  // it up and routes to the user's intended destination.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      // Storage events fire under whichever prefix the writer used.
      // Accept both names so a tab running an older bundle still
      // notifies a tab running the new bundle.
      if (e.key !== lsKey("backend_session") && e.key !== lsLegacyKey("backend_session")) return;
      try {
        const next = e.newValue ? JSON.parse(e.newValue) : null;
        ObaraBackend?.setSession?.(next);
        if (next?.access_token) {
          let target = "home";
          try {
            const stored = lsGet(INTENDED_ROUTE_KEY_SUFFIX);
            if (stored) {
              const id = stored.replace(/^#\/?/, "").split("?")[0];
              if (RESOLVERS[id] && id !== "connect") target = id;
              lsRemove(INTENDED_ROUTE_KEY_SUFFIX);
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
  // Pre-auth routes (signin / reset / landing) bypass RBAC because
  // they are accessible to unauthenticated visitors who have no role
  // yet, so RBAC.canRead would otherwise force-redirect them.
  useEffect(() => {
    if (route === "signin" || route === "reset" || route === "landing") return;
    if (!RBAC.canRead(route)) onRoute("home");
  }, [route, onRoute]);

  const role = RBAC.role();
  const roleObj = ROLES.find((r) => r.id === role) ||
                  { id: role, label: role.replace(/_/g, " "), short: role.slice(0, 3).toUpperCase() };

  const tenant = { code: (() => {
    try { return lsGet(TENANT_KEY_SUFFIX) || "OBARA-IN"; }
    catch (_) { return "OBARA-IN"; }
  })() };

  // Resolve the active screen. resolver returns a lazy component; key the
  // Suspense boundary by the screen identity so route changes remount.
  const resolver = RESOLVERS[route] || RESOLVERS[DEFAULT_ROUTE];
  const Active = resolver({ params: readHashParams(), role });

  const telemetry = useShellTelemetry();
  const viewport = useViewport();

  // HARD AUTH GATE. Render the landing surface (sign-in + sign-up
  // + product copy) for any visitor without a valid session. The
  // Shell, sidebar, route resolvers, telemetry hooks, and CmdK
  // overlay are deliberately not rendered. Toasts still mount so
  // the auth flow can surface a "signed in" notification.
  //
  // Exception: a small allowlist of pre-auth routes (password
  // reset, magic-link callback) must render their own surface
  // even when there's no session. We dispatch on the parsed
  // route id below.
  if (!authed) {
    if (route === "signin") {
      return (
        <>
          <Suspense fallback={<Loading label="signin" />}>
            <SignInScreen />
          </Suspense>
          <ToastStack />
        </>
      );
    }
    if (route === "reset" || PRE_AUTH_ROUTES.has(route)) {
      return (
        <>
          <Suspense fallback={<Loading label="reset" />}>
            <ResetPasswordScreen />
          </Suspense>
          <ToastStack />
        </>
      );
    }
    return (
      <>
        <Suspense fallback={<Loading label="anvil" />}>
          <LandingScreen />
        </Suspense>
        <ToastStack />
      </>
    );
  }

  return (
    <>
      <a className="skip-link" href="#main">Skip to main content</a>
      {viewport.isMobile ? (
        <MobileShell
          route={route}
          onRoute={onRoute}
          role={roleObj}
          nav={navFiltered}
          crumb={crumbFor(route)}
          telemetry={telemetry}
        >
          <ErrorBoundary key={route}>
            <Suspense fallback={<Loading label={route} />}>
              {Active ? <Active /> : <NotFound id={route} />}
            </Suspense>
          </ErrorBoundary>
        </MobileShell>
      ) : (
        <Shell
          route={route}
          onRoute={onRoute}
          role={roleObj}
          roleOptions={buildRoleOptions()}
          onRoleChange={(roleId) => {
            // The Shell hands back the raw id string; cast to the
            // canonical Role union here. RBAC.setRole validates against
            // ROLES at runtime so an unknown id throws.
            RBAC.setRole(roleId as (typeof RBAC.ROLES)[number]);
          }}
          tenant={tenant}
          onTenant={() => onRoute("connect")}
          onCmdK={() => setCmdk(true)}
          onThread={() => setThread(true)}
          crumb={crumbFor(route)}
          nav={navFiltered}
          telemetry={telemetry}
        >
          <ThemeBar />
          <ErrorBoundary key={route}>
            <Suspense fallback={<Loading label={route} />}>
              {Active ? <Active /> : <NotFound id={route} />}
            </Suspense>
          </ErrorBoundary>
        </Shell>
      )}
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
