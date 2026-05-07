// Shared customer canonicalizer for ERP sync paths.
//
// Audit P4.7. NetSuite/SAP/D365/Acumatica/etc. sync each used to
// upsert customers on (tenant_id, customer_key) with vendor-
// prefixed keys (ns:1234, sap_id:..., etc.). On a tenant that
// runs multiple ERPs the same physical customer ended up with
// N rows, one per vendor. The merge endpoint (P4.6) handles the
// post-hoc cleanup; this helper prevents the dup at sync time
// in the first place.
//
// Lookup order:
//
//   1. Match on external_ref->>{vendor}_id. Idempotent re-sync.
//   2. Match on GSTIN if the ERP supplies one. High confidence.
//   3. Match on canonical name (case-insensitive, alpha-num
//      only, common suffixes like Pvt/Ltd stripped).
//
// On match, fold the new ERP id + metadata into the existing
// row's external_ref. On no match, insert a new row with the
// vendor-prefixed customer_key. Returns the resolved row.
//
// Usage:
//
//   await canonicaliseCustomer(svc, tenantId, {
//     vendor: "netsuite",
//     vendorIdField: "netsuite_id",
//     externalId: c.id,
//     name: c.companyname,
//     email: c.email,
//     gstin: null,
//     ref: { datecreated: c.datecreated, ... },
//   });

const canonicaliseName = (s) => String(s || "")
  .toLowerCase()
  .replace(/\b(pvt|ltd|llp|inc|corp|gmbh|co|company|limited)\b/g, "")
  .replace(/[^a-z0-9]+/g, "");

const slugify = (s) => String(s || "")
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "")
  .slice(0, 60);

// Audit P10. Test-only exports so the unit test at
// src/v3-app/api-canonicaliser.test.js can lock the
// canonical-name rule without standing up Supabase.
export const __test = { canonicaliseName, slugify };

// Find an existing customer by external_ref->>vendorIdField.
const findByExternalId = async (svc, tenantId, vendorIdField, externalId) => {
  if (externalId == null) return null;
  // Supabase JSONB lookup via filter (->>): use the `?` operator
  // by way of `.eq("external_ref->>field", value)`.
  const r = await svc.from("customers")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("external_ref->>" + vendorIdField, String(externalId))
    .limit(1)
    .maybeSingle();
  return r.data || null;
};

const findByGstin = async (svc, tenantId, gstin) => {
  const k = String(gstin || "").trim().toUpperCase();
  if (!k || k.length < 15) return null;
  const r = await svc.from("customers")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("gstin", k)
    .limit(1)
    .maybeSingle();
  return r.data || null;
};

const findByCanonicalName = async (svc, tenantId, name) => {
  const canon = canonicaliseName(name);
  if (!canon || canon.length < 3) return null;
  // Pull a few candidates and filter by canonicalised name in JS;
  // ilike alone would over-match (e.g., "tata" would catch "Tata
  // Communications"). Limit reasonably to avoid full-table scans.
  const r = await svc.from("customers")
    .select("id, customer_name, gstin, external_ref")
    .eq("tenant_id", tenantId)
    .ilike("customer_name", "%" + String(name || "").slice(0, 16) + "%")
    .limit(50);
  if (r.error) return null;
  const exact = (r.data || []).find((c) => canonicaliseName(c.customer_name) === canon);
  return exact || null;
};

const mergeRef = (existing, vendorIdField, newId, extra) => {
  const out = { ...(existing || {}) };
  if (newId != null) out[vendorIdField] = newId;
  for (const [k, v] of Object.entries(extra || {})) {
    if (v != null) out[k] = v;
  }
  return out;
};

export const canonicaliseCustomer = async (svc, tenantId, input) => {
  const { vendor, vendorIdField, externalId, name, email, gstin, ref } = input;
  if (!vendor || !vendorIdField) throw new Error("vendor + vendorIdField required");

  // 1. external-id direct match.
  let existing = await findByExternalId(svc, tenantId, vendorIdField, externalId);
  if (existing) {
    const upd = await svc.from("customers").update({
      customer_name: existing.customer_name || name || ("Customer " + externalId),
      contact_email: existing.contact_email || email || null,
      external_ref: mergeRef(existing.external_ref, vendorIdField, externalId, ref),
    }).eq("tenant_id", tenantId).eq("id", existing.id).select("*").single();
    if (upd.error) throw new Error("canonicaliseCustomer external-id update: " + upd.error.message);
    return { customer: upd.data, signal: "external_id" };
  }

  // 2. GSTIN match.
  existing = await findByGstin(svc, tenantId, gstin);
  if (existing) {
    const upd = await svc.from("customers").update({
      external_ref: mergeRef(existing.external_ref, vendorIdField, externalId, ref),
      contact_email: existing.contact_email || email || null,
    }).eq("tenant_id", tenantId).eq("id", existing.id).select("*").single();
    if (upd.error) throw new Error("canonicaliseCustomer gstin update: " + upd.error.message);
    return { customer: upd.data, signal: "gstin" };
  }

  // 3. Canonical name match.
  existing = await findByCanonicalName(svc, tenantId, name);
  if (existing) {
    const upd = await svc.from("customers").update({
      external_ref: mergeRef(existing.external_ref, vendorIdField, externalId, ref),
      contact_email: existing.contact_email || email || null,
    }).eq("tenant_id", tenantId).eq("id", existing.id).select("*").single();
    if (upd.error) throw new Error("canonicaliseCustomer name update: " + upd.error.message);
    return { customer: upd.data, signal: "canonical_name" };
  }

  // 4. New customer. customer_key keeps the vendor prefix so
  // it's traceable; the merge endpoint can fold this in later if
  // an operator finds a better-fitting primary.
  const customerKey = vendor + ":" + (externalId || slugify(name) || Date.now());
  const ins = await svc.from("customers").insert({
    tenant_id: tenantId,
    customer_key: customerKey,
    customer_name: name || ("Customer " + externalId),
    contact_email: email || null,
    gstin: gstin || null,
    external_ref: mergeRef({}, vendorIdField, externalId, ref),
  }, { onConflict: "tenant_id,customer_key" }).select("*").single();
  if (ins.error) throw new Error("canonicaliseCustomer insert: " + ins.error.message);
  return { customer: ins.data, signal: "new" };
};
