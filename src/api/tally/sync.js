// POST or GET /api/tally/sync
//
// Reverse pull from Tally back into Anvil mirror tables. Two
// channels:
//   - voucher_state: any voucher altered or cancelled in Tally
//     since the last tick. Updates tally_voucher_state +
//     reflects status changes back to orders.tally_status.
//   - payments: Receipt vouchers since the last tick. Inserts into
//     tally_payment_receipts and best-effort matches the receipt
//     to an open invoice or einvoice by ledger / amount /
//     reference number.
//
// Cron-only by default (Bearer CRON_SECRET) but admin users can
// trigger a manual run. Each entity gets a tally_sync_runs audit row.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { tallyResolveCompany, tallySyncVouchers, tallySyncPayments } from "../_lib/tally-client.js";

const CRON_SECRET = process.env.CRON_SECRET;
const ENTITY_NAMES = ["voucher_state", "payments"];

const openSyncRun = async (svc, tenantId, companyId, entity, triggeredBy) => {
  const ins = await svc.from("tally_sync_runs").insert({
    tenant_id: tenantId,
    company_id: companyId,
    entity,
    status: "running",
    triggered_by: triggeredBy,
  }).select("id").single();
  return ins.data?.id || null;
};

const closeSyncRun = async (svc, runId, patch) => {
  if (!runId) return;
  await svc.from("tally_sync_runs").update({
    run_finished_at: new Date().toISOString(),
    ...patch,
  }).eq("id", runId);
};

// Pull voucher state. Bridge response shape:
// { vouchers: [{ external_voucher_no, voucher_type, status,
//                total, altered, cancelled, raw }] }
const syncVoucherState = async (svc, tenantId, company, opts) => {
  const runId = await openSyncRun(svc, tenantId, company.id, "voucher_state", opts.triggeredBy);
  let pulled = 0, updated = 0, errored = 0;
  try {
    const last = await svc.from("tally_voucher_state")
      .select("last_seen_at")
      .eq("tenant_id", tenantId).eq("company_id", company.id)
      .order("last_seen_at", { ascending: false }).limit(1).maybeSingle();
    const since = opts.full ? null : (last.data?.last_seen_at || null);
    const resp = await tallySyncVouchers(company, since);
    if (!resp.ok) throw new Error("bridge sync " + resp.status);
    const vouchers = resp.body?.vouchers || [];
    pulled = vouchers.length;
    for (const v of vouchers) {
      try {
        await svc.from("tally_voucher_state").upsert({
          tenant_id: tenantId,
          company_id: company.id,
          external_voucher_no: String(v.external_voucher_no || v.voucher_no || ""),
          voucher_type: v.voucher_type || null,
          status: v.status || null,
          total: v.total != null ? Number(v.total) : null,
          altered: !!v.altered,
          cancelled: !!v.cancelled,
          raw: v,
          last_seen_at: new Date().toISOString(),
        }, { onConflict: "tenant_id,company_id,external_voucher_no" });

        // If a voucher we previously pushed was cancelled in Tally,
        // bubble that up to the originating order.
        if (v.cancelled || v.altered) {
          await svc.from("tally_voucher_records").update({
            status: v.cancelled ? "failed" : "imported",
            error: v.cancelled ? "voucher cancelled in Tally" : null,
          })
          .eq("tenant_id", tenantId)
          .eq("external_voucher_no", String(v.external_voucher_no));
        }
        updated += 1;
      } catch (rowErr) {
        errored += 1;
      }
    }
    await closeSyncRun(svc, runId, {
      status: errored > 0 ? "partial" : "ok",
      rows_pulled: pulled, rows_updated: updated, rows_errored: errored,
    });
    return { entity: "voucher_state", pulled, updated, errored };
  } catch (err) {
    await closeSyncRun(svc, runId, {
      status: "error", rows_pulled: pulled, rows_errored: errored,
      error: (err.message || String(err)).slice(0, 800),
    });
    return { entity: "voucher_state", error: err.message };
  }
};

