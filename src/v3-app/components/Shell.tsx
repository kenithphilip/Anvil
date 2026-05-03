// Application shell: header, sidebar, dock. ESM port of src/v3/shell.jsx
// `Shell` component. CmdK + ThreadDrawer overlays live alongside.
//
// Pure presentation: every state lives in the parent (App.jsx). The shell
// renders whatever children + nav tree it gets handed.

import React, { ReactNode } from "react";
import { Icon } from "../lib/icons";
import { Dot } from "../lib/primitives";
import type { NavGroup, RoleEntry } from "../lib/nav";

export interface ShellTenant { code?: string; }

export interface ShellProps {
  children?: ReactNode;
  route?: string;
  onRoute?: (id: string) => void;
  role?: RoleEntry;
  onRole?: () => void;
  tenant?: ShellTenant;
  onTenant?: () => void;
  onCmdK?: () => void;
  onThread?: () => void;
  crumb?: string[];
  nav?: NavGroup[];
}

export const Shell: React.FC<ShellProps> = ({
  children, route, onRoute,
  role, onRole, tenant, onTenant,
  onCmdK, onThread,
  crumb, nav,
}) => (
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

      <div className="head-pill role" onClick={onRole} title="Switch role">
        <span style={{ fontFamily: "var(--mono)", color: "var(--ink-3)" }}>{role?.short || "ENG"}</span>
        <span style={{ borderLeft: "1px solid var(--hairline)", paddingLeft: 8, marginLeft: 2 }}>
          {role?.label || "Sales Engineer"}
        </span>
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
        {(nav || []).map((group) => (
          <div className="nav-section" key={group.label}>
            <div className="nav-section-label">{group.label}</div>
            {group.items.map((item) => (
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

    <main className="app-main" id="main" tabIndex={-1}>{children}</main>

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

// CmdK + ThreadDrawer were ported to dedicated files
// (components/CmdK.tsx, components/ThreadDrawer.tsx) with real backend
// wiring. Re-exports below preserve any older callers that imported
// from the Shell module; new code should import the wired versions
// directly.
export { CmdK } from "./CmdK";
export type { CmdKProps } from "./CmdK";
export { ThreadDrawer } from "./ThreadDrawer";
export type { ThreadDrawerProps } from "./ThreadDrawer";
