// Route table for the Vite v3 app.
//
// Each top-level nav id maps to a `resolve(params)` function that returns
// a lazy React component. The resolver runs every render so screens can
// branch on URL params (e.g. `so?id=X` -> SOWorkspace, `so?view=history`
// -> SOHistory). Each lazy() is created once at module load so router
// re-renders do not recreate Suspense boundaries.
//
// Adding a route: write src/v3-app/screens/<id>.jsx with a default export,
// register a `lazy(() => import("./screens/<id>"))` here, and slot it
// into the matching resolver. Screens not yet ported to the Vite app fall
// back to a stub that links the user to the legacy `/v3.html` route.

import React, { lazy } from "react";

// One lazy component per screen file. Vite emits one chunk per entry.
const screens = {
  // Workflows. The legacy build had role-specialized home variants
  // (HomeManager, HomeAdmin) sourced from the static demo file
  // src/v3/screens/screens-home.jsx. Those were never wired to live
  // data; they showed hard-coded customer names + dates. After cutover
  // every role lands on the wired engineer home, which is data-driven
  // and correct for all roles. Role-tailored widgets (manager approvals
  // queue, admin diagnostics) are tracked as a migration follow-up.
  home:               lazy(() => import("./screens/home")),
  intake:             lazy(() => import("./screens/intake")),
  soList:             lazy(() => import("./screens/orders")),
  soWorkspace:        lazy(() => import("./screens/so-workspace")),
  soIntake:           lazy(() => import("./screens/so-intake")),
  soHistory:          lazy(() => import("./screens/so-history")),
  internal:           lazy(() => import("./screens/internal-sos")),
  approvals:          lazy(() => import("./screens/approvals")),
  // Sales
  leads:              lazy(() => import("./screens/leads")),
  opps:               lazy(() => import("./screens/opps")),
  projects:           lazy(() => import("./screens/projects")),
  shipments:          lazy(() => import("./screens/shipments")),
  // Procurement
  spo:                lazy(() => import("./screens/source-pos")),
  spares:             lazy(() => import("./screens/spares")),
  // Service
  svcVisits:          lazy(() => import("./screens/service-visits")),
  amc:                lazy(() => import("./screens/amc")),
  car:                lazy(() => import("./screens/car")),
  // Finance
  tallyPush:          lazy(() => import("./screens/tally-push")),
  tallyMasters:       lazy(() => import("./screens/tally-masters")),
  tallyReconcile:     lazy(() => import("./screens/tally-reconcile")),
  einvoice:           lazy(() => import("./screens/einvoice")),
  invoices:           lazy(() => import("./screens/invoices")),
  cost:               lazy(() => import("./screens/cost")),
  // Audit P8.5: new screens for the P7.5 / P7.6 / P7.7 surfaces.
  creditNotes:        lazy(() => import("./screens/credit-notes")),
  recurringInvoices:  lazy(() => import("./screens/recurring-invoices")),
  ewayBills:          lazy(() => import("./screens/eway-bills")),
  // Data
  customers:          lazy(() => import("./screens/customers")),
  items:              lazy(() => import("./screens/items")),
  bomImport:          lazy(() => import("./screens/bom-import")),
  gunsViewer:         lazy(() => import("./screens/guns-viewer")),
  equipmentHierarchy: lazy(() => import("./screens/equipment-hierarchy")),
  jbmImporter:        lazy(() => import("./screens/jbm-importer")),
  graph:              lazy(() => import("./screens/graph")),
  forecasts:          lazy(() => import("./screens/forecasts")),
  // Quality
  evals:              lazy(() => import("./screens/evals")),
  studio:             lazy(() => import("./screens/studio")),
  anomaly:            lazy(() => import("./screens/anomaly")),
  duplicates:         lazy(() => import("./screens/duplicates")),
  // Audit P9.5: customer-level duplicate-merge screen.
  customerDuplicates: lazy(() => import("./screens/customer-duplicates")),
  agents:             lazy(() => import("./screens/agents")),
  // Comms & Security
  comms:              lazy(() => import("./screens/comms")),
  email:              lazy(() => import("./screens/email")),
  security:           lazy(() => import("./screens/security")),
  // Admin
  audit:              lazy(() => import("./screens/audit")),
  admin:              lazy(() => import("./screens/admin")),
  // Auth + onboarding (no nav entry)
  connect:            lazy(() => import("./screens/connect")),
  onboarding:         lazy(() => import("./screens/onboarding")),
  landing:            lazy(() => import("./screens/landing")),
  signin:             lazy(() => import("./screens/signin")),
  resetPassword:      lazy(() => import("./screens/reset-password")),
  documents:          lazy(() => import("./screens/documents")),
  pipelineKanban:     lazy(() => import("./screens/pipeline-kanban")),
  delays:             lazy(() => import("./screens/delays")),
  formatGuide:        lazy(() => import("./screens/format-guide")),
};

