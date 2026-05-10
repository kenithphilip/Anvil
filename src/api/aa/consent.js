// /api/aa/consent
//   POST  { invoice_id, purpose? }  start a new AA consent on the tenant's
//                                   supplier-side bank statements
//   GET   ?id=<consent-row-id>      poll a consent's current state
//
// The endpoint is the operator-side entry into the Account Aggregator
// flow. The supplier (the Anvil tenant) is the data principal whose
// bank-statement data flows to a financier as part of the TReDS
// underwriting (Bet 6 step 2 in the plan doc).
//
// In SANDBOX mode (tenant_settings.aa_provider in ('sandbox', 'none')
// or credentials missing), the consent_handle is deterministic and
// the redirect_url points to our own /api/aa/callback?sandbox=1
// stub so the UI flow can be exercised end-to-end without a real
// Setu account.
//
// RBAC: admin only (consent grants are sensitive).

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { tenantSettings } from "../_lib/stripe-client.js";
import { requestConsent, pollConsent, setuMode } from "../_lib/aa/setu-client.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const url = new URL(req.url, "http://_");
      const id = url.searchParams.get("id");
      if (id) {
        const r = await svc.from("aa_consents").select("*")
          .eq("tenant_id", ctx.tenantId).eq("id", id).maybeSingle();
        if (r.error) throw new Error(r.error.message);
        return json(res, 200, { consent: r.data || null });
      }
      // List recent consents for the operator dashboard.
      const r = await svc.from("aa_consents").select("*")
        .eq("tenant_id", ctx.tenantId)
        .order("created_at", { ascending: false })
        .limit(50);
      if (r.error) throw new Error(r.error.message);
      return json(res, 200, { consents: r.data || [] });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "admin");
      const body = await readBody(req);
      if (!body.invoice_id) {
        return json(res, 400, { error: { message: "invoice_id required" } });
      }
      // Verify the invoice belongs to this tenant.
      const inv = await svc.from("invoices").select("id, customer_id")
        .eq("tenant_id", ctx.tenantId).eq("id", body.invoice_id).maybeSingle();
      if (inv.error) throw new Error(inv.error.message);
      if (!inv.data) return json(res, 404, { error: { message: "invoice not found" } });

      const settings = await tenantSettings(svc, ctx.tenantId);
      const mode = setuMode(settings || {});
      const upstream = await requestConsent(settings || {}, {
        tenantId: ctx.tenantId,
        invoiceId: body.invoice_id,
        purpose: body.purpose || "working_capital_treds",
        fiTypes: ["DEPOSIT"],
        redirectUrl: body.redirect_url || null,
      });

      const row = {
        tenant_id: ctx.tenantId,
        customer_id: inv.data.customer_id || null,
        invoice_id: body.invoice_id,
        party_kind: "supplier",
        consent_handle: upstream.consent_handle,
        consent_id: upstream.consent_id || null,
        status: mode === "sandbox" ? "sandbox_active" : "pending",
        fi_types: ["DEPOSIT"],
        purpose_code: body.purpose || "working_capital_treds",
        expires_at: upstream.expires_at || null,
        is_sandbox: !!upstream.is_sandbox,
        raw: upstream,
      };
      const up = await svc.from("aa_consents")
        .upsert(row, { onConflict: "tenant_id,consent_handle" })
        .select("*").maybeSingle();
      if (up.error) throw new Error(up.error.message);

      await recordAudit(ctx, {
        action: "aa.consent.requested",
        objectType: "aa_consent",
        objectId: up.data?.id,
        detail: {
          invoice_id: body.invoice_id,
          mode,
          consent_handle: upstream.consent_handle,
        },
      });

      return json(res, 200, {
        consent: up.data,
        redirect_url: upstream.redirect_url,
        mode,
      });
    }

    if (req.method === "PATCH") {
      // Operator-initiated poll: idempotent, refreshes the row from
      // upstream and writes back.
      requirePermission(ctx, "admin");
      const body = await readBody(req);
      if (!body.id) return json(res, 400, { error: { message: "id required" } });
      const existing = await svc.from("aa_consents").select("*")
        .eq("tenant_id", ctx.tenantId).eq("id", body.id).maybeSingle();
      if (existing.error) throw new Error(existing.error.message);
      if (!existing.data) return json(res, 404, { error: { message: "consent not found" } });
      const settings = await tenantSettings(svc, ctx.tenantId);
      const upstream = await pollConsent(settings || {}, existing.data.consent_handle);
      const status = (upstream.status || "").toLowerCase() === "active"
        ? (upstream.is_sandbox ? "sandbox_active" : "active")
        : (upstream.status || "pending").toLowerCase();
      const upd = await svc.from("aa_consents")
        .update({
          status,
          consent_id: upstream.consent_id || existing.data.consent_id,
          granted_at: status === "active" || status === "sandbox_active"
            ? (existing.data.granted_at || new Date().toISOString())
            : existing.data.granted_at,
          raw: { ...existing.data.raw, last_poll: upstream },
        })
        .eq("id", body.id)
        .select("*").maybeSingle();
      if (upd.error) throw new Error(upd.error.message);
      return json(res, 200, { consent: upd.data });
    }

    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) { sendError(res, err); }
}
