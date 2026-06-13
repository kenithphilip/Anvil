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
import adminDocaiSettings      from "./admin/docai_settings.js";
import adminEquipment          from "./admin/equipment.js";
import adminFxRates            from "./admin/fx_rates.js";
import adminHolidays           from "./admin/holidays.js";
import adminInventory          from "./admin/inventory.js";
import adminItemMaster         from "./admin/item_master.js";
import adminItemSpecifications from "./admin/item_specifications.js";
import adminItemCustomerParts  from "./admin/item_customer_parts.js";
import adminItemUsage          from "./admin/item_usage.js";
import adminItemFieldDefinitions from "./admin/item_field_definitions.js";
import adminItemFieldValues    from "./admin/item_field_values.js";
import adminItemReference      from "./admin/item_reference.js";
import adminDocumentTemplates  from "./admin/document_templates.js";
import adminFreightRates       from "./admin/freight_rates.js";
import adminTenantPricingSettings from "./admin/tenant_pricing_settings.js";
import adminPricingProfiles    from "./admin/pricing_profiles.js";
import adminPricingProfileBindings from "./admin/pricing_profile_bindings.js";
import adminMaterialPriceReferences from "./admin/material_price_references.js";
import adminCustomerVendorCodes from "./admin/customer_vendor_codes.js";
import adminCustomerTerms        from "./admin/customer_terms.js";
import adminOrderLineTaxComponents from "./admin/order_line_tax_components.js";
import adminPriceCompositionLines from "./admin/price_composition_lines.js";
import adminCompositionMaterialLines from "./admin/composition_material_lines.js";
import adminQuoteLines           from "./admin/quote_lines.js";
import adminLeadTimes          from "./admin/lead_times.js";
import adminLostReasons        from "./admin/lost_reasons.js";
import adminMembers            from "./admin/members.js";
import adminAccessRequests     from "./admin/access_requests.js";
import adminNotifications      from "./admin/notifications.js";
import adminInstallVerticalPack from "./admin/install_vertical_pack.js";
// Phase 6 (C.1): SOC 2 controls.
import adminAccessReview       from "./admin/access_review.js";
import auditExport              from "./audit/export.js";
// Phase 6 (C.5): AP 3-way match + deductions.
import apMatch                  from "./ap/match.js";
import apDeductions             from "./ap/deductions.js";
// Phase 6 (C.3) agent eval, (C.4) docai routing, (C.6) prospecting.
import agentEval                from "./eval/agent_eval.js";
import docaiRoute               from "./docai/route.js";
import prospectingCampaigns     from "./prospecting/campaigns.js";
import prospectingTargets       from "./prospecting/targets.js";
import prospectingRun           from "./prospecting/run.js";

// Password reset (Phase: security flows).
import authRequestReset        from "./auth/request_reset.js";
import authCompleteReset       from "./auth/complete_reset.js";
import authMfa                 from "./auth/mfa.js";
import authPasskeyRegisterBegin  from "./auth/passkey/register_begin.js";
import authPasskeyRegisterFinish from "./auth/passkey/register_finish.js";
import authPasskeyAuthBegin       from "./auth/passkey/auth_begin.js";
import authPasskeyAuthFinish      from "./auth/passkey/auth_finish.js";
import authPasskeyList            from "./auth/passkey/list.js";
import adminQuoteApprovals     from "./admin/quote_approvals.js";

import aliasesIndex            from "./aliases/index.js";
import anomalyCompute          from "./anomaly/compute.js";
import anomalyExplain          from "./anomaly/explain.js";
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
import commsList               from "./communications/list.js";
import commsMissingDoc         from "./communications/missing_doc.js";
import commsSend               from "./communications/send.js";

import costBreakdown           from "./cost/breakdown.js";
import costMarginHistory       from "./cost/margin_history.js";
import costSimulator           from "./cost/simulator.js";

import customersIndex          from "./customers/index.js";
import customersProfileVersions from "./customers/profile_versions.js";
import customersContacts        from "./customers/contacts.js";
import customersDuplicates      from "./customers/duplicates.js";
import customersMerge           from "./customers/merge.js";
import customerLocationsIndex   from "./customer_locations/index.js";
// Phase 7.3: customer health score (Haiku per-customer + cron drain).
import customersHealthScore     from "./customers/health_score.js";

// Phase 7.5: credit + debit notes CRUD.
import creditNotesIndex         from "./credit_notes/index.js";

