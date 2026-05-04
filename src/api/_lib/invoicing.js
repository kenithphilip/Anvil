// Helpers shared by the invoicing module.
//
// formatInvoiceNumber takes the bare integer that next_invoice_number()
// returns and formats it per the tenant-configured template. Default
// template is "{prefix}-{number:04}" producing "INV-0001"; admins can
// override via tenant_settings.

const formatInteger = (n, width) => String(n).padStart(width, "0");

export const formatInvoiceNumber = (number, format, prefix) => {
  const tmpl = format || "{prefix}-{number:04}";
  const pfx = prefix || "INV";
  return tmpl
    .replace(/\{prefix\}/g, pfx)
    .replace(/\{number(?::(\d+))?\}/g, (_, w) => formatInteger(number, Number(w) || 1))
    .replace(/\{year\}/g, String(new Date().getUTCFullYear()))
    .replace(/\{month(?::(\d+))?\}/g, (_, w) => formatInteger(new Date().getUTCMonth() + 1, Number(w) || 2));
};

// Pull the next sequenced invoice number for a tenant. Returns the
// formatted string (e.g. "INV-0001"). Atomic via the database
// function next_invoice_number; concurrent callers always get
// distinct numbers.
export const nextInvoiceNumber = async (svc, tenantId) => {
  const seqQ = await svc
    .from("invoice_number_sequences")
    .select("prefix, format")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (seqQ.error) throw new Error("invoice sequence read: " + seqQ.error.message);
  const prefix = seqQ.data?.prefix || "INV";
  const format = seqQ.data?.format || "{prefix}-{number:04}";

  const rpc = await svc.rpc("next_invoice_number", { p_tenant: tenantId });
  if (rpc.error) throw new Error("next_invoice_number rpc: " + rpc.error.message);
  const number = rpc.data;
  if (number == null) throw new Error("next_invoice_number returned null");
  return formatInvoiceNumber(number, format, prefix);
};

// Build an invoice payload from an order. Caller persists the row.
export const invoiceFromOrder = (order, opts) => {
  const so = order.result?.salesOrder || {};
  const items = Array.isArray(so.lineItems) ? so.lineItems : [];
  const subtotal = Number(so.subtotal) || items.reduce((s, it) => s + (Number(it.total) || (Number(it.rate) * Number(it.quantity || 0))), 0);
  const tax = Number(so.taxTotal || so.gstTotal) || 0;
  const grand = Number(so.grandTotal || so.total) || (subtotal + tax);
  const dueDate = opts?.due_date || (() => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + (opts?.net_days || 30));
    return d.toISOString().slice(0, 10);
  })();
  return {
    order_id: order.id,
    customer_id: order.customer_id || null,
    issue_date: opts?.issue_date || new Date().toISOString().slice(0, 10),
    due_date: dueDate,
    currency: so.currency || opts?.currency || "USD",
    subtotal,
    tax_total: tax,
    grand_total: grand,
    payment_terms: opts?.payment_terms || ("Net " + (opts?.net_days || 30)),
    notes: opts?.notes || null,
    line_items: items,
  };
};
