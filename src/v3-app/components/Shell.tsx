// Application shell: header, sidebar, dock. ESM port of src/v3/shell.jsx
// `Shell` component. CmdK + ThreadDrawer overlays live alongside.
//
// Pure presentation: every state lives in the parent (App.tsx). The shell
// renders whatever children, nav tree, and live telemetry it gets handed.

import React, { ReactNode, useEffect, useRef, useState } from "react";
import { Icon } from "../lib/icons";
import { Dot, Chip } from "../lib/primitives";
import { ageLabel } from "../lib/helpers";
import { getRecent, clearRecent, type RecentItem } from "../lib/recent-items";
import { AnvilBackend } from "../lib/api";
import { Prefs } from "../lib/preferences";
import { signOutAndRedirect } from "../lib/session";
import type { NavGroup, RoleEntry, NavBadge } from "../lib/nav";
import type { ShellTelemetry, BadgeMap } from "../lib/telemetry";

// Polling cadence for the bell. Notifications volume is low (signups,
// push failures); a 30-second poll keeps the count fresh without
// hammering the API. The window is paused while the tab is hidden so
// background tabs don't burn requests.
const NOTIFICATION_POLL_MS = 30_000;

interface NotificationRow {
  id: string;
  kind: string;
  title: string;
  body?: string;
  link_route?: string;
  link_params?: Record<string, string>;
  actor_email?: string;
  read_by?: string[];
  resolved?: boolean;
  created_at?: string;
}