// Phase 7.6: recurring invoice schedules + drain cron.
import billingRecurring         from "./billing/recurring.js";
import billingRecurringCron     from "./billing/recurring_cron.js";

// Phase 7.7: e-Way bill module + daily expiry sweep.
import ewayBillsIndex           from "./eway_bills/index.js";
import ewayBillsExtract         from "./eway_bills/extract.js";
import ewayBillsExpire          from "./eway_bills/expire.js";

import deliveryPromise         from "./delivery/promise.js";
import logisticsConsolidations from "./logistics/consolidations.js";
import logisticsFreightBids     from "./logistics/freight_bids.js";

// SOC 2 CC8.1 change log: production deploy events.
import deploysIndex            from "./deploys/index.js";

import documentsById           from "./documents/[id].js";
import documentsEvidence       from "./documents/[id]/evidence.js";
import documentsIndex          from "./documents/index.js";
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
// Inventory-planning module (Phase 2). Endpoints + crons.
import inventoryPositions       from "./inventory/positions.js";
import inventoryForecasts       from "./inventory/forecasts.js";
import inventoryForecastRuns    from "./inventory/forecast_runs.js";
import inventoryPlans           from "./inventory/plans.js";
import inventoryExceptions      from "./inventory/exceptions.js";
import inventoryAllocations     from "./inventory/allocations.js";
import inventoryExplain         from "./inventory/explain.js";
import inventoryReplan          from "./inventory/replan.js";
// Phase 3.5 additions: calibration, suppliers, exception-tick cron.
import inventoryCalibration     from "./inventory/calibration.js";
import inventorySuppliers       from "./inventory/suppliers.js";
// Bet 3: conformal-prediction safety stock.
import inventoryConformalDiag   from "./inventory/conformal_diagnostics.js";
// Bet 7: BRSR value-chain reporting.
import brsrPeriod               from "./brsr/period.js";
import brsrDisclosure           from "./brsr/disclosure.js";
import brsrPrefill              from "./brsr/prefill.js";
import brsrRelationship         from "./brsr/relationship.js";
import brsrBuyerDashboard       from "./brsr/buyer/dashboard.js";
import brsrBuyerExport          from "./brsr/buyer/export.js";
// Bet 6: AA + TReDS receivables loop (sandbox scaffolding).
import aaConsent                from "./aa/consent.js";
import aaCallback               from "./aa/callback.js";
import aaWebhook                from "./aa/webhook.js";
import tredsOffer               from "./treds/offer.js";
import tredsAccept              from "./treds/accept.js";
import tredsList                from "./treds/list.js";
import tredsEligibleBuyers      from "./treds/eligible_buyers.js";
// Bet 2: format-template marketplace.
import marketplacePublish       from "./marketplace/publish.js";
import marketplaceRevoke        from "./marketplace/revoke.js";
import marketplaceImports       from "./marketplace/imports.js";
import marketplaceReport        from "./marketplace/report.js";
import marketplaceList          from "./marketplace/list.js";
import marketplaceReview        from "./marketplace/review.js";
import inventoryCronPositions   from "./cron/inventory-positions.js";
import inventoryCronWeekly      from "./cron/inventory-planning-weekly.js";
import inventoryCronExceptions  from "./cron/inventory-exceptions-tick.js";
import inventoryCronConformal   from "./cron/conformal-calibration-weekly.js";
import tallyReconcileCron       from "./cron/tally-reconcile.js";
import driftMeterCron           from "./cron/drift-meter.js";
import driftReportCron          from "./cron/drift-report.js";

import masterDataGraph         from "./master_data/graph.js";

import ordersById              from "./orders/[id].js";
import ordersIndex             from "./orders/index.js";
// Phase 3.6 observability: per-order pipeline diagnostics.
import ordersPipelineState     from "./orders/pipeline_state.js";
import ordersScheduleLines     from "./orders/schedule_lines.js";

import salesInternalSo         from "./sales/internal_so.js";
import salesLeads              from "./sales/leads.js";
import salesOpportunities      from "./sales/opportunities.js";
import opportunityLineItems    from "./opportunities/line_items.js";
import salesProjects           from "./sales/projects.js";
import salesShipments          from "./sales/shipments.js";
// Phase 7.1 + 7.2: lead scoring + opportunity probability.
import salesScoreLead          from "./sales/score_lead.js";
import salesPredictOpportunity from "./sales/predict_opportunity.js";

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
import sourcePosAckExtract     from "./source_pos/ack_extract.js";
import sourcePosAckAccept      from "./source_pos/ack_accept.js";
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
import tallyDriftAddon         from "./tally/drift_addon.js";
import tallyValidate           from "./tally/validate.js";
import tallyCompanies          from "./tally/companies.js";
import tallyHealth             from "./tally/health.js";
import tallyDiagnostics        from "./tally/diagnostics.js";
import tallyRetry              from "./tally/retry.js";
import tallySync               from "./tally/sync.js";

