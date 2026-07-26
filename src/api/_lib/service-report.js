// Customer-facing service report — TEMPLATE-DRIVEN, so it adapts to the seller
// (the Anvil tenant) AND to their customers, rather than replicating any one
// firm's form.
//
// An engineer fills a report on site, co-signed by both parties, so the
// customer already has a copy. The value of the typed report is a legible,
// archivable, retrievable record — and, when the visit was chargeable, the
// document that precedes billing.
//
// WHY A TEMPLATE, NOT FIXED FIELDS. A welding-gun service report, an HVAC one,
// and an IT one share almost no fields, and two customers of the same seller
// may want different sections. So layout, labels, and — critically — which
// fields are customer-facing vs internal all come from a template
// (service_report_templates), resolved customer -> tenant default -> the
// built-in DEFAULT_TEMPLATE below. Zero configuration still produces a sensible
// report: redundancy, not a gate.
//
// TWO PROPERTIES CARRIED FROM THE GRN STATEMENT:
//   * NO INTERNAL LEAK — now GENERALISED: a field is customer-facing only when
//     the template marks it visibility:'customer'. The engineer's private notes
//     are just a field the default template marks 'internal'.
//   * DEGRADE GRACEFULLY — a field with no value is OMITTED, never printed as an
//     empty skeleton, and never blocks the report.
//
// Pure: no I/O. The caller fetches the visit, its parts, the customer/contact,
// and the resolved template.

const s = (v) => (v == null ? null : (typeof v === "string" ? v.trim() || null : v));

const hhmm = (ts) => {
  if (!ts) return null;
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(11, 16);
};

// The built-in default, used when a tenant has authored no template. Generic on
// purpose — a seller renames sections, drops fields, or adds their own, but the
// out-of-the-box report is already useful. Field `key`s resolve against the
// merged value map built in buildServiceReport (core columns + report_fields).
export const DEFAULT_TEMPLATE = {
  name: "Default service report",
  include_parts: true,
  sections: [
    {
      key: "visit", title: "Visit details",
      fields: [
        { key: "report_number", label: "Report No", visibility: "customer" },
        { key: "visit_date", label: "Date", visibility: "customer" },
        { key: "location", label: "Line / Station", visibility: "customer" },
        { key: "equipment_name", label: "Equipment", visibility: "customer" },
        { key: "serial_no", label: "Serial No", visibility: "customer" },
        { key: "model_name", label: "Model", visibility: "customer" },
        { key: "support_type", label: "Support", visibility: "customer" },
        { key: "warranty_status", label: "Warranty", visibility: "customer" },
        { key: "on_site", label: "On site", visibility: "customer" },
      ],
    },
    {
      key: "work", title: "Work carried out",
      fields: [
        { key: "purpose", label: "Purpose", visibility: "customer" },
        { key: "observation", label: "Observation", visibility: "customer" },
        { key: "possible_cause", label: "Possible cause", visibility: "customer" },
        { key: "action_taken", label: "Action taken", visibility: "customer" },
        { key: "followup_action", label: "Follow-up", visibility: "customer" },
        // The engineer's private scratch pad: present in the model, never sent.
        { key: "notes", label: "Internal notes", visibility: "internal" },
      ],
    },
  ],
};

const SUPPORT_LABELS = { chargeable: "Chargeable", free: "Free of charge", amc: "Under AMC", pmc: "Under PMC", warranty: "Under warranty", goodwill: "Goodwill" };

// Merge the visit's core columns + its flexible report_fields into ONE value
// map that template field `key`s resolve against. Core columns win over
// report_fields on a key clash (a real column is more authoritative).
const valueMap = ({ visit = {}, customer = {}, contact = {} }) => {
  const inTime = hhmm(visit.check_in_at);
  const outTime = hhmm(visit.check_out_at);
  const core = {
    report_number: s(visit.report_number),
    visit_date: visit.visit_date || null,
    location: s(visit.line_or_station),
    support_type: SUPPORT_LABELS[String(visit.support_type || "").toLowerCase()] || s(visit.support_type),
    purpose: s(visit.purpose),
    observation: s(visit.observation),
    possible_cause: s(visit.possible_cause),
    action_taken: s(visit.action_taken),
    followup_action: s(visit.followup_action),
    notes: s(visit.notes),
    on_site: inTime && outTime ? inTime + "–" + outTime : (inTime || null),
    customer_name: s(customer.customer_name) || s(customer.name),
    contact_name: s(contact.name),
    contact_dept: s(contact.role),
  };
  const flexible = (visit.report_fields && typeof visit.report_fields === "object") ? visit.report_fields : {};
  const merged = { ...flexible };
  for (const [k, v] of Object.entries(core)) if (v != null) merged[k] = v;
  return merged;
};

