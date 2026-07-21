// CM P4: harvest ground truth for free. Every APPROVED order is a
// human-verified extraction — snapshot it into a golden eval_case so the
// accuracy harness can measure the pipeline against real, corrected output.
//
// Called best-effort from the orders PATCH approve path (orders/[id].js); the
// caller wraps it in try/catch and never lets a promotion failure block the
// approval. Routes to a SHARED regression corpus tenant (EVAL_GOLDEN_TENANT_ID)
// when configured, so accuracy is measured across every customer format in one
// suite; falls back to the order's own tenant otherwise.
//
// Idempotent: upserts on (tenant_id, suite, case_id) keyed by PO number, so
// re-approving the same PO refreshes the golden with the latest verified truth.

import { salesOrderToScorable } from "./eval-normalize.js";

const DEFAULT_SUITE = "po-extraction";

// Resolve the immutable source document(s) for a promoted order so the golden
// case is reproducible (and de-dupable by content hash). Two plain queries to
// avoid PostgREST embedded-FK fragility. Best-effort.
const resolveSourceDocuments = async (svc, sourceTenantId, orderId) => {
  try {
    const od = await svc.from("order_documents")
      .select("document_id, role")
      .eq("tenant_id", sourceTenantId)
      .eq("order_id", orderId);
    if (!od || od.error || !Array.isArray(od.data) || !od.data.length) return { documents: [], sourceSha256: null };
    const ids = od.data.map((r) => r.document_id).filter(Boolean);
    let shaById = {};
    if (ids.length) {
      const docs = await svc.from("documents").select("id, sha256").in("id", ids);
      if (docs && !docs.error && Array.isArray(docs.data)) {
        for (const d of docs.data) shaById[d.id] = d.sha256 || null;
      }
    }
    const documents = od.data.map((r) => ({
      documentId: r.document_id,
      role: r.role || "purchase_order",
      sha256: shaById[r.document_id] || null,
    }));
    const sourceSha256 = documents.find((d) => d.sha256)?.sha256 || null;
    return { documents, sourceSha256 };
  } catch (_) {
    return { documents: [], sourceSha256: null };
  }
};

// Snapshot one APPROVED order into a golden eval_case. `order` is the full
// orders row (select *). Returns { promoted, reason?, case_id?, tenant_id? }.
export const promoteApprovedOrder = async (svc, order, opts = {}) => {
  if (!order || order.status !== "APPROVED") return { promoted: false, reason: "not_approved" };
  const salesOrder = order.result && order.result.salesOrder;
  if (!salesOrder) return { promoted: false, reason: "no_sales_order" };

  const expected = salesOrderToScorable(salesOrder);
  if (!Array.isArray(expected.lineItems) || !expected.lineItems.length) {
    return { promoted: false, reason: "no_lines" };
  }

  const sourceTenantId = order.tenant_id;
  const targetTenantId = opts.targetTenantId || sourceTenantId;
  const suite = opts.suite || DEFAULT_SUITE;
  const nowIso = opts.nowIso || new Date().toISOString();

  const caseId = String(expected.poNumber || order.po_number || order.id).trim() || order.id;
  const customerName = expected.customer || "";

  const { documents, sourceSha256 } = await resolveSourceDocuments(svc, sourceTenantId, order.id);
  const extractionRunId = (order.preflight_payload && order.preflight_payload.extraction_run_id) || null;

  // Provenance rides inside `expected` under a key scoreCase ignores, so no
  // migration is needed. It pins how to reproduce + who verified the case.
  expected._provenance = {
    order_id: order.id,
    source_tenant_id: sourceTenantId,
    extraction_run_id: extractionRunId,
    payload_hash: order.payload_hash || (order.approval && order.approval.payloadHash) || null,
    approved_by: order.approved_by || (order.approval && order.approval.approvedBy) || null,
    approved_at: order.approved_at || null,
    doc_fingerprint: order.doc_fingerprint || null,
    source_sha256: sourceSha256,
    customer_id: order.customer_id || null,
    promoted_at: nowIso,
  };

  const row = {
    tenant_id: targetTenantId,
    suite,
    case_id: caseId,
    description: (customerName ? customerName + " — " : "") + "PO " + caseId,
    documents,
    expected,
    enabled: true,
  };

  const up = await svc.from("eval_cases")
    .upsert(row, { onConflict: "tenant_id,suite,case_id" })
    .select("id")
    .single();
  if (up.error) return { promoted: false, reason: up.error.message };
  return { promoted: true, case_id: caseId, tenant_id: targetTenantId, eval_case_id: up.data.id };
};
