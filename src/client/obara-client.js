/* Obara Ops backend client.
 * Drop-in replacement for the in-browser localStorage shim.
 * Falls back to localStorage when no backend URL is configured. */

(function (global) {
  const CFG_KEY = "obara:backend_config";
  const SESSION_KEY = "obara:backend_session";

  const readConfig = () => {
    try { return JSON.parse(localStorage.getItem(CFG_KEY) || "{}"); }
    catch (_) { return {}; }
  };
  const writeConfig = (cfg) => localStorage.setItem(CFG_KEY, JSON.stringify(cfg || {}));
  const clearConfig = () => localStorage.removeItem(CFG_KEY);

  const readSession = () => {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); }
    catch (_) { return null; }
  };
  const writeSession = (session) => localStorage.setItem(SESSION_KEY, JSON.stringify(session || null));
  const clearSession = () => localStorage.removeItem(SESSION_KEY);

  const buildHeaders = (cfg, session, extra) => {
    const headers = Object.assign({}, extra || {});
    headers["Content-Type"] = "application/json";
    if (session && session.access_token) headers["Authorization"] = "Bearer " + session.access_token;
    if (cfg.tenantId) headers["x-obara-tenant"] = cfg.tenantId;
    return headers;
  };

  const handleResponse = async (resp) => {
    const text = await resp.text();
    let body = null;
    if (text) {
      try { body = JSON.parse(text); }
      catch (_) { body = { raw: text }; }
    }
    if (!resp.ok) {
      const message = (body && body.error && body.error.message) || ("HTTP " + resp.status);
      const err = new Error(message);
      err.status = resp.status;
      err.body = body;
      throw err;
    }
    return body || {};
  };

  const apiFetch = async (path, init) => {
    const cfg = readConfig();
    if (!cfg.url) throw new Error("Backend URL not configured");
    const session = readSession();
    const fullUrl = cfg.url.replace(/\/+$/, "") + path;
    const opts = init || {};
    const resp = await fetch(fullUrl, {
      method: opts.method || "GET",
      headers: buildHeaders(cfg, session, opts.headers),
      body: opts.body && typeof opts.body !== "string" ? JSON.stringify(opts.body) : opts.body,
    });
    return handleResponse(resp);
  };

  const isReady = () => {
    const cfg = readConfig();
    return !!(cfg.url && cfg.url.length);
  };

  const setConfig = (cfg) => {
    if (!cfg || !cfg.url) {
      clearConfig();
      clearSession();
      return;
    }
    writeConfig({ url: cfg.url, tenantId: cfg.tenantId || null, projectRef: cfg.projectRef || null });
  };

  const setSession = (session) => {
    if (!session) clearSession();
    else writeSession({ access_token: session.access_token, refresh_token: session.refresh_token, expires_at: session.expires_at });
  };

  const ping = async () => {
    return apiFetch("/api/audit?limit=1");
  };

  const claudeCall = async (payload) => apiFetch("/api/claude/messages", { method: "POST", body: payload });

  const documents = {
    upload: async (file, classification) => {
      const meta = await apiFetch("/api/documents/upload", {
        method: "POST",
        body: { filename: file.name, mime_type: file.type, size_bytes: file.size, classification: classification || null },
      });
      const upstream = await fetch(meta.uploadUrl, { method: "PUT", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
      if (!upstream.ok) throw new Error("Upload failed: " + upstream.status);
      return meta;
    },
    fetch: async (id) => apiFetch("/api/documents/" + id),
    remove: async (id) => apiFetch("/api/documents/" + id, { method: "DELETE" }),
  };

  const orders = {
    list: async (params) => {
      const qs = new URLSearchParams(params || {}).toString();
      return apiFetch("/api/orders" + (qs ? "?" + qs : ""));
    },
    create: async (order) => apiFetch("/api/orders", { method: "POST", body: order }),
    get: async (id) => apiFetch("/api/orders/" + id),
    update: async (id, patch) => apiFetch("/api/orders/" + id, { method: "PATCH", body: patch }),
    remove: async (id) => apiFetch("/api/orders/" + id, { method: "DELETE" }),
  };

  const customers = {
    list: async () => apiFetch("/api/customers"),
    upsert: async (payload) => apiFetch("/api/customers", { method: "POST", body: payload }),
  };

  const aliases = {
    list: async (params) => {
      const qs = new URLSearchParams(params || {}).toString();
      return apiFetch("/api/aliases" + (qs ? "?" + qs : ""));
    },
    upsert: async (payload) => apiFetch("/api/aliases", { method: "POST", body: payload }),
    remove: async (id) => apiFetch("/api/aliases?id=" + encodeURIComponent(id), { method: "DELETE" }),
  };

  const audit = {
    list: async (params) => {
      const qs = new URLSearchParams(params || {}).toString();
      return apiFetch("/api/audit" + (qs ? "?" + qs : ""));
    },
    record: async (payload) => apiFetch("/api/audit", { method: "POST", body: payload }),
  };


  const events = {
    list: async (caseId) => apiFetch("/api/events?case_id=" + encodeURIComponent(caseId)),
    record: async (payload) => apiFetch("/api/events", { method: "POST", body: payload }),
  };

  const findings = {
    save: async (orderId, items) => apiFetch("/api/findings", { method: "POST", body: { order_id: orderId, findings: items } }),
    resolve: async (id, resolved) => apiFetch("/api/findings", { method: "PATCH", body: { id, resolved } }),
  };

  const duplicates = {
    search: async (candidate, minScore) => apiFetch("/api/duplicates/search", { method: "POST", body: { candidate, minScore } }),
  };

  const anomaly = {
    compute: async (customerId, candidate) => apiFetch("/api/anomaly/compute", { method: "POST", body: { customerId, candidate } }),
  };

  const evalSuite = {
    run: async (suite, cases) => apiFetch("/api/eval/run", { method: "POST", body: { suite, cases } }),
  };

  const authMethods = {
    requestMagicLink: async (email, redirectTo) => apiFetch("/api/auth/magic_link", { method: "POST", body: { email, redirectTo } }),
    verifyToken: async (access_token) => apiFetch("/api/auth/verify", { method: "POST", body: { access_token } }),
  };

  const ocr = {
    run: async (documentId, orderId) => apiFetch("/api/documents/ocr", { method: "POST", body: { documentId, orderId } }),
  };

  const scan = {
    run: async (documentId, opts) => apiFetch("/api/documents/scan", { method: "POST", body: { documentId, ...opts } }),
  };

  const fx = {
    lookup: async (params) => {
      const qs = new URLSearchParams(params || {}).toString();
      return apiFetch("/api/fx/rates" + (qs ? "?" + qs : ""));
    },
    refresh: async (payload) => apiFetch("/api/fx/rates", { method: "POST", body: payload || {} }),
  };

  const delivery = {
    promise: async (payload) => apiFetch("/api/delivery/promise", { method: "POST", body: payload }),
  };

  const inventory = {
    availability: async (lineItems) => apiFetch("/api/inventory/availability", { method: "POST", body: { lineItems } }),
    sync: async (records, replace) => apiFetch("/api/inventory/sync", { method: "POST", body: { records, replace: !!replace } }),
  };

  const masterData = {
    graph: async (params) => {
      const qs = new URLSearchParams(params || {}).toString();
      return apiFetch("/api/master_data/graph" + (qs ? "?" + qs : ""));
    },
  };

  const bom = {
    list: async (params) => {
      const qs = new URLSearchParams(params || {}).toString();
      return apiFetch("/api/bom" + (qs ? "?" + qs : ""));
    },
    upsert: async (rows) => apiFetch("/api/bom", { method: "POST", body: Array.isArray(rows) ? { rows } : rows }),
    remove: async (id) => apiFetch("/api/bom?id=" + encodeURIComponent(id), { method: "DELETE" }),
  };

  const profileVersions = {
    list: async (customerId) => apiFetch("/api/customers/profile_versions?customerId=" + encodeURIComponent(customerId)),
    rollback: async (profileVersionId) => apiFetch("/api/customers/profile_versions", { method: "POST", body: { profileVersionId } }),
  };

  // Re-export Tally with the new push/reconcile/amend, replacing the prior shape.
  const tallyExt = {
    validate: async (payload) => apiFetch("/api/tally/validate", { method: "POST", body: payload }),
    listMasters: async (type) => apiFetch("/api/tally/masters" + (type ? "?type=" + encodeURIComponent(type) : "")),
    syncMasters: async (master_type, records, replace) => apiFetch("/api/tally/masters", { method: "POST", body: { master_type, records, replace: !!replace } }),
    push: async (payload) => apiFetch("/api/tally/push", { method: "POST", body: payload }),
    reconcile: async (payload) => apiFetch("/api/tally/reconcile", { method: "POST", body: payload }),
    amend: async (payload) => apiFetch("/api/tally/amend", { method: "POST", body: payload }),
  };

  const sourcePos = {
    list: async (params) => {
      const qs = new URLSearchParams(params || {}).toString();
      return apiFetch("/api/source_pos" + (qs ? "?" + qs : ""));
    },
    get: async (id) => apiFetch("/api/source_pos/" + encodeURIComponent(id)),
    update: async (id, patch) => apiFetch("/api/source_pos/" + encodeURIComponent(id), { method: "PATCH", body: patch }),
    ack: async (sourcePoId, ack) => apiFetch("/api/source_pos/ack", { method: "POST", body: { sourcePoId, ack } }),
    scorecard: async (params) => {
      const qs = new URLSearchParams(params || {}).toString();
      return apiFetch("/api/source_pos/scorecard" + (qs ? "?" + qs : ""));
    },
  };

  const communications = {
    draft: async (payload) => apiFetch("/api/communications/draft", { method: "POST", body: payload }),
    send: async (id) => apiFetch("/api/communications/send", { method: "POST", body: { id } }),
    missingDoc: async (orderId) => apiFetch("/api/communications/missing_doc", { method: "POST", body: { orderId } }),
  };

  const evalExt = {
    run: async (suite, cases) => apiFetch("/api/eval/run", { method: "POST", body: { suite, cases } }),
    dashboard: async (suite) => apiFetch("/api/eval/dashboard" + (suite ? "?suite=" + encodeURIComponent(suite) : "")),
    listCases: async (suite) => apiFetch("/api/eval/cases" + (suite ? "?suite=" + encodeURIComponent(suite) : "")),
    upsertCase: async (payload) => apiFetch("/api/eval/cases", { method: "POST", body: payload }),
    deleteCase: async (id) => apiFetch("/api/eval/cases?id=" + encodeURIComponent(id), { method: "DELETE" }),
  };

  const cost = {
    breakdown: async (params) => {
      const qs = new URLSearchParams(params || {}).toString();
      return apiFetch("/api/cost/breakdown" + (qs ? "?" + qs : ""));
    },
    simulator: async (payload) => apiFetch("/api/cost/simulator", { method: "POST", body: payload }),
    marginHistory: async (customer_id) => apiFetch("/api/cost/margin_history?customer_id=" + encodeURIComponent(customer_id)),
  };

  const salesHistory = {
    priceBand: async (params) => {
      const qs = new URLSearchParams(params || {}).toString();
      return apiFetch("/api/sales_history/price_band" + (qs ? "?" + qs : ""));
    },
  };

  const security = {
    listRedactions: async () => apiFetch("/api/security/redact"),
    upsertRedaction: async (payload) => apiFetch("/api/security/redact", { method: "POST", body: payload }),
    deleteRedaction: async (id) => apiFetch("/api/security/redact?id=" + encodeURIComponent(id), { method: "DELETE" }),
    runInjectionTest: async (payload) => apiFetch("/api/security/inject_test", { method: "POST", body: payload || {} }),
    routingLog: async (limit) => apiFetch("/api/claude/messages?routing=1" + (limit ? "&limit=" + limit : "")),
  };

  const spareMatrix = {
    recommend: async (payload) => apiFetch("/api/spare_matrix/recommend", { method: "POST", body: payload || {} }),
    kit: async (payload) => apiFetch("/api/spare_matrix/kit", { method: "POST", body: payload }),
    opportunities: async (customer_id) => apiFetch("/api/spare_matrix/opportunities?customer_id=" + encodeURIComponent(customer_id)),
    obsolete: async (months) => apiFetch("/api/spare_matrix/obsolete" + (months ? "?months=" + months : "")),
  };

  const sales = {
    listLeads: async (params) => apiFetch("/api/sales/leads" + (params ? "?" + new URLSearchParams(params).toString() : "")),
    createLead: async (payload) => apiFetch("/api/sales/leads", { method: "POST", body: payload }),
    updateLead: async (payload) => apiFetch("/api/sales/leads", { method: "PATCH", body: payload }),
    deleteLead: async (id) => apiFetch("/api/sales/leads?id=" + encodeURIComponent(id), { method: "DELETE" }),
    listOpportunities: async (params) => apiFetch("/api/sales/opportunities" + (params ? "?" + new URLSearchParams(params).toString() : "")),
    createOpportunity: async (payload) => apiFetch("/api/sales/opportunities", { method: "POST", body: payload }),
    updateOpportunity: async (payload) => apiFetch("/api/sales/opportunities", { method: "PATCH", body: payload }),
    deleteOpportunity: async (id) => apiFetch("/api/sales/opportunities?id=" + encodeURIComponent(id), { method: "DELETE" }),
    listInternalSos: async (params) => apiFetch("/api/sales/internal_so" + (params ? "?" + new URLSearchParams(params).toString() : "")),
    createInternalSo: async (payload) => apiFetch("/api/sales/internal_so", { method: "POST", body: payload }),
    updateInternalSo: async (payload) => apiFetch("/api/sales/internal_so", { method: "PATCH", body: payload }),
    deleteInternalSo: async (id) => apiFetch("/api/sales/internal_so?id=" + encodeURIComponent(id), { method: "DELETE" }),
    listShipments: async (params) => apiFetch("/api/sales/shipments" + (params ? "?" + new URLSearchParams(params).toString() : "")),
    createShipment: async (payload) => apiFetch("/api/sales/shipments", { method: "POST", body: payload }),
    updateShipment: async (payload) => apiFetch("/api/sales/shipments", { method: "PATCH", body: payload }),
    deleteShipment: async (id) => apiFetch("/api/sales/shipments?id=" + encodeURIComponent(id), { method: "DELETE" }),
    listProjects: async (params) => apiFetch("/api/sales/projects" + (params ? "?" + new URLSearchParams(params).toString() : "")),
    createProject: async (payload) => apiFetch("/api/sales/projects", { method: "POST", body: payload }),
    updateProject: async (payload) => apiFetch("/api/sales/projects", { method: "PATCH", body: payload }),
    deleteProject: async (id) => apiFetch("/api/sales/projects?id=" + encodeURIComponent(id), { method: "DELETE" }),
  };

  const service = {
    listVisits: async (params) => apiFetch("/api/service/visits" + (params ? "?" + new URLSearchParams(params).toString() : "")),
    createVisit: async (payload) => apiFetch("/api/service/visits", { method: "POST", body: payload }),
    updateVisit: async (payload) => apiFetch("/api/service/visits", { method: "PATCH", body: payload }),
    deleteVisit: async (id) => apiFetch("/api/service/visits?id=" + encodeURIComponent(id), { method: "DELETE" }),
    listCarReports: async (params) => apiFetch("/api/service/car_reports" + (params ? "?" + new URLSearchParams(params).toString() : "")),
    createCarReport: async (payload) => apiFetch("/api/service/car_reports", { method: "POST", body: payload }),
    updateCarReport: async (payload) => apiFetch("/api/service/car_reports", { method: "PATCH", body: payload }),
  };

  const admin = {
    listHolidays: async (params) => {
      const qs = new URLSearchParams(params || {}).toString();
      return apiFetch("/api/admin/holidays" + (qs ? "?" + qs : ""));
    },
    upsertHoliday: async (payload) => apiFetch("/api/admin/holidays", { method: "POST", body: payload }),
    deleteHoliday: async (id) => apiFetch("/api/admin/holidays?id=" + encodeURIComponent(id), { method: "DELETE" }),
    listLeadTimes: async (type) => apiFetch("/api/admin/lead_times?type=" + encodeURIComponent(type || "supplier")),
    upsertLeadTime: async (type, payload) => apiFetch("/api/admin/lead_times?type=" + encodeURIComponent(type), { method: "POST", body: payload }),
    deleteLeadTime: async (type, id) => apiFetch("/api/admin/lead_times?type=" + encodeURIComponent(type) + "&id=" + encodeURIComponent(id), { method: "DELETE" }),
    listMembers: async () => apiFetch("/api/admin/members"),
    inviteMember: async (payload) => apiFetch("/api/admin/members", { method: "POST", body: payload }),
    updateMemberRole: async (payload) => apiFetch("/api/admin/members", { method: "PATCH", body: payload }),
    revokeMember: async (userId) => apiFetch("/api/admin/members?user_id=" + encodeURIComponent(userId), { method: "DELETE" }),
    listInventory: async (params) => {
      const qs = new URLSearchParams(params || {}).toString();
      return apiFetch("/api/admin/inventory" + (qs ? "?" + qs : ""));
    },
    upsertInventory: async (payload) => apiFetch("/api/admin/inventory", { method: "POST", body: payload }),
    deleteInventory: async (id) => apiFetch("/api/admin/inventory?id=" + encodeURIComponent(id), { method: "DELETE" }),
    listFxRates: async (params) => {
      const qs = new URLSearchParams(params || {}).toString();
      return apiFetch("/api/admin/fx_rates" + (qs ? "?" + qs : ""));
    },
    refreshFxRates: async (payload) => apiFetch("/api/admin/fx_rates", { method: "POST", body: payload || {} }),
    listContracts: async (params) => apiFetch("/api/admin/contracts" + (params ? "?" + new URLSearchParams(params).toString() : "")),
    upsertContract: async (payload) => apiFetch("/api/admin/contracts", { method: "POST", body: payload }),
    deleteContract: async (id) => apiFetch("/api/admin/contracts?id=" + encodeURIComponent(id), { method: "DELETE" }),
    listItemMaster: async (params) => apiFetch("/api/admin/item_master" + (params ? "?" + new URLSearchParams(params).toString() : "")),
    upsertItemMaster: async (payload) => apiFetch("/api/admin/item_master", { method: "POST", body: payload }),
    bulkItemMaster: async (rows) => apiFetch("/api/admin/item_master", { method: "POST", body: { rows } }),
    deleteItemMaster: async (id) => apiFetch("/api/admin/item_master?id=" + encodeURIComponent(id), { method: "DELETE" }),
    listCustomerLocations: async (customer_id) => apiFetch("/api/admin/customer_locations" + (customer_id ? "?customer_id=" + encodeURIComponent(customer_id) : "")),
    upsertCustomerLocation: async (payload) => apiFetch("/api/admin/customer_locations", { method: "POST", body: payload }),
    deleteCustomerLocation: async (id) => apiFetch("/api/admin/customer_locations?id=" + encodeURIComponent(id), { method: "DELETE" }),
    listEquipment: async (params) => apiFetch("/api/admin/equipment" + (params ? "?" + new URLSearchParams(params).toString() : "")),
    upsertEquipment: async (payload) => apiFetch("/api/admin/equipment", { method: "POST", body: payload }),
    deleteEquipment: async (id) => apiFetch("/api/admin/equipment?id=" + encodeURIComponent(id), { method: "DELETE" }),
    listLostReasons: async () => apiFetch("/api/admin/lost_reasons"),
    upsertLostReason: async (payload) => apiFetch("/api/admin/lost_reasons", { method: "POST", body: payload }),
    deleteLostReason: async (id) => apiFetch("/api/admin/lost_reasons?id=" + encodeURIComponent(id), { method: "DELETE" }),
    listApprovalThresholds: async () => apiFetch("/api/admin/quote_approvals?type=thresholds"),
    upsertApprovalThreshold: async (payload) => apiFetch("/api/admin/quote_approvals?type=thresholds", { method: "POST", body: payload }),
    deleteApprovalThreshold: async (id) => apiFetch("/api/admin/quote_approvals?type=thresholds&id=" + encodeURIComponent(id), { method: "DELETE" }),
    listApprovalRequests: async (order_id) => apiFetch("/api/admin/quote_approvals?type=approvals" + (order_id ? "&order_id=" + encodeURIComponent(order_id) : "")),
    decideApprovalRequest: async (payload) => apiFetch("/api/admin/quote_approvals?type=approvals", { method: "POST", body: payload }),
  };

  const email = {
    /* Provider configuration is documented in backend/README.md.
       This client method is for replaying captured emails into the same intake pipeline,
       useful for testing and migration. */
    submit: async (envelope) => apiFetch("/api/email/inbound", { method: "POST", body: envelope }),
  };

  /* The legacy SO agent uses window.storage.{get,set,delete,list}.
     When backend mode is enabled, we proxy specific keys to the relevant API. */

  const KEY_TO_RESOURCE = {
    "so_agent:orders": "orders",
    "so_agent:customer_formats": "customer_formats",
    "so_agent:result_cache": "extraction_cache",
    "so_agent:audit_log": "audit",
    "so_agent:customer_budgets": "budgets",
    "so_agent:learned_rules": "learned_rules",
  };

  const localStorageStorage = {
    get: async (k) => {
      const v = localStorage.getItem(k);
      return v ? { key: k, value: v } : null;
    },
    set: async (k, v) => {
      localStorage.setItem(k, v);
      return { key: k, value: v };
    },
    delete: async (k) => {
      localStorage.removeItem(k);
      return { key: k, deleted: true };
    },
    list: async (prefix) => ({
      keys: Object.keys(localStorage).filter((k) => !prefix || k.startsWith(prefix)),
    }),
  };

  const buildHybridStorage = () => {
    const local = localStorageStorage;
    return {
      get: async (k) => {
        if (!isReady()) return local.get(k);
        const resource = KEY_TO_RESOURCE[k];
        if (!resource) return local.get(k);
        try {
          if (resource === "orders") {
            const { orders } = await api.orders.list({ limit: 200 });
            return { key: k, value: JSON.stringify(orders || []) };
          }
          if (resource === "customer_formats") {
            const { customers, profiles } = await api.customers.list();
            const map = {};
            (customers || []).forEach((c) => {
              const profile = profiles && profiles[c.id];
              map[c.customer_key] = {
                customerKey: c.customer_key,
                customerName: c.customer_name,
                customerGSTIN: c.gstin || "",
                firstSeen: c.created_at,
                lastUpdated: c.updated_at,
                ordersProcessed: profile ? profile.orders_processed : 0,
                lastFormatChanged: profile ? profile.last_format_changed : false,
                formatChangeSummary: profile ? profile.format_change_summary : "",
                fingerprint: profile ? profile.fingerprint : {},
                trusted: profile ? profile.trusted : false,
                learnedRules: profile ? profile.learned_rules : {},
              };
            });
            return { key: k, value: JSON.stringify(map) };
          }
          if (resource === "audit") {
            const { events } = await api.audit.list({ limit: 200 });
            const mapped = (events || []).map((e) => ({ at: e.created_at, action: e.action, detail: e.detail || "", refId: e.object_id }));
            return { key: k, value: JSON.stringify(mapped) };
          }
        } catch (err) {
          if (typeof console !== "undefined") console.warn("[obara-client] backend get failed for " + k + ":", err.message);
        }
        return local.get(k);
      },
      set: async (k, v) => {
        if (!isReady()) return local.set(k, v);
        const resource = KEY_TO_RESOURCE[k];
        if (!resource) return local.set(k, v);
        try {
          if (resource === "audit") {
            const log = JSON.parse(v || "[]");
            const latest = (log[0] && log[0].at) || null;
            const knownLatest = await local.get(k + ":last_at");
            if (!latest || (knownLatest && knownLatest.value === latest)) return local.set(k, v);
            const newest = log.filter((entry) => !knownLatest || entry.at > knownLatest.value).slice(0, 100);
            for (const entry of newest) {
              await api.audit.record({ action: entry.action, objectType: "user_action", objectId: entry.refId || null, detail: entry.detail || "" });
            }
            await local.set(k + ":last_at", latest);
            return local.set(k, v);
          }
          if (resource === "orders") {
            const orders = JSON.parse(v || "[]");
            const latest = orders[0];
            if (!latest || !latest.id) return local.set(k, v);
            const known = await local.get(k + ":synced");
            const synced = known && known.value ? JSON.parse(known.value) : {};
            if (!synced[latest.id]) {
              try {
                await api.orders.create({
                  status: latest.status,
                  po_number: latest.preflightPONumber,
                  doc_fingerprint: latest.docFingerprint,
                  result: latest.result,
                  api_usage: latest.apiUsage || {},
                  cost_policy_snapshot: latest.costPolicySnapshot || {},
                  token_estimate: latest.tokenEstimate || {},
                  rule_findings: latest.ruleFindings || [],
                  anomaly_flags: latest.anomalyFlags || [],
                  evidence_by_field: latest.evidenceByField || {},
                  line_edits: latest.lineEdits || [],
                  approval: latest.approval || null,
                  payload_hash: (latest.approval && latest.approval.payloadHash) || null,
                  blocker_summary: latest.blockerSummary || null,
                  format_change_summary: latest.formatChangeSummary || null,
                  cost_avoided_reason: latest.costAvoidedReason || null,
                });
                synced[latest.id] = new Date().toISOString();
                await local.set(k + ":synced", JSON.stringify(synced));
              } catch (err) {
                if (typeof console !== "undefined") console.warn("[obara-client] order push failed:", err.message);
              }
            }
            return local.set(k, v);
          }
        } catch (err) {
          if (typeof console !== "undefined") console.warn("[obara-client] backend set failed for " + k + ":", err.message);
        }
        return local.set(k, v);
      },
      delete: async (k) => local.delete(k),
      list: async (prefix) => local.list(prefix),
    };
  };

  const api = {
    isReady,
    setConfig,
    getConfig: readConfig,
    setSession,
    getSession: readSession,
    ping,
    claudeCall,
    documents,
    orders,
    customers,
    aliases,
    audit,
    tally: tallyExt,
    events,
    findings,
    duplicates,
    anomaly,
    eval: evalExt,
    email,
    auth: authMethods,
    ocr,
    scan,
    fx,
    delivery,
    inventory,
    masterData,
    bom,
    profileVersions,
    sourcePos,
    communications,
    cost,
    salesHistory,
    security,
    spareMatrix,
    admin,
    sales,
    service,
  };

  global.ObaraBackend = api;
  global.storage = buildHybridStorage();
})(typeof window !== "undefined" ? window : globalThis);