import whatsappInbound         from "./whatsapp/inbound.js";
import whatsappSend            from "./whatsapp/send.js";

import quotesPdf               from "./quotes/pdf.js";
import quotesIndex             from "./quotes/index.js";
import quotesSend              from "./quotes/send.js";
import quotesConvert           from "./quotes/convert.js";
import quotesExpire            from "./quotes/expire.js";
import agentsHandleReplies     from "./agents/handle_replies.js";

import invoicesIndex           from "./invoices/index.js";
import invoicesById            from "./invoices/[id].js";
import invoicesPdf             from "./invoices/pdf.js";
import invoicesSend            from "./invoices/send.js";
import invoicesExtract         from "./invoices/extract.js";

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
import ordersSuggestMappings   from "./orders/suggest_mappings.js";
import ordersExtractionStatus from "./orders/extraction_status.js";
import ordersVoucherPdf       from "./orders/voucher_pdf.js";
import ordersExtractionJobs   from "./orders/extraction_jobs.js";
import ordersExtractionJobsId from "./orders/extraction_jobs_id.js";
import ordersCostSummary      from "./orders/cost_summary.js";

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
// Audit P8.4: catalog embeddings (Voyage AI + pgvector).
import catalogEmbed            from "./catalog/embed.js";

// Phase 5.6: in-network back-to-back sourcing.
import sourcingNetworkListings  from "./sourcing/network/listings.js";
import sourcingNetworkSearch    from "./sourcing/network/search.js";
import sourcingNetworkHandoff   from "./sourcing/network/handoff.js";

// Phase 5.5: PLM connectors (Windchill, Arena).
import plmConnect               from "./plm/connect.js";
import plmSync                  from "./plm/sync.js";
import plmHealth                from "./plm/health.js";

// Phase 5.2: multi-channel inbound (WhatsApp/Slack/Teams).
import inboundWhatsappWebhook   from "./inbound/whatsapp/webhook.js";
import inboundSlackWebhook      from "./inbound/slack/webhook.js";
import inboundTeamsWebhook      from "./inbound/teams/webhook.js";
import inboundChatConfigure     from "./inbound/chat/configure.js";
import inboundProcessMessages   from "./inbound/process_messages.js";
import inboundAutoOcr           from "./inbound/auto_ocr.js";

// Phase 5.1: voice agent (Vapi / Retell).
import voiceConfigure           from "./voice/configure.js";
import voiceWebhook             from "./voice/webhook.js";
import voiceHandoff             from "./voice/handoff.js";
import voiceProcessActions      from "./voice/process_actions.js";
// DEFERRED_ROADMAP §1: voice AI build, May 2026.
import voiceOutbound             from "./voice/outbound.js";
import voiceConsent              from "./voice/consent.js";
import voiceDnd                  from "./voice/dnd.js";

import kbAsk                   from "./kb/ask.js";

import esignConnect            from "./esign/connect.js";
import esignEnvelopes          from "./esign/envelopes.js";
import esignWebhook            from "./esign/webhook.js";

import cronTick                from "./cron/tick.js";
import cronDaily               from "./cron/daily.js";
import cronExtractionJobs      from "./cron/extraction_jobs.js";

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
import inboundEmailDraftOrders from "./inbound/email/draft_orders.js";
import inboundEmailPersistAttachments from "./inbound/email/persist_attachments.js";

import docaiExtract            from "./docai/extract.js";
import docaiCorrection         from "./docai/correction.js";
import docaiUsage               from "./docai/usage.js";
import docaiCostStatus          from "./docai/cost_status.js";
import docaiRuns               from "./docai/runs.js";
import docaiReviewQueue        from "./docai/review_queue.js";

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

// Phase 5.4 batch 1: Sage X3 (Sage Enterprise Management).
import sageX3Connect           from "./sage_x3/connect.js";
import sageX3Health            from "./sage_x3/health.js";
import sageX3Sync              from "./sage_x3/sync.js";
import sageX3Push              from "./sage_x3/push.js";
import sageX3Retry             from "./sage_x3/retry.js";
import sxeDiagnostics          from "./sxe/diagnostics.js";
import sxeFieldMap             from "./sxe/field_map.js";

