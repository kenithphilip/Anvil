// Route table for the Vite v3 app.
//
// Each top-level nav id maps to a `resolve(params)` function that returns
// a lazy React component. The resolver runs every render so screens can
// branch on URL params (e.g. `so?id=X` -> SOWorkspace, `so?view=history`
// -> SOHistory). Each lazy() is created once at module load so router
// re-renders do not recreate Suspense boundaries.
//
// Adding a route: write src/v3-app/screens/<id>.jsx with a default export,
// register a `lazyReload(() => import("./screens/<id>"))` here, and slot it
// into the matching resolver. Screens not yet ported to the Vite app fall
// back to a stub that links the user to the legacy `/v3.html` route.

import React, { lazy } from "react";

// Recover from a stale code-split chunk after a deploy. A failed dynamic import
// on an already-open tab almost always means the chunk hash changed under it
// (Vite re-hashes chunks every deploy, and the old file is gone). Reload ONCE to
// fetch the fresh index.html + asset graph; guard against reload loops with a 10s
// sessionStorage window so a genuinely-missing chunk still surfaces to the
// ErrorBoundary instead of looping.
const lazyReload = (factory: () => Promise<any>) =>
  lazy(() =>
    factory().catch((err) => {
      try {
        if (typeof window !== "undefined" && typeof sessionStorage !== "undefined") {
          const KEY = "anvil:chunk-reload-at";
          const last = Number(sessionStorage.getItem(KEY) || 0);
          if (!last || Date.now() - last > 10000) {
            sessionStorage.setItem(KEY, String(Date.now()));
            window.location.reload();
            return new Promise(() => {}); // hold the render while the page reloads
          }
        }
      } catch (_) { /* sessionStorage/window unavailable -> fall through */ }
      throw err;
    })
  );

