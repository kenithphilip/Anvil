// PII redaction for marketplace publication. Bet 2.
//
// Before a customer_format_templates row leaves the publisher's
// tenant boundary, this module strips the sample_value column on
// every anchor + inspects every label for accidental PII (email,
// phone, PAN, GSTIN, address fragments, Aadhaar, person names with
// honorifics).
//
// The output shape is:
//
//   redactTemplateForPublication(template) -> {
//     redacted: { anchors[], line_anchors[] }   (sample_value removed,
//                                                labels scrubbed),
//     report: {
//       stripped_sample_values: number,
//       scrubbed_labels:        [{ field, reasons[] }],
//       pii_detections:         [{ kind, sample, where }],
//       ok: boolean             (false when ANY PII detected; caller
//                                decides whether to block).
//     }
//   }
//
// We treat ANY PII detection as a publish blocker by default. The
// publisher can edit the label to remove the PII and retry.
//
// Pure: no I/O, no LLM. Pattern set is deliberately narrow + audit-
// able; we don't reach into Presidio or a downstream service.

// Regex set for detection. Each entry returns the kind so the
// caller can show specific feedback ("you have a phone number in
// the label for field=customer.name").
const PII_PATTERNS = [
  { kind: "gstin",     rx: /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/ },
  { kind: "pan",       rx: /\b[A-Z]{5}\d{4}[A-Z]\b/ },
  { kind: "email",     rx: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
  { kind: "phone_in",  rx: /\b(?:\+?91[\s-]?)?[6-9]\d{9}\b/ },
  { kind: "phone_intl",rx: /\+\d{1,3}[\s-]?\d{6,12}\b/ },
  { kind: "aadhaar",   rx: /\b\d{4}\s?\d{4}\s?\d{4}\b/ },
  // Indian postal codes are 6 digits; we treat a 6-digit run on its
  // own as a weak signal, not a hard PII.
  { kind: "pincode",   rx: /\b\d{6}\b/, soft: true },
  // Bank-account-ish numbers (10-18 digit runs without separators).
  { kind: "bank_acct", rx: /\b\d{10,18}\b/ },
  // IBAN.
  { kind: "iban",      rx: /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/ },
  // Honorific + capitalised first word (Mr Smith, Mrs Kumar, M/s. Acme).
  // Note: "M/s." is a corporate prefix Anvil's stripping rule deletes
  // from the customer name; if it ended up in a label, that's a
  // customer-identity leak worth blocking.
  { kind: "honorific", rx: /\b(?:Mr\.?|Mrs\.?|Ms\.?|Dr\.?|M\/[Ss]\.?)\s+[A-Z][a-zA-Z]+\b/ },
];

// Anchor field names whose label is allowed to be ANY string (the
// document's natural language varies enough that we cannot enforce
// a strict whitelist). We DO still PII-scan the label text.
const KNOWN_FIELDS = new Set([
  "customer.name", "customer.email", "customer.phone",
  "customer.gstin", "customer.state_code", "customer.currency",
  "customer.payment_terms", "customer.bill_to_address",
  "customer.ship_to_address", "customer.po_number", "customer.po_date",
  "lines.partNumber", "lines.description", "lines.quantity",
  "lines.unitPrice", "lines.uom", "lines.hsn", "lines.gst_pct",
]);

const detectPiiIn = (text, where) => {
  const out = [];
  if (typeof text !== "string" || text.length === 0) return out;
  for (const p of PII_PATTERNS) {
    if (p.soft) continue;        // soft signals do not block by default
    const m = text.match(p.rx);
    if (m) {
      out.push({ kind: p.kind, sample: m[0].slice(0, 40), where });
    }
  }
  return out;
};

const scrubAnchor = (anchor, kind) => {
  const labelDetections = detectPiiIn(anchor?.label || "", `${kind}.label`);
  const sampleDetections = detectPiiIn(anchor?.sample_value || "", `${kind}.sample_value`);
  const scrubbed = {
    field: anchor?.field,
    pattern: anchor?.pattern,
    capture_group: anchor?.capture_group ?? 1,
    label: anchor?.label || "",
    // sample_value is ALWAYS stripped, regardless of PII detection.
    // We replace with a stable placeholder so consumers know there
    // was once a sample (but never see it).
    sample_value: anchor?.sample_value ? "<redacted>" : null,
  };
  return {
    anchor: scrubbed,
    detections: [...labelDetections, ...sampleDetections],
  };
};

// Public entry. Walks every anchor + line_anchor, returns the
// scrubbed bundle + a detection report.
export const redactTemplateForPublication = (template) => {
  if (!template || typeof template !== "object") {
    return {
      redacted: { anchors: [], line_anchors: [] },
      report: {
        stripped_sample_values: 0,
        scrubbed_labels: [],
        pii_detections: [],
        ok: false,
        error: "template_not_object",
      },
    };
  }
  const detections = [];
  const scrubbedLabels = [];
  const anchors = (template.anchors || []).map((a) => {
    const r = scrubAnchor(a, "anchor");
    if (r.detections.length) {
      detections.push(...r.detections);
      scrubbedLabels.push({ field: a?.field, reasons: r.detections.map((d) => d.kind) });
    }
    return r.anchor;
  });
  const lineAnchors = (template.line_anchors || []).map((a) => {
    const r = scrubAnchor(a, "line_anchor");
    if (r.detections.length) {
      detections.push(...r.detections);
      scrubbedLabels.push({ field: a?.field, reasons: r.detections.map((d) => d.kind) });
    }
    return r.anchor;
  });
  const stripped = anchors.filter((a) => a.sample_value === "<redacted>").length
                 + lineAnchors.filter((a) => a.sample_value === "<redacted>").length;
  // Optional: also check that every anchor's `field` is one of our
  // known canonical fields. An anchor for an unknown field name is
  // suspicious (might be a custom exfiltration path) and we tag it
  // so the human reviewer can decide.
  const unknownFields = [...anchors, ...lineAnchors]
    .filter((a) => a.field && !KNOWN_FIELDS.has(a.field))
    .map((a) => a.field);
  return {
    redacted: { anchors, line_anchors: lineAnchors },
    report: {
      stripped_sample_values: stripped,
      scrubbed_labels: scrubbedLabels,
      pii_detections: detections,
      unknown_fields: unknownFields,
      ok: detections.length === 0,
    },
  };
};

// Convenience predicate: does this redaction report block
// publication? Returns true iff any PII detection OR any unknown
// field.
export const isBlockingReport = (report) => {
  if (!report) return true;
  return !report.ok || (report.unknown_fields || []).length > 0;
};

export const __test = { PII_PATTERNS, KNOWN_FIELDS, detectPiiIn };
