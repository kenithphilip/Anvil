// Route table + URL dispatcher. Hobby Vercel deploys cap us at 12
// serverless functions, so all 75 endpoints share a single function
// (api/dispatch.js, reached via a vercel.json rewrite that maps
// /api/:p* to /api/dispatch?_p=:p*). The dispatcher reads `_p`,
// matches it against the table below, and calls the right handler.
//
// Each handler is the default export of its file under src/api/. The
// imports are static so Vercel's Node.js cold start picks them up
// once and caches subsequent invocations.
//
// Adding a new endpoint:
//   1. Write the handler under src/api/<group>/<name>.js with default
//      `export default async function handler(req, res) { ... }`.
//   2. Add a row below: `[METHOD, "/path", handlerImport]`.
//   3. Done. The dispatcher picks it up automatically.

import adminContracts          from "./admin/contracts.js";
import adminCustomerLocations  from "./admin/customer_locations.js";
import adminDiagnostics        from "./admin/diagnostics.js";
import adminEquipment          from "./admin/equipment.js";
import adminFxRates            from "./admin/fx_rates.js";
import adminHolidays           from "./admin/holidays.js";
import adminInventory          from "./admin/inventory.js";
import adminItemMaster         from "./admin/item_master.js";
import adminLeadTimes          from "./admin/lead_times.js";
import adminLostReasons        from "./admin/lost_reasons.js";
import adminMembers            from "./admin/members.js";
import adminQuoteApprovals     from "./admin/quote_approvals.js";

import aliasesIndex            from "./aliases/index.js";
import anomalyCompute          from "./anomaly/compute.js";
import auditIndex              from "./audit/index.js";

import authMagicLink           from "./auth/magic_link.js";
import authPasswordLogin       from "./auth/password_login.js";
import authProfile             from "./auth/profile.js";
import authSignup              from "./auth/signup.js";
import authVerify              from "./auth/verify.js";

import billingUsage            from "./billing/usage.js";

import bomIndex                from "./bom/index.js";
import claudeMessages          from "./claude/messages.js";

import commsDraft              from "./communications/draft.js";
import commsMissingDoc         from "./communications/missing_doc.js";
import commsSend               from "./communications/send.js";

import costBreakdown           from "./cost/breakdown.js";
import costMarginHistory       from "./cost/margin_history.js";
import costSimulator           from "./cost/simulator.js";

import customersIndex          from "./customers/index.js";
import customersProfileVersions from "./customers/profile_versions.js";

import deliveryPromise         from "./delivery/promise.js";

import documentsById           from "./documents/[id].js";
import documentsOcr            from "./documents/ocr.js";
import documentsScan           from "./documents/scan.js";
import documentsUpload         from "./documents/upload.js";

import duplicatesSearch        from "./duplicates/search.js";
import einvoiceIndex           from "./einvoice/index.js";
import emailInbound            from "./email/inbound.js";

import evalCases               from "./eval/cases.js";
import evalDashboard           from "./eval/dashboard.js";
import evalRun                 from "./eval/run.js";

import eventsIndex             from "./events/index.js";
import findingsIndex           from "./findings/index.js";
import forecastIndex           from "./forecast/index.js";

import fxCron                  from "./fx/cron.js";
import fxRates                 from "./fx/rates.js";

import inventoryAvailability   from "./inventory/availability.js";
import inventorySync           from "./inventory/sync.js";

import masterDataGraph         from "./master_data/graph.js";

import ordersById              from "./orders/[id].js";
import ordersIndex             from "./orders/index.js";
import ordersScheduleLines     from "./orders/schedule_lines.js";

import salesInternalSo         from "./sales/internal_so.js";
import salesLeads              from "./sales/leads.js";
import salesOpportunities      from "./sales/opportunities.js";
import salesProjects           from "./sales/projects.js";
import salesShipments          from "./sales/shipments.js";

import salesHistoryPriceBand   from "./sales_history/price_band.js";

import securityInjectTest      from "./security/inject_test.js";
import securityRedact          from "./security/redact.js";

