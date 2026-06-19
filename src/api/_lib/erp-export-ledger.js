// ERP-push idempotency guard (PR3).
//
// A guard in front of the existing push path. Before the outbound call a
// handler asks checkExportIdempotency() whether this (order, connector,
// payload_hash) was already exported:
//
//   - exact match already succeeded  -> { idempotent: true, external_id }
//     The handler returns a no-op with the prior external id and makes NO
//     outbound call.
//   - a prior export exists under a DIFFERENT hash, and the caller did not
//     opt into re-export -> { blocked: true, status: 409, body }
//     (code PAYLOAD_HASH_CHANGED). Prevents a changed order from silently
//     creating a second ERP sales order.
//   - otherwise -> { proceed: true }
//
// After a successful push the handler calls recordExport() to upsert the
// success row keyed by the unique (tenant_id, order_id, connector,
// payload_hash) constraint, so the next identical push short-circuits.
//
// Tally is intentionally not routed through this ledger: it already has
// its own idempotency via tally_voucher_records.

const TABLE = "erp_export_ledger";

// The hash an export is built from is the same one the approval is bound
// to. Falls back through the order's stored hash and the approval blob.
export const orderPayloadHash = (order) =>
  order?.payload_hash || order?.approval?.payloadHash || null;

// Look up the exact (tenant, order, connector, payload_hash) success row.
const findExact = async (svc, { tenantId, orderId, connector, payloadHash }) => {
  const r = await svc.from(TABLE).select("external_id")
    .eq("tenant_id", tenantId).eq("order_id", orderId)
    .eq("connector", connector).eq("payload_hash", payloadHash)
    .eq("status", "success").maybeSingle();
  if (r.error) throw new Error("export ledger read: " + r.error.message);
  return r.data || null;
};

// Look up the most recent success row for this order+connector under ANY
// hash, to detect that the payload changed since a prior export.
const findPrior = async (svc, { tenantId, orderId, connector }) => {
  const r = await svc.from(TABLE).select("external_id, payload_hash, last_pushed_at")
    .eq("tenant_id", tenantId).eq("order_id", orderId).eq("connector", connector)
    .eq("status", "success").order("last_pushed_at", { ascending: false })
    .limit(1).maybeSingle();
  if (r.error) throw new Error("export ledger read: " + r.error.message);
  return r.data || null;
};

export const checkExportIdempotency = async (svc, { tenantId, orderId, connector, payloadHash, allowReexport }) => {
  // No hash to key on (e.g. legacy order with no stored hash): cannot
  // dedup safely, so proceed rather than risk a false block.
  if (!payloadHash) return { proceed: true };

  const exact = await findExact(svc, { tenantId, orderId, connector, payloadHash });
  if (exact) {
    return { idempotent: true, external_id: exact.external_id || null };
  }

  if (!allowReexport) {
    const prior = await findPrior(svc, { tenantId, orderId, connector });
    if (prior) {
      return {
        blocked: true,
        status: 409,
        body: {
          error: {
            code: "PAYLOAD_HASH_CHANGED",
            message: "This order was already exported to " + connector + " under a different payload hash. Re-exporting would create a duplicate. Pass reexport:true to override.",
            prior_external_id: prior.external_id || null,
            prior_payload_hash: prior.payload_hash || null,
            current_payload_hash: payloadHash,
          },
        },
      };
    }
  }

  return { proceed: true };
};

// Upsert a success row. onConflict on the unique key makes a repeated
// success (e.g. an allowed re-export of the same hash) idempotent.
export const recordExport = async (svc, { tenantId, orderId, connector, payloadHash, externalId }) => {
  if (!payloadHash) return;
  const r = await svc.from(TABLE).upsert({
    tenant_id: tenantId,
    order_id: orderId,
    connector,
    payload_hash: payloadHash,
    external_id: externalId || null,
    status: "success",
    last_pushed_at: new Date().toISOString(),
  }, { onConflict: "tenant_id,order_id,connector,payload_hash" });
  if (r.error) throw new Error("export ledger write: " + r.error.message);
};
