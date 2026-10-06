// A rep touch: a call, meeting, WhatsApp, visit or note a sales rep logs
// against a quote or an opportunity.
//
// A touch is a `communications` row, not a new table. The row is written
// already-final (status 'sent', provider 'manual'), so nothing downstream
// treats it as mail to transmit:
//   * the queued-comms reaper (agents/run.js reapQueuedCommsForTenant) selects
//     status = 'queued' only;
//   * sendCommunication (_lib/comms-send.js) returns idempotent on a 'sent' row;
//   * the customer-comms metrics (_lib/metrics/catalog.js CUSTOMER_COMMS_TYPES)
//     count an allow-list of document types, and 'rep_touch' is not on it.
//
// Pure: no I/O. The screen imports TOUCH_CHANNELS from here so the form's
// options and the server's allow-list cannot drift apart.

export const TOUCH_DOCUMENT_TYPE = "rep_touch";

// Allow-list, not a free-text field: an unknown channel is refused (400).
export const TOUCH_CHANNELS = ["call", "meeting", "whatsapp", "visit", "note"];

// The objects a touch may be logged against, and the table each lives in.
// The target is looked up tenant-scoped; its customer_id is copied onto the
// touch so a per-customer timeline sees it.
export const TOUCH_OBJECT_TABLES = {
  quote: "quotes",
  opportunity: "opportunities",
};

// Longest note a rep can log in one touch. Generous for call notes; it stops a
// pasted email thread from becoming a multi-megabyte communications row.
export const TOUCH_BODY_MAX = 10000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v) => typeof v === "string" && UUID_RE.test(v);

// A calendar date written YYYY-MM-DD that actually exists. "2026-02-30" has the
// right shape but is not a date, and Date would silently roll it to March.
export const isIsoDate = (v) => {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + "T00:00:00Z");
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

const bad = (message) => ({ error: message });

// Validate a POST body. Returns { error } for a 400, or { value } holding the
// normalised fields. Never touches the database: the tenant-scoped target and
// contact lookups happen in the handler.
export const validateTouch = (body) => {
  const b = body && typeof body === "object" ? body : {};
  const objectType = typeof b.object_type === "string" ? b.object_type : "";
  if (!Object.prototype.hasOwnProperty.call(TOUCH_OBJECT_TABLES, objectType)) {
    return bad("object_type must be one of: " + Object.keys(TOUCH_OBJECT_TABLES).join(", "));
  }
  if (!isUuid(b.object_id)) return bad("object_id must be a uuid");
  // Exact match: the channel is a discriminator, so a near miss is refused
  // rather than coerced.
  const channel = b.channel;
  if (typeof channel !== "string" || !TOUCH_CHANNELS.includes(channel)) {
    return bad("channel must be one of: " + TOUCH_CHANNELS.join(", "));
  }
  const text = typeof b.body === "string" ? b.body.trim() : "";
  if (!text) return bad("body is required");
  if (text.length > TOUCH_BODY_MAX) return bad("body is longer than " + TOUCH_BODY_MAX + " characters");

  const meta = b.metadata && typeof b.metadata === "object" ? b.metadata : {};
  const next = meta.next_followup_at;
  if (next != null && next !== "" && !isIsoDate(next)) {
    return bad("metadata.next_followup_at must be a date written YYYY-MM-DD");
  }
  const contactId = b.customer_contact_id;
  if (contactId != null && contactId !== "" && !isUuid(contactId)) {
    return bad("customer_contact_id must be a uuid");
  }
  return {
    value: {
      object_type: objectType,
      object_id: b.object_id,
      channel,
      body: text,
      next_followup_at: next ? next : null,
      customer_contact_id: contactId ? contactId : null,
    },
  };
};