// Pull payments. Bridge response: { receipts: [...] }.
const syncPayments = async (svc, tenantId, company, opts) => {
  const runId = await openSyncRun(svc, tenantId, company.id, "payments", opts.triggeredBy);
  let pulled = 0, inserted = 0, errored = 0;
  try {
    const last = await svc.from("tally_payment_receipts")
      .select("synced_at")
      .eq("tenant_id", tenantId).eq("company_id", company.id)
      .order("synced_at", { ascending: false }).limit(1).maybeSingle();
    const since = opts.full ? null : (last.data?.synced_at || null);
    const resp = await tallySyncPayments(company, since);
    if (!resp.ok) throw new Error("bridge payments " + resp.status);
    const receipts = resp.body?.receipts || [];
    pulled = receipts.length;
    for (const r of receipts) {
      try {
        // Best-effort match to an invoice. Try reference_no as
        // invoice_number first, then einvoice irn.
        let matchedInvoice = null;
        let matchedEinvoice = null;
        if (r.reference_no) {
          const inv = await svc.from("invoices").select("id")
            .eq("tenant_id", tenantId)
            .eq("invoice_number", r.reference_no)
            .maybeSingle();
          matchedInvoice = inv.data?.id || null;
          if (!matchedInvoice) {
            const ein = await svc.from("einvoices").select("id")
              .eq("tenant_id", tenantId).eq("irn", r.reference_no).maybeSingle();
            matchedEinvoice = ein.data?.id || null;
          }
        }
        await svc.from("tally_payment_receipts").upsert({
          tenant_id: tenantId,
          company_id: company.id,
          external_voucher_no: String(r.external_voucher_no || r.voucher_no || ""),
          voucher_date: r.voucher_date || null,
          party_ledger: r.party_ledger || null,
          amount: r.amount != null ? Number(r.amount) : null,
          currency: r.currency || "INR",
          bank_ledger: r.bank_ledger || null,
          reference_no: r.reference_no || null,
          matched_invoice_id: matchedInvoice,
          matched_einvoice_id: matchedEinvoice,
          raw: r,
          synced_at: new Date().toISOString(),
        }, { onConflict: "tenant_id,company_id,external_voucher_no" });

        // Apply the payment to the matched invoice. We don't try to
        // partial-pay; an exact-amount match flips the invoice to
        // 'paid', a smaller amount flips to 'partial'.
        if (matchedInvoice && r.amount != null) {
          const inv = await svc.from("invoices").select("grand_total, paid_amount")
            .eq("id", matchedInvoice).maybeSingle();
          if (inv.data) {
            const newPaid = Number(inv.data.paid_amount || 0) + Number(r.amount);
            const grand = Number(inv.data.grand_total || 0);
            const newStatus = newPaid >= grand ? "paid" : (newPaid > 0 ? "partial" : "sent");
            await svc.from("invoices").update({
              paid_amount: newPaid,
              status: newStatus,
              paid_at: newStatus === "paid" ? new Date().toISOString() : null,
            }).eq("id", matchedInvoice);
          }
        }
        inserted += 1;
      } catch (rowErr) {
        errored += 1;
      }
    }
    await closeSyncRun(svc, runId, {
      status: errored > 0 ? "partial" : "ok",
      rows_pulled: pulled, rows_inserted: inserted, rows_errored: errored,
    });
    return { entity: "payments", pulled, inserted, errored };
  } catch (err) {
    await closeSyncRun(svc, runId, {
      status: "error", rows_pulled: pulled, rows_errored: errored,
      error: (err.message || String(err)).slice(0, 800),
    });
    return { entity: "payments", error: err.message };
  }
};

const runForCompany = async (svc, tenantId, company, opts) => {
  if (!company || !company.bridge_url) {
    return { company_id: company?.id || null, skipped: true, reason: "bridge URL missing" };
  }
  const out = [];
  const which = (opts.entities && opts.entities.length)
    ? opts.entities.filter((e) => ENTITY_NAMES.includes(e))
    : ENTITY_NAMES;
  for (const entity of which) {
    if (entity === "voucher_state") out.push(await syncVoucherState(svc, tenantId, company, opts));
    if (entity === "payments")      out.push(await syncPayments(svc, tenantId, company, opts));
  }
  return { company_id: company.id, name: company.name, results: out };
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const isCron = !!CRON_SECRET && auth === CRON_SECRET;
    const svc = serviceClient();

    if (isCron) {
      const companies = await svc.from("tally_companies")
        .select("*")
        .not("bridge_url", "is", null);
      if (companies.error) throw new Error("companies read: " + companies.error.message);
      const out = [];
      for (const c of companies.data || []) {
        out.push(await runForCompany(svc, c.tenant_id, c, { triggeredBy: "cron" }));
      }
      return json(res, 200, {
        ran_at: new Date().toISOString(),
        companies_considered: (companies.data || []).length,
        results: out,
      });
    }

    const ctx = await resolveContext(req);
    requirePermission(ctx, "admin");
    const body = req.method === "POST" ? await readBody(req) : {};
    const company = await tallyResolveCompany(svc, ctx.tenantId, body?.companyId);
    if (!company) return json(res, 404, { error: { message: "no company configured" } });
    const result = await runForCompany(svc, ctx.tenantId, company, {
      triggeredBy: "manual",
      entities: Array.isArray(body?.entities) ? body.entities : (body?.entity ? [body.entity] : null),
      full: !!body?.full,
    });
    return json(res, 200, { ran_at: new Date().toISOString(), ...result });
  } catch (err) {
    sendError(res, err);
  }
}
