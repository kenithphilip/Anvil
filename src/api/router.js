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

import agentsGoals             from "./agents/goals.js";
import agentsRun               from "./agents/run.js";

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
import stripeConnectOnboard    from "./billing/stripe/connect_onboard.js";
import stripeConnectStatus     from "./billing/stripe/connect_status.js";
import stripeCheckout          from "./billing/stripe/checkout.js";
import stripeWebhook           from "./billing/stripe/webhook.js";

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
import tallyCompanies          from "./tally/companies.js";
import tallyHealth             from "./tally/health.js";
import tallyDiagnostics        from "./tally/diagnostics.js";
import tallyRetry              from "./tally/retry.js";
import tallySync               from "./tally/sync.js";

import whatsappInbound         from "./whatsapp/inbound.js";
import whatsappSend            from "./whatsapp/send.js";

import quotesPdf               from "./quotes/pdf.js";

import invoicesIndex           from "./invoices/index.js";
import invoicesById            from "./invoices/[id].js";
import invoicesPdf             from "./invoices/pdf.js";
import invoicesSend            from "./invoices/send.js";

import netsuiteConnect         from "./netsuite/connect.js";
import netsuiteHealth          from "./netsuite/health.js";
import netsuitePush            from "./netsuite/push.js";
import netsuiteSync            from "./netsuite/sync.js";
import netsuiteRetry           from "./netsuite/retry.js";
import netsuiteDiagnostics     from "./netsuite/diagnostics.js";
import netsuiteFieldMap        from "./netsuite/field_map.js";

import sapConnect              from "./sap/connect.js";
import sapHealth               from "./sap/health.js";
import sapSync                 from "./sap/sync.js";
import sapPush                 from "./sap/push.js";
import sapRetry                from "./sap/retry.js";
import sapDiagnostics          from "./sap/diagnostics.js";
import sapFieldMap             from "./sap/field_map.js";

import d365Connect             from "./d365/connect.js";
import d365Health              from "./d365/health.js";
import d365Sync                from "./d365/sync.js";
import d365Push                from "./d365/push.js";
import d365Retry               from "./d365/retry.js";
import d365Diagnostics         from "./d365/diagnostics.js";
import d365FieldMap            from "./d365/field_map.js";

import acuConnect              from "./acumatica/connect.js";
import acuHealth               from "./acumatica/health.js";
import acuSync                 from "./acumatica/sync.js";
import acuPush                 from "./acumatica/push.js";
import acuRetry                from "./acumatica/retry.js";
import acuDiagnostics          from "./acumatica/diagnostics.js";
import acuFieldMap             from "./acumatica/field_map.js";

import razorpayConnect         from "./billing/razorpay/connect.js";
import razorpayCheckout        from "./billing/razorpay/checkout.js";
import razorpayWebhook         from "./billing/razorpay/webhook.js";
import razorpayStatus          from "./billing/razorpay/status.js";

import pushSubscribe           from "./push/subscribe.js";
import pushUnsubscribe         from "./push/unsubscribe.js";
import pushSend                from "./push/send.js";

import portalTokens            from "./portal/tokens.js";
import portalView              from "./portal/view.js";
import portalPay               from "./portal/pay.js";
import portalReorder           from "./portal/reorder.js";
import portalInvoicePdf        from "./portal/invoice_pdf.js";
import portalAcceptQuote       from "./portal/accept_quote.js";

import ordersTraveler          from "./orders/traveler.js";
import ordersPrintJobs         from "./orders/print_jobs.js";
import ordersReconcile         from "./orders/reconcile.js";

import supplierRfqIndex        from "./supplier_rfq/index.js";
import supplierRfqSend         from "./supplier_rfq/send.js";
import supplierRfqQuote        from "./supplier_rfq/quote.js";
import supplierRfqMatrix       from "./supplier_rfq/matrix.js";
import supplierRfqAward        from "./supplier_rfq/award.js";
import supplierRfqVendors      from "./supplier_rfq/vendors.js";

import analyticsWinloss        from "./analytics/winloss.js";
import analyticsRefresh        from "./analytics/refresh.js";

import catalogSearch           from "./catalog/search.js";
import catalogSynonyms         from "./catalog/synonyms.js";
import catalogAlternatives     from "./catalog/alternatives.js";
import catalogPrivateLabel     from "./catalog/private_label.js";

import kbAsk                   from "./kb/ask.js";

import esignConnect            from "./esign/connect.js";
import esignEnvelopes          from "./esign/envelopes.js";
import esignWebhook            from "./esign/webhook.js";

