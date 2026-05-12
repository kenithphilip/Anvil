// Live Cmd+K palette. Replaces the static demo CmdK in Shell.tsx with
// a real backend-search palette:
//
//   1. Recent orders (loaded from ObaraBackend.orders.list).
//   2. As-you-type filter against po_number / quote_number / customer
//      name / id.
//   3. Static "Jump to" entries that route to known nav ids; these
//      respect the active RBAC role so a sales_engineer doesn't see
//      Admin Center in the list.
//   4. Up/Down arrows + Enter for keyboard nav. Esc closes. Click
//      selects.
//
// All copy strings are derived from real data. No hardcoded customer
// names or quote numbers leak into the rendered UI.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../lib/icons";
import { ObaraBackend } from "../lib/api";
import { RBAC } from "../lib/rbac";
import { ageLabel } from "../lib/helpers";

interface CmdKItem {
  ic: React.ReactNode;
  t: string;
  m?: string;
  go: () => void;
}

export interface CmdKProps {
  open: boolean;
  onClose: () => void;
  onJump: (id: string) => void;
}

const NAV_JUMPS: Array<{ id: string; t: string; m: string; ic: keyof typeof Icon }> = [
  { id: "home",     t: "My Day",                 m: "G H", ic: "bolt" },
  { id: "intake",   t: "Inbox",                  m: "G I", ic: "inbox" },
  { id: "so",       t: "Sales Orders",           m: "G S", ic: "layers" },
  { id: "approvals",t: "Approvals",              m: "G P", ic: "shieldCheck" },
  { id: "leads",    t: "Leads",                  m: "G L", ic: "flame" },
  { id: "opps",     t: "Opportunities pipeline", m: "G O", ic: "signal" },
  { id: "tally",    t: "Tally Sync",             m: "G T", ic: "ledger" },
  { id: "evals",    t: "Eval Suites",            m: "G E", ic: "brain" },
  { id: "admin",    t: "Admin Center",           m: "G A", ic: "settings" },
  { id: "audit",    t: "Audit log",              m: "G U", ic: "history" },
];

const ACTIONS: Array<{ id: string; t: string; m: string; ic: keyof typeof Icon; route: string }> = [
  { id: "new-so",       t: "Create Sales Order from PO upload", m: "C O", ic: "plus", route: "#/intake" },
  { id: "new-lead",     t: "Create Lead",                       m: "C L", ic: "plus", route: "#/leads?new=1" },
  { id: "new-visit",    t: "Log Service Visit",                 m: "C V", ic: "plus", route: "#/svc-visits?new=1" },
  { id: "new-customer", t: "Add Customer Format Profile",       m: "C P", ic: "plus", route: "#/customers?new=1" },
  // Per Landing.html design package CmdK list: 5 actions, the 5th
  // is "Send missing-doc nudge" which routes to the comms inbox
  // where the operator can pick a draft and fire it. Specific
  // label ("missing-doc nudge") narrows the use case so it's
  // discoverable: chasing a buyer for a missing GST cert /
  // delivery note / spec sheet rather than any generic ping.
  { id: "send-nudge",   t: "Send missing-doc nudge",            m: "C N", ic: "send", route: "#/comms?new=nudge" },
];

const ordersOf = (resp: any): any[] => {
  if (!resp) return [];
  if (Array.isArray(resp)) return resp;
  if (Array.isArray(resp.orders)) return resp.orders;
  if (Array.isArray(resp.rows)) return resp.rows;
  return [];
};

