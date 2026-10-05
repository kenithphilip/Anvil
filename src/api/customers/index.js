import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission, requireAction } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { safeAwait } from "../_lib/safe-thenable.js";
import { validateGstin } from "../_lib/gstin.js";

// Best-effort parser that pulls structured fields out of a multi-line
// address blob. The intake dialog gives us free-text; the
// customer_locations table wants discrete columns. We don't try to
// be clever, just split on newlines and pick the last non-empty line
// as city + the first 6-digit token as pincode. Returns whatever we
// can recover; the rest stay null.
const parseAddressBlob = (text) => {
  if (!text) return null;
  const t = String(text).trim();
  if (!t) return null;
  const lines = t.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  const pincode = (t.match(/\b\d{6}\b/) || [])[0] || null;
  // Heuristic: city is usually the line BEFORE the pincode, or the
  // last non-empty line if no pincode.
  let city = null;
  if (pincode) {
    for (const line of lines) {
      if (line.includes(pincode)) {
        // The city is whatever's on the same line minus the pincode
        // and any trailing punctuation.
        const cleaned = line.replace(pincode, "").replace(/[,\-]+$/, "").trim();
        if (cleaned) city = cleaned;
        break;
      }
    }
  }
  if (!city) city = lines[lines.length - 1];
  return {
    address_line1: lines[0] || null,
    address_line2: lines.length > 2 ? lines.slice(1, -1).join(", ") : null,
    city,
    pincode,
  };
};

// Idempotent: insert a customer_locations row for the parsed
// address. If a row with the same (tenant, customer, location_code)
// already exists, the unique constraint upserts without duplicating.
// Best-effort: a failure here doesn't fail the whole customer save.
const upsertLocation = async (svc, tenantId, customer, kind, addressText, gstin, stateCode) => {
  const parsed = parseAddressBlob(addressText);
  if (!parsed) return;
  const code = kind === "ship" ? "default_ship" : "default_bill";
  await safeAwait(svc.from("customer_locations").upsert({
    tenant_id: tenantId,
    customer_id: customer.id,
    location_code: code,
    plant_name: customer.customer_name || null,
    gstin: gstin || customer.gstin || null,
    state_code: stateCode || customer.state_code || null,
    address_line1: parsed.address_line1,
    address_line2: parsed.address_line2,
    city: parsed.city,
    pincode: parsed.pincode,
    is_default: true,
  }, { onConflict: "tenant_id,customer_id,location_code" }), "customer_locations_upsert");
};

// True when the request body carries `key`. A key that is absent (or
// undefined, which JSON drops) leaves the stored column unchanged on an
// update; an explicit null clears it.
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined;

