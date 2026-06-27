// Customer-registration field catalog + helpers.
//
// Defines the ideal customer-registration form (design:
// docs/CUSTOMER_REGISTRATION_DESIGN.md) as a categorized catalog of data
// points. The values are tracked per customer in `customer_registration_fields`
// (one row per field, with provenance + verification metadata) so the later
// automation (GSTIN fetch #186, document OCR cross-check #187) can populate and
// verify fields individually. The canonical master stays in `customers`;
// `mapsTo` records which catalog fields sync into a master column later.
//
// Pure module: no DB/network. Safe to unit-test.

// Provenance for a captured value.
export const FIELD_SOURCES = new Set(["manual", "gst", "doc", "internal"]);

// Categories in display order.
export const CATEGORIES = [
  { key: "statutory_identity", label: "Statutory identity" },
  { key: "business_profile",   label: "Business profile" },
  { key: "contacts",           label: "Contacts" },
  { key: "commercial_terms",   label: "Commercial terms" },
  { key: "banking",            label: "Banking" },
  { key: "internal",           label: "Internal" },
];

// Field catalog. type: text | longtext | email | phone | amount | date | select.
// mandatory marks the minimum viable registration. mapsTo (optional) is the
// `customers` master column an approved value syncs into later.
export const FIELD_CATALOG = [
  // A. Statutory identity (GST-first; auto-fill + verify later)
  { key: "gstin",                 category: "statutory_identity", label: "GSTIN",                       type: "text",     mandatory: true,  mapsTo: "gstin" },
  { key: "legal_name",            category: "statutory_identity", label: "Legal name",                  type: "text",     mandatory: true,  mapsTo: "customer_name" },
  { key: "trade_name",            category: "statutory_identity", label: "Trade name",                  type: "text" },
  { key: "pan",                   category: "statutory_identity", label: "PAN",                         type: "text",     mandatory: true },
  { key: "state_code",            category: "statutory_identity", label: "State code",                  type: "text",     mandatory: true,  mapsTo: "state_code" },
  { key: "principal_address",     category: "statutory_identity", label: "Principal place of business", type: "longtext", mandatory: true },
  { key: "taxpayer_type",         category: "statutory_identity", label: "Taxpayer type",               type: "select",   options: ["Regular", "Composition", "SEZ", "Casual", "Unregistered"] },
  { key: "gst_status",            category: "statutory_identity", label: "GST status",                  type: "select",   options: ["Active", "Cancelled", "Suspended", "Provisional"] },
  { key: "gst_registration_date", category: "statutory_identity", label: "GST registration date",       type: "date" },
  { key: "constitution",          category: "statutory_identity", label: "Constitution of business",    type: "text" },
  { key: "country",               category: "statutory_identity", label: "Country",                     type: "text",     mandatory: true },
  { key: "foreign_tax_id",        category: "statutory_identity", label: "Foreign tax id",              type: "text" },
  { key: "foreign_tax_id_type",   category: "statutory_identity", label: "Foreign tax id type",         type: "select",   options: ["VAT", "TIN", "EIN", "Other"] },

  // B. Business profile
  { key: "customer_type",     category: "business_profile", label: "Customer type",     type: "select", mandatory: true, options: ["OEM", "Tier-1", "Distributor", "Aftermarket", "Internal", "Other"] },
  { key: "industry_segment",  category: "business_profile", label: "Industry / segment", type: "text" },
  { key: "customer_category", category: "business_profile", label: "Customer category",  type: "text" },
  { key: "short_name",        category: "business_profile", label: "Short name (<=10)",  type: "text" },
  { key: "msme_status",       category: "business_profile", label: "MSME status",        type: "select", options: ["None", "Micro", "Small", "Medium"] },
  { key: "udyam_number",      category: "business_profile", label: "Udyam number",       type: "text" },
  { key: "website",           category: "business_profile", label: "Website",            type: "text" },

  // C. Contacts (role-based, trimmed)
  { key: "purchase_contact_name",        category: "contacts", label: "Purchase contact name",        type: "text", mandatory: true },
  { key: "purchase_contact_designation", category: "contacts", label: "Purchase contact designation", type: "text" },
  { key: "purchase_contact_email",       category: "contacts", label: "Purchase contact email",       type: "email" },
  { key: "purchase_contact_mobile",      category: "contacts", label: "Purchase contact mobile",      type: "phone" },
  { key: "finance_contact_name",         category: "contacts", label: "Finance contact name",         type: "text" },
  { key: "finance_contact_email",        category: "contacts", label: "Finance contact email",        type: "email" },
  { key: "finance_contact_phone",        category: "contacts", label: "Finance contact phone",        type: "phone" },
  { key: "project_contact_name",         category: "contacts", label: "Project contact name",         type: "text" },
  { key: "project_contact_email",        category: "contacts", label: "Project contact email",        type: "email" },

  // D. Commercial terms
  { key: "currency",                  category: "commercial_terms", label: "Currency",                 type: "text",   mandatory: true },
  { key: "payment_terms",             category: "commercial_terms", label: "Payment terms",            type: "text",   mandatory: true, mapsTo: "default_payment_terms" },
  { key: "credit_limit",              category: "commercial_terms", label: "Credit limit",             type: "amount" },
  { key: "incoterms",                 category: "commercial_terms", label: "Incoterms",                type: "text",   mapsTo: "default_incoterms" },
  { key: "special_rate_customer_ref", category: "commercial_terms", label: "Special-rate customer ref", type: "text" },

  // E. Banking (verified by cancelled cheque)
  { key: "bank_name",         category: "banking", label: "Bank name",     type: "text" },
  { key: "bank_account_no",   category: "banking", label: "Account number", type: "text" },
  { key: "bank_ifsc",         category: "banking", label: "IFSC code",      type: "text" },
  { key: "bank_branch",       category: "banking", label: "Branch",         type: "text" },
  { key: "bank_account_type", category: "banking", label: "Account type",   type: "select", options: ["Current", "Savings", "Cash Credit", "Other"] },
  { key: "bank_swift",        category: "banking", label: "SWIFT (foreign)", type: "text" },
  { key: "bank_iban",         category: "banking", label: "IBAN (foreign)",  type: "text" },

  // F. Internal (Obara-managed; never shown to the customer)
  { key: "customer_code",         category: "internal", label: "Customer code",         type: "text",   mapsTo: "customer_key" },
  { key: "sales_owner",           category: "internal", label: "Sales owner",           type: "text" },
  { key: "requesting_department", category: "internal", label: "Requesting department", type: "text" },
  { key: "registration_status",   category: "internal", label: "Registration status",   type: "select", options: ["draft", "submitted", "verifying", "approved", "rejected"] },
];

