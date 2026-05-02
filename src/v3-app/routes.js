// Route table for the Vite v3 app.
//
// Each top-level nav id maps to a `resolve(params)` function that returns
// a lazy React component. The resolver runs every render so screens can
// branch on URL params (e.g. `so?id=X` -> SOWorkspace, `so?view=history`
// -> SOHistory). Each lazy() is created once at module load so router
// re-renders do not recreate Suspense boundaries.
//
// Adding a route: write src/v3-app/screens/<id>.jsx with a default export,
// register a `lazy(() => import("./screens/<id>.jsx"))` here, and slot it
// into the matching resolver. Screens not yet ported to the Vite app fall
// back to a stub that links the user to the legacy `/v3.html` route.

import React, { lazy } from "react";

// One lazy component per screen file. Vite emits one chunk per entry.
const screens = {
  // Workflows
  home:               lazy(() => import("./screens/home.jsx")),
  homeManager:        lazy(() => import("./screens/home-manager.jsx")),
  homeAdmin:          lazy(() => import("./screens/home-admin.jsx")),
  intake:             lazy(() => import("./screens/intake.jsx")),
  soList:             lazy(() => import("./screens/orders.jsx")),
  soWorkspace:        lazy(() => import("./screens/so-workspace.jsx")),
  soIntake:           lazy(() => import("./screens/so-intake.jsx")),
  soHistory:          lazy(() => import("./screens/so-history.jsx")),
  internal:           lazy(() => import("./screens/internal-sos.jsx")),
  approvals:          lazy(() => import("./screens/approvals.jsx")),
  // Sales
  leads:              lazy(() => import("./screens/leads.jsx")),
  opps:               lazy(() => import("./screens/opps.jsx")),
  projects:           lazy(() => import("./screens/projects.jsx")),
  shipments:          lazy(() => import("./screens/shipments.jsx")),
  // Procurement
  spo:                lazy(() => import("./screens/source-pos.jsx")),
  spares:             lazy(() => import("./screens/spares.jsx")),
  // Service
  svcVisits:          lazy(() => import("./screens/service-visits.jsx")),
  amc:                lazy(() => import("./screens/amc.jsx")),
  car:                lazy(() => import("./screens/car.jsx")),
  // Finance
  tallyPush:          lazy(() => import("./screens/tally-push.jsx")),
  tallyMasters:       lazy(() => import("./screens/tally-masters.jsx")),
  tallyReconcile:     lazy(() => import("./screens/tally-reconcile.jsx")),
  einvoice:           lazy(() => import("./screens/einvoice.jsx")),
  cost:               lazy(() => import("./screens/cost.jsx")),
  // Data
  customers:          lazy(() => import("./screens/customers.jsx")),
  items:              lazy(() => import("./screens/items.jsx")),
  bomImport:          lazy(() => import("./screens/bom-import.jsx")),
  gunsViewer:         lazy(() => import("./screens/guns-viewer.jsx")),
  equipmentHierarchy: lazy(() => import("./screens/equipment-hierarchy.jsx")),
  jbmImporter:        lazy(() => import("./screens/jbm-importer.jsx")),
  graph:              lazy(() => import("./screens/graph.jsx")),
  forecasts:          lazy(() => import("./screens/forecasts.jsx")),
  // Quality
  evals:              lazy(() => import("./screens/evals.jsx")),
  studio:             lazy(() => import("./screens/studio.jsx")),
  anomaly:            lazy(() => import("./screens/anomaly.jsx")),
  duplicates:         lazy(() => import("./screens/duplicates.jsx")),
  // Comms & Security
  comms:              lazy(() => import("./screens/comms.jsx")),
  email:              lazy(() => import("./screens/email.jsx")),
  security:           lazy(() => import("./screens/security.jsx")),
  // Admin
  audit:              lazy(() => import("./screens/audit.jsx")),
  admin:              lazy(() => import("./screens/admin.jsx")),
  // Auth + onboarding (no nav entry)
  connect:            lazy(() => import("./screens/connect.jsx")),
  onboarding:         lazy(() => import("./screens/onboarding.jsx")),
  formatGuide:        lazy(() => import("./screens/format-guide.jsx")),
};

// Lazy-resolve role-aware HomeRoute. Reads RBAC role at render time so a
// role switch instantly shows the right home variant.
const HomeRoute = (params) => {
  const role = params.role || "sales_engineer";
  if (role === "sales_manager") return screens.homeManager;
  if (role === "admin")          return screens.homeAdmin;
  return screens.home;
};

// Resolver per top-level nav id. Each receives `{ params, role }` where
// `params` is a URLSearchParams view of the hash query.
export const RESOLVERS = {
  home:        ({ role }) => HomeRoute({ role }),
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
  cost:        () => screens.cost,
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
  comms:       () => screens.comms,
  email:       () => screens.email,
  security:    () => screens.security,
  audit:       () => screens.audit,
  admin:       () => screens.admin,
  connect:     () => screens.connect,
  onboarding:  () => screens.onboarding,
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
