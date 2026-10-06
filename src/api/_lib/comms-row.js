// One shape for every `communications` row.
//
// WHY THIS EXISTS. The table was defined once and never altered, but twelve
// writers grew six mutually-incompatible schemas around it — three different
// names for the recipient (`to_addr` / `to_address` / `recipient`), three for
// the template (`template_code` / `template_kind` / `template`), four for the
// subject reference (`object_id` / `ref_id` / `origin_ref` / `external_ref`),
// and four statuses the CHECK rejected (`queued`, `manual`, `pending_send`).
//
// The consequences were not theoretical: POST /api/quotes/send and
// /api/invoices/send threw on every call, so customer-facing quote and invoice
// email was broken end to end, and the writers that swallowed their errors
// dropped messages silently.
//
// Rewriting twelve call sites by hand is how the drift happened in the first
// place. Instead every writer now passes its own vocabulary to commsRow(),
// which maps the aliases onto the real columns and drops anything that is not
// one. Adding a column means changing this file, not twelve.
//
// Pure: no I/O, no database. Fully testable.

// The real columns, per 005_close_remaining_gaps.sql + 189_communications_reconcile.sql.
export const COMMS_COLUMNS = new Set([
  "tenant_id", "order_id", "source_po_id", "direction", "channel", "thread_id",
  "from_addr", "to_addr", "subject", "body", "status", "template_code",
  "attachments", "metadata", "sent_at", "created_at",
  // added by 189
  "cc_addrs", "bcc_addrs", "reply_to", "object_type", "object_id",
  "customer_id", "customer_contact_id", "document_type",
  "provider", "provider_message_id", "sent_by", "updated_at",
]);

export const COMMS_STATUSES = new Set([
  "draft", "queued", "sent", "failed", "replied", "archived",
]);

// Writer vocabulary -> real column.
const ALIASES = {
  to_address: "to_addr",
  recipient: "to_addr",
  template: "template_code",
  template_kind: "template_code",
  meta: "metadata",
  body_text: "body",
  kind: "document_type",       // `kind` was always a document-type in disguise
};

// Statuses writers used that the CHECK rejected. `manual` meant "no provider
// configured, a human must send it" — which is queued, not sent.
const STATUS_ALIASES = {
  pending_send: "queued",
  manual: "queued",
};

const asArray = (v) => {
  if (v == null || v === "") return [];
  return (Array.isArray(v) ? v : [v]).map((x) => String(x).trim()).filter(Boolean);
};

// Build a valid communications row from any writer's vocabulary.
//
// Rules:
//   * aliases are mapped onto real columns;
//   * unknown keys are moved into `metadata` rather than dropped, so a writer's
//     context (origin_ref, external_ref, to_name, …) survives instead of
//     throwing a PostgREST error;
//   * `direction` defaults to 'outbound' — it is NOT NULL, and every writer
//     that omitted it was sending;
//   * `body_html` is preserved in metadata (there is no such column, and the
//     drift-report cron is the only producer).
export const commsRow = (input = {}) => {
  const out = {};
  const extra = {};

  for (const [rawKey, value] of Object.entries(input)) {
    if (value === undefined) continue;
    const key = ALIASES[rawKey] || rawKey;
    if (key === "metadata") {
      Object.assign(extra, value && typeof value === "object" ? value : { metadata: value });
      continue;
    }
    if (COMMS_COLUMNS.has(key)) {
      // Last writer wins, except never let an alias clobber an explicit value.
      if (out[key] === undefined || rawKey === key) out[key] = value;
    } else {
      extra[rawKey] = value;
    }
  }

  out.direction = out.direction || "outbound";
  out.channel = out.channel || "email";

  const status = String(out.status || "draft");
  out.status = STATUS_ALIASES[status] || (COMMS_STATUSES.has(status) ? status : "queued");

  out.cc_addrs = asArray(out.cc_addrs);
  out.bcc_addrs = asArray(out.bcc_addrs);

  if (Object.keys(extra).length) out.metadata = { ...(out.metadata || {}), ...extra };
  return out;
};

// True when a row is safe to insert — used by tests and by the guard test that
// scans handler source. Kept separate so a caller can assert without inserting.
export const invalidCommsKeys = (row) =>
  Object.keys(row || {}).filter((k) => !COMMS_COLUMNS.has(k));