import serviceAmc              from "./service/amc.js";
import serviceAmcCron          from "./service/amc_cron.js";
import serviceCarReports       from "./service/car_reports.js";
import serviceClosureReports   from "./service/closure_reports.js";
import serviceVisits           from "./service/visits.js";

import sourcePosById           from "./source_pos/[id].js";
import sourcePosAck            from "./source_pos/ack.js";
import sourcePosIndex          from "./source_pos/index.js";
import sourcePosScorecard      from "./source_pos/scorecard.js";

import spareMatrixKit          from "./spare_matrix/kit.js";
import spareMatrixObsolete     from "./spare_matrix/obsolete.js";
import spareMatrixOpportunities from "./spare_matrix/opportunities.js";
import spareMatrixRecommend    from "./spare_matrix/recommend.js";

import tallyAmend              from "./tally/amend.js";
import tallyMasters            from "./tally/masters.js";
import tallyPush               from "./tally/push.js";
import tallyReconcile          from "./tally/reconcile.js";
import tallyValidate           from "./tally/validate.js";

import healthCheck             from "./health.js";

// Static routes resolved by exact match. Order does not matter.
const STATIC_ROUTES = {
  "/health":                        healthCheck,
  "/admin/contracts":               adminContracts,
  "/admin/customer_locations":      adminCustomerLocations,
  "/admin/diagnostics":             adminDiagnostics,
  "/admin/equipment":               adminEquipment,
  "/admin/fx_rates":                adminFxRates,
  "/admin/holidays":                adminHolidays,
  "/admin/inventory":               adminInventory,
  "/admin/item_master":             adminItemMaster,
  "/admin/lead_times":              adminLeadTimes,
  "/admin/lost_reasons":            adminLostReasons,
  "/admin/members":                 adminMembers,
  "/admin/quote_approvals":         adminQuoteApprovals,

  "/aliases":                       aliasesIndex,
  "/anomaly/compute":               anomalyCompute,
  "/audit":                         auditIndex,

  "/auth/magic_link":               authMagicLink,
  "/auth/password_login":           authPasswordLogin,
  "/auth/profile":                  authProfile,
  "/auth/signup":                   authSignup,
  "/auth/verify":                   authVerify,

  "/billing/usage":                 billingUsage,

  "/bom":                           bomIndex,
  "/claude/messages":               claudeMessages,

  "/communications/draft":          commsDraft,
  "/communications/missing_doc":    commsMissingDoc,
  "/communications/send":           commsSend,

  "/cost/breakdown":                costBreakdown,
  "/cost/margin_history":           costMarginHistory,
  "/cost/simulator":                costSimulator,

  "/customers":                     customersIndex,
  "/customers/profile_versions":    customersProfileVersions,

  "/delivery/promise":              deliveryPromise,

  "/documents/ocr":                 documentsOcr,
  "/documents/scan":                documentsScan,
  "/documents/upload":              documentsUpload,

  "/duplicates/search":             duplicatesSearch,
  "/einvoice":                      einvoiceIndex,
  "/email/inbound":                 emailInbound,

  "/eval/cases":                    evalCases,
  "/eval/dashboard":                evalDashboard,
  "/eval/run":                      evalRun,

  "/events":                        eventsIndex,
  "/findings":                      findingsIndex,
  "/forecast":                      forecastIndex,

  "/fx/cron":                       fxCron,
  "/fx/rates":                      fxRates,

  "/inventory/availability":        inventoryAvailability,
  "/inventory/sync":                inventorySync,

  "/master_data/graph":             masterDataGraph,

  "/orders":                        ordersIndex,
  "/orders/schedule_lines":         ordersScheduleLines,

  "/sales/internal_so":             salesInternalSo,
  "/sales/leads":                   salesLeads,
  "/sales/opportunities":           salesOpportunities,
  "/sales/projects":                salesProjects,
  "/sales/shipments":               salesShipments,

  "/sales_history/price_band":      salesHistoryPriceBand,

  "/security/inject_test":          securityInjectTest,
  "/security/redact":               securityRedact,

  "/service/amc":                   serviceAmc,
  "/service/amc_cron":              serviceAmcCron,
  "/service/car_reports":           serviceCarReports,
  "/service/closure_reports":       serviceClosureReports,
  "/service/visits":                serviceVisits,

  "/source_pos":                    sourcePosIndex,
  "/source_pos/ack":                sourcePosAck,
  "/source_pos/scorecard":          sourcePosScorecard,

  "/spare_matrix/kit":              spareMatrixKit,
  "/spare_matrix/obsolete":         spareMatrixObsolete,
  "/spare_matrix/opportunities":    spareMatrixOpportunities,
  "/spare_matrix/recommend":        spareMatrixRecommend,

  "/tally/amend":                   tallyAmend,
  "/tally/masters":                 tallyMasters,
  "/tally/push":                    tallyPush,
  "/tally/reconcile":               tallyReconcile,
  "/tally/validate":                tallyValidate,
};