// Build the customer-facing report from a template. Only 'customer'-visibility
// fields with a value survive; empty fields and empty sections are dropped.
export const buildServiceReport = ({ visit = {}, parts = [], customer = {}, contact = {}, template } = {}) => {
  const tpl = template && Array.isArray(template.sections) && template.sections.length ? template : DEFAULT_TEMPLATE;
  const values = valueMap({ visit, customer, contact });

  const sections = [];
  for (const sec of tpl.sections || []) {
    const rows = [];
    for (const f of sec.fields || []) {
      if (f.visibility !== "customer") continue;         // internal fields never leave
      const value = values[f.key];
      if (value == null || value === "") continue;        // degrade: omit empty
      rows.push({ key: f.key, label: f.label || f.key, value: String(value) });
    }
    if (rows.length) sections.push({ key: sec.key, title: sec.title || null, rows });
  }

  const includeParts = tpl.include_parts !== false;
  const partLines = includeParts
    ? (Array.isArray(parts) ? parts : [])
      .slice().sort((a, b) => (a.seq || 0) - (b.seq || 0))
      .map((p) => ({ part_name: s(p.part_name), part_number: s(p.part_number), action_details: s(p.action_details), remarks: s(p.remarks) }))
      .filter((p) => p.part_name || p.part_number || p.action_details)
    : [];

  return {
    template_name: tpl.name || null,
    report_number: values.report_number || null,
    visit_date: values.visit_date || null,
    customer_name: values.customer_name || null,
    contact_name: values.contact_name || null,
    contact_dept: values.contact_dept || null,
    support_type: s(visit.support_type),                  // raw, for metadata/analytics
    sections,
    parts: partLines,
  };
};

// Render the composed report as an email body. Purely structural — it never
// decides visibility (buildServiceReport already did) and never sees an
// internal field.
export const renderServiceReportText = (r, opts = {}) => {
  const L = [];
  L.push("Service Report" + (r.report_number ? "  (" + r.report_number + ")" : ""));
  if (r.customer_name) L.push("Customer: " + r.customer_name);
  if (r.contact_name) L.push("Attn: " + r.contact_name + (r.contact_dept ? " (" + r.contact_dept + ")" : ""));

  for (const sec of r.sections) {
    L.push("");
    if (sec.title) L.push(sec.title + ":");
    for (const row of sec.rows) {
      // Short values inline; long narrative on its own line.
      if (row.value.length <= 40 && !row.value.includes("\n")) L.push("  " + row.label + ": " + row.value);
      else { L.push("  " + row.label + ":"); L.push("  " + row.value.replace(/\n/g, "\n  ")); }
    }
  }

  if (r.parts.length) {
    L.push("");
    L.push("Parts & action summary:");
    L.push("Sr | Part Name          | Part Number     | Action              | Remarks");
    r.parts.forEach((p, i) => {
      L.push([
        String(i + 1).padEnd(2),
        (p.part_name || "—").padEnd(18),
        (p.part_number || "—").padEnd(15),
        (p.action_details || "—").padEnd(19),
        p.remarks || "",
      ].join(" | "));
    });
  }

  if (opts.footer) { L.push(""); L.push(opts.footer); }
  return L.join("\n");
};

// Nothing worth sending: no visible section rows and no parts.
export const isReportEmpty = (r) =>
  !(r.sections || []).some((sec) => sec.rows.length) && !(r.parts || []).length;

// Resolve the template for a customer: their override, else the tenant default,
// else the built-in. Pure; caller supplies the fetched rows.
export const resolveTemplate = (templates, customerId) => {
  const active = (Array.isArray(templates) ? templates : []).filter((t) => t && t.is_active !== false);
  const forCustomer = customerId && active.find((t) => t.customer_id === customerId);
  const tenantDefault = active.find((t) => t.customer_id == null);
  return forCustomer || tenantDefault || DEFAULT_TEMPLATE;
};