// Header "Recent" menu: quick navigation back to records the user recently
// opened or created. Reads the client-side recent-items store; additive.
const RecentMenu: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<RecentItem[]>(() => getRecent());
  useEffect(() => {
    const on = () => setItems(getRecent());
    window.addEventListener("recent:change", on);
    return () => window.removeEventListener("recent:change", on);
  }, []);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!(e.target as HTMLElement)?.closest?.(".recent-menu-wrap")) setOpen(false);
    };
    window.addEventListener("mousedown", onDoc);
    return () => window.removeEventListener("mousedown", onDoc);
  }, [open]);
  const go = (href: string) => { setOpen(false); try { window.location.hash = href; } catch (_) { /* noop */ } };
  return (
    <div className="recent-menu-wrap" style={{ position: "relative" }}>
      <button type="button" className="head-pill" title="Recently opened / created records"
        onClick={() => { setItems(getRecent()); setOpen((o) => !o); }}>
        {Icon.history} Recent
      </button>
      {open && (
        <div role="menu" style={{ position: "absolute", right: 0, top: "calc(100% + 6px)", width: 340, maxWidth: "90vw", zIndex: 300, background: "var(--paper)", border: "1px solid var(--hairline)", borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,0.18)", padding: 4, maxHeight: "72vh", overflowY: "auto" }}>
          {items.length === 0 ? (
            <div className="mono-sm" style={{ padding: 12, color: "var(--ink-3)" }}>No recent items yet. Open or create a record and it shows up here.</div>
          ) : items.map((it) => (
            <div key={it.key} role="button" tabIndex={0} className="cmdk-row"
              onClick={() => go(it.href)} onKeyDown={(e) => { if (e.key === "Enter") go(it.href); }}
              style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", cursor: "pointer", borderRadius: 6 }}>
              <Chip k="ghost">{it.type}</Chip>
              <span style={{ flex: 1, fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.label}</span>
              <span className="mono-sm" style={{ color: "var(--ink-4)", fontSize: 10 }}>{ageLabel(new Date(it.ts).toISOString())}</span>
            </div>
          ))}
          {items.length > 0 && (
            <div style={{ borderTop: "1px solid var(--hairline-2)", padding: "6px 10px", display: "flex", justifyContent: "flex-end" }}>
              <button type="button" className="btn sm ghost" onClick={() => clearRecent()}>Clear</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const NotificationsBell: React.FC<{ onRoute?: (id: string) => void; isAdminLike: boolean }> = ({ onRoute, isAdminLike }) => {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationRow[]>([]);
  const [unread, setUnread] = useState<number>(0);
  const [busy, setBusy] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const load = async () => {
    if (!isAdminLike) { setItems([]); setUnread(0); return; }
    try {
      const resp: any = await AnvilBackend?.notifications?.list?.();
      setItems(resp?.notifications || []);
      setUnread(resp?.unread_count || 0);
    } catch (_) { /* leave previous state */ }
  };

  // Poll on mount + when the tab becomes visible. Skip for non-
  // admins, since the backend filter would still surface tenant-wide
  // events (resolved=false), but the bell is admin-only.
  useEffect(() => {
    if (!isAdminLike) return;
    let timer: number | undefined;
    const tick = () => { if (!document.hidden) load(); };
    tick();
    timer = window.setInterval(tick, NOTIFICATION_POLL_MS) as unknown as number;
    document.addEventListener("visibilitychange", tick);
    return () => {
      if (timer) window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdminLike]);

  // Click-outside to close.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const onItemClick = async (n: NotificationRow) => {
    setBusy(n.id);
    try {
      // Mark read so the user-specific bell count goes down even if
      // someone else resolves the row later.
      try { await AnvilBackend?.notifications?.markRead?.(n.id); } catch (_) { /* ignore */ }
      // Deep-link if the row carries a route hint. Validate that
      // the target route exists in RESOLVERS so a stale link_route
      // (renamed screen, dropped feature) doesn't dump the user on
      // a NotFound page silently.
      if (n.link_route) {
        // Lazy-import to avoid pulling routes.ts into Shell's normal
        // bundle path. We just need the keys.
        let routeOk = true;
        try {
          const { ROUTE_IDS } = await import("../routes");
          routeOk = (ROUTE_IDS as readonly string[]).includes(n.link_route);
        } catch (_) { /* if the import fails, attempt the navigation anyway */ }
        if (!routeOk) {
          (window as any).notifyWarn?.(
            "Cannot open this notification",
            "The target screen `" + n.link_route + "` no longer exists.",
          );
        } else {
          const params = n.link_params ? new URLSearchParams(n.link_params as Record<string, string>).toString() : "";
          window.location.hash = "#/" + n.link_route + (params ? "?" + params : "");
          if (onRoute) onRoute(n.link_route);
        }
      }
      setOpen(false);
      // Refresh the count.
      load();
    } finally {
      setBusy(null);
    }
  };

  const onMarkAll = async () => {
    try { await AnvilBackend?.notifications?.markAllRead?.(); } catch (_) { /* ignore */ }
    load();
  };

  if (!isAdminLike) return null;

  return (
    <div ref={wrapRef} className="head-pill-wrap" style={{ position: "relative" }}>
      <button
        type="button"
        className="head-pill"
        title={unread ? `${unread} unread notification${unread === 1 ? "" : "s"}` : "Notifications"}
        aria-label={unread ? `${unread} unread notifications` : "Notifications"}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{ position: "relative" }}
      >
        {Icon.bell}
        {unread > 0 && (
          <span
            aria-hidden="true"
            style={{
              position: "absolute", top: 2, right: 4,
              minWidth: 14, height: 14,
              padding: "0 4px",
              borderRadius: 999,
              background: "var(--rust)",
              color: "var(--paper)",
              fontFamily: "var(--mono)",
              fontSize: 9,
              fontWeight: 700,
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              lineHeight: 1,
            }}
          >
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="head-pill-menu notifications-menu" role="menu" style={{ width: 360, maxWidth: "90vw", padding: 0 }}>
          <div className="row" style={{ padding: "10px 12px", borderBottom: "1px solid var(--hairline)", alignItems: "center" }}>
            <span className="mono-sm" style={{ fontWeight: 600, flex: 1 }}>Notifications</span>
            {items.length > 0 && (
              <button type="button" className="link-btn" onClick={onMarkAll} style={{ fontSize: 11 }}>
                mark all read
              </button>
            )}
          </div>
          {items.length === 0 ? (
            <div style={{ padding: 18, textAlign: "center", color: "var(--ink-3)", fontSize: 12 }}>
              You're all caught up. New activity will show here.
            </div>
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0, maxHeight: 420, overflowY: "auto" }}>
              {items.slice(0, 30).map((n) => {
                const read = (n.read_by || []).length > 0;
                return (
                  <li key={n.id}>
                    <button
                      type="button"
                      onClick={() => onItemClick(n)}
                      disabled={busy === n.id}
                      style={{
                        display: "block",
                        width: "100%",
                        textAlign: "left",
                        padding: "10px 14px",
                        background: read ? "transparent" : "var(--paper-2)",
                        border: 0,
                        borderBottom: "1px solid var(--hairline-2)",
                        cursor: "pointer",
                        font: "inherit",
                        color: "inherit",
                      }}
                    >
                      <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                        <span style={{ fontWeight: 600, fontSize: 12.5 }}>{n.title}</span>
                        <span style={{ marginLeft: "auto", fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-4)" }}>
                          {n.kind}
                        </span>
                      </div>
                      {n.body && (
                        <div style={{ fontSize: 12, color: "var(--ink-2)", marginTop: 2, lineHeight: 1.45 }}>
                          {n.body}
                        </div>
                      )}
                      {n.actor_email && (
                        <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--ink-3)", marginTop: 4 }}>
                          {n.actor_email}
                        </div>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};

// Settings popover anchored to the gear icon in the sidebar footer.
// Replaces the previous floating ThemeBar that was always visible
// bottom-right and obscured the bottom rows of every page. Click the
// gear, the popover appears just above it, click outside (or any
// row) to close.
const SettingsMenu: React.FC<{ onRoute?: (id: string) => void }> = ({ onRoute }) => {
  const [open, setOpen] = useState(false);
  const [, force] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Re-render on prefs:change so the popover labels reflect the
  // current theme / density / rail state without re-mounting.
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    window.addEventListener("prefs:change", fn);
    return () => window.removeEventListener("prefs:change", fn);
  }, []);

  // Click-outside to close.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  const theme = Prefs.theme();
  const density = Prefs.density();
  const railState = Prefs.rail();

  const cycleDensity = () => {
    const order: Array<"compact" | "normal" | "comfortable"> = ["compact", "normal", "comfortable"];
    Prefs.setDensity(order[(order.indexOf(density) + 1) % order.length]);
  };

  return (
    <div ref={wrapRef} className="settings-menu-wrap">
      <button
        className="btn ghost icon sm"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Settings"
        title="Settings"
        onClick={() => setOpen((v) => !v)}
      >
        {Icon.settings}
      </button>
      {open && (
        <div className="settings-menu" role="menu">
          <button className="settings-menu-row" role="menuitem" onClick={() => Prefs.toggleTheme()}>
            <span className="settings-menu-ic">{Icon.eye}</span>
            <span className="settings-menu-lbl">Theme</span>
            <span className="settings-menu-val">{theme}</span>
          </button>
          <button className="settings-menu-row" role="menuitem" onClick={cycleDensity}>
            <span className="settings-menu-ic">{Icon.layers}</span>
            <span className="settings-menu-lbl">Density</span>
            <span className="settings-menu-val">{density}</span>
          </button>
          <button className="settings-menu-row" role="menuitem" onClick={() => Prefs.toggleRail()}>
            <span className="settings-menu-ic">{Icon.arrowL}</span>
            <span className="settings-menu-lbl">Sidebar</span>
            <span className="settings-menu-val">{railState === "collapsed" ? "collapsed" : "expanded"}</span>
          </button>
          <div className="settings-menu-sep" />
          <button
            className="settings-menu-row"
            role="menuitem"
            onClick={() => { setOpen(false); onRoute?.("admin"); }}
          >
            <span className="settings-menu-ic">{Icon.settings}</span>
            <span className="settings-menu-lbl">Open settings</span>
          </button>
          <button
            className="settings-menu-row settings-menu-danger"
            role="menuitem"
            onClick={() => {
              if (typeof window !== "undefined" && window.confirm?.("Sign out of Anvil?") === false) return;
              setOpen(false);
              signOutAndRedirect();
            }}
          >
            <span className="settings-menu-ic">{Icon.logout}</span>
            <span className="settings-menu-lbl">Sign out</span>
          </button>
        </div>
      )}
    </div>
  );
};

export interface ShellTenant { code?: string; }

export interface RoleOption { id: string; label: string; short: string; }

export interface ShellProps {
  children?: ReactNode;
  route?: string;
  onRoute?: (id: string) => void;
  role?: RoleEntry;
  /** Full list of roles the user can switch into. */
  roleOptions?: RoleOption[];
  /** Called with the chosen role id when the user picks from the menu. */
  onRoleChange?: (roleId: string) => void;
  /** Legacy fallback when no roleOptions are provided. */
  onRole?: () => void;
  tenant?: ShellTenant;
  onTenant?: () => void;
  onCmdK?: () => void;
  onThread?: () => void;
  crumb?: string[];
  nav?: NavGroup[];
  telemetry?: ShellTelemetry;
}

// Anchored dropdown menu. Used by the role pill in the header. We
// keep it inline here instead of building a generic <Popover> because
// it's the only place the shell needs one, and a portal-based primitive
// would be overkill for a 200x320 anchored menu.
interface PillMenuProps {
  trigger: ReactNode;
  triggerClassName?: string;
  triggerTitle?: string;
  options: Array<{ id: string; label: string; right?: ReactNode; active?: boolean }>;
  onSelect: (id: string) => void;
  align?: "start" | "end";
}

const PillMenu: React.FC<PillMenuProps> = ({
  trigger, triggerClassName, triggerTitle, options, onSelect, align = "end",
}) => {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close on click-outside or Escape. We listen on capture so a click
  // on a menu item still fires the item handler before the menu closes.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="head-pill-wrap" ref={wrapRef}>
      <button
        type="button"
        className={triggerClassName || "head-pill"}
        title={triggerTitle}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {trigger}
      </button>
      {open && (
        <div className="head-pill-menu" role="menu" style={align === "start" ? { left: 0, right: "auto" } : undefined}>
          {options.map((opt) => (
            <button
              key={opt.id}
              type="button"
              role="menuitem"
              className={"head-pill-menu-item" + (opt.active ? " active" : "")}
              onClick={() => { onSelect(opt.id); setOpen(false); }}
            >
              <span>{opt.label}</span>
              {opt.right && <span className="badge">{opt.right}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

const resolveBadge = (id: string, item: { badge?: NavBadge }, badges?: BadgeMap): NavBadge | undefined => {
  // Live counts from telemetry win when present. Otherwise no badge.
  // We deliberately do NOT fall back to the static badge defined on
  // the nav item: those values were demo placeholders that disagreed
  // with the real data, which was the bug.
  return badges?.[id];
};

const formatRate = (n: number | undefined, digits = 2): string => {
  if (n == null || Number.isNaN(n)) return "-";
  return n.toFixed(digits);
};

const IntegrationPill: React.FC<{ label: string; configured: boolean }> = ({ label, configured }) => (
  <span>
    {label}{" "}
    <span style={{ color: configured ? "var(--sage)" : "var(--ink-4)" }}>
      {configured ? "configured" : "not configured"}
    </span>
  </span>
);

export const Shell: React.FC<ShellProps> = ({
  children, route, onRoute,
  role, roleOptions, onRoleChange, onRole,
  tenant, onTenant,
  onCmdK, onThread,
  crumb, nav, telemetry,
}) => {
  const badges = telemetry?.badges;
  const session = telemetry?.session;
  const fx = telemetry?.fx;
  const drafts = telemetry?.drafts ?? 0;
  const time = telemetry?.time || "";
  const version = telemetry?.version || "dev";

  // Universal "back to list": any record/sub-view opens as #/<object>?<params>
  // (e.g. #/so?id=, #/quotes?id=, #/customers?id=). When params are present we
  // show a back button that strips them, returning to that object's list.
  const inRecordView = (h: string) => /#\/[^?]+\?.+/.test(h || "");
  const [recordView, setRecordView] = useState(() => inRecordView(typeof window !== "undefined" ? window.location.hash : ""));
  useEffect(() => {
    const on = () => setRecordView(inRecordView(window.location.hash || ""));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const backToList = () => {
    const base = (window.location.hash.match(/#\/([^?]+)/) || [])[1] || route;
    if (base) { try { window.location.hash = "#/" + base; } catch (_) { /* noop */ } }
  };

  return (
  <div className="app">
    {/* Skip-to-main link: visible only when focused via keyboard,
     * lets users bypass the nav. Required for WCAG 2.4.1 (Bypass
     * Blocks). The target id matches the <main id="app-main"> below. */}
    <a className="skip-link" href="#app-main">Skip to main content</a>
    <header className="app-head">
      <div className="brand">
        <div className="brand-mark">
          {/* Anvil mark (compact 14px variant): struck-anvil + circle spark.
              Body inherits color from .brand-mark container; spark uses --accent. */}
          <svg viewBox="0 0 32 32" width="14" height="14" role="img" aria-hidden="true">
            <path fill="currentColor" d="M 6 13 L 2 13 L 4 10 L 10 10 L 10 8 L 26 8 L 26 13 L 22 13 L 21 17 L 24 17 L 24 20 L 22 20 L 22 24 L 28 24 L 28 27 L 4 27 L 4 24 L 10 24 L 10 20 L 8 20 L 8 17 L 11 17 Z" />
            <circle cx="20.5" cy="5" r="2.4" fill="var(--accent)" />
          </svg>
        </div>
        <span className="name">Anvil</span>
      </div>

      {recordView && (
        <button type="button" className="head-pill" title="Back to list" aria-label="Back to list"
          onClick={backToList} style={{ marginRight: 2 }}>
          ← Back
        </button>
      )}

      <div className="crumb">
        {crumb?.map((c, i) => (
          <React.Fragment key={i}>
            {i > 0 && <span className="crumb-sep">/</span>}
            {i === crumb.length - 1 ? <b>{c}</b> : <span>{c}</span>}
          </React.Fragment>
        ))}
      </div>

      <button type="button" className="head-search" onClick={onCmdK} aria-label="Open search (Cmd+K)">
        {Icon.search}
        <span>Search orders, customers, items, jobs…</span>
        <kbd>⌘K</kbd>
      </button>

      <button type="button" className="head-pill tenant" onClick={onTenant} title="Switch tenant" aria-label={`Switch tenant (current: ${tenant?.code || "OBARA-IN"})`}>
        <Dot k="live" />
        {tenant?.code || "OBARA-IN"}
        {Icon.caret}
      </button>

      {roleOptions && roleOptions.length > 0 && onRoleChange ? (
        <PillMenu
          triggerClassName="head-pill role"
          triggerTitle="Switch role"
          trigger={<>
            <span style={{ fontFamily: "var(--mono)", color: "var(--ink-3)" }}>{role?.short || "ENG"}</span>
            <span style={{ borderLeft: "1px solid var(--hairline)", paddingLeft: 8, marginLeft: 2 }}>
              {role?.label || "Sales Engineer"}
            </span>
            {Icon.caret}
          </>}
          options={roleOptions.map((r) => ({
            id: r.id,
            label: r.label,
            right: r.short,
            active: r.id === role?.id,
          }))}
          onSelect={onRoleChange}
        />
      ) : (
        <button type="button" className="head-pill role" onClick={onRole} title="Switch role" aria-label={`Switch role (current: ${role?.label || "Sales Engineer"})`}>
          <span style={{ fontFamily: "var(--mono)", color: "var(--ink-3)" }}>{role?.short || "ENG"}</span>
          <span style={{ borderLeft: "1px solid var(--hairline)", paddingLeft: 8, marginLeft: 2 }}>
            {role?.label || "Sales Engineer"}
          </span>
          {Icon.caret}
        </button>
      )}

      <RecentMenu />

      <button className="head-pill" title="Thread drawer" onClick={onThread}>
        {Icon.history} Thread
      </button>

      <NotificationsBell onRoute={onRoute} isAdminLike={role?.id === "admin" || role?.id === "operator"} />
    </header>

    <aside className="app-side">
      <nav className="nav">
        {(nav || []).map((group) => (
          <div className="nav-section" key={group.label}>
            <div className="nav-section-label">{group.label}</div>
            {group.items.map((item) => {
              const badge = resolveBadge(item.id, item, badges);
              return (
                <button
                  type="button"
                  key={item.id}
                  className={`nav-item ${route === item.id ? "active" : ""}`}
                  onClick={() => onRoute?.(item.id)}
                  aria-current={route === item.id ? "page" : undefined}
                >
                  <span className="nav-icon">{item.icon}</span>
                  <span className="nav-label">{item.label}</span>
                  {badge && (
                    <span className={`nav-badge ${badge.k || ""}`}>{badge.v}</span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </nav>
      <div className="side-foot">
        <div className="av">{session?.initials || "GU"}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11, fontFamily: "var(--sans)", color: "var(--ink-2)", fontWeight: 600 }}>
            {session?.displayName || "Guest"}
          </div>
          <div style={{ fontSize: 10, fontFamily: "var(--mono)", color: "var(--ink-4)" }}>
            {role?.label || "Sales Engineer"}
          </div>
        </div>
        <SettingsMenu onRoute={onRoute} />
      </div>
    </aside>

    {/* Keying on `route` triggers the .route-enter animation each time
        the user navigates. The wrapper is a transparent block so the
        animation has a box to apply to without disturbing the screen's
        own layout primitives. Reduced-motion users get no animation
        per the @media rule in styles.css. */}
    <main className="app-main" id="app-main" tabIndex={-1}>
      <div className="route-enter" key={route || "default"}>
        {children}
      </div>
    </main>

    <footer className="app-dock">
      <span>
        <Dot k={telemetry?.dbOk === true ? "live" : telemetry?.dbOk === false ? "warn" : "ghost"} />
        {telemetry?.dbOk === true ? "DB reachable" : telemetry?.dbOk === false ? "DB unreachable" : "DB checking…"}
      </span>
      <span style={{ color: "var(--ink-4)" }}>·</span>
      <span>v{version}</span>
      <span style={{ color: "var(--ink-4)" }}>·</span>
      {telemetry?.integrations?.find((i) => i.id === "tally") && (
        <>
          <IntegrationPill
            label="Tally bridge"
            configured={!!telemetry.integrations.find((i) => i.id === "tally")?.configured}
          />
          <span style={{ color: "var(--ink-4)" }}>·</span>
        </>
      )}
      {telemetry?.integrations?.find((i) => i.id === "clamav") && (
        <>
          <IntegrationPill
            label="ClamAV"
            configured={!!telemetry.integrations.find((i) => i.id === "clamav")?.configured}
          />
          <span style={{ color: "var(--ink-4)" }}>·</span>
        </>
      )}
      <span>
        FX
        {fx?.usd != null ? <> · USD {formatRate(fx.usd)}</> : <span style={{ color: "var(--ink-4)" }}> n/a</span>}
        {fx?.jpy != null && <> · JPY {formatRate(fx.jpy)}</>}
      </span>
      <span style={{ marginLeft: "auto" }}>{drafts} draft{drafts === 1 ? "" : "s"} · {time}</span>
    </footer>
  </div>
  );
};

// CmdK + ThreadDrawer were ported to dedicated files
// (components/CmdK.tsx, components/ThreadDrawer.tsx) with real backend
// wiring. Re-exports below preserve any older callers that imported
// from the Shell module; new code should import the wired versions
// directly.
export { CmdK } from "./CmdK";
export type { CmdKProps } from "./CmdK";
export { ThreadDrawer } from "./ThreadDrawer";
export type { ThreadDrawerProps } from "./ThreadDrawer";