// One lazy component per screen file. Vite emits one chunk per entry.
const screens = {
  // Workflows. The legacy build had role-specialized home variants
  // (HomeManager, HomeAdmin) sourced from the static demo file
  // src/v3/screens/screens-home.jsx. Those were never wired to live
  // data; they showed hard-coded customer names + dates. After cutover
  // every role lands on the wired engineer home, which is data-driven
  // and correct for all roles. Role-tailored widgets (manager approvals
  // queue, admin diagnostics) are tracked as a migration follow-up.
  home:               lazyReload(() => import("./screens/home")),
  intake:             lazyReload(() => import("./screens/intake")),
  soList:             lazyReload(() => import("./screens/orders")),
  soWorkspace:        lazyReload(() => import("./screens/so-workspace")),
  soIntake:           lazyReload(() => import("./screens/so-intake")),
  soHistory:          lazyReload(() => import("./screens/so-history")),
  internal:           lazyReload(() => import("./screens/internal-sos")),
  approvals:          lazyReload(() => import("./screens/approvals")),
  // Sales
  leads:              lazyReload(() => import("./screens/leads")),
  opps:               lazyReload(() => import("./screens/opps")),
  salesOps:           lazyReload(() => import("./screens/sales-ops")),
  projects:           lazyReload(() => import("./screens/projects")),
  shipments:          lazyReload(() => import("./screens/shipments")),
  // Procurement
  spo:                lazyReload(() => import("./screens/source-pos")),
  spares:             lazyReload(() => import("./screens/spares")),
  // Inventory-planning module (Phase 3).
  inventoryPlanning:    lazyReload(() => import("./screens/inventory-planning")),
  inventoryPlans:       lazyReload(() => import("./screens/inventory-plans")),
  inventoryExceptions:  lazyReload(() => import("./screens/inventory-exceptions")),
  inventoryItem:        lazyReload(() => import("./screens/inventory-item")),
  inventoryAllocations: lazyReload(() => import("./screens/inventory-allocations")),
  inventorySuppliers:   lazyReload(() => import("./screens/inventory-suppliers")),
  // P4: freight consolidation + LCL/FCL bidding.
  logistics:            lazyReload(() => import("./screens/logistics")),
  supplierRfq:          lazyReload(() => import("./screens/supplier-rfq")),
  // Bet 7: BRSR value-chain reporting.
  brsrSupplier:         lazyReload(() => import("./screens/brsr-supplier")),
  brsrBuyerDashboard:   lazyReload(() => import("./screens/brsr-buyer-dashboard")),
  brsrDisclosureDetail: lazyReload(() => import("./screens/brsr-disclosure-detail")),
  // Bet 2: format-template marketplace.
  marketplace:          lazyReload(() => import("./screens/marketplace")),
  // Service
  svcVisits:          lazyReload(() => import("./screens/service-visits")),
  amc:                lazyReload(() => import("./screens/amc")),
  car:                lazyReload(() => import("./screens/car")),
  // Finance
  tallyPush:          lazyReload(() => import("./screens/tally-push")),
  tallyMasters:       lazyReload(() => import("./screens/tally-masters")),
  tallyReconcile:     lazyReload(() => import("./screens/tally-reconcile")),
  einvoice:           lazyReload(() => import("./screens/einvoice")),
  invoices:           lazyReload(() => import("./screens/invoices")),
  // Bet 6: TReDS receivables loop (sandbox).
  treds:              lazyReload(() => import("./screens/treds")),
  // Audit P10 (May 2026): frontend for the quotes-as-first-class
  // object backend that shipped in 068_quotes_object.sql + the
  // /api/quotes/{index,convert,expire,pdf,send} endpoints.
  quotes:             lazyReload(() => import("./screens/quotes")),
  cost:               lazyReload(() => import("./screens/cost")),
  // Audit P8.5: new screens for the P7.5 / P7.6 / P7.7 surfaces.
  creditNotes:        lazyReload(() => import("./screens/credit-notes")),
  recurringInvoices:  lazyReload(() => import("./screens/recurring-invoices")),
  ewayBills:          lazyReload(() => import("./screens/eway-bills")),
  // Data
  customers:          lazyReload(() => import("./screens/customers")),
  items:              lazyReload(() => import("./screens/items")),
  bomImport:          lazyReload(() => import("./screens/bom-import")),
  gunsViewer:         lazyReload(() => import("./screens/guns-viewer")),
  equipmentHierarchy: lazyReload(() => import("./screens/equipment-hierarchy")),
  fmeca:              lazyReload(() => import("./screens/fmeca")),
  warehouses:         lazyReload(() => import("./screens/warehouses")),
  jbmImporter:        lazyReload(() => import("./screens/jbm-importer")),
  graph:              lazyReload(() => import("./screens/graph")),
  forecasts:          lazyReload(() => import("./screens/forecasts")),
  // Quality
  evals:              lazyReload(() => import("./screens/evals")),
  studio:             lazyReload(() => import("./screens/studio")),
  anomaly:            lazyReload(() => import("./screens/anomaly")),
  // Wave 4.1: operator review queue for low-confidence / anomaly /
  // parse-failed docai extractions.
  extractionReview:   lazyReload(() => import("./screens/extraction-review")),
  duplicates:         lazyReload(() => import("./screens/duplicates")),
  // Audit P9.5: customer-level duplicate-merge screen.
  customerDuplicates: lazyReload(() => import("./screens/customer-duplicates")),
  agents:             lazyReload(() => import("./screens/agents")),
  // Comms & Security
  comms:              lazyReload(() => import("./screens/comms")),
  email:              lazyReload(() => import("./screens/email")),
  security:           lazyReload(() => import("./screens/security")),
  // DEFERRED_ROADMAP §1: voice AI (May 2026).
  voice:              lazyReload(() => import("./screens/voice")),
  // Admin
  audit:              lazyReload(() => import("./screens/audit")),
  admin:              lazyReload(() => import("./screens/admin")),
  // Auth + onboarding (no nav entry)
  connect:            lazyReload(() => import("./screens/connect")),
  onboarding:         lazyReload(() => import("./screens/onboarding")),
  landing:            lazyReload(() => import("./screens/landing")),
  signin:             lazyReload(() => import("./screens/signin")),
  resetPassword:      lazyReload(() => import("./screens/reset-password")),
  documents:          lazyReload(() => import("./screens/documents")),
  pipelineKanban:     lazyReload(() => import("./screens/pipeline-kanban")),
  delays:             lazyReload(() => import("./screens/delays")),
  formatGuide:        lazyReload(() => import("./screens/format-guide")),
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
  "sales-ops": () => screens.salesOps,
  projects:    () => screens.projects,
  shipments:   () => screens.shipments,
  spo:         () => screens.spo,
  spares:      () => screens.spares,
  // Inventory-planning module (Phase 3).
  "inventory-planning":   () => screens.inventoryPlanning,
  "inventory-plans":      () => screens.inventoryPlans,
  "inventory-exceptions": () => screens.inventoryExceptions,
  "inventory-item":       () => screens.inventoryItem,
  "inventory-allocations":() => screens.inventoryAllocations,
  "inventory-suppliers":  () => screens.inventorySuppliers,
  logistics:              () => screens.logistics,
  "supplier-rfq":         () => screens.supplierRfq,
  // Bet 7: BRSR value-chain reporting.
  "brsr-supplier":          () => screens.brsrSupplier,
  "brsr-buyer-dashboard":   () => screens.brsrBuyerDashboard,
  "brsr-disclosure-detail": () => screens.brsrDisclosureDetail,
  // Bet 2: format-template marketplace.
  marketplace:            () => screens.marketplace,
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
  quotes:      () => screens.quotes,
  // Bet 6: TReDS receivables loop (sandbox).
  treds:       () => screens.treds,
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
  "items-import": () => screens.bomImport,
  graph:       () => screens.graph,
  forecasts:   () => screens.forecasts,
  fmeca:       () => screens.fmeca,
  warehouses:  () => screens.warehouses,
  evals:       () => screens.evals,
  studio:      () => screens.studio,
  anomaly:     () => screens.anomaly,
  "extraction-review": () => screens.extractionReview,
  duplicates:  () => screens.duplicates,
  "customer-duplicates": () => screens.customerDuplicates,
  agents:      () => screens.agents,
  comms:       () => screens.comms,
  email:       () => screens.email,
  voice:       () => screens.voice,
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