// Dynamic routes: prefix match. The handler receives the segment via
// req.query.id (legacy contract from the [id].js naming).
const DYNAMIC_ROUTES = [
  // "/documents/<id>" -> documentsById, sets req.query.id
  { prefix: "/documents/",   handler: documentsById,  param: "id" },
  // "/orders/<id>"
  { prefix: "/orders/",      handler: ordersById,     param: "id" },
  // "/source_pos/<id>"
  { prefix: "/source_pos/",  handler: sourcePosById,  param: "id" },
];

// Resolve a request URL to a handler. Returns null if not matched.
const resolve = (pathname) => {
  if (STATIC_ROUTES[pathname]) {
    return { handler: STATIC_ROUTES[pathname], params: {} };
  }
  for (const route of DYNAMIC_ROUTES) {
    if (pathname.startsWith(route.prefix)) {
      const tail = pathname.slice(route.prefix.length);
      // Don't match deeper paths (e.g. /orders/abc/extra). The legacy
      // [id].js handlers expect a single trailing segment.
      if (!tail || tail.includes("/")) continue;
      return { handler: route.handler, params: { [route.param]: tail } };
    }
  }
  return null;
};

// Public dispatcher. Resolves the original `/api/<rest>` path the
// browser asked for, strips the /api prefix, parses the query string,
// and calls the matching handler. Path params (e.g. /orders/:id) get
// merged into req.query so handlers that read req.query.id keep
// working without changes.
//
// Path resolution order, most reliable first:
//
//   1. `req.query._p`. Set by the `vercel.json` rewrite that maps
//      `/api/:p*` to `/api/dispatch?_p=:p*`. Always present in
//      production traffic. Survives Vercel's req.url-rewriting quirks.
//
//   2. `req.url`. Used in unit tests + local development where the
//      request bypasses Vercel's rewrite layer. Also a fallback if
//      the rewrite is misconfigured.
//
// Both shapes get the same parsing.
export const dispatch = async (req, res) => {
  const fullUrl = req.url || "/";
  const [pathWithApi, queryString] = fullUrl.split("?");

  // Pull `_p` out of the query string FIRST so we can use it as the
  // canonical path. Anything else stays in the per-request query.
  const query = {};
  let pPath = null;
  if (queryString) {
    for (const [k, v] of new URLSearchParams(queryString)) {
      if (k === "_p") pPath = v;
      else query[k] = v;
    }
  }

  let pathname;
  if (pPath != null && pPath !== "") {
    // _p comes from a Vercel splat capture, may be slash-joined.
    // Normalize to a leading slash + no trailing slash.
    pathname = pPath.startsWith("/") ? pPath : "/" + pPath;
  } else {
    // Local / test path: req.url has the original /api/<rest>.
    pathname = pathWithApi.replace(/^\/api/, "");
    if (!pathname.startsWith("/")) pathname = "/" + pathname;
  }
  if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);
  // Defensive: if the rewrite landed us at /dispatch directly,
  // there is no original path to resolve. Surface that explicitly.
  if (pathname === "/dispatch") {
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: { message: "Empty path. Hit /api/<endpoint> instead." } }));
    return;
  }

  const match = resolve(pathname);
  if (!match) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: { message: `Route not found: ${pathname}` } }));
    return;
  }

  Object.assign(query, match.params);
  req.query = query;

  return match.handler(req, res);
};

export default dispatch;