import cronTick                from "./cron/tick.js";
import cronDaily               from "./cron/daily.js";

import ediInbound              from "./edi/inbound.js";
import ediOutbound             from "./edi/outbound.js";
import ediPartners             from "./edi/partners.js";
import ediEnvelopes            from "./edi/envelopes.js";

import rlhfFeedback            from "./rlhf/feedback.js";
import rlhfAggregate           from "./rlhf/aggregate.js";
import rlhfDataset             from "./rlhf/dataset.js";

import erpChatSend             from "./erp_chat/send.js";
import erpChatSessions         from "./erp_chat/sessions.js";

import mcpServer               from "./mcp/server.js";
import mcpTokens               from "./mcp/tokens.js";
import mcpUsage                from "./mcp/usage.js";

import inboundEmailWebhook     from "./inbound/email/webhook.js";
import inboundEmailParse       from "./inbound/email/parse.js";
import inboundEmailThreads     from "./inbound/email/threads.js";
import inboundEmailConfigure   from "./inbound/email/configure.js";

import docaiExtract            from "./docai/extract.js";
import docaiCorrection         from "./docai/correction.js";
import docaiRuns               from "./docai/runs.js";

import p21Connect              from "./p21/connect.js";
import p21Health               from "./p21/health.js";
import p21Sync                 from "./p21/sync.js";
import p21Push                 from "./p21/push.js";
import p21Retry                from "./p21/retry.js";
import p21Diagnostics          from "./p21/diagnostics.js";
import p21FieldMap             from "./p21/field_map.js";

import eclipseConnect          from "./eclipse/connect.js";
import eclipseHealth           from "./eclipse/health.js";
import eclipseSync             from "./eclipse/sync.js";
import eclipsePush             from "./eclipse/push.js";
import eclipseRetry            from "./eclipse/retry.js";
import eclipseDiagnostics      from "./eclipse/diagnostics.js";
import eclipseFieldMap         from "./eclipse/field_map.js";

import sxeConnect              from "./sxe/connect.js";
import sxeHealth               from "./sxe/health.js";
import sxeSync                 from "./sxe/sync.js";
import sxePush                 from "./sxe/push.js";
import sxeRetry                from "./sxe/retry.js";
import sxeDiagnostics          from "./sxe/diagnostics.js";
import sxeFieldMap             from "./sxe/field_map.js";

import healthCheck             from "./health.js";

