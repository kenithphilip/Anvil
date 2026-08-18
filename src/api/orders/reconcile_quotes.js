// POST /api/orders/reconcile_quotes   body: { order_id, price_tolerance_pct? }
//
// Auto-reconcile a received PO/SO against the customer's quotes — the
// operator uploads the PO and Anvil finds the corresponding quotes on its
// own. Pools ALL of the order customer's quotes (across every quote, not a
// single hand-picked one), matches each PO line by part number, enriches
// it with the quoted HSN / discounted rate / tax / source, stamps which
// quote priced each line, and stores a verification report (price/qty/part
// exceptions) on the order so the SO renders complete and the operator
// only reviews the flags.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { reconcilePoAgainstQuotes, comparePaymentTerms, compareIncoterms } from "../_lib/quote-reconcile.js";
import { modBomFinding, provisionalParts, MOD_BOM_FINDING_CODE } from "../_lib/mod-parts.js";
import { mergeBlockersForward, isUnresolvedBlocker } from "../_lib/blocking-findings.js";

// Quotes in these states can't have priced this PO.
const EXCLUDED_QUOTE_STATUSES = ["CANCELLED"];

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "write");
    const body = (await readBody(req)) || {};
    const orderId = body.order_id;
    if (!orderId) return json(res, 400, { error: { message: "order_id required" } });
    const svc = serviceClient();

    const orderQ = await svc.from("orders")
      // incoterm_code + delivery_terms feed the header incoterm check, and
      // rule_findings is read-modify-written for the -MOD blocker. All three
      // were absent from this select, so the incoterm comparison silently read
      // undefined off the order and fell through to the extracted payload.
      .select("id, customer_id, result, quote_id, quote_number, rule_findings, incoterm_code, delivery_terms")
      .eq("tenant_id", ctx.tenantId).eq("id", orderId).maybeSingle();
    if (orderQ.error) throw new Error("orders read: " + orderQ.error.message);
    if (!orderQ.data) return json(res, 404, { error: { message: "Order not found" } });
    const order = orderQ.data;
    if (!order.customer_id) {
      return json(res, 400, { error: { message: "Order has no customer; cannot find matching quotes. Set the customer first." } });
    }
    const orderLines = Array.isArray(order.result?.salesOrder?.lineItems) ? order.result.salesOrder.lineItems : [];
    if (!orderLines.length) return json(res, 400, { error: { message: "Order has no lines to reconcile." } });

    // 1. All the customer's quotes (most recent first = preferred price).
    const quotesQ = await svc.from("quotes")
      .select("id, quote_number, created_at, status, terms")
      .eq("tenant_id", ctx.tenantId).eq("customer_id", order.customer_id)
      .not("status", "in", "(" + EXCLUDED_QUOTE_STATUSES.join(",") + ")")
      .order("created_at", { ascending: false });
    if (quotesQ.error) throw new Error("quotes read: " + quotesQ.error.message);
    const quotes = quotesQ.data || [];
    const quoteMeta = new Map(quotes.map((q) => [q.id, q]));

    // 2. Their quote lines, tagged with quote provenance, in preferred order.
    let quoteLines = [];
    if (quotes.length) {
      const qlQ = await svc.from("quote_lines")
        .select("quote_id, line_index, part_no, description, qty, uom, hsn_sac, customer_part_number, source_country, listed_unit_price, discount_pct, discounted_unit_price, line_amount, cgst_pct, sgst_pct, igst_pct")
        .eq("tenant_id", ctx.tenantId).in("quote_id", quotes.map((q) => q.id));
      if (qlQ.error) throw new Error("quote_lines read: " + qlQ.error.message);
      quoteLines = (qlQ.data || []).map((ql) => {
        const m = quoteMeta.get(ql.quote_id);
        return { ...ql, _quote_id: ql.quote_id, _quote_number: m?.quote_number || null, _quote_created_at: m?.created_at || null };
      }).sort((a, b) => String(b._quote_created_at || "").localeCompare(String(a._quote_created_at || "")));
    }

    // 3. Reconcile.
    const rec = reconcilePoAgainstQuotes(orderLines, quoteLines, {
      priceTolerancePct: body.price_tolerance_pct != null ? Number(body.price_tolerance_pct) : 0.5,
    });

    // 3b. Header-level payment-terms check: the PO's payment terms
    // (extracted verbatim) vs the primary matched quote's terms.
    const primary = rec.quotes_used[0] || null;
    const poPayTerms = order.result?.salesOrder?.customer?.payment_terms
      || order.result?.salesOrder?.payment_terms || null;
    const primaryQuoteTerms = primary ? (quoteMeta.get(primary.quote_id)?.terms || null) : null;
    const paymentTerms = comparePaymentTerms(poPayTerms, primaryQuoteTerms);
    if (primary) paymentTerms.source_quote_number = primary.quote_number;
    if (paymentTerms.verdict === "mismatch") {
      rec.flags.push({
        line_no: null, part_no: null, verdict: "payment_terms_mismatch",
        po_rate: null, quote_rate: null, price_delta_pct: null,
        source_quote_number: primary?.quote_number || null,
        po_terms: paymentTerms.po_terms, quote_terms: paymentTerms.quote_terms,
      });
    }

    // 3c. Header-level INCOTERM check — the delivery rule was never compared,
    // so a PO switching FOB to CIF (who pays the freight and carries the risk)
    // passed reconciliation silently.
    //
    // `quotes` has no incoterm column, so the quote side is parsed out of its
    // terms text: parseIncoterm finds a rule code anywhere in a string, which
    // is how these are actually written ("FOB Busan, 30 days net").
    const poIncoterm = order.incoterm_code
      || order.result?.salesOrder?.incoterms
      || order.result?.salesOrder?.incoterm_code
      || order.delivery_terms || null;
    const primaryQuoteRow = primary ? quoteMeta.get(primary.quote_id) : null;
    const quoteIncoterm = primaryQuoteRow
      ? (primaryQuoteRow.incoterm_code || primaryQuoteRow.delivery_terms || primaryQuoteRow.terms || null)
      : null;
    const incoterms = compareIncoterms(poIncoterm, quoteIncoterm);
    if (primary) incoterms.source_quote_number = primary.quote_number;
    // place_differs is reported too: the rule is the same but the named place
    // moved, which still changes who pays for what leg.
    if (incoterms.verdict === "mismatch" || incoterms.verdict === "place_differs") {
      rec.flags.push({
        line_no: null, part_no: null, verdict: "incoterms_" + incoterms.verdict,
        po_rate: null, quote_rate: null, price_delta_pct: null,
        source_quote_number: primary?.quote_number || null,
        po_incoterm: incoterms.po_incoterm, quote_incoterm: incoterms.quote_incoterm,
      });
    }

    // 3d. GUN-MODIFICATION QUOTES.
    //
    // A modification quote is priced before engineering has issued the real
    // part numbers, so its lines carry provisional -MOD codes. Derived from the
    // parts rather than declared: order_mode 'SPARES_ASSEMBLY' exists but is
    // picked by hand on intake BEFORE extraction runs, so it cannot answer
    // this, and a hand-set flag would go stale the moment the lines changed.
    //
    // Both sides are checked. A -MOD part can reach the order from the quote
    // (priced provisionally) or from the PO itself (the customer ordered the
    // provisional number), and either way the order is committed to a part that
    // does not yet exist.
    const modFromOrder = provisionalParts(orderLines);
    const modFromQuotes = provisionalParts(quoteLines);
    const modFinding = modBomFinding([...orderLines, ...quoteLines], {
      sourceQuoteNumber: primary?.quote_number || null,
    });
    const modBom = {
      is_modification_quote: !!modFinding,
      pending_parts: modFinding ? modFinding.pending_parts : [],
      from_order: modFromOrder,
      from_quotes: modFromQuotes,
      // A final BOM is one with NO provisional parts. Until design supplies it
      // the order is blocked; the finding below is what enforces that.
      final_bom_present: !modFinding,
    };

    // 4. Persist enriched lines + report; link the primary quote (most lines).
    const nowIso = new Date().toISOString();

    // Raise or clear the blocking finding.
    //
    // mergeBlockersForward is what stops a routine rule_findings overwrite from
    // dropping an unresolved blocker; reconciliation is exactly such a routine
    // overwrite, so it must go through it rather than assigning the array.
    // When the provisional parts are gone the finding is dropped outright —
    // the condition genuinely cleared, so it should not linger as resolved
    // noise the operator has to read past.
    const priorFindings = Array.isArray(order.rule_findings) ? order.rule_findings : [];
    const withoutMod = priorFindings.filter((f) => (f?.code || f?.rule_id) !== MOD_BOM_FINDING_CODE);
    let nextFindings;
    if (modFinding) {
      // Preserve an existing RESOLVED one rather than re-raising it: the
      // operator has already said the provisional numbers are intentional.
      const existing = priorFindings.find((f) => (f?.code || f?.rule_id) === MOD_BOM_FINDING_CODE);
      // (incoming, prior) — the new array first. Reversing these would have
      // treated the OLD findings as the result and merged the new ones in as
      // carry-forwards, which mergeBlockersForward only does for
      // source === "extraction" entries, so the -MOD finding would have been
      // dropped every time.
      nextFindings = existing && !isUnresolvedBlocker(existing)
        ? priorFindings
        : mergeBlockersForward([...withoutMod, modFinding], priorFindings);
    } else {
      nextFindings = mergeBlockersForward(withoutMod, priorFindings);
    }
    const newResult = {
      ...(order.result || {}),
      salesOrder: { ...(order.result?.salesOrder || {}), lineItems: rec.lines },
      quoteReconciliation: {
        as_of: nowIso,
        summary: rec.summary,
        quotes_used: rec.quotes_used,
        // Lines the customer was quoted and did NOT order. Surfaced so the
        // operator can decide whether it is a deliberate partial order or an
        // omission worth chasing a PO amendment for.
        quoted_not_ordered: rec.quoted_not_ordered,
        ambiguous_parts: rec.ambiguous_parts,
        payment_terms: paymentTerms,
        incoterms,
        mod_bom: modBom,
        flags: rec.flags,
      },
    };
    const upd = await svc.from("orders")
      .update({
        result: newResult,
        rule_findings: nextFindings,
        quote_id: primary?.quote_id || order.quote_id || null,
        quote_number: primary?.quote_number || order.quote_number || null,
      })
      .eq("tenant_id", ctx.tenantId).eq("id", orderId);
    if (upd.error) throw new Error("orders update: " + upd.error.message);

    await recordAudit(ctx, {
      action: "order_reconcile_quotes", objectType: "order", objectId: orderId,
      detail: rec.summary.matched + "/" + rec.summary.total + " matched, " + rec.summary.price_mismatch + " price-mismatch, " + rec.summary.unmatched + " unmatched across " + rec.quotes_used.length + " quote(s)" + (paymentTerms.verdict === "mismatch" ? "; PAYMENT-TERMS MISMATCH (PO " + paymentTerms.po_terms + " vs quote " + paymentTerms.quote_terms + ")" : ""),
    });

    return json(res, 200, {
      order_id: orderId,
      summary: rec.summary,
      quotes_used: rec.quotes_used,
      ambiguous_parts: rec.ambiguous_parts,
      payment_terms: paymentTerms,
      flags: rec.flags,
      quotes_available: quotes.length,
    });
  } catch (err) {
    sendError(res, err);
  }
}
