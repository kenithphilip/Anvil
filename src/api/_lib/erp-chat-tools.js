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
import { createProposal } from "./action-proposals.js";
import { validateGstin, gstinStateCode } from "./gstin.js";
import { searchItemsHybrid } from "./hybrid-item-search.js";

const limit = (n) => Math.max(1, Math.min(50, Number(n || 25)));

// The orders table stores SO totals + currency inside the `result`
// JSONB (result.salesOrder.grandTotal / .currency), NOT as top-level
// columns — selecting `total_value` / `currency` / `tally_status`
// directly throws "column orders.currency does not exist". The Tally
// lifecycle is encoded in `status` (…_TALLY / RECONCILED), so there is
// no separate tally_status column either. Select `result` and flatten
// to the shape the chat / MCP consumers expect.
const TALLY_STATUSES = new Set(["EXPORTED_TO_TALLY", "FAILED_TALLY_IMPORT", "RECONCILED"]);
const mapOrderRow = (o) => {
  const so = (o && o.result && o.result.salesOrder) || {};
  return {
    id: o.id,
    quote_number: o.quote_number,
    po_number: o.po_number,
    status: o.status,
    tally_status: TALLY_STATUSES.has(o.status) ? o.status : null,
    total_value: so.grandTotal != null ? so.grandTotal : null,
    currency: so.currency != null ? so.currency : null,
    customer_id: o.customer_id,
    created_at: o.created_at,
  };
};

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
      let q = svc.from("orders").select("id, quote_number, po_number, status, result, customer_id, created_at");
      q = q.eq("tenant_id", tenantId);
      if (args?.status) q = q.eq("status", args.status);
      if (args?.query) {
        q = q.or(`quote_number.ilike.%${args.query}%,po_number.ilike.%${args.query}%`);
      }
      const r = await q.order("created_at", { ascending: false }).limit(limit(args?.limit));
      return { rows: (r.data || []).map(mapOrderRow), source: "orders" };
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

  // KB-assistant tools (Phase 4.7 — Avent/Axal parity).

  customer_history: {
    scope: "read.customers",
    description: "Pull a customer's order + invoice history for the last 12 months. Used for 'what's Acme's recent activity' questions.",
    parameters: {
      type: "object",
      properties: {
        customer_id_or_name: { type: "string", description: "uuid or name fragment" },
        months: { type: "integer", default: 12 },
      },
      required: ["customer_id_or_name"],
    },
    run: async (svc, tenantId, args) => {
      const months = Math.max(1, Math.min(36, Number(args?.months || 12)));
      const since = new Date(Date.now() - months * 30 * 86400_000).toISOString();
      // Resolve to a customer id.
      let customerId = String(args?.customer_id_or_name || "").trim();
      if (!/^[0-9a-f]{8}-/i.test(customerId)) {
        const c = await svc.from("customers").select("id").eq("tenant_id", tenantId)
          .ilike("customer_name", "%" + customerId + "%").limit(1).maybeSingle();
        customerId = c.data?.id || null;
      }
      if (!customerId) return { error: "customer not found" };
      const [orders, invoices] = await Promise.all([
        svc.from("orders").select("id, quote_number, po_number, status, result, customer_id, created_at")
          .eq("tenant_id", tenantId).eq("customer_id", customerId)
          .gte("created_at", since).order("created_at", { ascending: false }).limit(50),
        svc.from("invoices").select("id, invoice_number, issue_date, grand_total, paid_amount, status, currency")
          .eq("tenant_id", tenantId).eq("customer_id", customerId)
          .gte("issue_date", since.slice(0, 10)).order("issue_date", { ascending: false }).limit(50),
      ]);
      return {
        customer_id: customerId,
        orders: (orders.data || []).map(mapOrderRow),
        invoices: invoices.data || [],
        source: "customers+orders+invoices",
      };
    },
  },

  last_purchase_price: {
    scope: "read.orders",
    description: "Find a customer's last purchase price for a given SKU. Used by inside-sales reps quoting a repeat customer.",
    parameters: {
      type: "object",
      properties: {
        customer_id_or_name: { type: "string" },
        part_number: { type: "string" },
      },
      required: ["customer_id_or_name", "part_number"],
    },
    run: async (svc, tenantId, args) => {
      let customerId = String(args?.customer_id_or_name || "").trim();
      if (!/^[0-9a-f]{8}-/i.test(customerId)) {
        const c = await svc.from("customers").select("id").eq("tenant_id", tenantId)
          .ilike("customer_name", "%" + customerId + "%").limit(1).maybeSingle();
        customerId = c.data?.id || null;
      }
      if (!customerId) return { error: "customer not found" };
      const r = await svc.from("orders")
        .select("id, po_number, created_at, result")
        .eq("tenant_id", tenantId).eq("customer_id", customerId)
        .order("created_at", { ascending: false }).limit(50);
      const part = String(args.part_number).toLowerCase();
      for (const o of r.data || []) {
        const lines = o.result?.salesOrder?.lineItems || [];
        for (const li of lines) {
          if (String(li.partNumber || li.itemName || "").toLowerCase() === part) {
            return {
              part_number: li.partNumber || li.itemName,
              unit_price: Number(li.rate || li.unitPrice || 0),
              quantity: Number(li.quantity || li.qty || 0),
              order_id: o.id,
              po_number: o.po_number,
              ordered_at: o.created_at,
              source: "orders",
            };
          }
        }
      }
      return { rows: [], source: "orders", note: "no match" };
    },
  },

  catalog_lookup: {
    scope: "read.misc",
    description: "Look up an item from the catalog with synonyms, alternatives, and any private-label upsell. Same engine as /api/catalog/search.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    run: async (svc, tenantId, args) => {
      const q = String(args?.query || "").trim();
      if (!q) return { error: "query required" };
      const term = "%" + q.replace(/[%_]/g, "") + "%";
      const items = await svc.from("item_master")
        .select("id, part_no, description, list_price")
        .eq("tenant_id", tenantId)
        .or(`part_no.ilike.${term},description.ilike.${term}`)
        .limit(10);
      const synonyms = await svc.from("catalog_synonyms")
        .select("item_id, synonym, confidence")
        .eq("tenant_id", tenantId).ilike("synonym", term).limit(10);
      const synIds = (synonyms.data || []).map((s) => s.item_id);
      let synItems = [];
      if (synIds.length) {
        const r = await svc.from("item_master").select("id, part_no, description, list_price")
          .eq("tenant_id", tenantId).in("id", synIds);
        synItems = r.data || [];
      }
      return {
        items: items.data || [],
        synonym_matches: synItems,
        source: "item_master+catalog_synonyms",
      };
    },
  },

  // ── Grounding / verification tools (SO processing). Read-only; each wraps
  // Anvil data + logic that already exists so the operator copilot (or a
  // scoped MCP agent) can verify a customer or resolve a line against the
  // catalog on demand — the same signals the deterministic extraction
  // grounding pass uses. See docs/ANVIL_MCP_SO_TOOLS_DESIGN.md.
  verify_customer_gstin: {
    scope: "read.customers",
    description: "Validate a GSTIN (format + Mod-36 checksum) and resolve it to a known customer in this tenant's registry. Returns the match, the GSTIN-derived state code, and a verdict: known_customer / valid_unknown / invalid.",
    parameters: { type: "object", properties: { gstin: { type: "string", description: "15-character GSTIN" } }, required: ["gstin"] },
    run: async (svc, tenantId, args) => {
      const v = validateGstin(String(args?.gstin || "").trim());
      if (!v.ok) return { valid: false, verdict: "invalid", reason: v.code || "invalid", message: v.message || null, source: "gstin" };
      const r = await svc.from("customers")
        .select("id, customer_name, state_code")
        .eq("tenant_id", tenantId).eq("gstin", v.normalized).limit(1).maybeSingle();
      const matched = r.error ? null : (r.data || null);
      return {
        valid: true,
        normalized: v.normalized,
        state_code: gstinStateCode(v.normalized),
        matched: matched ? { id: matched.id, customer_name: matched.customer_name } : null,
        verdict: matched ? "known_customer" : "valid_unknown",
        source: "gstin+customers",
      };
    },
  },

  resolve_item: {
    scope: "read.inventory",
    description: "Resolve a PO line (part number or free-text description) to ranked item_master candidates using hybrid lexical + semantic search. Use for reconciliation when the literal ilike catalog_lookup misses. Returns candidates with scores.",
    parameters: { type: "object", properties: { query: { type: "string", description: "part_no or line description" }, limit: { type: "integer", default: 10 } }, required: ["query"] },
    run: async (svc, tenantId, args) => {
      const q = String(args?.query || "").trim();
      if (!q) return { error: "query required" };
      const rows = await searchItemsHybrid(svc, { tenantId, queryText: q, matchCount: limit(args?.limit) });
      return { rows: rows || [], source: "item_master_hybrid" };
    },
  },

  lookup_customer_parts: {
    scope: "read.customers",
    description: "List a customer's known part aliases (item_customer_parts): their customer_part_number mapped to the canonical item_master part_no. Grounds line matching for repeat customers.",
    parameters: { type: "object", properties: { customer_id: { type: "string" }, query: { type: "string", description: "optional filter on customer_part_number" }, limit: { type: "integer", default: 25 } }, required: ["customer_id"] },
    run: async (svc, tenantId, args) => {
      const customerId = String(args?.customer_id || "").trim();
      if (!customerId) return { error: "customer_id required" };
      let q = svc.from("item_customer_parts")
        .select("customer_part_number, customer_part_description, item_id, is_primary")
        .eq("tenant_id", tenantId).eq("customer_id", customerId);
      if (args?.query) q = q.ilike("customer_part_number", `%${args.query}%`);
      const r = await q.limit(limit(args?.limit));
      const rows = r.data || [];
      const ids = [...new Set(rows.map((x) => x.item_id).filter(Boolean))];
      let byId = new Map();
      if (ids.length) {
        const im = await svc.from("item_master").select("id, part_no").eq("tenant_id", tenantId).in("id", ids);
        byId = new Map((im.data || []).map((x) => [x.id, x.part_no]));
      }
      return {
        rows: rows.map((x) => ({
          customer_part_number: x.customer_part_number,
          customer_part_description: x.customer_part_description,
          canonical_part_no: byId.get(x.item_id) || null,
          item_id: x.item_id,
          is_primary: x.is_primary,
        })),
        source: "item_customer_parts",
      };
    },
  },

  // ── write.* tools (PR2): propose-only. They NEVER execute on first
  // call - they create an action_proposals row and return a preview +
  // single-use confirm_token. A human confirms via POST /api/copilot/
  // confirm (approve-gated) to actually run the action. MCP tokens must
  // hold the write.* scope to call these (default-deny); internal chat
  // allows proposing under `read` (execution is still approve-gated).
  create_lead: {
    scope: "write.leads",
    description: "Propose creating a new sales lead. Does NOT create it - returns a preview and a confirm_token; a human must confirm in the app to actually create the lead.",
    parameters: {
      type: "object",
      properties: {
        company_name: { type: "string" },
        contact_name: { type: "string" },
        contact_email: { type: "string" },
        contact_phone: { type: "string" },
        product_interest: { type: "string" },
        region: { type: "string" },
        lead_source: { type: "string" },
        notes: { type: "string" },
      },
      required: ["company_name"],
    },
    run: async (svc, tenantId, args, ctx2) => {
      if (!args || !args.company_name) return { error: "company_name required" };
      const preview = {
        action: "create_lead",
        company_name: args.company_name,
        contact_name: args.contact_name || null,
        contact_email: args.contact_email || null,
        product_interest: args.product_interest || null,
      };
      const p = await createProposal(svc, { tenantId, userId: ctx2?.userId, action: "create_lead", args, preview });
      return { proposed: true, action: "create_lead", preview, confirm_token: p.confirm_token, expires_at: p.expires_at, note: "No lead created yet. Confirm in the app to execute." };
    },
  },
  draft_and_send_comms: {
    scope: "write.comms",
    description: "Propose drafting and sending a customer message (email/whatsapp/slack/teams). Does NOT send - returns the drafted message preview and a confirm_token; a human must confirm in the app to send.",
    parameters: {
      type: "object",
      properties: {
        channel: { type: "string", description: "email | whatsapp | slack | teams", default: "email" },
        to_addr: { type: "string" },
        subject: { type: "string" },
        body: { type: "string" },
        order_id: { type: "string" },
        from_addr: { type: "string" },
      },
      required: ["to_addr", "body"],
    },
    run: async (svc, tenantId, args, ctx2) => {
      if (!args || !args.to_addr || !args.body) return { error: "to_addr and body required" };
      const preview = {
        action: "draft_and_send_comms",
        channel: args.channel || "email",
        to_addr: args.to_addr,
        subject: args.subject || null,
        body: args.body,
      };
      const p = await createProposal(svc, { tenantId, userId: ctx2?.userId, action: "draft_and_send_comms", args, preview });
      return { proposed: true, action: "draft_and_send_comms", preview, confirm_token: p.confirm_token, expires_at: p.expires_at, note: "Nothing sent yet. Confirm in the app to send." };
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

// Read-only scopes; the default grant for a new MCP token. write.*
// scopes are opt-in (default-deny) so a copilot token cannot take
// actions unless explicitly issued with the matching write scope.
export const erpChatReadScopes = () => erpChatScopes().filter((s) => s.startsWith("read."));

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
    // 4th arg carries the actor so write/propose tools bind the proposal
    // to the proposing user. Read tools ignore it.
    return await tool.run(svc, tenantId, args || {}, { userId: opts?.userId });
  } catch (err) {
    return { error: err.message || String(err) };
  }
};

export const erpChatToolNames = () => Object.keys(TOOLS);
