// Tool dispatcher for the ERP-query chat. Each tool maps to a
// safe, parameterised query against a mirror table. We deliberately
// don't expose raw SQL to the model: the model picks a tool name
// + structured args, we run a known query, return the result.
//
// All tools are tenant-scoped via the service-role client and the
// caller's tenant_id (passed in as `tenantId` in dispatch()).
//
// Each tool declares a `scope` tag (read.orders, read.invoices,
// read.customers, read.inventory, read.pipeline). The MCP server
// uses these scopes to enforce per-token RBAC; the internal ERP
// chat ignores scopes (the user is already authenticated and
// permission-checked at the route layer).

import { serviceClient } from "./supabase.js";

const limit = (n) => Math.max(1, Math.min(50, Number(n || 25)));

const TOOLS = {
  search_orders: {
    scope: "read.orders",
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
    scope: "read.invoices",
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
    scope: "read.customers",
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
    scope: "read.orders",
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
    scope: "read.orders",
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
    scope: "read.orders",
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
    scope: "read.orders",
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
    scope: "read.inventory",
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
    scope: "read.invoices",
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

  get_quote_status: {
    scope: "read.orders",
    description: "Look up the full status of a single quote/order by its quote_number, po_number, or id. Returns approval state, ERP-export state across every connected ERP, last touch.",
    parameters: {
      type: "object",
      properties: {
        identifier: { type: "string", description: "quote_number, po_number, or order id" },
      },
      required: ["identifier"],
    },
    run: async (svc, tenantId, args) => {
      const id = String(args?.identifier || "").trim();
      if (!id) return { error: "identifier required" };
      let q = svc.from("orders").select("*").eq("tenant_id", tenantId);
      // UUID-shaped lookup, otherwise treat as quote/po number.
      if (/^[0-9a-f]{8}-/i.test(id)) q = q.eq("id", id);
      else q = q.or(`quote_number.eq.${id},po_number.eq.${id}`);
      const r = await q.maybeSingle();
      if (r.error) return { error: r.error.message };
      if (!r.data) return { rows: [], source: "orders", note: "not found" };
      const o = r.data;
      const ext = o.result?.external_systems || {};
      return {
        order: {
          id: o.id,
          quote_number: o.quote_number,
          po_number: o.po_number,
          status: o.status,
          tally_status: o.tally_status,
          total_value: o.total_value,
          currency: o.currency,
          created_at: o.created_at,
          approval: o.approval ? {
            decided_by: o.approval.decided_by,
            decided_at: o.approval.decided_at,
            decision: o.approval.decision,
          } : null,
          erp_exports: {
            netsuite: ext.netsuite ? { id: ext.netsuite.external_id, status: ext.netsuite.status } : null,
            sap:      ext.sap      ? { id: ext.sap.external_id,      status: ext.sap.status } : null,
            d365:     ext.d365     ? { id: ext.d365.external_id,     status: ext.d365.status } : null,
            acumatica: ext.acumatica ? { id: ext.acumatica.external_id, status: ext.acumatica.status } : null,
          },
        },
        source: "orders",
      };
    },
  },

  summarize_open_pipeline: {
    scope: "read.pipeline",
    description: "Summarise the tenant's open pipeline: counts of orders by status, sum of total_value by status, top 10 customers by open value. Used for pipeline-health questions.",
    parameters: { type: "object", properties: {} },
    run: async (svc, tenantId, _args) => {
      const r = await svc.from("orders")
        .select("status, total_value, currency, customer_id")
        .eq("tenant_id", tenantId)
        .not("status", "in", "(\"DONE\",\"RECONCILED\",\"CANCELLED\")")
        .limit(2000);
      if (r.error) return { error: r.error.message };
      const byStatus = new Map();
      const byCustomer = new Map();
      for (const o of r.data || []) {
        const s = o.status || "UNKNOWN";
        const v = Number(o.total_value || 0);
        byStatus.set(s, (byStatus.get(s) || { count: 0, value: 0 }));
        byStatus.get(s).count += 1;
        byStatus.get(s).value += v;
        if (o.customer_id) {
          byCustomer.set(o.customer_id, (byCustomer.get(o.customer_id) || 0) + v);
        }
      }
      const topCustomerIds = Array.from(byCustomer.entries())
        .sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id, v]) => ({ id, open_value: v }));
      // Hydrate customer names.
      if (topCustomerIds.length) {
        const ids = topCustomerIds.map((c) => c.id);
        const cQ = await svc.from("customers").select("id, customer_name").eq("tenant_id", tenantId).in("id", ids);
        const nameMap = new Map((cQ.data || []).map((c) => [c.id, c.customer_name]));
        topCustomerIds.forEach((c) => { c.customer_name = nameMap.get(c.id) || null; });
      }
      return {
        by_status: Object.fromEntries(byStatus),
        top_customers_by_open_value: topCustomerIds,
        total_open_count: (r.data || []).length,
        source: "orders",
      };
    },
  },
};

// Default scope set for tools that didn't declare one.
const DEFAULT_SCOPE = "read.misc";

export const erpChatTools = (opts) => {
  const allowedScopes = opts?.scopes ? new Set(opts.scopes) : null;
  return Object.entries(TOOLS)
    .filter(([_n, t]) => !allowedScopes || allowedScopes.has(t.scope || DEFAULT_SCOPE))
    .map(([name, t]) => ({
      name,
      description: t.description,
      input_schema: t.parameters,
    }));
};

// All declared scopes; used by the MCP server token issuer + Admin UI.
export const erpChatScopes = () =>
  Array.from(new Set(Object.values(TOOLS).map((t) => t.scope || DEFAULT_SCOPE))).sort();

// Lookup helper: which scope does a tool need?
export const erpChatToolScope = (name) => TOOLS[name]?.scope || DEFAULT_SCOPE;

export const dispatchErpChatTool = async (tenantId, name, args, opts) => {
  const tool = TOOLS[name];
  if (!tool) return { error: "unknown tool: " + name };
  if (opts?.scopes) {
    const required = tool.scope || DEFAULT_SCOPE;
    const allowed = new Set(opts.scopes);
    if (!allowed.has(required)) {
      return { error: "scope not allowed: needs " + required };
    }
  }
  try {
    const svc = serviceClient();
    return await tool.run(svc, tenantId, args || {});
  } catch (err) {
    return { error: err.message || String(err) };
  }
};

export const erpChatToolNames = () => Object.keys(TOOLS);