// Resolver per top-level nav id. Each receives `{ params, role }` where
// `params` is a URLSearchParams view of the hash query.
export const RESOLVERS = {
  home:        () => screens.home,
  intake:      () => screens.intake,
  so:          ({ params }) => {
    const view = params.get("view");
    if (view === "history") return screens.soHistory;
    if (params.get("id")) return screens.soWorkspace;
    if (params.get("new")) return screens.soIntake;
    return screens.soList;
  },
  internal:    () => screens.internal,
  approvals:   () => screens.approvals,
  leads:       () => screens.leads,
  opps:        () => screens.opps,
  projects:    () => screens.projects,
  shipments:   () => screens.shipments,
  spo:         () => screens.spo,
  spares:      () => screens.spares,
  "svc-visits":() => screens.svcVisits,
  amc:         () => screens.amc,
  car:         () => screens.car,
  tally:       ({ params }) => {
    const sub = params.get("sub");
    if (sub === "masters")   return screens.tallyMasters;
    if (sub === "reconcile") return screens.tallyReconcile;
    return screens.tallyPush;
  },
  einvoice:    () => screens.einvoice,
  invoices:    () => screens.invoices,
  cost:        () => screens.cost,
  // Audit P8.5: P7.5 / P7.6 / P7.7 surfaces.
  "credit-notes":      () => screens.creditNotes,
  "recurring-invoices":() => screens.recurringInvoices,
  "eway-bills":        () => screens.ewayBills,
  customers:   () => screens.customers,
  items:       ({ params }) => {
    const view = params.get("view");
    if (view === "import")     return screens.bomImport;
    if (view === "guns")       return screens.gunsViewer;
    if (view === "equipment")  return screens.equipmentHierarchy;
    if (view === "jbm-import") return screens.jbmImporter;
    return screens.items;
  },
  graph:       () => screens.graph,
  forecasts:   () => screens.forecasts,
  evals:       () => screens.evals,
  studio:      () => screens.studio,
  anomaly:     () => screens.anomaly,
  duplicates:  () => screens.duplicates,
  "customer-duplicates": () => screens.customerDuplicates,
  agents:      () => screens.agents,
  comms:       () => screens.comms,
  email:       () => screens.email,
  security:    () => screens.security,
  audit:       () => screens.audit,
  admin:       () => screens.admin,
  connect:     () => screens.connect,
  onboarding:  () => screens.onboarding,
  landing:     () => screens.landing,
  signin:      () => screens.signin,
  reset:       () => screens.resetPassword,
  documents:   () => screens.documents,
  "pipeline-kanban": () => screens.pipelineKanban,
  delays:      () => screens.delays,
  "format-guide": () => screens.formatGuide,
};

export const ROUTE_IDS = Object.keys(RESOLVERS);

export const DEFAULT_ROUTE = "home";

// Read a URLSearchParams view of the current hash query.
export const readHashParams = () => {
  const hash = (typeof window !== "undefined" && window.location.hash) || "";
  const qpos = hash.indexOf("?");
  if (qpos < 0) return new URLSearchParams("");
  return new URLSearchParams(hash.slice(qpos + 1));
};
