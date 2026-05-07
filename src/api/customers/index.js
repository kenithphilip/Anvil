import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { safeAwait } from "../_lib/safe-thenable.js";

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
      const body = await readBody(req);
      // Auto-derive customer_key from customer_name when the caller
      // didn't supply one. The intake "new customer" dialog asks for
      // a name only; forcing the operator to invent a slug was a
      // dead-end UX. Slug = lowercase alphanumeric + dashes, capped.
      const slugify = (s) => String(s || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60);
      const derivedKey = body.customer_key || slugify(body.customer_name);
      if (!derivedKey) {
        return json(res, 400, { error: { message: "customer_key or customer_name required" } });
      }
      const upsert = await svc.from("customers").upsert({
        tenant_id: ctx.tenantId,
        customer_key: derivedKey,
        customer_name: body.customer_name || "",
        gstin: body.gstin || null,
        state_code: body.state_code || null,
        default_payment_terms: body.default_payment_terms || null,
        default_incoterms: body.default_incoterms || null,
        default_quote_validity_days: body.default_quote_validity_days || null,
        notes: body.notes || null,
        // Relational fields added in migration 061. The columns are
        // nullable so older deployments that haven't run the migration
        // simply ignore them (Supabase will reject unknown columns; we
        // strip them out below if the response indicates the column is
        // missing).
        currency: body.currency || null,
        payment_terms: body.payment_terms || null,
        margin_floor_pct: body.margin_floor_pct != null ? Number(body.margin_floor_pct) : null,
        bill_to: body.bill_to || null,
        ship_to: body.ship_to || body.bill_to || null,
      }, { onConflict: "tenant_id,customer_key" }).select("*").single();
      if (upsert.error) {
        // If migration 061 hasn't been applied yet on this deployment,
        // Postgres rejects the unknown columns with code 42703. Retry
        // once with only the legacy column set so signups still work
        // until the operator runs the migration.
        if (upsert.error.code === "42703" || /column .* does not exist/i.test(upsert.error.message)) {
          const retry = await svc.from("customers").upsert({
            tenant_id: ctx.tenantId,
            customer_key: derivedKey,
            customer_name: body.customer_name || "",
            gstin: body.gstin || null,
            state_code: body.state_code || null,
            default_payment_terms: body.default_payment_terms || body.payment_terms || null,
            default_incoterms: body.default_incoterms || null,
            default_quote_validity_days: body.default_quote_validity_days || null,
            notes: body.notes || null,
          }, { onConflict: "tenant_id,customer_key" }).select("*").single();
          if (retry.error) throw new Error(retry.error.message);
          // eslint-disable-next-line no-console
          console.warn("[customers] saved without relational fields; run migration 061_customers_relational_fields.sql to enable currency/payment_terms/margin_floor_pct/bill_to/ship_to columns");
          return json(res, 200, { customer: retry.data, warning: "relational_fields_unavailable" });
        }
        throw new Error(upsert.error.message);
      }
      const customer = upsert.data;

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
