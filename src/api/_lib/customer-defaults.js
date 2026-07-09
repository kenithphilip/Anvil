// Per-customer defaults for order header fields.
//
// "Cleaner than an ERP": an operator sets a customer's incoterm, the buyer's
// vendor code for us, and the delivery contact ONCE on the customer master;
// every order for that customer inherits them so nobody re-types per PO.
//
// Reads only EXISTING masters (no new schema):
//   incoterm_code             <- customers.default_incoterms
//   vendor_code               <- customer_vendor_codes (is_primary first)
//   delivery_point_contact_id <- customer_contacts (is_primary)
//   country                   <- customers.country (locale hint for date parse)
//
// Every query is best-effort: an error (e.g. a table missing on an older
// deployment) leaves that field unresolved rather than failing order create.

export const resolveCustomerDefaults = async (svc, tenantId, customerId) => {
  const out = {};
  if (!svc || !tenantId || !customerId) return out;
  try {
    const cust = await svc.from("customers")
      .select("country, default_incoterms")
      .eq("tenant_id", tenantId).eq("id", customerId).maybeSingle();
    if (cust?.data) {
      if (cust.data.country) out.country = cust.data.country;
      if (cust.data.default_incoterms) out.incoterm_code = cust.data.default_incoterms;
    }
  } catch (_) { /* best-effort */ }
  try {
    const vc = await svc.from("customer_vendor_codes")
      .select("vendor_code, is_primary")
      .eq("tenant_id", tenantId).eq("customer_id", customerId)
      .order("is_primary", { ascending: false });
    const primary = (vc?.data || [])[0];
    if (primary?.vendor_code) out.vendor_code = primary.vendor_code;
  } catch (_) { /* best-effort */ }
  try {
    const ct = await svc.from("customer_contacts")
      .select("id, is_primary")
      .eq("tenant_id", tenantId).eq("customer_id", customerId)
      .eq("is_primary", true).limit(1);
    const c = (ct?.data || [])[0];
    if (c?.id) out.delivery_point_contact_id = c.id;
  } catch (_) { /* best-effort */ }
  return out;
};

// Header fields (excluding the country locale hint) that carry a "from
// customer" provenance pill on the Header tab when auto-filled.
export const CUSTOMER_DEFAULT_HEADER_KEYS = ["incoterm_code", "vendor_code", "delivery_point_contact_id"];

// Fill body header fields from the resolved defaults, ONLY when the caller
// didn't already supply one — so an explicit value or an OCR-detected value
// from the PO always wins over the customer default. Mutates body and returns
// the list of keys that were filled (so the caller can stamp provenance).
export const applyCustomerDefaults = (body, defaults) => {
  const filled = [];
  for (const k of ["country", ...CUSTOMER_DEFAULT_HEADER_KEYS]) {
    const cur = body[k];
    if ((cur == null || cur === "") && defaults[k] != null && defaults[k] !== "") {
      body[k] = defaults[k];
      filled.push(k);
    }
  }
  return filled;
};
