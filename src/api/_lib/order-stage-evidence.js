// The evidence orderStage() (order-stage.js) needs beyond the order row, read
// once per request for a whole list: the tenant's mode, and which orders have
// an ERP sales order attached. Read-only.

import { isModeB } from "./so-processing-mode.js";
import { chunk } from "./customer-owner.js";

// { mode: "A" | "B", erpSo: Map(order id -> [{ document_id }]) }.
// orderIds must come from this tenant's own orders query: order_documents has
// no tenant_id, so the ids are its tenant scope (as register.js reads it).
export const readStageEvidence = async (svc, tenantId, orderIds) => {
  const erpSo = new Map();
  if (!orderIds.length) return { mode: "A", erpSo };
  const modeB = await isModeB(svc, tenantId);
  for (const part of chunk(orderIds)) {
    const q = await svc.from("order_documents").select("order_id, document_id")
      .eq("role", "sales_order").in("order_id", part);
    if (q.error) throw new Error("order_documents: " + q.error.message);
    for (const l of q.data || []) {
      if (!erpSo.has(l.order_id)) erpSo.set(l.order_id, []);
      erpSo.get(l.order_id).push({ document_id: l.document_id });
    }
  }
  return { mode: modeB ? "B" : "A", erpSo };
};

// The evidence argument of orderStage() for one order of the list.
export const stageEvidenceFor = (ev, orderId) => ({ mode: ev.mode, erp_so: ev.erpSo.get(orderId) || null });
