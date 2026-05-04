// Mobile shell. Replaces the desktop Shell when the viewport drops
// below 768px. Prioritises four flows that matter on the go:
// My Day, Inbox, Approvals, Sales Orders. Everything else lives
// behind the "More" tab which opens a full-screen drawer of every
// nav item the user has access to.

import React, { ReactNode, useEffect, useMemo, useState } from "react";
import { Icon } from "../lib/icons";
import type { NavGroup, RoleEntry } from "../lib/nav";
import type { ShellTelemetry } from "../lib/telemetry";

const PRIMARY_TABS: Array<{ id: string; label: string; icon: ReactNode }> = [
  { id: "home",      label: "My Day",   icon: Icon.bolt },
  { id: "intake",    label: "Inbox",    icon: Icon.inbox },
  { id: "approvals", label: "Approve",  icon: Icon.shieldCheck },
  { id: "so",        label: "SOs",      icon: Icon.layers },
  { id: "__more",    label: "More",     icon: Icon.more },
];

export interface MobileShellProps {
  children?: ReactNode;
  route?: string;
  onRoute?: (id: string) => void;
  role?: RoleEntry;
  nav?: NavGroup[];
  telemetry?: ShellTelemetry;
  crumb?: string[];
}

export const MobileShell: React.FC<MobileShellProps> = ({
  children, route, onRoute, role, nav, telemetry, crumb,
}) => {
  const [moreOpen, setMoreOpen] = useState(false);
  const session = telemetry?.session;
  const time = telemetry?.time;
  const navItems = useMemo(() => (nav || []).flatMap((g) => g.items), [nav]);

  // Auto-close the More drawer on every route change so the user
  // doesn't have to dismiss it manually.
  useEffect(() => { setMoreOpen(false); }, [route]);

  const onPrimaryClick = (id: string) => {
    if (id === "__more") {
      setMoreOpen((v) => !v);
      return;
    }
    setMoreOpen(false);
    onRoute?.(id);
  };

  return (
    <div className="app app-mobile">
      <header className="app-mobile-head">
        <div className="brand">
          <div className="brand-mark">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
              <path d="M3 6h11l-2 4h6v3H8l-2 4H3l2-4H2V9h4l-3-3Z"/>
            </svg>
          </div>
          <span className="name">Anvil</span>
        </div>
        <div className="app-mobile-crumb">
          {(crumb || []).slice(-1)[0] || "Anvil"}
        </div>
        <div className="app-mobile-id" title={session?.email || "Guest"}>
          {session?.initials || "GU"}
        </div>
      </header>

      <main className="app-mobile-main" id="main" tabIndex={-1}>
        {children}
      </main>

      {moreOpen && (
        <div className="app-mobile-more" role="dialog" aria-modal="true">
          <div className="app-mobile-more-head">
            <div>
              <div className="h2">{session?.displayName || "Guest"}</div>
              <div className="mono-sm" style={{ color: "var(--ink-3)" }}>
                {role?.label || "Sales Engineer"}
                {time ? "  ·  " + time : ""}
              </div>
            </div>
            <button className="head-pill" onClick={() => setMoreOpen(false)} aria-label="Close menu">
              {Icon.x}
            </button>
          </div>
          <nav className="app-mobile-more-nav">
            {(nav || []).map((group) => (
              <div className="app-mobile-more-group" key={group.label}>
                <div className="app-mobile-more-label">{group.label}</div>
                {group.items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={"app-mobile-more-item" + (route === item.id ? " active" : "")}
                    onClick={() => onPrimaryClick(item.id)}
                  >
                    <span className="nav-icon">{item.icon}</span>
                    <span className="nav-label">{item.label}</span>
                    {item.badge && (
                      <span className={"nav-badge " + (item.badge.k || "")}>{item.badge.v}</span>
                    )}
                  </button>
                ))}
              </div>
            ))}
          </nav>
        </div>
      )}

      <nav className="app-mobile-tabbar" role="tablist">
        {PRIMARY_TABS.map((t) => {
          const active = t.id === "__more"
            ? moreOpen
            : (route === t.id || (t.id === "so" && route === "so"));
          // navItems uses nav (filtered by RBAC) so we only render a
          // primary tab if the user can actually access it. Hide
          // unreachable primaries; "more" is always shown.
          if (t.id !== "__more" && !navItems.some((n) => n.id === t.id)) return null;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={active}
              className={"app-mobile-tab" + (active ? " active" : "")}
              onClick={() => onPrimaryClick(t.id)}
            >
              <span className="app-mobile-tab-icon">{t.icon}</span>
              <span className="app-mobile-tab-label">{t.label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
};
