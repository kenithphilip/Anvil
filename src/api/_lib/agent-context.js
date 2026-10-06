// Server-side record context for Ask Anvil personas.
//
// WHY THIS EXISTS
//
// The panel used to tell the agent which order it was looking at by prefixing
// the operator's first message: "Context: I am looking at sales order PO
// 0066026562." A configured rule in redaction_rules matched the ten-digit PO
// number as a phone number, so what actually reached the model was
//
//   Context: I am looking at sales order PO [redacted-phone].
//
// and the agent — correctly — answered that it could not tell which order was
// meant. Every reply would have been a request for clarification.
//
// Routing our own record identifiers through a filter built for untrusted user
// text was the mistake. redactMessages() is applied to MESSAGES only;
// applyFirewall() prepends a header to the system prompt and strips nothing
// from it. So context belongs in the system prompt, assembled here from the
// database rather than echoed out of a request body.
//
// SECURITY. The order is fetched by id AND tenant_id. A client that guesses or
// forges an id from another tenant gets no context at all — not an error, which
// would confirm the id exists. Nothing here is caller-supplied text: every value
// is read from our own tables, which is exactly why it is safe to place above
// the firewall header.

const money = (n) => {
  const v = Number(n);
  return Number.isFinite(v) ? v.toLocaleString("en-IN", { maximumFractionDigits: 2 }) : null;
};

// A compact, factual block. Deliberately NOT a summary: anything inferred here
// is something the agent cannot check, and a wrong inference stated as context
// is worse than no context. Counts and totals only.
export const loadOrderContext = async (svc, tenantId, orderId) => {
  if (!svc || !tenantId || !orderId) return null;
  let order = null;
  try {
    const r = await svc.from("orders")
      .select("id, po_number, po_date, status, customer_id, result, rule_findings")
      .eq("tenant_id", tenantId)
      .eq("id", orderId)
      .maybeSingle();
    if (r.error || !r.data) return null;
    order = r.data;
  } catch (_e) {
    // Context is an enhancement. A failure here must not fail the turn — the
    // agent still has its tools and can look the order up itself.
    return null;
  }

  const so = order.result?.salesOrder || {};
  const lines = Array.isArray(so.lineItems) ? so.lineItems : [];
  const findings = Array.isArray(order.rule_findings) ? order.rule_findings : [];

  let customerName = so.customer?.name || null;
  if (!customerName && order.customer_id) {
    try {
      const c = await svc.from("customers").select("customer_name")
        .eq("tenant_id", tenantId).eq("id", order.customer_id).maybeSingle();
      customerName = c.data?.customer_name || null;
    } catch (_e) { /* name is optional */ }
  }

  // Sum what the lines actually carry, rather than trusting a stored total that
  // may predate the last extraction.
  let taxable = 0;
  let gross = 0;
  for (const l of lines) {
    const qty = Number(l?.quantity ?? l?.qty) || 0;
    const rate = Number(l?.unitPrice ?? l?.rate) || 0;
    taxable += qty * rate;
    gross += Number(l?.lineTotal) || (qty * rate);
  }

  const bits = [
    "ORDER CONTEXT (from Anvil's database, not from the operator):",
    order.po_number ? "- PO number: " + order.po_number : null,
    customerName ? "- Customer: " + customerName : null,
    order.po_date ? "- PO date: " + order.po_date : null,
    order.status ? "- Status: " + order.status : null,
    "- Extracted line items: " + lines.length,
    lines.length ? "- Sum of line taxable values: " + money(taxable) : null,
    lines.length && gross !== taxable ? "- Sum of line totals (incl. tax): " + money(gross) : null,
    so.grandTotal ? "- Grand total recorded on the order: " + money(so.grandTotal) : null,
    findings.length ? "- Open validation findings: " + findings.length : null,
    "",
    "This order is the subject of the conversation. When the operator says"
      + " \"this order\" or \"the PO\", they mean the one above. You still have"
      + " tools — use them for anything not stated here, and never infer a number"
      + " that is not in this block or returned by a tool.",
  ].filter(Boolean);

  return { text: bits.join("\n"), poNumber: order.po_number || null, lineCount: lines.length };
};

// Persona id -> loader. A persona without an entry simply gets no record
// context, which is why adding one is opt-in rather than automatic.
export const CONTEXT_LOADERS = Object.freeze({
  so: loadOrderContext,
});

export const loadPersonaContext = async (personaId, svc, tenantId, recordId) => {
  const loader = CONTEXT_LOADERS[personaId];
  if (!loader || !recordId) return null;
  return loader(svc, tenantId, recordId);
};
