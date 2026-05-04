// Application shell: header, sidebar, dock. ESM port of src/v3/shell.jsx
// `Shell` component. CmdK + ThreadDrawer overlays live alongside.
//
// Pure presentation: every state lives in the parent (App.tsx). The shell
// renders whatever children, nav tree, and live telemetry it gets handed.

import React, { ReactNode, useEffect, useRef, useState } from "react";
import { Icon } from "../lib/icons";
import { Dot } from "../lib/primitives";
import type { NavGroup, RoleEntry, NavBadge } from "../lib/nav";
import type { ShellTelemetry, BadgeMap } from "../lib/telemetry";

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

  return (
  <div className="app">
    <header className="app-head">
      <div className="brand">
        <div className="brand-mark">
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
        <div className="head-pill role" onClick={onRole} title="Switch role">
          <span style={{ fontFamily: "var(--mono)", color: "var(--ink-3)" }}>{role?.short || "ENG"}</span>
          <span style={{ borderLeft: "1px solid var(--hairline)", paddingLeft: 8, marginLeft: 2 }}>
            {role?.label || "Sales Engineer"}
          </span>
          {Icon.caret}
        </div>
      )}

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
        {(nav || []).map((group) => (
          <div className="nav-section" key={group.label}>
            <div className="nav-section-label">{group.label}</div>
            {group.items.map((item) => {
              const badge = resolveBadge(item.id, item, badges);
              return (
                <div
                  key={item.id}
                  className={`nav-item ${route === item.id ? "active" : ""}`}
                  onClick={() => onRoute?.(item.id)}
                >
                  <span className="nav-icon">{item.icon}</span>
                  <span className="nav-label">{item.label}</span>
                  {badge && (
                    <span className={`nav-badge ${badge.k || ""}`}>{badge.v}</span>
                  )}
                </div>
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
        <button className="btn ghost icon sm" onClick={() => onRoute?.("admin")} title="Settings">{Icon.settings}</button>
      </div>
    </aside>

    <main className="app-main" id="main" tabIndex={-1}>{children}</main>

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
