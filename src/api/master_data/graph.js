// GET /api/master_data/graph?customerId=&partNo=&depth=
// Returns a graph of customer -> orders -> source POs -> parts -> aliases -> BOM children/parents
// for use by both table and graph UI views.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";

const upper = (s) => String(s || "").toUpperCase();

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "GET") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const customerId = req.query.customerId || null;
    const partNo = req.query.partNo ? String(req.query.partNo).trim() : null;
    const depth = Math.max(1, Math.min(3, Number(req.query.depth || 1)));
    const svc = serviceClient();
    const nodes = new Map();
    const edges = [];
    const edgeKeys = new Set();
    const addNode = (id, type, label, attrs) => {
      if (nodes.has(id)) return;
      nodes.set(id, { id, type, label, attrs: attrs || {} });
    };
    const addEdge = (source, target, kind) => {
      const key = source + "->" + target + "::" + kind;
      if (edgeKeys.has(key)) return;
      edgeKeys.add(key);
      edges.push({ source, target, kind });
    };

    // Customers (filtered if customerId given)
    let customerQuery = svc.from("customers").select("*").eq("tenant_id", ctx.tenantId);
    if (customerId) customerQuery = customerQuery.eq("id", customerId);
    const customers = await customerQuery.limit(50);
    if (customers.error) throw new Error(customers.error.message);
    (customers.data || []).forEach((c) => {
      const id = "customer:" + c.id;
      addNode(id, "customer", c.customer_name || c.customer_key, { gstin: c.gstin, key: c.customer_key, state: c.state_code });
    });

    if (!customers.data || !customers.data.length) {
      return json(res, 200, { nodes: [], edges: [], summary: { customers: 0 } });
    }
    const customerIds = customers.data.map((c) => c.id);

    // Orders for the customers
    const orders = await svc.from("orders")
      .select("id, status, po_number, po_date, customer_id, result")
      .eq("tenant_id", ctx.tenantId)
      .in("customer_id", customerIds)
      .order("created_at", { ascending: false })
      .limit(200);
    if (orders.error) throw new Error(orders.error.message);
    const orderIds = (orders.data || []).map((o) => o.id);
    (orders.data || []).forEach((o) => {
      const id = "order:" + o.id;
      addNode(id, "order", o.po_number || o.id, { status: o.status, po_date: o.po_date });
      addEdge("customer:" + o.customer_id, id, "order");
      const lines = (o.result && o.result.salesOrder && o.result.salesOrder.lineItems) || [];
      lines.forEach((li) => {
        const partKey = upper(li.tallyItemName || li.itemName || li.sellerPartNo || "");
        if (!partKey) return;
        const partId = "part:" + partKey;
        addNode(partId, "part", partKey, { hsn: li.hsnCode || null });
        addEdge(id, partId, "ordered");
        addEdge("customer:" + o.customer_id, partId, "buys");
      });
    });

    // Source POs
    if (orderIds.length) {
      const sourcePos = await svc.from("source_pos").select("id, order_id, supplier, country, currency, status, exchange_rate").eq("tenant_id", ctx.tenantId).in("order_id", orderIds);
      if (!sourcePos.error) {
        (sourcePos.data || []).forEach((spo) => {
          const id = "spo:" + spo.id;
          addNode(id, "source_po", spo.supplier || spo.country || spo.id, { country: spo.country, currency: spo.currency, status: spo.status, exchange_rate: spo.exchange_rate });
          addEdge("order:" + spo.order_id, id, "fulfilled_by");
          if (spo.supplier) {
            const supplierId = "supplier:" + spo.supplier;
            addNode(supplierId, "supplier", spo.supplier, { country: spo.country });
            addEdge(id, supplierId, "supplier");
          }
        });
      }
    }

    // Aliases connect customer parts to seller parts
    const aliases = await svc.from("part_aliases").select("customer_id, customer_part_no, customer_description, obara_part_no, status").eq("tenant_id", ctx.tenantId).in("customer_id", customerIds);
    (aliases.data || []).forEach((alias) => {
      const customerNode = "customer:" + alias.customer_id;
      const obaraId = "part:" + upper(alias.obara_part_no);
      const customerPartId = "customer_part:" + alias.customer_id + ":" + alias.customer_part_no;
      addNode(obaraId, "part", upper(alias.obara_part_no), { source: "alias" });
      addNode(customerPartId, "customer_part", alias.customer_part_no, { description: alias.customer_description || null, status: alias.status });
      addEdge(customerNode, customerPartId, "uses_part_no");
      addEdge(customerPartId, obaraId, "alias_of");
    });

    // BOM parents/children for any parts in the graph (or filtered)
    const partKeys = Array.from(nodes.keys()).filter((id) => id.startsWith("part:")).map((id) => id.slice(5));
    if (partNo) partKeys.push(upper(partNo));
    if (partKeys.length) {
      const bomParents = await svc.from("bill_of_materials").select("parent_part_no, child_part_no, qty, uom").eq("tenant_id", ctx.tenantId).in("child_part_no", partKeys);
      const bomChildren = await svc.from("bill_of_materials").select("parent_part_no, child_part_no, qty, uom").eq("tenant_id", ctx.tenantId).in("parent_part_no", partKeys);
      (bomParents.data || []).forEach((row) => {
        const parentId = "part:" + upper(row.parent_part_no);
        const childId = "part:" + upper(row.child_part_no);
        addNode(parentId, "part", upper(row.parent_part_no), { is_assembly: true });
        addNode(childId, "part", upper(row.child_part_no), { is_component: true });
        addEdge(parentId, childId, "bom");
      });
      (bomChildren.data || []).forEach((row) => {
        const parentId = "part:" + upper(row.parent_part_no);
        const childId = "part:" + upper(row.child_part_no);
        addNode(parentId, "part", upper(row.parent_part_no), { is_assembly: true });
        addNode(childId, "part", upper(row.child_part_no), { is_component: true });
        addEdge(parentId, childId, "bom");
      });
    }

    return json(res, 200, {
      nodes: Array.from(nodes.values()),
      edges,
      summary: {
        customers: customers.data.length,
        orders: orders.data ? orders.data.length : 0,
        nodes: nodes.size,
        edges: edges.length,
      },
      depth,
    });
  } catch (err) {
    sendError(res, err);
  }
}
