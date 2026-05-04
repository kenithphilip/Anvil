/* Anvil backend client.
 * Drop-in replacement for the in-browser localStorage shim.
 * Falls back to localStorage when no backend URL is configured.
 *
 * Storage migration: every persisted key was prefixed `obara:` before
 * the rebrand. We now write `anvil:` and read both, preferring the
 * newer name. The legacy keys are migrated lazily on first read so a
 * user with the old session does not get bounced out when this code
 * ships.
 */

(function (global) {
  const NEW_PREFIX = "anvil:";
  const OLD_PREFIX = "obara:";

  // Read a key under the new prefix, falling back to the legacy
  // prefix and migrating the value over so subsequent reads are fast.
  const lsGet = (suffix) => {
    try {
      const fresh = localStorage.getItem(NEW_PREFIX + suffix);
      if (fresh != null) return fresh;
      const legacy = localStorage.getItem(OLD_PREFIX + suffix);
      if (legacy != null) {
        try { localStorage.setItem(NEW_PREFIX + suffix, legacy); } catch (_) {}
        return legacy;
      }
      return null;
    } catch (_) { return null; }
  };
  // Keys that screens still read directly under the legacy prefix.
  // Until those 48 inline `localStorage.getItem("obara:backend_config")`
  // sites are refactored, we keep dual-writing so they don't break.
  const DUAL_WRITE_SUFFIXES = new Set(["backend_config", "backend_session"]);
  const lsSet = (suffix, value) => {
    try { localStorage.setItem(NEW_PREFIX + suffix, value); } catch (_) {}
    if (DUAL_WRITE_SUFFIXES.has(suffix)) {
      // Mirror the value under the legacy prefix so screens that
      // bypass the client and read directly keep getting fresh data.
      try { localStorage.setItem(OLD_PREFIX + suffix, value); } catch (_) {}
    } else {
      // For keys nobody reads cross-bundle, drop the legacy duplicate
      // so localStorage stays tidy.
      try { localStorage.removeItem(OLD_PREFIX + suffix); } catch (_) {}
    }
  };
  const lsRemove = (suffix) => {
    try { localStorage.removeItem(NEW_PREFIX + suffix); } catch (_) {}
    try { localStorage.removeItem(OLD_PREFIX + suffix); } catch (_) {}
  };

  const CFG_KEY = "backend_config";
  const SESSION_KEY = "backend_session";

  const readConfig = () => {
    try { return JSON.parse(lsGet(CFG_KEY) || "{}"); }
    catch (_) { return {}; }
  };
  const writeConfig = (cfg) => lsSet(CFG_KEY, JSON.stringify(cfg || {}));
  const clearConfig = () => lsRemove(CFG_KEY);

  const readSession = () => {
    try { return JSON.parse(lsGet(SESSION_KEY) || "null"); }
    catch (_) { return null; }
  };
  const writeSession = (session) => lsSet(SESSION_KEY, JSON.stringify(session || null));
  const clearSession = () => lsRemove(SESSION_KEY);

  const buildHeaders = (cfg, session, extra) => {
    const headers = Object.assign({}, extra || {});
    headers["Content-Type"] = "application/json";
    if (session && session.access_token) headers["Authorization"] = "Bearer " + session.access_token;
    // The legacy header name is preserved server-side; renaming it
    // would break every call from a deployed client mid-rebrand.
    // We keep `x-obara-tenant` as the wire-level header name.
    if (cfg.tenantId) headers["x-obara-tenant"] = cfg.tenantId;
    return headers;
  };

  // Once-per-session warnings for auth failures. Without these, every
  // screen just shows "Failed to load <thing>" and the user can't tell
  // whether the data is empty or the backend is locking them out. The
  // dedupe matters because a single page render fires 4-6 parallel API
  // calls; without it the user gets a stack of identical "Session
  // expired" toasts.
  let warnedNoTenant = false;
  let warnedExpired = false;
  const surfaceAuthError = (status, message) => {
    const notify = (typeof global !== "undefined" && global.notifyError) || null;
    if (status === 403 && /tenant membership/i.test(message || "")) {
      if (warnedNoTenant || !notify) return;
      warnedNoTenant = true;
      notify(
        "Account not onboarded",
        "Your sign-in succeeded but no tenant is attached to your user. Sign out and back in, or have an admin invite you via the Admin Center."
      );
    } else if (status === 401) {
      // Stop sending the dead token. Every subsequent request would
      // otherwise re-fire 401 and re-trigger this toast. We clear the
      // session so the anonymous fallback (ALLOW_ANONYMOUS_TENANT) at
      // least lets read-only screens render.
      clearSession();
      // Bounce to the connect screen so the user can sign back in. We
      // do not redirect if the user is already on connect, otherwise
      // the route reload causes a refresh loop.
      if (typeof global !== "undefined" && global.location) {
        const here = String(global.location.hash || "").replace(/^#\/?/, "").split("?")[0];
        if (here !== "connect") {
          // Remember where they were so the post-sign-in flow can
          // bring them back.
          try {
            global.localStorage?.setItem("anvil:v3_intended_route", global.location.hash || "");
          } catch (_) { /* localStorage may be blocked */ }
          global.location.hash = "#/connect";
        }
      }
      if (warnedExpired || !notify) return;
      warnedExpired = true;
      notify("Session expired", "Sign in again to continue. Your last action was not saved.");
    }
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
      surfaceAuthError(resp.status, message);
      const err = new Error(message);
      err.status = resp.status;
      err.body = body;
      throw err;
    }
    return body || {};
  };

  // Compare the session's expires_at (Supabase stores it as Unix
  // seconds) to the current clock. We shave 30s off so a token that
  // expires mid-request still gets dropped before we send. Tokens
  // without an expires_at are considered live; the server will tell
  // us if they are not.
  const isSessionExpired = (session) => {
    if (!session || !session.expires_at) return false;
    const exp = Number(session.expires_at);
    if (!Number.isFinite(exp)) return false;
    return Date.now() / 1000 > (exp - 30);
  };

  const apiFetch = async (path, init) => {
    const cfg = readConfig();
    if (!cfg.url) throw new Error("Backend URL not configured");
    let session = readSession();
    // Drop locally-expired sessions before sending. This prevents the
    // 401-toast cascade: with a stale token in localStorage, every
    // parallel call from a screen render would round-trip to Supabase
    // and bounce off as 401, each one re-firing the toast.
    if (session && isSessionExpired(session)) {
      surfaceAuthError(401, "Session expired locally");
      session = null;
    }
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
    // Reset the auth-warning dedupe so a freshly signed-in user can be
    // warned again the NEXT time their token expires.
    warnedNoTenant = false;
    warnedExpired = false;
    if (!session) { clearSession(); return; }
    // Preserve user info when present so the shell can render the real
    // identity (email, display name) without an extra /api/auth/profile
    // round trip. The previous implementation stripped session.user
    // and the sidebar rendered "Guest" for every signed-in session.
    writeSession({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_at: session.expires_at,
      user: session.user || null,
    });
  };

  const ping = async () => {
    return apiFetch("/api/audit?limit=1");
  };

  const health = async () => apiFetch("/api/health");

  const billing = {
    usage: async (params) => {
      const qs = new URLSearchParams(params || {}).toString();
      return apiFetch("/api/billing/usage" + (qs ? "?" + qs : ""));
    },
    stripe: {
      onboard: async (payload) => apiFetch("/api/billing/stripe/connect_onboard", { method: "POST", body: payload || {} }),
      status:  async () => apiFetch("/api/billing/stripe/connect_status"),
      checkout: async (payload) => apiFetch("/api/billing/stripe/checkout", { method: "POST", body: payload }),
    },
  };

  // Quote PDF helpers. `pdf(orderId)` resolves the binary URL the
  // browser can navigate to (auth header is on apiFetch's contract,
  // so for direct browser navigation we expose a download blob via
  // pdfBlob instead). `share(orderId)` requests a 7-day signed URL
  // that can be sent to a customer.
  const invoices = {
    list: async (params) => {
      const qs = new URLSearchParams(params || {}).toString();
      return apiFetch("/api/invoices" + (qs ? "?" + qs : ""));
    },
    create: async (payload) => apiFetch("/api/invoices", { method: "POST", body: payload }),
    get: async (id) => apiFetch("/api/invoices/" + encodeURIComponent(id)),
    update: async (id, patch) => apiFetch("/api/invoices/" + encodeURIComponent(id), { method: "PATCH", body: patch }),
    void: async (id) => apiFetch("/api/invoices/" + encodeURIComponent(id), { method: "DELETE" }),
    send: async (payload) => apiFetch("/api/invoices/send", { method: "POST", body: payload }),
    pdfBlob: async (id) => {
      const cfg = readConfig();
      if (!cfg.url) throw new Error("Backend URL not configured");
      const session = readSession();
      const url = cfg.url.replace(/\/+$/, "") + "/api/invoices/pdf?id=" + encodeURIComponent(id);
      const headers = {};
      if (session?.access_token) headers["Authorization"] = "Bearer " + session.access_token;
      if (cfg.tenantId) headers["x-obara-tenant"] = cfg.tenantId;
      const resp = await fetch(url, { headers });
      if (!resp.ok) throw new Error("PDF " + resp.status);
      return await resp.blob();
    },
    share: async (id) => apiFetch("/api/invoices/pdf?id=" + encodeURIComponent(id) + "&format=share"),
  };

  const quotes = {
    pdfUrl: (orderId) => {
      const cfg = readConfig();
      const base = (cfg.url || "").replace(/\/+$/, "");
      return base + "/api/quotes/pdf?orderId=" + encodeURIComponent(orderId);
    },
    pdfBlob: async (orderId) => {
      const cfg = readConfig();
      if (!cfg.url) throw new Error("Backend URL not configured");
      const session = readSession();
      const url = cfg.url.replace(/\/+$/, "") + "/api/quotes/pdf?orderId=" + encodeURIComponent(orderId);
      const headers = {};
      if (session?.access_token) headers["Authorization"] = "Bearer " + session.access_token;
      if (cfg.tenantId) headers["x-obara-tenant"] = cfg.tenantId;
      const resp = await fetch(url, { headers });
      if (!resp.ok) throw new Error("PDF " + resp.status);
      return await resp.blob();
    },
    share: async (orderId) => apiFetch("/api/quotes/pdf?orderId=" + encodeURIComponent(orderId) + "&format=share"),
  };

  const agents = {
    listGoals: async (params) => {
      const qs = new URLSearchParams(params || {}).toString();
      return apiFetch("/api/agents/goals" + (qs ? "?" + qs : ""));
    },
    armGoal: async (payload) => apiFetch("/api/agents/goals", { method: "POST", body: payload }),
    updateGoal: async (payload) => apiFetch("/api/agents/goals", { method: "PATCH", body: payload }),
    cancelGoal: async (id) => apiFetch("/api/agents/goals?id=" + encodeURIComponent(id), { method: "DELETE" }),
  };

  const whatsapp = {
    send: async (payload) => apiFetch("/api/whatsapp/send", { method: "POST", body: payload }),
  };

  const netsuite = {
    health:        async () => apiFetch("/api/netsuite/health"),
    connect:       async (payload) => apiFetch("/api/netsuite/connect", { method: "POST", body: payload }),
    push:          async (orderId, options) =>
                     apiFetch("/api/netsuite/push", { method: "POST", body: { orderId, ...(options || {}) } }),
    pushPreview:   async (orderId) =>
                     apiFetch("/api/netsuite/push", { method: "POST", body: { orderId, dry_run: true } }),
    syncNow:       async (payload) => apiFetch("/api/netsuite/sync", { method: "POST", body: payload || {} }),
    retry:         async (payload) => apiFetch("/api/netsuite/retry", { method: "POST", body: payload || {} }),
    diagnostics:   async () => apiFetch("/api/netsuite/diagnostics"),
    fieldMap:      async () => apiFetch("/api/netsuite/field_map"),
    saveFieldMap:  async (map) =>
                     apiFetch("/api/netsuite/field_map", { method: "PUT", body: { field_map: map } }),
  };

  const erpFactory = (prefix) => ({
    health:        async () => apiFetch("/api/" + prefix + "/health"),
    connect:       async (payload) => apiFetch("/api/" + prefix + "/connect", { method: "POST", body: payload }),
    push:          async (orderId, options) =>
                     apiFetch("/api/" + prefix + "/push", { method: "POST", body: { orderId, ...(options || {}) } }),
    pushPreview:   async (orderId) =>
                     apiFetch("/api/" + prefix + "/push", { method: "POST", body: { orderId, dry_run: true } }),
    syncNow:       async (payload) => apiFetch("/api/" + prefix + "/sync", { method: "POST", body: payload || {} }),
    retry:         async (payload) => apiFetch("/api/" + prefix + "/retry", { method: "POST", body: payload || {} }),
    diagnostics:   async () => apiFetch("/api/" + prefix + "/diagnostics"),
    fieldMap:      async () => apiFetch("/api/" + prefix + "/field_map"),
    saveFieldMap:  async (map) => apiFetch("/api/" + prefix + "/field_map", { method: "PUT", body: { field_map: map } }),
  });

  const sap = erpFactory("sap");
  const d365 = erpFactory("d365");
  const acumatica = erpFactory("acumatica");
  const p21 = erpFactory("p21");
  const eclipse = erpFactory("eclipse");
  const sxe = erpFactory("sxe");

  const razorpay = {
    status:   async () => apiFetch("/api/billing/razorpay/status"),
    connect:  async (payload) => apiFetch("/api/billing/razorpay/connect", { method: "POST", body: payload }),
    checkout: async (invoiceId) => apiFetch("/api/billing/razorpay/checkout", { method: "POST", body: { invoice_id: invoiceId } }),
  };

  const push = {
    subscribe:   async (payload) => apiFetch("/api/push/subscribe", { method: "POST", body: payload }),
    unsubscribe: async (payload) => apiFetch("/api/push/unsubscribe", { method: "POST", body: payload || {} }),
    send:        async (payload) => apiFetch("/api/push/send", { method: "POST", body: payload }),
  };

  const portal = {
    listTokens:   async () => apiFetch("/api/portal/tokens"),
    createToken:  async (payload) => apiFetch("/api/portal/tokens", { method: "POST", body: payload }),
    revokeToken:  async (id) => apiFetch("/api/portal/tokens?id=" + encodeURIComponent(id), { method: "PATCH", body: { revoke: true } }),
    deleteToken:  async (id) => apiFetch("/api/portal/tokens?id=" + encodeURIComponent(id), { method: "DELETE" }),
  };

  const esign = {
    connect:      async (payload) => apiFetch("/api/esign/connect", { method: "POST", body: payload }),
    list:         async () => apiFetch("/api/esign/envelopes"),
    create:       async (payload) => apiFetch("/api/esign/envelopes", { method: "POST", body: payload }),
    voidEnvelope: async (id, reason) => apiFetch("/api/esign/envelopes?id=" + encodeURIComponent(id), { method: "PATCH", body: { void: true, voidedReason: reason } }),
  };

  const edi = {
    listEnvelopes:  async (q) => apiFetch("/api/edi/envelopes" + (q ? "?" + new URLSearchParams(q).toString() : "")),
    getEnvelope:    async (id) => apiFetch("/api/edi/envelopes?id=" + encodeURIComponent(id)),
    inbound:        async (payload) => apiFetch("/api/edi/inbound", { method: "POST", body: payload }),
    outbound:       async (payload) => apiFetch("/api/edi/outbound", { method: "POST", body: payload }),
    listPartners:   async () => apiFetch("/api/edi/partners"),
    createPartner:  async (payload) => apiFetch("/api/edi/partners", { method: "POST", body: payload }),
    updatePartner:  async (id, payload) => apiFetch("/api/edi/partners?id=" + encodeURIComponent(id), { method: "PATCH", body: payload }),
    deletePartner:  async (id) => apiFetch("/api/edi/partners?id=" + encodeURIComponent(id), { method: "DELETE" }),
  };

  const rlhf = {
    submit:    async (payload) => apiFetch("/api/rlhf/feedback", { method: "POST", body: payload }),
    list:      async (q) => apiFetch("/api/rlhf/feedback" + (q ? "?" + new URLSearchParams(q).toString() : "")),
    aggregate: async (payload) => apiFetch("/api/rlhf/aggregate", { method: "POST", body: payload || {} }),
    dataset:   async (q) => apiFetch("/api/rlhf/dataset" + (q ? "?" + new URLSearchParams(q).toString() : "")),
  };

  const erpChat = {
    sessions:    async () => apiFetch("/api/erp_chat/sessions"),
    session:     async (id) => apiFetch("/api/erp_chat/sessions?id=" + encodeURIComponent(id) + "&messages=true"),
    deleteSession: async (id) => apiFetch("/api/erp_chat/sessions?id=" + encodeURIComponent(id), { method: "DELETE" }),
    send:        async (payload) => apiFetch("/api/erp_chat/send", { method: "POST", body: payload }),
  };

  const mcp = {
    listTokens:   async () => apiFetch("/api/mcp/tokens"),
    createToken:  async (payload) => apiFetch("/api/mcp/tokens", { method: "POST", body: payload }),
    revokeToken:  async (id) => apiFetch("/api/mcp/tokens?id=" + encodeURIComponent(id), { method: "PATCH", body: { revoke: true } }),
    deleteToken:  async (id) => apiFetch("/api/mcp/tokens?id=" + encodeURIComponent(id), { method: "DELETE" }),
    usage:        async (since) => apiFetch("/api/mcp/usage" + (since ? "?since=" + encodeURIComponent(since) : "")),
  };

  const inbound = {
    listThreads:   async (q) => apiFetch("/api/inbound/email/threads" + (q ? "?" + new URLSearchParams(q).toString() : "")),
    getThread:     async (id) => apiFetch("/api/inbound/email/threads?id=" + encodeURIComponent(id) + "&messages=true"),
    parseNow:      async () => apiFetch("/api/inbound/email/parse", { method: "POST", body: {} }),
    getConfigure:  async () => apiFetch("/api/inbound/email/configure"),
    saveConfigure: async (payload) => apiFetch("/api/inbound/email/configure", { method: "PUT", body: payload }),
  };

  const docai = {
    extract:    async (payload) => apiFetch("/api/docai/extract", { method: "POST", body: payload }),
    correction: async (payload) => apiFetch("/api/docai/correction", { method: "POST", body: payload }),
    listRuns:   async (q) => apiFetch("/api/docai/runs" + (q ? "?" + new URLSearchParams(q).toString() : "")),
    getRun:     async (id) => apiFetch("/api/docai/runs?id=" + encodeURIComponent(id)),
  };

  const claudeCall = async (payload) => apiFetch("/api/claude/messages", { method: "POST", body: payload });

  const documents = {
    // Default flow: request signed URL, PUT the file, then trigger a scan
    // and return the verdict alongside the upload metadata. Pass
    // `{ autoScan: false }` to opt out (e.g. bulk imports where the
    // caller will scan in batches).
    upload: async (file, classification, options) => {
      const opts = options || {};
      const meta = await apiFetch("/api/documents/upload", {
        method: "POST",
        body: { filename: file.name, mime_type: file.type, size_bytes: file.size, classification: classification || null },
      });
      const upstream = await fetch(meta.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      if (!upstream.ok) throw new Error("Upload failed: " + upstream.status);
      let scan = null;
      if (opts.autoScan !== false) {
        try {
          scan = await apiFetch("/api/documents/scan", {
            method: "POST",
            body: { documentId: meta.documentId },
          });
        } catch (err) {
          // Scan failure does not undo the upload. The doc row exists; the
          // caller can re-trigger /api/documents/scan later. We surface
          // the error inline so the UI can flag the unscanned state.
          scan = { error: err.message || String(err), status: "scan_error" };
        }
      }
      return { ...meta, scan };
    },
    scan: async (documentId) => apiFetch("/api/documents/scan", { method: "POST", body: { documentId } }),
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
    signup: async (payload) => apiFetch("/api/auth/signup", { method: "POST", body: payload }),
    passwordLogin: async (email, password) => apiFetch("/api/auth/password_login", { method: "POST", body: { email, password } }),
    getProfile: async () => apiFetch("/api/auth/profile"),
    updateProfile: async (patch) => apiFetch("/api/auth/profile", { method: "PATCH", body: patch }),
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
    pushPreview: async (payload) => apiFetch("/api/tally/push", { method: "POST", body: { ...(payload || {}), dry_run: true } }),
    reconcile: async (payload) => apiFetch("/api/tally/reconcile", { method: "POST", body: payload }),
    amend: async (payload) => apiFetch("/api/tally/amend", { method: "POST", body: payload }),
    health: async () => apiFetch("/api/tally/health"),
    diagnostics: async (companyId) => apiFetch("/api/tally/diagnostics" + (companyId ? "?companyId=" + encodeURIComponent(companyId) : "")),
    listCompanies: async () => apiFetch("/api/tally/companies"),
    createCompany: async (payload) => apiFetch("/api/tally/companies", { method: "POST", body: payload }),
    updateCompany: async (id, payload) => apiFetch("/api/tally/companies?id=" + encodeURIComponent(id), { method: "PATCH", body: payload }),
    deleteCompany: async (id) => apiFetch("/api/tally/companies?id=" + encodeURIComponent(id), { method: "DELETE" }),
    syncNow: async (payload) => apiFetch("/api/tally/sync", { method: "POST", body: payload || {} }),
    retry: async (payload) => apiFetch("/api/tally/retry", { method: "POST", body: payload || {} }),
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
    listClosureReports: async (params) => apiFetch("/api/service/closure_reports" + (params ? "?" + new URLSearchParams(params).toString() : "")),
    createClosureReport: async (payload) => apiFetch("/api/service/closure_reports", { method: "POST", body: payload }),
    updateClosureReport: async (payload) => apiFetch("/api/service/closure_reports", { method: "PATCH", body: payload }),
    listAmcSchedules: async (params) => apiFetch("/api/service/amc" + (params ? "?" + new URLSearchParams(params).toString() : "")),
    createAmcSchedule: async (payload) => apiFetch("/api/service/amc", { method: "POST", body: payload }),
    bulkSeedAmcSchedule: async (payload) => apiFetch("/api/service/amc", { method: "POST", body: { bulk_seed: payload } }),
    updateAmcSchedule: async (payload) => apiFetch("/api/service/amc", { method: "PATCH", body: payload }),
    generateAmcVisit: async (id) => apiFetch("/api/service/amc", { method: "PATCH", body: { id, generate_visit: true } }),
    deleteAmcSchedule: async (id) => apiFetch("/api/service/amc?id=" + encodeURIComponent(id), { method: "DELETE" }),
  };

  const einvoice = {
    list: async (params) => apiFetch("/api/einvoice" + (params ? "?" + new URLSearchParams(params).toString() : "")),
    createDraft: async (payload) => apiFetch("/api/einvoice", { method: "POST", body: payload }),
    update: async (payload) => apiFetch("/api/einvoice", { method: "PATCH", body: payload }),
    sendToGstn: async (id) => apiFetch("/api/einvoice", { method: "PATCH", body: { id, action: "send_to_gstn" } }),
    cancel: async (payload) => apiFetch("/api/einvoice", { method: "PATCH", body: { ...payload, action: "cancel" } }),
    remove: async (id) => apiFetch("/api/einvoice?id=" + encodeURIComponent(id), { method: "DELETE" }),
  };

  const forecast = {
    get: async (params) => apiFetch("/api/forecast" + (params ? "?" + new URLSearchParams(params).toString() : "")),
    snapshot: async () => apiFetch("/api/forecast", { method: "POST", body: {} }),
  };

  const scheduleLines = {
    list: async (orderId) => apiFetch("/api/orders/schedule_lines?order_id=" + encodeURIComponent(orderId)),
    create: async (payload) => apiFetch("/api/orders/schedule_lines", { method: "POST", body: payload }),
    bulkCreate: async (orderId, rows, sourceDocId) =>
      apiFetch("/api/orders/schedule_lines", { method: "POST", body: { order_id: orderId, rows, source_document_id: sourceDocId || null } }),
    deleteOne: async (id) => apiFetch("/api/orders/schedule_lines?id=" + encodeURIComponent(id), { method: "DELETE" }),
    clear: async (orderId) => apiFetch("/api/orders/schedule_lines?order_id=" + encodeURIComponent(orderId), { method: "DELETE" }),
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
    resendInvite: async (email) => apiFetch("/api/admin/members", { method: "POST", body: { email, resend: true } }),
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
    diagnostics: async () => apiFetch("/api/admin/diagnostics"),
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
          if (typeof console !== "undefined") console.warn("[anvil-client] backend get failed for " + k + ":", err.message);
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
                if (typeof console !== "undefined") console.warn("[anvil-client] order push failed:", err.message);
              }
            }
            return local.set(k, v);
          }
        } catch (err) {
          if (typeof console !== "undefined") console.warn("[anvil-client] backend set failed for " + k + ":", err.message);
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
    health,
    billing,
    quotes,
    invoices: invoices,
    agents,
    whatsapp,
    netsuite,
    sap,
    d365,
    acumatica,
    p21,
    eclipse,
    sxe,
    razorpay,
    push,
    portal,
    esign,
    edi,
    rlhf,
    erpChat,
    mcp,
    inbound,
    docai,
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
    einvoice,
    forecast,
    scheduleLines,
  };

  // Canonical name post-rebrand. The old name stays as a writable
  // alias so any consumer that grabbed `window.ObaraBackend`
  // (102 call sites across screens + scripts at the rename time)
  // keeps working without an import change, and tests that swap
  // `window.ObaraBackend` for a stub keep working too. Both globals
  // point at the same object, so a write to one is a write to both.
  global.AnvilBackend = api;
  global.ObaraBackend = api;
  global.storage = buildHybridStorage();
})(typeof window !== "undefined" ? window : globalThis);