export const CmdK: React.FC<CmdKProps> = ({ open, onClose, onJump }) => {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [orders, setOrders] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Load recent orders the moment the palette opens. We cap at 20 so a
  // tenant with thousands of orders doesn't ship them all to the
  // browser; the as-you-type filter then picks among them.
  useEffect(() => {
    if (!open) return;
    let cancel = false;
    setLoading(true);
    Promise.resolve(ObaraBackend?.orders?.list?.({ limit: 20 }) ?? [])
      .then((r) => {
        if (cancel) return;
        setOrders(ordersOf(r));
      })
      .catch(() => { if (!cancel) setOrders([]); })
      .finally(() => { if (!cancel) setLoading(false); });
    // Focus the input after the dialog mounts.
    const t = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => { cancel = true; window.clearTimeout(t); };
  }, [open]);

  // Reset on close so the next open starts fresh.
  useEffect(() => {
    if (!open) {
      setQuery("");
      setActive(0);
    }
  }, [open]);

  const filteredOrders = useMemo(() => {
    if (!query.trim()) return orders.slice(0, 8);
    const q = query.toLowerCase();
    return orders
      .filter((o) =>
        (o.po_number || "").toLowerCase().includes(q) ||
        (o.quote_number || "").toLowerCase().includes(q) ||
        (o.customer?.customer_name || "").toLowerCase().includes(q) ||
        (o.id || "").toLowerCase().includes(q),
      )
      .slice(0, 12);
  }, [orders, query]);

  const navItems = useMemo<CmdKItem[]>(() => {
    return NAV_JUMPS
      .filter((n) => RBAC.canRead(n.id))
      .filter((n) => !query || n.t.toLowerCase().includes(query.toLowerCase()))
      .map((n) => ({
        ic: Icon[n.ic],
        t: n.t,
        m: n.m,
        go: () => { onJump(n.id); onClose(); },
      }));
  }, [query, onJump, onClose]);

  const actionItems = useMemo<CmdKItem[]>(() => {
    return ACTIONS
      .filter((a) => !query || a.t.toLowerCase().includes(query.toLowerCase()))
      .map((a) => ({
        ic: Icon[a.ic],
        t: a.t,
        m: a.m,
        go: () => { window.location.hash = a.route; onClose(); },
      }));
  }, [query, onClose]);

  const orderItems = useMemo<CmdKItem[]>(() =>
    filteredOrders.map((o) => ({
      ic: Icon.layers,
      t: [o.po_number || o.quote_number || `draft ${(o.id || "").slice(0, 8)}`,
          o.customer?.customer_name,
          o.updated_at ? ageLabel(o.updated_at) + " ago" : null,
         ].filter(Boolean).join(" · "),
      m: "↵ open",
      go: () => { window.location.hash = `#/so?id=${o.id}`; onClose(); },
    })),
  [filteredOrders, onClose]);

  // Flat list for keyboard navigation: orders first, then jumps, then actions.
  const flat = useMemo(() => [...orderItems, ...navItems, ...actionItems], [orderItems, navItems, actionItems]);

  // Clamp active index when the list shrinks (e.g. search narrows).
  useEffect(() => {
    if (active >= flat.length) setActive(Math.max(0, flat.length - 1));
  }, [flat.length, active]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, flat.length - 1)); return; }
    if (e.key === "ArrowUp")   { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); return; }
    if (e.key === "Enter")     { e.preventDefault(); flat[active]?.go(); return; }
    if (e.key === "Escape")    { e.preventDefault(); onClose(); return; }
  };

  if (!open) return null;

  return (
    <div className="cmdk-bg" onClick={onClose} role="presentation">
      <div
        className="cmdk"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
      >
        <div className="cmdk-input">
          {Icon.search}
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            placeholder={loading ? "Loading orders…" : "Search orders, jump to module, run action…"}
            aria-label="Search"
            aria-autocomplete="list"
            aria-controls="cmdk-list"
            aria-activedescendant={`cmdk-row-${active}`}
          />
          <kbd style={{ fontFamily: "var(--mono)", fontSize: 10, padding: "2px 5px", border: "1px solid var(--hairline)", borderRadius: 2, color: "var(--ink-3)" }}>esc</kbd>
        </div>
        <div className="cmdk-list" id="cmdk-list" role="listbox">
          {orderItems.length > 0 && (
            <CmdKGroup label={query ? "Matching orders" : "Recent orders"}>
              {orderItems.map((it, i) => (
                <CmdKRow key={`o-${i}`} item={it} active={i === active} onMouseEnter={() => setActive(i)} index={i} />
              ))}
            </CmdKGroup>
          )}
          {!loading && orderItems.length === 0 && query && (
            <div className="cmdk-empty" style={{ padding: "12px 16px", color: "var(--ink-3)" }}>
              No orders match "{query}".
            </div>
          )}
          {navItems.length > 0 && (
            <CmdKGroup label="Jump to">
              {navItems.map((it, i) => (
                <CmdKRow key={`n-${i}`} item={it} active={(orderItems.length + i) === active} onMouseEnter={() => setActive(orderItems.length + i)} index={orderItems.length + i} />
              ))}
            </CmdKGroup>
          )}
          {actionItems.length > 0 && (
            <CmdKGroup label="Actions">
              {actionItems.map((it, i) => (
                <CmdKRow key={`a-${i}`} item={it} active={(orderItems.length + navItems.length + i) === active} onMouseEnter={() => setActive(orderItems.length + navItems.length + i)} index={orderItems.length + navItems.length + i} />
              ))}
            </CmdKGroup>
          )}
        </div>
      </div>
    </div>
  );
};

const CmdKGroup: React.FC<{ label: string; children?: React.ReactNode }> = ({ label, children }) => (
  <div>
    <div className="cmdk-group">{label}</div>
    {children}
  </div>
);

const CmdKRow: React.FC<{ item: CmdKItem; active: boolean; index: number; onMouseEnter: () => void }> = ({ item, active, index, onMouseEnter }) => (
  <div
    id={`cmdk-row-${index}`}
    role="option"
    aria-selected={active}
    className={`cmdk-row ${active ? "active" : ""}`}
    onMouseEnter={onMouseEnter}
    onClick={item.go}
  >
    <span className="ic">{item.ic}</span>
    <span>{item.t}</span>
    {item.m && <span className="meta">{item.m}</span>}
  </div>
);