// Phase 5.4b cluster A (OAuth2): IFS Cloud, Oracle Fusion, Ramco.
import ifsConnect              from "./ifs/connect.js";
import ifsHealth               from "./ifs/health.js";
import ifsSync                 from "./ifs/sync.js";
import ifsPush                 from "./ifs/push.js";
import ifsRetry                from "./ifs/retry.js";
import oracleFusionConnect     from "./oracle_fusion/connect.js";
import oracleFusionHealth      from "./oracle_fusion/health.js";
import oracleFusionSync        from "./oracle_fusion/sync.js";
import oracleFusionPush        from "./oracle_fusion/push.js";
import oracleFusionRetry       from "./oracle_fusion/retry.js";
import ramcoConnect            from "./ramco/connect.js";
import ramcoHealth             from "./ramco/health.js";
import ramcoSync               from "./ramco/sync.js";
import ramcoPush               from "./ramco/push.js";
import ramcoRetry              from "./ramco/retry.js";
// Phase 5.4b cluster B (token-pair): JDE, Plex, JobBoss.
import jdeConnect              from "./jde/connect.js";
import jdeHealth               from "./jde/health.js";
import jdeSync                 from "./jde/sync.js";
import jdePush                 from "./jde/push.js";
import jdeRetry                from "./jde/retry.js";
import plexConnect             from "./plex/connect.js";
import plexHealth              from "./plex/health.js";
import plexSync                from "./plex/sync.js";
import plexPush                from "./plex/push.js";
import plexRetry               from "./plex/retry.js";
import jobbossConnect          from "./jobboss/connect.js";
import jobbossHealth           from "./jobboss/health.js";
import jobbossSync             from "./jobboss/sync.js";
import jobbossPush             from "./jobboss/push.js";
import jobbossRetry            from "./jobboss/retry.js";
// Phase 5.4b cluster C (HTTP Basic): Oracle EBS, proALPHA.
import oracleEbsConnect        from "./oracle_ebs/connect.js";
import oracleEbsHealth         from "./oracle_ebs/health.js";
import oracleEbsSync           from "./oracle_ebs/sync.js";
import oracleEbsPush           from "./oracle_ebs/push.js";
import oracleEbsRetry          from "./oracle_ebs/retry.js";
import proalphaConnect         from "./proalpha/connect.js";
import proalphaHealth          from "./proalpha/health.js";
import proalphaSync            from "./proalpha/sync.js";
import proalphaPush            from "./proalpha/push.js";
import proalphaRetry           from "./proalpha/retry.js";

import healthCheck             from "./health.js";
import healthz                 from "./healthz.js";