// Migration 006 customer_type enum.
const CUSTOMER_TYPES = ["AUTO_OEM", "TIER_ONE", "LINE_BUILDER", "OTHER"];
// Migration 096 customers_tax_id_type_check.
const TAX_ID_TYPES = ["pan", "brn", "jp_corp", "eu_vat", "us_ein", "de_steuernummer", "other"];
// Columns from migration 001, present on every deployment.
const LEGACY_COLUMNS = ["customer_name", "gstin", "state_code", "default_payment_terms", "default_incoterms", "default_quote_validity_days", "notes"];

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();
    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const { data: customers, error } = await svc.from("customers").select("*").eq("tenant_id", ctx.tenantId).order("updated_at", { ascending: false }).limit(500);
      if (error) throw new Error(error.message);
      const ids = customers.map((c) => c.id);
      const profiles = ids.length
        ? await svc.from("customer_format_profiles").select("*").eq("tenant_id", ctx.tenantId).in("customer_id", ids).eq("is_current", true)
        : { data: [] };
      const profileByCustomer = {};
      (profiles.data || []).forEach((p) => { profileByCustomer[p.customer_id] = p; });
      return json(res, 200, { customers, profiles: profileByCustomer });
    }
    if (req.method === "POST") {
      requirePermission(ctx, "write");
      const body = await readBody(req) || {};

      // Resolve the existing customer this write targets, if any. An `id`
      // addresses the row directly; otherwise the (tenant, customer_key)
      // pair does, with customer_key auto-derived from customer_name when
      // the caller didn't supply one. The intake "new customer" dialog
      // asks for a name only; forcing the operator to invent a slug was a
      // dead-end UX. Slug = lowercase alphanumeric + dashes, capped.
      const slugify = (s) => String(s || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60);
      let existing = null;
      let derivedKey = null;
      if (body.id != null) {
        const found = await svc.from("customers").select("*").eq("tenant_id", ctx.tenantId).eq("id", body.id).maybeSingle();
        if (found.error) throw new Error(found.error.message);
        if (!found.data) return json(res, 404, { error: { code: "CUSTOMER_NOT_FOUND", message: "Customer not found" } });
        existing = found.data;
        // customer_key is the upsert identity other callers address this
        // row by; this endpoint never rewrites it.
        if (has(body, "customer_key") && body.customer_key !== existing.customer_key) {
          return json(res, 400, { error: { code: "CUSTOMER_KEY_IMMUTABLE", message: "customer_key cannot be changed", field: "customer_key" } });
        }
        derivedKey = existing.customer_key;
      } else {
        derivedKey = body.customer_key || slugify(body.customer_name);
        if (!derivedKey) {
          return json(res, 400, { error: { message: "customer_key or customer_name required" } });
        }
        const found = await svc.from("customers").select("*").eq("tenant_id", ctx.tenantId).eq("customer_key", derivedKey).maybeSingle();
        if (found.error) throw new Error(found.error.message);
        existing = found.data || null;
      }

      // An update cannot blank the name of a named customer.
      if (existing && has(body, "customer_name") && !String(body.customer_name ?? "").trim() && String(existing.customer_name || "").trim()) {
        return json(res, 400, { error: { code: "CUSTOMER_NAME_REQUIRED", message: "customer_name cannot be cleared", field: "customer_name" } });
      }

      // Phase 1 F8: validate GSTIN at the entry point so typos
      // (digit-swap, transposed letters, wrong last char) cannot
      // land on the customer master and break downstream e-invoice
      // IRN generation or Tally party lookup. Existing records are
      // not retroactively validated; only new writes, so resending the
      // stored GSTIN unchanged is not a GSTIN edit.
      const gstinIn = has(body, "gstin") && body.gstin != null ? String(body.gstin).trim() : "";
      const storedGstin = existing && existing.gstin ? String(existing.gstin).trim() : "";
      if (gstinIn && storedGstin && gstinIn.toUpperCase() === storedGstin.toUpperCase()) {
        body.gstin = existing.gstin;
      } else if (gstinIn) {
        // GSTIN is restricted to sales_manager/admin (ACTIONS.customer.edit_gstin)
        // because a wrong GSTIN breaks e-invoice IRN + Tally lookup. The UI hides the
        // field from other roles; enforce it server-side too.
        requireAction(ctx, "customer.edit_gstin");
        const v = validateGstin(body.gstin);
        if (!v.ok) {
          return json(res, 400, {
            error: {
              code: v.code,
              message: "Customer GSTIN rejected: " + v.message,
              field: "gstin",
            },
          });
        }
        body.gstin = v.normalized;
      } else if (has(body, "gstin")) {
        // A blank GSTIN clears it, and clearing a stored one is a GSTIN edit too.
        if (storedGstin) requireAction(ctx, "customer.edit_gstin");
        body.gstin = null;
      }

      // customer_type is the migration 006 enum. Refuse a value outside it
      // rather than let Postgres reject the whole write.
      if (has(body, "customer_type") && body.customer_type != null && String(body.customer_type).trim()) {
        const t = String(body.customer_type).trim().toUpperCase();
        if (!CUSTOMER_TYPES.includes(t)) {
          return json(res, 400, {
            error: {
              code: "INVALID_CUSTOMER_TYPE",
              message: "customer_type must be one of " + CUSTOMER_TYPES.join(", "),
              field: "customer_type",
            },
          });
        }
        body.customer_type = t;
      }

      // The value each writable column takes from the body. A create
      // writes every column (absent = its default); an update writes only
      // the columns whose key the body carries, so a partial edit cannot
      // erase what it did not send. owner_user_id is deliberately not here:
      // it has its own endpoint.
      const values = {
        customer_name: body.customer_name || "",
        gstin: body.gstin || null,
        state_code: body.state_code || null,
        // Migration 096: country + tax_id + tax_id_type for non-Indian
        // customers (Northwind Korea, Meridian Steel Japan, Voestalpine AT).
        // Indian customers leave these NULL and use gstin / state_code
        // as before. Country is NULL for an empty string, upper-case
        // otherwise. The retry-without-new-columns block below catches
        // pre-096 deployments.
        country: body.country ? String(body.country).toUpperCase() : null,
        tax_id: body.tax_id || null,
        tax_id_type: body.tax_id_type
          ? (TAX_ID_TYPES.includes(body.tax_id_type) ? body.tax_id_type : "other")
          : null,
        default_payment_terms: body.default_payment_terms || null,
        default_incoterms: body.default_incoterms || null,
        default_quote_validity_days: body.default_quote_validity_days || null,
        notes: body.notes || null,
        // Migration 006: AUTO_OEM | TIER_ONE | LINE_BUILDER | OTHER.
        customer_type: body.customer_type || null,
        // Relational fields added in migration 061. On a deployment that
        // hasn't run it, Postgres rejects the unknown columns and the
        // retry below falls back to the legacy column set.
        currency: body.currency || null,
        payment_terms: body.payment_terms || null,
        margin_floor_pct: body.margin_floor_pct != null ? Number(body.margin_floor_pct) : null,
        bill_to: body.bill_to || null,
        ship_to: body.ship_to || body.bill_to || null,
        // Bug fix May 2026: contact_email + contact_phone (also added
        // by migration 061) were silently dropped by the create
        // handler, so the so-intake new-customer dialog could collect
        // them and they vanished. Both columns are read by
        // api/agents/_handlers/ar_collect.js and the inbound-chat
        // path; persisting them here closes the loop.
        contact_email: body.contact_email || null,
        contact_phone: body.contact_phone || null,
        // Migration 137: self-referential parent for corporate-group
        // hierarchy (group -> child entities/plants). Self-parenting is
        // corrected to null after the write returns the row id.
        parent_customer_id: body.parent_customer_id || null,
      };
      const patch = {};
      for (const k of Object.keys(values)) if (has(body, k)) patch[k] = values[k];

      const createRow = (cols) => svc.from("customers")
        .upsert({ tenant_id: ctx.tenantId, customer_key: derivedKey, ...cols }, { onConflict: "tenant_id,customer_key" })
        .select("*").single();
      const updateRow = (cols) => (Object.keys(cols).length
        ? svc.from("customers").update(cols).eq("tenant_id", ctx.tenantId).eq("id", existing.id).select("*").single()
        : Promise.resolve({ data: existing, error: null }));

      const upsert = existing ? await updateRow(patch) : await createRow(values);
      if (upsert.error) {
        // If migration 061 hasn't been applied yet on this deployment,
        // Postgres rejects the unknown columns with code 42703. Retry
        // once with only the legacy column set so signups still work
        // until the operator runs the migration. Also catches pre-096
        // (country / tax_id) deployments.
        if (upsert.error.code === "42703" || /column .* does not exist/i.test(upsert.error.message)) {
          const legacyPatch = {};
          for (const k of LEGACY_COLUMNS) if (has(patch, k)) legacyPatch[k] = patch[k];
          const retry = existing
            ? await updateRow(legacyPatch)
            : await createRow({
              customer_name: values.customer_name,
              gstin: values.gstin,
              state_code: values.state_code,
              default_payment_terms: body.default_payment_terms || body.payment_terms || null,
              default_incoterms: values.default_incoterms,
              default_quote_validity_days: values.default_quote_validity_days,
              notes: values.notes,
            });
          if (retry.error) throw new Error(retry.error.message);
          console.warn("[customers] saved without optional fields; run migrations 061 + 096 to enable currency/payment_terms/margin_floor_pct/bill_to/ship_to/country/tax_id columns");
          return json(res, 200, { customer: retry.data, warning: "optional_fields_unavailable" });
        }
        throw new Error(upsert.error.message);
      }
      const customer = upsert.data;

      // Guard against a customer being its own parent (the id is only
      // known after the upsert). Cycles deeper than one hop are left to
      // the picker, which excludes self.
      if (customer.parent_customer_id && customer.parent_customer_id === customer.id) {
        await svc.from("customers").update({ parent_customer_id: null }).eq("tenant_id", ctx.tenantId).eq("id", customer.id);
        customer.parent_customer_id = null;
      }

      // Mirror bill_to / ship_to into customer_locations so the
      // e-invoice handler's JOIN finds the address fields. The text
      // blob stays on customers (used by the so-intake summary
      // panel); the structured row goes here so downstream consumers
      // (e-invoice, GST validation, shipping label) have discrete
      // address_line1/city/pincode columns to read. Idempotent.
      if (body.bill_to) {
        await upsertLocation(svc, ctx.tenantId, customer, "bill", body.bill_to, body.gstin, body.state_code);
      }
      if (body.ship_to && body.ship_to !== body.bill_to) {
        await upsertLocation(svc, ctx.tenantId, customer, "ship", body.ship_to, body.gstin, body.state_code);
      }

      if (body.profile) {
        const newVersion = (Number(body.profile.version || 0) || 0) + 1;
        await svc.from("customer_format_profiles").update({ is_current: false }).eq("tenant_id", ctx.tenantId).eq("customer_id", customer.id).eq("is_current", true);
        const profileInsert = await svc.from("customer_format_profiles").insert({
          tenant_id: ctx.tenantId,
          customer_id: customer.id,
          version: newVersion,
          fingerprint: body.profile.fingerprint || {},
          orders_processed: body.profile.orders_processed || 0,
          last_format_changed: !!body.profile.last_format_changed,
          format_change_summary: body.profile.format_change_summary || null,
          trusted: !!body.profile.trusted,
          learned_rules: body.profile.learned_rules || {},
          recipe: body.profile.recipe || {},
          force_llm_fallback: !!body.profile.force_llm_fallback,
          golden_examples: Array.isArray(body.profile.golden_examples) ? body.profile.golden_examples : [],
          is_current: true,
        }).select("*").single();
        if (profileInsert.error) throw new Error(profileInsert.error.message);
        await recordAudit(ctx, { action: "upsert_customer_profile", objectType: "customer", objectId: customer.id, after: { profileId: profileInsert.data.id, version: newVersion } });
        return json(res, 200, { customer, profile: profileInsert.data });
      }
      return json(res, 200, { customer });
    }
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
