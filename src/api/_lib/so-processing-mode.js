// The tenant's sales-order processing mode (migration 221), and the refusal
// every path that writes to the ERP returns in Mode B.
//
// MODE A  Anvil processes the sales order and pushes the voucher to the ERP.
// MODE B  A person processes it by hand in the ERP. Anvil pushes nothing.
// (The full description lives in admin/so_processing_mode.js.)
//
// One copy, because the push and the retry drain must refuse in exactly the
// same way. tally/retry.js used to drain tally_retry_queue with no mode check,
// so a row queued before a switch to B (or enqueued by the copilot) could
// still post a voucher to a ledger the tenant had said Anvil must not touch.

export const MODE_B_CODE = "SO_PROCESSING_MODE_B";

// Refused LOUDLY rather than no-oped. A push that silently does nothing is how
// a tenant discovers their mode by finding an empty ledger a week later; a 409
// naming the mode is how they discover it in the second it happens.
export const modeBRefusal = () => ({
  error: {
    code: MODE_B_CODE,
    message: "This tenant is in Mode B: sales orders are processed by hand in the ERP and Anvil does not"
      + " push vouchers. Anvil's own proposal is still recorded and compared. Switch to Mode A under"
      + " Admin > Sales-order processing to let Anvil push.",
  },
});

// True only when the tenant's stored mode is B.
//
// An unreadable setting (a read that returns an error), or a database without
// migration 221, reads as not B, and the caller proceeds. That is mode A, the
// behaviour every tenant already has. Failing the other way would stop pushes
// on a transient read error.
export const isModeB = async (svc, tenantId) => {
  const q = await svc.from("tenant_settings")
    .select("so_processing_mode").eq("tenant_id", tenantId).maybeSingle();
  return q?.data?.so_processing_mode === "B";
};
