// Sidebar nav tree + role list. ESM port of the constants that lived at
// the top of src/v3/shell.jsx. The icon references resolve at module load,
// so this file imports from icons.jsx and is not tree-shakable past the
// icons that ship in NAV.

import { ReactNode } from "react";
import { Icon } from "./icons";

export interface NavBadge { v: string; k?: string; }
export interface NavItem { id: string; label: string; icon: ReactNode; badge?: NavBadge; }
export interface NavGroup { label: string; items: NavItem[]; }
export interface RoleEntry { id: string; label: string; short: string; }

export const NAV: NavGroup[] = [
  {
    label: "Workflows",
    items: [
      // Badges are populated live from telemetry. See lib/telemetry.ts.
      { id: "home",      label: "My Day",        icon: Icon.bolt },
      { id: "intake",    label: "Inbox",         icon: Icon.inbox },
      { id: "so",        label: "Sales Orders",  icon: Icon.layers },
      { id: "internal",  label: "Internal SOs",  icon: Icon.cycle },
      { id: "approvals", label: "Approvals",     icon: Icon.shieldCheck },
    ],
  },
  {
    label: "Sales",
    items: [
      { id: "leads",     label: "Leads",         icon: Icon.flame },
      { id: "opps",      label: "Opportunities", icon: Icon.signal },
      { id: "projects",  label: "Projects",      icon: Icon.briefcase },
      { id: "shipments", label: "Shipments",     icon: Icon.truck },
    ],
  },
  {
    label: "Procurement",
    items: [
      { id: "spo",       label: "Source POs",    icon: Icon.pkg },
      { id: "spares",    label: "Spares Matrix", icon: Icon.layers },
    ],
  },
  {
    label: "Service",
    items: [
      { id: "svc-visits",label: "Service Visits",icon: Icon.wrench },
      { id: "amc",       label: "AMC Schedule",  icon: Icon.cal },
      { id: "car",       label: "CAR Reports",   icon: Icon.flag },
    ],
  },
  {
    label: "Finance",
    items: [
      { id: "tally",     label: "Tally Sync",    icon: Icon.ledger },
      { id: "einvoice",  label: "e-Invoice",     icon: Icon.doc },
      { id: "invoices",  label: "Invoices",      icon: Icon.doc },
      { id: "cost",      label: "Cost & Margin", icon: Icon.cash },
    ],
  },
  {
    label: "Data",
    items: [
      { id: "customers", label: "Customers",     icon: Icon.users },
      { id: "items",     label: "Item Master",   icon: Icon.tag },
      { id: "graph",     label: "Master Data Graph", icon: Icon.graph },
      { id: "forecasts", label: "Forecasts",     icon: Icon.signal },
    ],
  },
  {
    label: "Quality",
    items: [
      { id: "evals",     label: "Eval Suites",   icon: Icon.brain },
      { id: "studio",    label: "Profile Studio",icon: Icon.diff },
      { id: "anomaly",   label: "Anomaly Compute", icon: Icon.alert },
      { id: "duplicates",label: "Duplicates",    icon: Icon.layers },
      { id: "agents",    label: "Agents",        icon: Icon.bolt },
    ],
  },
  {
    label: "Comms & Security",
    items: [
      { id: "comms",     label: "Communications",icon: Icon.send },
      { id: "email",     label: "Email Triage",  icon: Icon.inbox },
      { id: "security",  label: "Security",      icon: Icon.shield },
    ],
  },
  {
    label: "Admin",
    items: [
      { id: "audit",     label: "Audit",         icon: Icon.history },
      { id: "admin",     label: "Admin Center",  icon: Icon.settings },
    ],
  },
];

// Display tuples for each canonical RBAC role. The id MUST match the
// id stored by RBAC.setRole / read by RBAC.role(); the previous file
// used loose short ids ("engineer", "manager") which never matched the
// canonical ones ("sales_engineer", "sales_manager"), so the lookup
// in app.tsx fell back to `slice(0,3).toUpperCase()` for both sales_*
// roles, producing two "SAL" pills that the user could not tell apart.
export const ROLES: RoleEntry[] = [
  { id: "sales_engineer", label: "Sales Engineer", short: "ENG" },
  { id: "sales_manager",  label: "Sales Manager",  short: "MGR" },
  { id: "procurement",    label: "Procurement",    short: "PRO" },
  { id: "finance",        label: "Finance",        short: "FIN" },
  { id: "admin",          label: "Admin",          short: "ADM" },
  { id: "operator",       label: "Operator",       short: "OPS" },
  { id: "viewer",         label: "Viewer",         short: "VWR" },
];

// Build a breadcrumb from a nav id by walking NAV.
export const crumbFor = (navId: string, navTree: NavGroup[] = NAV): string[] => {
  const group = navTree.find((g) => g.items.some((i) => i.id === navId));
  const item = group?.items.find((i) => i.id === navId);
  return group && item ? ["Anvil", group.label, item.label] : ["Anvil"];
};
