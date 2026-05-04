// Tool dispatcher for the ERP-query chat. Each tool maps to a
// safe, parameterised query against a mirror table. We deliberately
// don't expose raw SQL to the model: the model picks a tool name
// + structured args, we run a known query, return the result.
//
// All tools are tenant-scoped via the service-role client and the
// caller's tenant_id (passed in as `tenantId` in dispatch()).

import { serviceClient } from "./supabase.js";

const limit = (n) => Math.max(1, Math.min(50, Number(n || 25)));

const TOOLS = {
  search_orders: {
    description: "Search Anvil orders by po_number, quote_number, customer name, or status. Returns id, status, totals.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "free-text query (po, quote, customer)" },
        status: { type: "string" },
        limit: { type: "integer", default: 25 },
      },
    },
    run: async (svc, tenantId, args) => {
      let q = svc.from("orders").select("id, quote_number, po_number, status, tally_status, total_value, currency, customer_id, created_at");
      q = q.eq("tenant_id", tenantId);
      if (args?.status) q = q.eq("status", args.status);
      if (args?.query) {
        q = q.or(`quote_number.ilike.%${args.query}%,po_number.ilike.%${args.query}%`);
      }
      const r = await q.order("created_at", { ascending: false }).limit(limit(args?.limit));
      return { rows: r.data || [], source: "orders" };
    },
  },

  search_invoices: {
    description: "Search Anvil invoices by invoice_number, customer, or status. Returns totals + paid_amount.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        status: { type: "string" },
        limit: { type: "integer", default: 25 },
      },
    },
    run: async (svc, tenantId, args) => {
      let q = svc.from("invoices").select("id, invoice_number, issue_date, due_date, currency, grand_total, paid_amount, status, customer_id");
      q = q.eq("tenant_id", tenantId);
      if (args?.status) q = q.eq("status", args.status);
      if (args?.query) q = q.ilike("invoice_number", `%${args.query}%`);
      const r = await q.order("issue_date", { ascending: false }).limit(limit(args?.limit));
      return { rows: r.data || [], source: "invoices" };
    },
  },

  search_customers: {
    description: "Search customers by name or external_ref.",
    parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer", default: 25 } } },
    run: async (svc, tenantId, args) => {
      let q = svc.from("customers").select("id, customer_name, customer_key, contact_email, external_ref")
        .eq("tenant_id", tenantId);
      if (args?.query) q = q.ilike("customer_name", `%${args.query}%`);
      const r = await q.limit(limit(args?.limit));
      return { rows: r.data || [], source: "customers" };
    },
  },

  search_netsuite_open_orders: {
    description: "Search NetSuite mirror table of open sales orders.",
    parameters: { type: "object", properties: { query: { type: "string" }, status: { type: "string" }, limit: { type: "integer", default: 25 } } },
    run: async (svc, tenantId, args) => {
      let q = svc.from("netsuite_open_orders").select("*").eq("tenant_id", tenantId);
      if (args?.status) q = q.eq("status", args.status);
      if (args?.query) q = q.ilike("order_number", `%${args.query}%`);
      const r = await q.order("ordered_at", { ascending: false }).limit(limit(args?.limit));
      return { rows: r.data || [], source: "netsuite_open_orders" };
    },
  },

  search_sap_sales_orders: {
    description: "Search SAP S/4HANA mirror table of sales orders.",
    parameters: { type: "object", properties: { query: { type: "string" }, status: { type: "string" }, limit: { type: "integer", default: 25 } } },
    run: async (svc, tenantId, args) => {
      let q = svc.from("sap_sales_orders").select("*").eq("tenant_id", tenantId);
      if (args?.status) q = q.eq("status", args.status);
      if (args?.query) q = q.ilike("external_id", `%${args.query}%`);
      const r = await q.order("ordered_at", { ascending: false }).limit(limit(args?.limit));
      return { rows: r.data || [], source: "sap_sales_orders" };
    },
  },

  search_d365_sales_orders: {
    description: "Search Dynamics 365 mirror sales orders.",
    parameters: { type: "object", properties: { query: { type: "string" }, status: { type: "string" }, limit: { type: "integer", default: 25 } } },
    run: async (svc, tenantId, args) => {
      let q = svc.from("d365_sales_orders").select("*").eq("tenant_id", tenantId);
      if (args?.status) q = q.eq("status", args.status);
      if (args?.query) q = q.ilike("external_id", `%${args.query}%`);
      const r = await q.order("ordered_at", { ascending: false }).limit(limit(args?.limit));
      return { rows: r.data || [], source: "d365_sales_orders" };
    },
  },

  search_acu_sales_orders: {
    description: "Search Acumatica mirror sales orders.",
    parameters: { type: "object", properties: { query: { type: "string" }, status: { type: "string" }, limit: { type: "integer", default: 25 } } },
    run: async (svc, tenantId, args) => {
      let q = svc.from("acu_sales_orders").select("*").eq("tenant_id", tenantId);
      if (args?.status) q = q.eq("status", args.status);
      if (args?.query) q = q.ilike("external_id", `%${args.query}%`);
      const r = await q.order("ordered_at", { ascending: false }).limit(limit(args?.limit));
      return { rows: r.data || [], source: "acu_sales_orders" };
    },
  },

  search_inventory: {
    description: "Search inventory across NetSuite/SAP/D365/Acumatica mirrors. Filters by item_external_id or material_external_id.",
    parameters: { type: "object", properties: { item: { type: "string" }, limit: { type: "integer", default: 25 } } },
    run: async (svc, tenantId, args) => {
      const q = String(args?.item || "");
      const [ns, sap, d365, acu] = await Promise.all([
        svc.from("netsuite_inventory_balances").select("*").eq("tenant_id", tenantId).ilike("item_netsuite_id", q ? `%${q}%` : "%").limit(limit(args?.limit)),
        svc.from("sap_inventory_balances").select("*").eq("tenant_id", tenantId).ilike("material_external_id", q ? `%${q}%` : "%").limit(limit(args?.limit)),
        svc.from("d365_inventory_balances").select("*").eq("tenant_id", tenantId).ilike("product_external_id", q ? `%${q}%` : "%").limit(limit(args?.limit)),
        svc.from("acu_inventory_balances").select("*").eq("tenant_id", tenantId).ilike("item_external_id", q ? `%${q}%` : "%").limit(limit(args?.limit)),
      ]);
      return {
        rows: {
          netsuite: ns.data || [],
          sap: sap.data || [],
          d365: d365.data || [],
          acumatica: acu.data || [],
        },
        source: "inventory_combined",
      };
    },
  },

  open_invoices_aging: {
    description: "List overdue invoices grouped by days overdue (0-30, 31-60, 61+). Used for AR aging questions.",
    parameters: { type: "object", properties: {} },
    run: async (svc, tenantId, _args) => {
      const r = await svc.from("invoices")
        .select("id, invoice_number, due_date, grand_total, paid_amount, status, currency")
        .eq("tenant_id", tenantId)
        .in("status", ["sent", "partial", "overdue"])
        .order("due_date", { ascending: true });
      const buckets = { "0-30": 0, "31-60": 0, "61+": 0, total: 0 };
      const now = Date.now();
      for (const inv of r.data || []) {
        const overdue = inv.due_date ? Math.max(0, Math.floor((now - new Date(inv.due_date).getTime()) / 86400_000)) : 0;
        const outstanding = Number(inv.grand_total || 0) - Number(inv.paid_amount || 0);
        if (overdue <= 30) buckets["0-30"] += outstanding;
        else if (overdue <= 60) buckets["31-60"] += outstanding;
        else buckets["61+"] += outstanding;
        buckets.total += outstanding;
      }
      return { buckets, count: (r.data || []).length, source: "invoices" };
    },
  },
};

export const erpChatTools = () => Object.entries(TOOLS).map(([name, t]) => ({
  name,
  description: t.description,
  input_schema: t.parameters,
}));

export const dispatchErpChatTool = async (tenantId, name, args) => {
  const tool = TOOLS[name];
  if (!tool) return { error: "unknown tool: " + name };
  try {
    const svc = serviceClient();
    return await tool.run(svc, tenantId, args || {});
  } catch (err) {
    return { error: err.message || String(err) };
  }
};

export const erpChatToolNames = () => Object.keys(TOOLS);
