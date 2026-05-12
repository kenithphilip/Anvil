// Tenant-identity scrubber for DocAI extraction output.
//
// Reported behaviour (May 2026): the extractor scans the whole
// PDF and pulls any email/phone it finds into `customer.email` /
// `customer.phone`. For Indian POs the seller's contact details
// (the tenant's own salesperson email, support number) are
// printed in the "Your Ref" or "Vendor" block above the line
// table. When the buyer block omits an email (very common; many
// Indian POs only include billing address + GSTIN), the model
// happily promotes the seller's email into the customer record.
//
// Fix: after extraction, compare each customer-block scalar
// against the known tenant identity. Null any field that
// matches the tenant. This is adapter-agnostic; works for any
// model that might leak.
//
// Caller is also responsible for telling the model what the
// tenant identity is in the system prompt (claude.js +
// gemini.js do this from May 2026 onward), so the leak is
// proactively prevented; the scrubber is the safety net.

// Pure-data extraction. The DB read happens in run.js.

const normEmail = (s) => String(s || "").trim().toLowerCase();
const emailDomain = (s) => {
  const v = normEmail(s);
  const at = v.indexOf("@");
  return at >= 0 ? v.slice(at + 1) : "";
};
const normGstin = (s) => String(s || "").trim().toUpperCase().replace(/\s+/g, "");
const digits = (s) => String(s || "").replace(/\D+/g, "");

const sameEmail = (a, b) => !!a && !!b && normEmail(a) === normEmail(b);
const sameDomain = (a, b) => {
  const da = emailDomain(a);
  const db = emailDomain(b);
  return !!da && !!db && da === db;
};
const sameGstin = (a, b) => !!a && !!b && normGstin(a) === normGstin(b);
const samePhone = (a, b) => {
  const da = digits(a);
  const db = digits(b);
  if (!da || !db) return false;
  // Compare the last 10 digits so country-code prefixes do not
  // miss a match (091 vs +91 vs 91 vs no prefix).
  return da.slice(-10) === db.slice(-10);
};

// Build a tenant-identity object from tenant_settings + tenants
// rows. Returns null when no identity could be gathered (legacy
// deployments without migration 062 columns), in which case the
// scrubber skips entirely.
export const buildTenantIdentity = (tenant, settings) => {
  if (!tenant && !settings) return null;
  const tenantEmail = (settings && (settings.einvoice_seller_email || settings.tenant_email)) || null;
  const tenantGstin = (settings && (settings.einvoice_seller_gstin || settings.tenant_gstin)) || null;
  const tenantPhone = (settings && (settings.einvoice_seller_phone || settings.tenant_phone)) || null;
  const tenantLegalName = (settings && settings.einvoice_seller_legal_name)
    || (tenant && tenant.display_name)
    || null;
  // Allow the operator to seed additional sentinel emails / phones
  // via tenant_settings.docai_tenant_aliases JSONB. Useful when
  // multiple support inboxes / sales reps are printed on outgoing
  // quotes and may leak back through customer POs.
  const aliasEmails = Array.isArray(settings?.docai_tenant_aliases?.emails)
    ? settings.docai_tenant_aliases.emails.map(normEmail).filter(Boolean)
    : [];
  const aliasPhones = Array.isArray(settings?.docai_tenant_aliases?.phones)
    ? settings.docai_tenant_aliases.phones.map(digits).filter(Boolean)
    : [];
  // Derived: domain part of the tenant email used to catch
  // "<other person>@<tenant-domain>" leaks.
  const domain = tenantEmail ? emailDomain(tenantEmail) : "";
  if (!tenantEmail && !tenantGstin && !tenantPhone && !tenantLegalName && !aliasEmails.length) return null;
  return {
    legal_name: tenantLegalName,
    gstin: tenantGstin || null,
    email: tenantEmail || null,
    phone: tenantPhone || null,
    email_domain: domain || null,
    alias_emails: aliasEmails,
    alias_phones: aliasPhones,
  };
};

// Scrub a customer block in place (returns a new object). For
// each field that matches the tenant identity, replace with
// null and record the field name in the returned `scrubbed`
// array. Caller logs scrubbed to the audit trail so operators
// can verify nothing legitimate was nulled.
export const scrubCustomerOfTenantIdentity = (customer, identity) => {
  if (!customer || typeof customer !== "object") return { customer, scrubbed: [] };
  if (!identity) return { customer, scrubbed: [] };
  const scrubbed = [];
  const next = { ...customer };

  // Email.
  if (next.email) {
    const tenantEmails = [identity.email, ...identity.alias_emails].filter(Boolean);
    const exact = tenantEmails.some((te) => sameEmail(next.email, te));
    const domainHit = !!identity.email_domain && sameDomain(next.email, identity.email);
    if (exact || domainHit) {
      next.email = null;
      scrubbed.push("email");
    }
  }

  // Phone.
  if (next.phone) {
    const tenantPhones = [identity.phone, ...identity.alias_phones].filter(Boolean);
    if (tenantPhones.some((tp) => samePhone(next.phone, tp))) {
      next.phone = null;
      scrubbed.push("phone");
    }
  }

  // GSTIN. A customer with the tenant's own GSTIN is by
  // definition the seller, not the buyer. Hard nullification.
  if (next.gstin && identity.gstin && sameGstin(next.gstin, identity.gstin)) {
    next.gstin = null;
    scrubbed.push("gstin");
  }

  // Legal name. Some models report the seller's legal name in
  // the customer slot when the buyer block is sparse. Compare
  // case-insensitively after trimming common entity suffixes.
  if (next.name && identity.legal_name) {
    const norm = (s) => String(s || "").toLowerCase()
      .replace(/\b(pvt|private|ltd|limited|llp|inc|corp|corporation|co|company)\b/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
    if (norm(next.name) && norm(next.name) === norm(identity.legal_name)) {
      next.name = null;
      scrubbed.push("name");
    }
  }

  return { customer: next, scrubbed };
};
