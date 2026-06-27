// Shared cash-application core.
//
// applyPayment() records a received payment against an invoice and
// advances the invoice status (partial/paid). It is the single place
// money lands on an invoice from the MANUAL fallback path
// (/api/invoices/payment) and, later, the AUTOMATED bank-statement
// matching path (Phase 2) — both post through here so the accounting is
// identical no matter how the receipt arrived.
//
// Customers here are OEMs (large corporates) paying through their SAP
// AP / payment runs, not hosted card gateways (Stripe/Razorpay). The
// real rails are bank transfer / RTGS / NEFT / wire (and occasionally
// cheque), recorded against the invoice. Crucially, OEMs withhold TDS
// at source: the cash received is LESS than the invoice, and the
// withheld portion settles the invoice as a tax credit (method "tds"),
// exactly as SAP clears an AR open item with cash + a TDS GL line.
//
// Money is summed in integer cents (paise), matching the Stripe webhook
// (Audit M9): JS Number is binary float, so numeric(14,2) columns must
// not be added as floats. The >= comparison that decides paid-vs-partial
// also happens on integer cents.

const toCents = (n) => Math.round(Number(n || 0) * 100);
const fromCents = (c) => c / 100;

// Free-text at the DB layer, but we gate the API to this set so a typo
// does not create a phantom method that breaks reporting later.
export const PAYMENT_METHODS = new Set([
  "bank_transfer", "rtgs", "neft", "wire", "cheque", "imps", "upi", "cash",
  "tds", "card", "stripe", "razorpay", "other",
]);

// Records one payment and re-derives invoice status.
//
//   svc      - service-role supabase client; every query is scoped by
//              tenant_id explicitly (the caller has already authorized).
//   invoice  - the full invoice row (must include tenant_id, id,
//              paid_amount, grand_total, currency, paid_at).
//   opts     - { amount, method, reference, paidAt, note, actorId,
//                externalId }
//
// externalId is the idempotency key for AUTOMATED/matched payments
// (e.g. a bank UTR or gateway intent id) stored in the
// stripe_payment_intent_id slot, which carries a unique
// (tenant_id, stripe_payment_intent_id) constraint. Manual entries pass
// no externalId and are always inserted (an operator may legitimately
// record two identical cash receipts).
//
// Returns { invoice, payment, applied, status } or { duplicate: true }.
export async function applyPayment(svc, invoice, opts = {}) {
  const {
    amount, method = "bank_transfer", reference = null, paidAt = null,
    note = null, actorId = null, externalId = null,
  } = opts;

  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    throw new Error("amount must be a positive number");
  }
  const meth = String(method || "bank_transfer").toLowerCase();
  const currency = (invoice.currency || "INR").toUpperCase();
  const paid_at = paidAt ? new Date(paidAt).toISOString() : new Date().toISOString();

  if (externalId) {
    const existing = await svc.from("payment_records").select("id")
      .eq("tenant_id", invoice.tenant_id)
      .eq("stripe_payment_intent_id", externalId).limit(1);
    if (!existing.error && (existing.data || []).length > 0) {
      return { duplicate: true };
    }
  }

  const ins = await svc.from("payment_records").insert({
    tenant_id: invoice.tenant_id,
    invoice_id: invoice.id,
    amount: amt,
    currency,
    method: meth,
    stripe_payment_intent_id: externalId || null,
    paid_at,
    raw: {
      reference: reference || null,
      note: note || null,
      recorded_by: actorId || null,
      source: externalId ? "matched" : "manual",
    },
  }).select("*").maybeSingle();
  if (ins.error) throw new Error(ins.error.message);

  const newPaidCents = toCents(invoice.paid_amount) + toCents(amt);
  const totalCents = toCents(invoice.grand_total);
  const status = newPaidCents >= totalCents ? "paid" : "partial";

  const upd = await svc.from("invoices").update({
    paid_amount: fromCents(newPaidCents),
    status,
    paid_at: status === "paid" ? paid_at : invoice.paid_at,
  }).eq("tenant_id", invoice.tenant_id).eq("id", invoice.id).select("*").maybeSingle();
  if (upd.error) throw new Error(upd.error.message);

  return { invoice: upd.data, payment: ins.data, applied: amt, status, duplicate: false };
}

export const __test__ = { toCents, fromCents };
