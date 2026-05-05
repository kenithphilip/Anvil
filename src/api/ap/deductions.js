// /api/ap/deductions
//
//   GET   list deductions for the calling tenant.
//   POST  body: { invoice_id, paid_amount, reason_guess? }. Records
//         a short-pay against an Anvil invoice. If paid_amount <
//         invoice.grand_total, a deduction_queue row is opened. If
//         paid_amount >= grand_total this is a no-op (logged as
//         payment_full).
//   PATCH body: { id, status, notes? }. Resolves a deduction.
//
// Phase 6 (C.5) — short-pay deduction tracking.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const ALLOWED_STATUSES = new Set(["open","researching","disputed","written_off","recovered"]);

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "approve");
    const svc = serviceClient();

    if (req.method === "GET") {
      const url = new URL(req.url || "/", "http://x");
      const status = url.searchParams.get("status");
      let q = svc.from("deduction_queue")
        .select("*")
        .eq("tenant_id", ctx.tenantId)
        .order("flagged_at", { ascending: false })
        .limit(200);
      if (status) q = q.eq("status", status);
      const r = await q;
      if (r.error) throw new Error(r.error.message);
      return json(res, 200, { deductions: r.data || [], count: (r.data || []).length });
    }

    if (req.method === "POST") {
      const body = await readBody(req);
      if (!body?.invoice_id) return json(res, 400, { error: { message: "invoice_id required" } });
      // Audit M9 (May 2026): integer-cents arithmetic. JS Number
      // arithmetic on decimal money drops cents (0.1+0.2 != 0.3).
      // Round each input to cents, sum as int, divide back at the
      // boundary; threshold compare runs on int cents.
      const toCents = (n) => Math.round(Number(n || 0) * 100);
      const fromCents = (c) => c / 100;

      const paidCents = toCents(body.paid_amount);
      if (!Number.isFinite(paidCents)) return json(res, 400, { error: { message: "paid_amount required" } });

      const inv = await svc.from("invoices").select("*")
        .eq("tenant_id", ctx.tenantId).eq("id", body.invoice_id).maybeSingle();
      if (inv.error) throw new Error(inv.error.message);
      if (!inv.data) return json(res, 404, { error: { message: "Invoice not found" } });

      const expectedCents = toCents(inv.data.grand_total);
      const existingPaidCents = toCents(inv.data.paid_amount);
      const shortCents = expectedCents - paidCents;

      if (shortCents <= 0) {
        // Paid in full or overpaid; just patch the invoice.
        await svc.from("invoices").update({
          paid_amount: fromCents(existingPaidCents + paidCents),
          status: "paid",
          paid_at: new Date().toISOString(),
        }).eq("id", inv.data.id);
        await recordAudit(ctx, {
          action: "payment_received",
          objectType: "invoice",
          objectId: inv.data.id,
          detail: "amount=" + fromCents(paidCents).toFixed(2) + "::full",
        });
        return json(res, 200, { ok: true, full_payment: true });
      }

      // Short pay — open a deduction queue row.
      const ins = await svc.from("deduction_queue").insert({
        tenant_id: ctx.tenantId,
        invoice_id: inv.data.id,
        customer_id: inv.data.customer_id || null,
        expected_amount: fromCents(expectedCents),
        paid_amount: fromCents(paidCents),
        short_amount: fromCents(shortCents),
        reason_guess: body.reason_guess || null,
        status: "open",
        notes: body.notes || null,
      }).select("id").single();
      if (ins.error) throw new Error("deduction_queue insert: " + ins.error.message);

      await svc.from("invoices").update({
        paid_amount: fromCents(existingPaidCents + paidCents),
        status: "partial",
      }).eq("id", inv.data.id);

      await recordAudit(ctx, {
        action: "deduction_flagged",
        objectType: "invoice",
        objectId: inv.data.id,
        detail: "short=" + short + "::deduction=" + (ins.data?.id || ""),
      });

      return json(res, 200, {
        ok: true,
        full_payment: false,
        short_amount: short,
        deduction_id: ins.data?.id || null,
      });
    }

    if (req.method === "PATCH") {
      const body = await readBody(req);
      if (!body?.id) return json(res, 400, { error: { message: "id required" } });
      const status = body?.status;
      if (status && !ALLOWED_STATUSES.has(status)) {
        return json(res, 400, { error: { message: "status must be one of " + [...ALLOWED_STATUSES].join(", ") } });
      }
      const patch = { notes: body.notes ?? null };
      if (status) {
        patch.status = status;
        if (status !== "open") {
          patch.resolved_at = new Date().toISOString();
          patch.resolved_by = ctx.userId || null;
        }
      }
      const upd = await svc.from("deduction_queue").update(patch)
        .eq("tenant_id", ctx.tenantId).eq("id", body.id).select("id, status").single();
      if (upd.error) throw new Error(upd.error.message);
      await recordAudit(ctx, {
        action: "deduction_resolved",
        objectType: "deduction_queue",
        objectId: body.id,
        detail: "status=" + (upd.data?.status || ""),
      });
      return json(res, 200, { ok: true, id: upd.data?.id, status: upd.data?.status });
    }

    res.setHeader("Allow", "GET, POST, PATCH");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    return sendError(res, err);
  }
}