export const FIELD_BY_KEY = FIELD_CATALOG.reduce((m, f) => { m[f.key] = f; return m; }, {});
export const FIELD_KEYS = new Set(FIELD_CATALOG.map((f) => f.key));

export const isValidFieldKey = (key) => FIELD_KEYS.has(key);

// Merge the catalog with the stored value rows into a category-grouped view.
// rows: [{ field_key, value, source, verified, verified_against, updated_at }]
export const groupByCategory = (rows = []) => {
  const byKey = {};
  for (const r of rows) byKey[r.field_key] = r;
  return CATEGORIES.map((cat) => ({
    key: cat.key,
    label: cat.label,
    fields: FIELD_CATALOG.filter((f) => f.category === cat.key).map((f) => {
      const v = byKey[f.key] || null;
      return {
        key: f.key,
        label: f.label,
        type: f.type,
        mandatory: !!f.mandatory,
        options: f.options || null,
        mapsTo: f.mapsTo || null,
        value: v ? v.value : null,
        source: v ? v.source : null,
        verified: v ? !!v.verified : false,
        verified_against: v ? v.verified_against : null,
        updated_at: v ? v.updated_at : null,
      };
    }),
  }));
};

// Completeness: fraction of mandatory fields that have a non-empty value.
export const completeness = (rows = []) => {
  const byKey = {};
  for (const r of rows) byKey[r.field_key] = r;
  const mandatory = FIELD_CATALOG.filter((f) => f.mandatory);
  const filled = mandatory.filter((f) => {
    const v = byKey[f.key];
    return v && v.value != null && String(v.value).trim() !== "";
  });
  return {
    mandatory_total: mandatory.length,
    mandatory_filled: filled.length,
    pct: mandatory.length ? Math.round((filled.length / mandatory.length) * 100) : 100,
    missing: mandatory.filter((f) => {
      const v = byKey[f.key];
      return !(v && v.value != null && String(v.value).trim() !== "");
    }).map((f) => f.key),
  };
};

// Normalize a single incoming field entry into a stored shape. Accepts either
// a raw scalar (value) or an object { value, source, verified, verified_against }.
export const normalizeFieldInput = (entry) => {
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    const source = FIELD_SOURCES.has(entry.source) ? entry.source : "manual";
    return {
      value: entry.value != null ? String(entry.value) : null,
      source,
      verified: !!entry.verified,
      verified_against: entry.verified_against != null ? String(entry.verified_against) : null,
    };
  }
  return { value: entry != null ? String(entry) : null, source: "manual", verified: false, verified_against: null };
};