// Static routes resolved by exact match. Order does not matter.
const STATIC_ROUTES = {
  "/health":                        healthCheck,

  "/agents/goals":                  agentsGoals,
  "/agents/run":                    agentsRun,

  "/netsuite/connect":              netsuiteConnect,
  "/netsuite/health":               netsuiteHealth,
  "/netsuite/push":                 netsuitePush,
  "/netsuite/sync":                 netsuiteSync,
  "/netsuite/retry":                netsuiteRetry,
  "/netsuite/diagnostics":          netsuiteDiagnostics,
  "/netsuite/field_map":            netsuiteFieldMap,
  "/sap/connect":                   sapConnect,
  "/sap/health":                    sapHealth,
  "/sap/sync":                      sapSync,
  "/sap/push":                      sapPush,
  "/sap/retry":                     sapRetry,
  "/sap/diagnostics":               sapDiagnostics,
  "/sap/field_map":                 sapFieldMap,
  "/d365/connect":                  d365Connect,
  "/d365/health":                   d365Health,
  "/d365/sync":                     d365Sync,
  "/d365/push":                     d365Push,
  "/d365/retry":                    d365Retry,
  "/d365/diagnostics":              d365Diagnostics,
  "/d365/field_map":                d365FieldMap,
  "/acumatica/connect":             acuConnect,
  "/acumatica/health":              acuHealth,
  "/acumatica/sync":                acuSync,
  "/acumatica/push":                acuPush,
  "/acumatica/retry":               acuRetry,
  "/acumatica/diagnostics":         acuDiagnostics,
  "/acumatica/field_map":           acuFieldMap,
  "/billing/razorpay/connect":      razorpayConnect,
  "/billing/razorpay/checkout":     razorpayCheckout,
  "/billing/razorpay/webhook":      razorpayWebhook,
  "/billing/razorpay/status":       razorpayStatus,
  "/push/subscribe":                pushSubscribe,
  "/push/unsubscribe":              pushUnsubscribe,
  "/push/send":                     pushSend,
  "/portal/tokens":                 portalTokens,
  "/portal/view":                   portalView,
  "/portal/pay":                    portalPay,
  "/portal/reorder":                portalReorder,
  "/portal/invoice_pdf":            portalInvoicePdf,
  "/portal/accept_quote":           portalAcceptQuote,
  "/orders/traveler":               ordersTraveler,
  "/orders/print_jobs":             ordersPrintJobs,
  "/orders/reconcile":              ordersReconcile,
  "/supplier_rfq":                  supplierRfqIndex,
  "/supplier_rfq/send":             supplierRfqSend,
  "/supplier_rfq/quote":            supplierRfqQuote,
  "/supplier_rfq/matrix":           supplierRfqMatrix,
  "/supplier_rfq/award":            supplierRfqAward,
  "/supplier_rfq/vendors":          supplierRfqVendors,
  "/analytics/winloss":             analyticsWinloss,
  "/analytics/refresh":             analyticsRefresh,
  "/catalog/search":                catalogSearch,
  "/catalog/synonyms":              catalogSynonyms,
  "/catalog/alternatives":          catalogAlternatives,
  "/catalog/private_label":         catalogPrivateLabel,
  "/kb/ask":                        kbAsk,
  "/esign/connect":                 esignConnect,
  "/esign/envelopes":               esignEnvelopes,
  "/esign/webhook":                 esignWebhook,
  "/cron/tick":                     cronTick,
  "/cron/daily":                    cronDaily,
  "/edi/inbound":                   ediInbound,
  "/edi/outbound":                  ediOutbound,
  "/edi/partners":                  ediPartners,
  "/edi/envelopes":                 ediEnvelopes,
  "/rlhf/feedback":                 rlhfFeedback,
  "/rlhf/aggregate":                rlhfAggregate,
  "/rlhf/dataset":                  rlhfDataset,
  "/erp_chat/send":                 erpChatSend,
  "/erp_chat/sessions":             erpChatSessions,
  "/mcp/server":                    mcpServer,
  "/mcp/tokens":                    mcpTokens,
  "/mcp/usage":                     mcpUsage,
  "/inbound/email/webhook":         inboundEmailWebhook,
  "/inbound/email/parse":           inboundEmailParse,
  "/inbound/email/threads":         inboundEmailThreads,
  "/inbound/email/configure":       inboundEmailConfigure,
  "/docai/extract":                 docaiExtract,
  "/docai/correction":              docaiCorrection,
  "/docai/runs":                    docaiRuns,
  "/p21/connect":                   p21Connect,
  "/p21/health":                    p21Health,
  "/p21/sync":                      p21Sync,
  "/p21/push":                      p21Push,
  "/p21/retry":                     p21Retry,
  "/p21/diagnostics":               p21Diagnostics,
  "/p21/field_map":                 p21FieldMap,
  "/eclipse/connect":               eclipseConnect,
  "/eclipse/health":                eclipseHealth,
  "/eclipse/sync":                  eclipseSync,
  "/eclipse/push":                  eclipsePush,
  "/eclipse/retry":                 eclipseRetry,
  "/eclipse/diagnostics":           eclipseDiagnostics,
  "/eclipse/field_map":             eclipseFieldMap,
  "/sxe/connect":                   sxeConnect,
  "/sxe/health":                    sxeHealth,
  "/sxe/sync":                      sxeSync,
  "/sxe/push":                      sxePush,
  "/sxe/retry":                     sxeRetry,
  "/sxe/diagnostics":               sxeDiagnostics,
  "/sxe/field_map":                 sxeFieldMap,
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
  "/billing/stripe/connect_onboard":stripeConnectOnboard,
  "/billing/stripe/connect_status": stripeConnectStatus,
  "/billing/stripe/checkout":       stripeCheckout,
  "/billing/stripe/webhook":        stripeWebhook,

  "/quotes/pdf":                    quotesPdf,

  "/invoices":                      invoicesIndex,
  "/invoices/pdf":                  invoicesPdf,
  "/invoices/send":                 invoicesSend,

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
  "/tally/companies":               tallyCompanies,
  "/tally/health":                  tallyHealth,
  "/tally/diagnostics":             tallyDiagnostics,
  "/tally/retry":                   tallyRetry,
  "/tally/sync":                    tallySync,

  "/whatsapp/inbound":              whatsappInbound,
  "/whatsapp/send":                 whatsappSend,
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
  // Invoices: /invoices/<id>. The static "/invoices" + "/invoices/pdf"
  // + "/invoices/send" entries above take precedence; the dynamic
  // path only resolves when none of those match.
  { prefix: "/invoices/",    handler: invoicesById,   param: "id" },
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