// Static routes resolved by exact match. Order does not matter.
const STATIC_ROUTES = {
  "/health":                        healthCheck,
  // F9 minimal probe for external uptime monitors. Returns 503
  // when DB is unreachable or any cron is stale.
  "/_healthz":                      healthz,

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
  "/orders/suggest_mappings":       ordersSuggestMappings,
  "/orders/extraction_status":      ordersExtractionStatus,
  "/orders/extraction_jobs":        ordersExtractionJobs,
  "/orders/cost_summary":           ordersCostSummary,
  "/orders/voucher_pdf":            ordersVoucherPdf,
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
  "/catalog/embed":                 catalogEmbed,

  "/sourcing/network/listings":     sourcingNetworkListings,
  "/sourcing/network/search":       sourcingNetworkSearch,
  "/sourcing/network/handoff":      sourcingNetworkHandoff,

  "/plm/connect":                   plmConnect,
  "/plm/sync":                      plmSync,
  "/plm/health":                    plmHealth,

  "/inbound/whatsapp/webhook":      inboundWhatsappWebhook,
  "/inbound/slack/webhook":         inboundSlackWebhook,
  "/inbound/teams/webhook":         inboundTeamsWebhook,
  "/inbound/chat/configure":        inboundChatConfigure,
  "/inbound/process_messages":      inboundProcessMessages,
  "/inbound/auto_ocr":              inboundAutoOcr,

  "/voice/configure":               voiceConfigure,
  "/voice/webhook":                 voiceWebhook,
  "/voice/handoff":                 voiceHandoff,
  "/voice/process_actions":         voiceProcessActions,
  "/voice/outbound":                voiceOutbound,
  "/voice/consent":                 voiceConsent,
  "/voice/dnd":                     voiceDnd,
  "/kb/ask":                        kbAsk,
  "/esign/connect":                 esignConnect,
  "/esign/envelopes":               esignEnvelopes,
  "/esign/webhook":                 esignWebhook,
  "/cron/tick":                     cronTick,
  "/cron/daily":                    cronDaily,
  "/cron/extraction_jobs":          cronExtractionJobs,
  "/cron/inventory-positions":       inventoryCronPositions,
  "/cron/inventory-planning-weekly": inventoryCronWeekly,
  "/cron/inventory-exceptions-tick": inventoryCronExceptions,
  "/cron/conformal-calibration-weekly": inventoryCronConformal,
  "/cron/tally-reconcile":           tallyReconcileCron,
  "/cron/drift-meter":               driftMeterCron,
  "/cron/drift-report":              driftReportCron,
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
  "/inbound/email/draft_orders":    inboundEmailDraftOrders,
  "/inbound/email/persist_attachments": inboundEmailPersistAttachments,
  "/docai/extract":                 docaiExtract,
  "/docai/correction":              docaiCorrection,
  "/docai/usage":                   docaiUsage,
  "/docai/cost_status":             docaiCostStatus,
  "/docai/runs":                    docaiRuns,
  "/docai/review_queue":            docaiReviewQueue,
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

  "/sage_x3/connect":               sageX3Connect,
  "/sage_x3/health":                sageX3Health,
  "/sage_x3/sync":                  sageX3Sync,
  "/sage_x3/push":                  sageX3Push,
  "/sage_x3/retry":                 sageX3Retry,

  "/ifs/connect":                   ifsConnect,
  "/ifs/health":                    ifsHealth,
  "/ifs/sync":                      ifsSync,
  "/ifs/push":                      ifsPush,
  "/ifs/retry":                     ifsRetry,

  "/oracle_fusion/connect":         oracleFusionConnect,
  "/oracle_fusion/health":          oracleFusionHealth,
  "/oracle_fusion/sync":            oracleFusionSync,
  "/oracle_fusion/push":            oracleFusionPush,
  "/oracle_fusion/retry":           oracleFusionRetry,

  "/ramco/connect":                 ramcoConnect,
  "/ramco/health":                  ramcoHealth,
  "/ramco/sync":                    ramcoSync,
  "/ramco/push":                    ramcoPush,
  "/ramco/retry":                   ramcoRetry,

  "/jde/connect":                   jdeConnect,
  "/jde/health":                    jdeHealth,
  "/jde/sync":                      jdeSync,
  "/jde/push":                      jdePush,
  "/jde/retry":                     jdeRetry,

  "/plex/connect":                  plexConnect,
  "/plex/health":                   plexHealth,
  "/plex/sync":                     plexSync,
  "/plex/push":                     plexPush,
  "/plex/retry":                    plexRetry,

  "/jobboss/connect":               jobbossConnect,
  "/jobboss/health":                jobbossHealth,
  "/jobboss/sync":                  jobbossSync,
  "/jobboss/push":                  jobbossPush,
  "/jobboss/retry":                 jobbossRetry,

  "/oracle_ebs/connect":            oracleEbsConnect,
  "/oracle_ebs/health":             oracleEbsHealth,
  "/oracle_ebs/sync":               oracleEbsSync,
  "/oracle_ebs/push":               oracleEbsPush,
  "/oracle_ebs/retry":              oracleEbsRetry,

  "/proalpha/connect":              proalphaConnect,
  "/proalpha/health":               proalphaHealth,
  "/proalpha/sync":                 proalphaSync,
  "/proalpha/push":                 proalphaPush,
  "/proalpha/retry":                proalphaRetry,
  "/sxe/diagnostics":               sxeDiagnostics,
  "/sxe/field_map":                 sxeFieldMap,
  "/admin/contracts":               adminContracts,
  "/admin/customer_locations":      adminCustomerLocations,
  "/admin/diagnostics":             adminDiagnostics,
  "/admin/docai_settings":          adminDocaiSettings,
  "/admin/equipment":               adminEquipment,
  "/admin/fx_rates":                adminFxRates,
  "/admin/holidays":                adminHolidays,
  "/admin/inventory":               adminInventory,
  "/admin/item_master":             adminItemMaster,
  "/admin/item_specifications":     adminItemSpecifications,
  "/admin/item_customer_parts":     adminItemCustomerParts,
  "/admin/item_usage":              adminItemUsage,
  "/admin/item_field_definitions":  adminItemFieldDefinitions,
  "/admin/item_field_values":       adminItemFieldValues,
  "/admin/item_reference":          adminItemReference,
  "/admin/document_templates":      adminDocumentTemplates,
  "/admin/freight_rates":           adminFreightRates,
  "/admin/tenant_pricing_settings": adminTenantPricingSettings,
  "/admin/pricing_profiles":        adminPricingProfiles,
  "/admin/pricing_profile_bindings": adminPricingProfileBindings,
  "/admin/material_price_references": adminMaterialPriceReferences,
  "/admin/customer_vendor_codes":   adminCustomerVendorCodes,
  "/admin/customer_terms":          adminCustomerTerms,
  "/admin/customer_terms/pack":     adminCustomerTerms,
  "/admin/customer_terms/clause":   adminCustomerTerms,
  "/admin/order_line_tax_components": adminOrderLineTaxComponents,
  "/admin/price_composition_lines": adminPriceCompositionLines,
  "/admin/composition_material_lines": adminCompositionMaterialLines,
  "/admin/quote_lines":             adminQuoteLines,
  "/admin/lead_times":              adminLeadTimes,
  "/admin/lost_reasons":            adminLostReasons,
  "/admin/members":                 adminMembers,
  "/admin/access_requests":         adminAccessRequests,
  "/admin/notifications":           adminNotifications,
  "/admin/install_vertical_pack":   adminInstallVerticalPack,
  "/admin/access_review":           adminAccessReview,
  "/audit/export":                  auditExport,
  "/ap/match":                      apMatch,
  "/ap/deductions":                 apDeductions,
  "/eval/agent_eval":               agentEval,
  "/docai/route":                   docaiRoute,
  "/prospecting/campaigns":         prospectingCampaigns,
  "/prospecting/targets":           prospectingTargets,
  "/prospecting/run":               prospectingRun,
  "/admin/quote_approvals":         adminQuoteApprovals,

  "/aliases":                       aliasesIndex,
  "/anomaly/compute":               anomalyCompute,
  "/anomaly/explain":               anomalyExplain,
  "/audit":                         auditIndex,

  "/auth/magic_link":               authMagicLink,
  "/auth/password_login":           authPasswordLogin,
  "/auth/profile":                  authProfile,
  "/auth/signup":                   authSignup,
  "/auth/verify":                   authVerify,
  "/auth/request_reset":            authRequestReset,
  "/auth/complete_reset":           authCompleteReset,
  "/auth/mfa":                      authMfa,
  "/auth/passkey/register/begin":   authPasskeyRegisterBegin,
  "/auth/passkey/register/finish":  authPasskeyRegisterFinish,
  "/auth/passkey/auth/begin":       authPasskeyAuthBegin,
  "/auth/passkey/auth/finish":      authPasskeyAuthFinish,
  "/auth/passkey/list":             authPasskeyList,

  "/billing/usage":                 billingUsage,
  "/billing/stripe/connect_onboard":stripeConnectOnboard,
  "/billing/stripe/connect_status": stripeConnectStatus,
  "/billing/stripe/checkout":       stripeCheckout,
  "/billing/stripe/webhook":        stripeWebhook,

  "/quotes/pdf":                    quotesPdf,
  "/quotes":                        quotesIndex,
  "/quotes/send":                   quotesSend,
  "/quotes/convert":                quotesConvert,
  "/quotes/expire":                 quotesExpire,
  "/agents/handle_replies":         agentsHandleReplies,

  "/invoices":                      invoicesIndex,
  "/invoices/pdf":                  invoicesPdf,
  "/invoices/send":                 invoicesSend,
  "/invoices/extract":              invoicesExtract,

  "/bom":                           bomIndex,
  "/claude/messages":               claudeMessages,

  "/communications":                commsList,
  "/communications/draft":          commsDraft,
  "/communications/missing_doc":    commsMissingDoc,
  "/communications/send":           commsSend,

  "/cost/breakdown":                costBreakdown,
  "/cost/margin_history":           costMarginHistory,
  "/cost/simulator":                costSimulator,

  "/customers":                     customersIndex,
  "/customers/profile_versions":    customersProfileVersions,
  "/customers/contacts":            customersContacts,
  "/customers/duplicates":          customersDuplicates,
  "/customers/merge":               customersMerge,
  "/customer_locations":            customerLocationsIndex,
  "/customers/health_score":        customersHealthScore,

  "/credit_notes":                  creditNotesIndex,

  "/billing/recurring":             billingRecurring,
  "/billing/recurring_cron":        billingRecurringCron,

  "/eway_bills":                    ewayBillsIndex,
  "/eway_bills/extract":            ewayBillsExtract,
  "/eway_bills/expire":             ewayBillsExpire,

  "/delivery/promise":              deliveryPromise,
  "/logistics/consolidations":      logisticsConsolidations,
  "/logistics/freight_bids":        logisticsFreightBids,
  "/deploys":                       deploysIndex,

  "/documents":                     documentsIndex,
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
  // Inventory-planning module endpoints (Phase 2).
  "/inventory/positions":           inventoryPositions,
  "/inventory/forecasts":           inventoryForecasts,
  "/inventory/forecast_runs":       inventoryForecastRuns,
  "/inventory/plans":               inventoryPlans,
  "/inventory/exceptions":          inventoryExceptions,
  "/inventory/allocations":         inventoryAllocations,
  "/inventory/explain":             inventoryExplain,
  "/inventory/replan":              inventoryReplan,
  // Phase 3.5 endpoints.
  "/inventory/calibration":         inventoryCalibration,
  "/inventory/suppliers":           inventorySuppliers,
  // Bet 3: conformal-prediction diagnostics + per-SKU override.
  "/inventory/conformal_diagnostics": inventoryConformalDiag,
  // Bet 7: BRSR value-chain reporting.
  "/brsr/period":                   brsrPeriod,
  "/brsr/disclosure":               brsrDisclosure,
  "/brsr/disclosure/submit":        brsrDisclosure,
  "/brsr/prefill":                  brsrPrefill,
  "/brsr/relationship":             brsrRelationship,
  "/brsr/relationship/invite":      brsrRelationship,
  "/brsr/relationship/accept":      brsrRelationship,
  "/brsr/relationship/reject":      brsrRelationship,
  "/brsr/relationship/revoke":      brsrRelationship,
  "/brsr/buyer/dashboard":          brsrBuyerDashboard,
  "/brsr/buyer/export":             brsrBuyerExport,
  // Bet 6: AA + TReDS receivables loop (sandbox).
  "/aa/consent":                    aaConsent,
  "/aa/callback":                   aaCallback,
  "/aa/webhook":                    aaWebhook,
  "/treds/offer":                   tredsOffer,
  "/treds/accept":                  tredsAccept,
  "/treds/list":                    tredsList,
  "/treds/eligible_buyers":         tredsEligibleBuyers,
  "/treds/eligible_buyers/refresh": tredsEligibleBuyers,
  // Bet 2: format-template marketplace.
  "/marketplace/publish":           marketplacePublish,
  "/marketplace/revoke":            marketplaceRevoke,
  "/marketplace/imports":           marketplaceImports,
  "/marketplace/imports/confirm":   marketplaceImports,
  "/marketplace/imports/revert":    marketplaceImports,
  "/marketplace/report":            marketplaceReport,
  "/marketplace/list":              marketplaceList,
  "/marketplace/review":            marketplaceReview,
  "/marketplace/review/revoke":     marketplaceReview,

  "/master_data/graph":             masterDataGraph,

  "/orders":                        ordersIndex,
  "/orders/schedule_lines":         ordersScheduleLines,

  "/sales/internal_so":             salesInternalSo,
  "/sales/leads":                   salesLeads,
  "/sales/opportunities":           salesOpportunities,
  "/opportunities/line_items":      opportunityLineItems,
  "/sales/projects":                salesProjects,
  "/sales/shipments":               salesShipments,
  "/sales/score_lead":              salesScoreLead,
  "/sales/predict_opportunity":     salesPredictOpportunity,

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
  // Phase F.2 dynamic /source_pos/<id>/ack_extract is wired in DYNAMIC_ROUTES.

  "/spare_matrix/kit":              spareMatrixKit,
  "/spare_matrix/obsolete":         spareMatrixObsolete,
  "/spare_matrix/opportunities":    spareMatrixOpportunities,
  "/spare_matrix/recommend":        spareMatrixRecommend,

  "/tally/amend":                   tallyAmend,
  "/tally/masters":                 tallyMasters,
  "/tally/push":                    tallyPush,
  "/tally/reconcile":               tallyReconcile,
  "/tally/drift_addon":             tallyDriftAddon,
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
//
// Two shapes:
//   - { prefix } only:         /<group>/<id>            (one segment)
//   - { prefix, suffix }:      /<group>/<id>/<suffix>   (two segments)
//
// Suffix entries are tried in order BEFORE the corresponding
// prefix-only entry so the more specific match wins. The legacy
// router rejected anything with an extra "/", which is what the
// "does not match a nested path under a dynamic prefix" test
// asserts against /orders/abc/extra; that test still passes
// because no SUFFIX entry exists for /orders.
const DYNAMIC_ROUTES = [
  // "/documents/<id>/evidence" -> per-document OCR bbox readback.
  { prefix: "/documents/",   suffix: "/evidence", handler: documentsEvidence, param: "id" },
  // "/documents/<id>" -> documentsById, sets req.query.id
  { prefix: "/documents/",   handler: documentsById,  param: "id" },
  // "/orders/<id>"
  // /orders/<id>/pipeline-state takes precedence over the bare
  // /orders/<id> route below thanks to suffix-aware matching.
  { prefix: "/orders/",      suffix: "/pipeline-state", handler: ordersPipelineState, param: "id" },
  // /orders/extraction_jobs/<id> is the Phase C job-status read
  // path. Must precede the bare /orders/<id> handler so its
  // more-specific prefix wins the match order.
  { prefix: "/orders/extraction_jobs/", handler: ordersExtractionJobsId, param: "id" },
  { prefix: "/orders/",      handler: ordersById,     param: "id" },
  // "/source_pos/<id>/ack_extract" -> Phase F.2 supplier-ack PDF extractor.
  // "/source_pos/<id>/ack_accept" -> Phase F.2 commit reviewed extraction.
  // Listed BEFORE the bare /source_pos/<id> entry so the suffix-aware
  // matcher catches them first.
  { prefix: "/source_pos/",  suffix: "/ack_extract", handler: sourcePosAckExtract, param: "id" },
  { prefix: "/source_pos/",  suffix: "/ack_accept",  handler: sourcePosAckAccept,  param: "id" },
  // "/source_pos/<id>"
  { prefix: "/source_pos/",  handler: sourcePosById,  param: "id" },
  // Invoices: /invoices/<id>. The static "/invoices" + "/invoices/pdf"
  // + "/invoices/send" entries above take precedence; the dynamic
  // path only resolves when none of those match.
  { prefix: "/invoices/",    handler: invoicesById,   param: "id" },
  // Inventory-planning action endpoints (Phase 2). Each handler
  // parses its own (id, action) from req.url so we just dispatch to
  // it on the right prefix+suffix combo.
  { prefix: "/inventory/plans/",      suffix: "/approve",  handler: inventoryPlans,      param: "id" },
  { prefix: "/inventory/plans/",      suffix: "/release",  handler: inventoryPlans,      param: "id" },
  { prefix: "/inventory/plans/",      suffix: "/cancel",   handler: inventoryPlans,      param: "id" },
  { prefix: "/inventory/exceptions/", suffix: "/ack",      handler: inventoryExceptions, param: "id" },
  { prefix: "/inventory/exceptions/", suffix: "/resolve",  handler: inventoryExceptions, param: "id" },
  { prefix: "/inventory/exceptions/", suffix: "/suppress", handler: inventoryExceptions, param: "id" },
  // PATCH /inventory/allocations/<id>.
  { prefix: "/inventory/allocations/", handler: inventoryAllocations, param: "id" },
  // PATCH /inventory/suppliers/<id>.
  { prefix: "/inventory/suppliers/",   handler: inventorySuppliers,   param: "id" },
];

// Resolve a request URL to a handler. Returns null if not matched.
const resolve = (pathname) => {
  if (STATIC_ROUTES[pathname]) {
    return { handler: STATIC_ROUTES[pathname], params: {} };
  }
  for (const route of DYNAMIC_ROUTES) {
    if (!pathname.startsWith(route.prefix)) continue;
    let tail = pathname.slice(route.prefix.length);
    if (route.suffix) {
      if (!tail.endsWith(route.suffix)) continue;
      tail = tail.slice(0, -route.suffix.length);
    }
    // Don't match deeper paths than expected (e.g. /orders/abc/extra
    // when no suffix is configured). The legacy [id].js handlers
    // expect a single trailing segment.
    if (!tail || tail.includes("/")) continue;
    return { handler: route.handler, params: { [route.param]: tail } };
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
