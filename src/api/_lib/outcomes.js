// Maps the 96 distinct audit-event actions onto a small set of billable
// outcomes. The audit table is the source of truth for "did the system
// do work that the customer paid for"; this file is the dictionary that
// turns raw verbs into invoiceable line items.
//
// Categories chosen for billing readability, not engineering precision:
//
//   order_processed       a new SO entered the system
//   order_pushed          an SO was pushed to a real ERP (Tally today)
//   quote_drafted         a quote draft was generated for a customer
//   communication_sent    an outbound email/SMS/WhatsApp left the system
//   invoice_generated     a customer invoice was generated (GSTN today)
//   approval_decision     a manager / finance role accepted or rejected
//   document_extracted    OCR + Claude extracted structured fields
//   service_visit_closed  a service visit closure report was filed
//   agent_action          an autonomous follow-up agent took a step
//   anomaly_resolved      an anomaly or duplicate was resolved
//
// Anything not in the map is treated as "platform overhead" and not
// charged. Adding a new outcome means adding the verb here AND
// updating docs/BILLING_OUTCOMES.md so the customer-facing meter
// matches the engineering view.

export const ACTION_TO_OUTCOME = {
  // Orders
  create_order:           "order_processed",
  // Tally push pipeline. We only count exported, not the upstream attempts.
  tally_push:             "order_pushed",
  tally_amend:            "order_pushed",
  tally_reconcile:        "order_pushed",

  // Quotes + communications
  comm_draft:             "quote_drafted",
  comm_send:              "communication_sent",
  comm_missing_doc:       "communication_sent",

  // Invoicing (India today; non-India lands here when invoicing module ships)
  einvoice_draft:         "invoice_generated",
  einvoice_generated:     "invoice_generated",
  einvoice_send_pending:  "invoice_generated",

  // Approvals (only the decision counts, not the request)
  approval_decision:      "approval_decision",

  // Document pipeline
  document_upload_intent: "document_extracted",
  document_scan:          "document_extracted",
  email_intake:           "document_extracted",
  whatsapp_intake:        "document_extracted",

  // Service ops
  closure_create:         "service_visit_closed",
  amc_visit_auto_created: "service_visit_closed",
  car_create:             "service_visit_closed",

  // Agent v1 (forward-compatible; rows land here once agents/run lands)
  agent_action_taken:     "agent_action",
  agent_goal_completed:   "agent_action",

  // Anomaly + duplicates
  anomaly_resolved:       "anomaly_resolved",
  duplicate_resolved:     "anomaly_resolved",
};

export const OUTCOME_LABELS = {
  order_processed:      "Orders processed",
  order_pushed:         "Orders pushed to ERP",
  quote_drafted:        "Quotes drafted",
  communication_sent:   "Communications sent",
  invoice_generated:    "Invoices generated",
  approval_decision:    "Approval decisions",
  document_extracted:   "Documents extracted",
  service_visit_closed: "Service visits closed",
  agent_action:         "Autonomous agent actions",
  anomaly_resolved:     "Anomalies resolved",
};

// All known outcome ids in display order.
export const OUTCOME_ORDER = [
  "order_processed",
  "order_pushed",
  "quote_drafted",
  "invoice_generated",
  "approval_decision",
  "document_extracted",
  "communication_sent",
  "service_visit_closed",
  "agent_action",
  "anomaly_resolved",
];

// Default per-outcome unit prices in USD cents. Sourced from the pricing
// recommendations in the gap analysis ("outcome / per-task pricing").
// Tenants can override via tenant_settings later; for now this is the
// public price card.
export const OUTCOME_UNIT_PRICE_CENTS = {
  order_processed:      50,
  order_pushed:         100,
  quote_drafted:        25,
  invoice_generated:    50,
  approval_decision:    10,
  document_extracted:   10,
  communication_sent:   10,
  service_visit_closed: 50,
  agent_action:         5,
  anomaly_resolved:     25,
};

// Convenience: classify a raw audit row.
export const outcomeFor = (action) => ACTION_TO_OUTCOME[action] || null;
