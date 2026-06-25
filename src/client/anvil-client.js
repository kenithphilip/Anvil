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

  // Audit C5 part 2 (May 2026): session storage migration.
  //
  // Primary store is sessionStorage (tab-scoped, cleared on tab
  // close) under the new `anvil:` prefix. We continue to mirror to
  // localStorage under both prefixes during the transition window
  // because 43 v3 screens read the legacy key inline. Once those
  // screens are migrated to call `ObaraBackend.getSession()` we can
  // drop the localStorage write and the supply-chain JS exfiltration
  // surface goes away.
  //
  // Read order: sessionStorage → localStorage (with promotion). On a
  // sign-in via popup callback, the callback page (callback.html)
  // writes to localStorage; the next API call from this script reads
  // it, promotes it to sessionStorage, and from then on the tab uses
  // sessionStorage exclusively.
  const ssGet = (suffix) => {
    try { return sessionStorage.getItem(NEW_PREFIX + suffix); }
    catch (_) { return null; }
  };
  const ssSet = (suffix, value) => {
    try { sessionStorage.setItem(NEW_PREFIX + suffix, value); } catch (_) {}
  };
  const ssRemove = (suffix) => {
    try { sessionStorage.removeItem(NEW_PREFIX + suffix); } catch (_) {}
  };

  const readSession = () => {
    try {
      const fresh = ssGet(SESSION_KEY);
      if (fresh != null) return JSON.parse(fresh);
      // Promote legacy localStorage value to sessionStorage on first read.
      const legacy = lsGet(SESSION_KEY);
      if (legacy != null) {
        ssSet(SESSION_KEY, legacy);
        return JSON.parse(legacy || "null");
      }
      return null;
    } catch (_) { return null; }
  };
  const writeSession = (session) => {
    const value = JSON.stringify(session || null);
    ssSet(SESSION_KEY, value);
    // Mirror to localStorage during transition for the 43 screens
    // that read it directly. Tracked for removal once migrated.
    lsSet(SESSION_KEY, value);
  };
  const clearSession = () => {
    ssRemove(SESSION_KEY);
    lsRemove(SESSION_KEY);
  };

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
      // the route reload causes a refresh loop. We also skip the
      // redirect on the pre-auth surface (signin / reset / landing /
      // the bare "#") because those screens have NO session by
      // design: a background telemetry poll (useShellTelemetry's
      // focus listener) firing a 401 after a tab switch would
      // otherwise punt the visitor off the sign-in form straight
      // onto the marketing landing within seconds.
      if (typeof global !== "undefined" && global.location) {
        const here = String(global.location.hash || "").replace(/^#\/?/, "").split("?")[0];
        const PRE_AUTH = new Set(["connect", "signin", "reset", "landing", ""]);
        if (!PRE_AUTH.has(here)) {
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
    // Audit P6.1-6.5: first-class quote object.
    list: async (params) => apiFetch("/api/quotes" + (params ? "?" + new URLSearchParams(params).toString() : "")),
    get: async (id) => apiFetch("/api/quotes?id=" + encodeURIComponent(id)),
    create: async (payload) => apiFetch("/api/quotes", { method: "POST", body: payload }),
    update: async (id, patch) => apiFetch("/api/quotes?id=" + encodeURIComponent(id), { method: "PATCH", body: patch }),
    revise: async (id) => apiFetch("/api/quotes?id=" + encodeURIComponent(id) + "&action=revise", { method: "POST" }),
    transition: async (id, status) => apiFetch("/api/quotes?id=" + encodeURIComponent(id), { method: "PATCH", body: { status } }),
    cancel: async (id) => apiFetch("/api/quotes?id=" + encodeURIComponent(id), { method: "DELETE" }),
    sendQuote: async (id, payload) => apiFetch("/api/quotes/send", { method: "POST", body: { id, ...(payload || {}) } }),
    convertToOrder: async (id) => apiFetch("/api/quotes/convert", { method: "POST", body: { id } }),
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
  const sageX3 = erpFactory("sage_x3");
  // Phase 5.4b cluster A (OAuth2): IFS Cloud, Oracle Fusion, Ramco.
  const ifs = erpFactory("ifs");
  const oracleFusion = erpFactory("oracle_fusion");
  const ramco = erpFactory("ramco");
  // Phase 5.4b cluster B (token-pair): JDE, Plex, JobBoss.
  const jde = erpFactory("jde");
  const plex = erpFactory("plex");
  const jobboss = erpFactory("jobboss");
  // Phase 5.4b cluster C (HTTP Basic): Oracle EBS, proALPHA.
  const oracleEbs = erpFactory("oracle_ebs");
  const proalpha = erpFactory("proalpha");

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

  // Customer-facing portal v2 client. These calls take a token (not
  // a session) and run anonymously on the buyer's side.
  const portalCustomer = {
    reorder:      async (payload) => apiFetch("/api/portal/reorder", { method: "POST", body: payload }),
    invoicePdf:   async (token, invoiceId) => apiFetch("/api/portal/invoice_pdf?token=" + encodeURIComponent(token) + "&invoice_id=" + encodeURIComponent(invoiceId)),
    acceptQuote:  async (payload) => apiFetch("/api/portal/accept_quote", { method: "POST", body: payload }),
  };

  const travelers = {
    generate:     async (payload) => apiFetch("/api/orders/traveler", { method: "POST", body: payload }),
    listJobs:     async (q) => apiFetch("/api/orders/print_jobs" + (q ? "?" + new URLSearchParams(q).toString() : "")),
    cancelJob:    async (id) => apiFetch("/api/orders/print_jobs?id=" + encodeURIComponent(id), { method: "PATCH", body: { cancel: true } }),
  };

  const analytics = {
    winloss:  async (q) => apiFetch("/api/analytics/winloss" + (q ? "?" + new URLSearchParams(q).toString() : "")),
    refresh:  async (payload) => apiFetch("/api/analytics/refresh", { method: "POST", body: payload || {} }),
    funnel:   async (q) => apiFetch("/api/analytics/funnel" + (q ? "?" + new URLSearchParams(q).toString() : "")),
  };

  const supplierRfq = {
    list:        async () => apiFetch("/api/supplier_rfq"),
    get:         async (id) => apiFetch("/api/supplier_rfq?id=" + encodeURIComponent(id)),
    create:      async (payload) => apiFetch("/api/supplier_rfq", { method: "POST", body: payload }),
    update:      async (id, payload) => apiFetch("/api/supplier_rfq?id=" + encodeURIComponent(id), { method: "PATCH", body: payload }),
    remove:      async (id) => apiFetch("/api/supplier_rfq?id=" + encodeURIComponent(id), { method: "DELETE" }),
    send:        async (payload) => apiFetch("/api/supplier_rfq/send", { method: "POST", body: payload }),
    submitQuote: async (payload) => apiFetch("/api/supplier_rfq/quote", { method: "POST", body: payload }),
    matrix:      async (rfqId) => apiFetch("/api/supplier_rfq/matrix?rfq_id=" + encodeURIComponent(rfqId)),
    award:       async (payload) => apiFetch("/api/supplier_rfq/award", { method: "POST", body: payload }),
    listVendors: async () => apiFetch("/api/supplier_rfq/vendors"),
    createVendor: async (payload) => apiFetch("/api/supplier_rfq/vendors", { method: "POST", body: payload }),
    updateVendor: async (id, payload) => apiFetch("/api/supplier_rfq/vendors?id=" + encodeURIComponent(id), { method: "PATCH", body: payload }),
    deleteVendor: async (id) => apiFetch("/api/supplier_rfq/vendors?id=" + encodeURIComponent(id), { method: "DELETE" }),
  };

  const reconcile = {
    submit: async (payload) => apiFetch("/api/orders/reconcile", { method: "POST", body: payload }),
  };

  const catalog = {
    search:           async (q, opts) => {
      const params = new URLSearchParams({ q });
      if (opts?.limit) params.set("limit", String(opts.limit));
      if (opts?.mode)  params.set("mode", String(opts.mode));
      return apiFetch("/api/catalog/search?" + params.toString());
    },
    // Audit P8.4: catalog embeddings indexer.
    embedStatus:      async () => apiFetch("/api/catalog/embed"),
    embedDrain:       async (ids) => apiFetch("/api/catalog/embed", { method: "POST", body: ids ? { ids } : {} }),
    listSynonyms:     async (itemId) => apiFetch("/api/catalog/synonyms" + (itemId ? "?item_id=" + encodeURIComponent(itemId) : "")),
    addSynonym:       async (payload) => apiFetch("/api/catalog/synonyms", { method: "POST", body: payload }),
    removeSynonym:    async (id) => apiFetch("/api/catalog/synonyms?id=" + encodeURIComponent(id), { method: "DELETE" }),
    listAlternatives: async (itemId) => apiFetch("/api/catalog/alternatives" + (itemId ? "?item_id=" + encodeURIComponent(itemId) : "")),
    addAlternative:   async (payload) => apiFetch("/api/catalog/alternatives", { method: "POST", body: payload }),
    removeAlternative: async (id) => apiFetch("/api/catalog/alternatives?id=" + encodeURIComponent(id), { method: "DELETE" }),
    listPrivateLabel: async () => apiFetch("/api/catalog/private_label"),
    addPrivateLabel:  async (payload) => apiFetch("/api/catalog/private_label", { method: "POST", body: payload }),
    updatePrivateLabel: async (id, payload) => apiFetch("/api/catalog/private_label?id=" + encodeURIComponent(id), { method: "PATCH", body: payload }),
    removePrivateLabel: async (id) => apiFetch("/api/catalog/private_label?id=" + encodeURIComponent(id), { method: "DELETE" }),
  };

  const kb = {
    ask: async (payload) => apiFetch("/api/kb/ask", { method: "POST", body: payload }),
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
    // Phase Cost-Opt: today's per-adapter call counters + per-adapter
    // budget so the admin UI can render "Claude: 12/50 used today".
    usage:      async (date) => apiFetch("/api/docai/usage" + (date ? "?date=" + encodeURIComponent(date) : "")),
    // Aggregate cost-optimisation status: usage + 7d trend + caps +
    // adapter health + actionable recommendations. Drives the
    // admin "DocAI cost" tab.
    costStatus: async (days) => apiFetch("/api/docai/cost_status" + (days ? "?days=" + encodeURIComponent(days) : "")),
    // Tenant docai settings (admin only). GET returns current
    // values; updateSettings PATCHes a partial.
    getSettings:    async () => apiFetch("/api/admin/docai_settings"),
    updateSettings: async (patch) => apiFetch("/api/admin/docai_settings", { method: "PATCH", body: patch }),
    // Wave 4.1 operator review queue. listReviewQueue returns
    // { queue, summary }; reviewDecide triages one row with an
    // action of "claim" | "resolve" | "reopen".
    listReviewQueue: async (q) => apiFetch("/api/docai/review_queue" + (q ? "?" + new URLSearchParams(q).toString() : "")),
    reviewDecide:    async (payload) => apiFetch("/api/docai/review_queue", { method: "POST", body: payload }),
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
    // OCR evidence rows for a document. Returns the per-token bboxes
    // the documents-detail overlay paints on top of the source image.
    // The Mistral OCR pipeline (/api/documents/ocr, exposed as
    // ObaraBackend.ocr.run below) populates these; an empty `rows`
    // array means OCR has not yet been run on this document.
    evidence: async (id) => apiFetch("/api/documents/" + id + "/evidence"),
    // List documents for the tenant. Powers the Documents library
    // screen. Was missing entirely; documents.tsx called list() and
    // got `undefined` (optional chaining), which silently rendered
    // an empty library on every load.
    list: async (params) => {
      const qs = new URLSearchParams(params || {}).toString();
      return apiFetch("/api/documents" + (qs ? "?" + qs : ""));
    },

    // Run the docai extractor on a freshly-uploaded file. Reads the
    // browser File into base64 and posts to /api/docai/extract so the
    // adapter chain (Reducto / Azure DI / Claude fallback) can return
    // structured customer + lines. Returns the extraction_run row's
    // `normalized` payload + run_id + confidence.
    //
    // The caller (so-intake.tsx) uses this immediately after upload
    // to pre-fill customer info and either auto-select an existing
    // customer match or open the new-customer dialog with the
    // extracted fields populated.
    extract: async (file, opts) => {
      const o = opts || {};
      const buf = await file.arrayBuffer();
      // Chunked base64. The naive
      //   btoa(String.fromCharCode(...new Uint8Array(buf)))
      // throws "Maximum call stack size exceeded" on files larger
      // than ~65 KB because of the spread operator. Walk the bytes
      // in 32 KB chunks instead. Works for the 50 MB upload cap
      // without blowing the stack.
      const u8 = new Uint8Array(buf);
      const CHUNK = 32 * 1024;
      let bin = "";
      for (let i = 0; i < u8.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
      }
      const bytesB64 = btoa(bin);
      return apiFetch("/api/docai/extract", {
        method: "POST",
        body: {
          source_type: o.source_type || (file.type === "application/pdf" ? "pdf"
                                       : file.type?.startsWith("image/") ? "image"
                                       : "pdf"),
          source_filename: file.name,
          mime: file.type,
          size_bytes: file.size,
          bytes_base64: bytesB64,
          customer_id: o.customer_id || null,
          source_id: o.source_id || null,
          // Phase 3.6 observability: pass order_id so the
          // extract handler can key processing_events by case
          // for the workspace's Activity timeline + Pipeline
          // Diagnostics tab. Optional; falls back to source_id.
          order_id: o.order_id || null,
        },
      });
    },
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
    // ERP-format sales-order voucher PDF (post-approval). Binary blob
    // for in-browser download; share() returns a 7-day signed URL.
    voucherPdfBlob: async (orderId) => {
      const cfg = readConfig();
      if (!cfg.url) throw new Error("Backend URL not configured");
      const session = readSession();
      const url = cfg.url.replace(/\/+$/, "") + "/api/orders/voucher_pdf?orderId=" + encodeURIComponent(orderId);
      const headers = {};
      if (session?.access_token) headers["Authorization"] = "Bearer " + session.access_token;
      if (cfg.tenantId) headers["x-obara-tenant"] = cfg.tenantId;
      const resp = await fetch(url, { headers });
      if (!resp.ok) {
        let msg = "Voucher PDF " + resp.status;
        try { const j = await resp.json(); msg = j?.error?.message || msg; } catch (_) { /* binary/empty */ }
        throw new Error(msg);
      }
      return await resp.blob();
    },
    voucherShare: async (orderId) => apiFetch("/api/orders/voucher_pdf?orderId=" + encodeURIComponent(orderId) + "&format=share"),
    // Phase 3.6 observability: full pipeline-diagnostics blob for
    // an order. Used by the workspace's Pipeline Diagnostics tab
    // to render extraction_runs + processing_events + adapter
    // health in one place.
    pipelineState: async (id) => apiFetch("/api/orders/" + encodeURIComponent(id) + "/pipeline-state"),
  };

  const customers = {
    list: async () => apiFetch("/api/customers"),
    upsert: async (payload) => apiFetch("/api/customers", { method: "POST", body: payload }),
    // Lists customer_locations across the tenant. Used by the
    // so-intake "new customer" dialog's address picker so the
    // operator can pick an existing address (any customer's) instead
    // of re-typing one that's already in the database. Optional
    // params: customer_id, q (substring search).
    listLocations: async (params) => {
      const qs = new URLSearchParams(params || {}).toString();
      return apiFetch("/api/customer_locations" + (qs ? "?" + qs : ""));
    },
    // Audit P7.3: Haiku customer health score (single + batch drain).
    healthScore: async (id) => apiFetch("/api/customers/health_score?id=" + encodeURIComponent(id)),
    refreshHealthScores: async () => apiFetch("/api/customers/health_score", { method: "POST" }),
    // Audit P4.1: contacts CRUD.
    listContacts: async (params) => {
      const qs = new URLSearchParams(params || {}).toString();
      return apiFetch("/api/customers/contacts" + (qs ? "?" + qs : ""));
    },
    upsertContact: async (payload) => apiFetch("/api/customers/contacts", { method: "POST", body: payload }),
    updateContact: async (payload) => apiFetch("/api/customers/contacts", { method: "PATCH", body: payload }),
    deleteContact: async (id) => apiFetch("/api/customers/contacts?id=" + encodeURIComponent(id), { method: "DELETE" }),
    // Audit P4.5 + P4.6: duplicate detection + merge.
    findDuplicates: async (params) => {
      const qs = new URLSearchParams(params || {}).toString();
      return apiFetch("/api/customers/duplicates" + (qs ? "?" + qs : ""));
    },
    merge: async (payload) => apiFetch("/api/customers/merge", { method: "POST", body: payload }),
  };

  // Audit P7.5: credit + debit notes.
  const creditNotes = {
    list: async (params) => apiFetch("/api/credit_notes" + (params ? "?" + new URLSearchParams(params).toString() : "")),
    get: async (id) => apiFetch("/api/credit_notes?id=" + encodeURIComponent(id)),
    create: async (payload) => apiFetch("/api/credit_notes", { method: "POST", body: payload }),
    update: async (id, patch) => apiFetch("/api/credit_notes?id=" + encodeURIComponent(id), { method: "PATCH", body: patch }),
    transition: async (id, status) => apiFetch("/api/credit_notes?id=" + encodeURIComponent(id), { method: "PATCH", body: { status } }),
    cancel: async (id) => apiFetch("/api/credit_notes?id=" + encodeURIComponent(id), { method: "DELETE" }),
  };

  // Audit P7.6: recurring invoice schedules.
  const billingRecurring = {
    list: async (params) => apiFetch("/api/billing/recurring" + (params ? "?" + new URLSearchParams(params).toString() : "")),
    get: async (id) => apiFetch("/api/billing/recurring?id=" + encodeURIComponent(id)),
    create: async (payload) => apiFetch("/api/billing/recurring", { method: "POST", body: payload }),
    update: async (id, patch) => apiFetch("/api/billing/recurring?id=" + encodeURIComponent(id), { method: "PATCH", body: patch }),
    pause: async (id) => apiFetch("/api/billing/recurring?id=" + encodeURIComponent(id), { method: "PATCH", body: { status: "PAUSED" } }),
    resume: async (id) => apiFetch("/api/billing/recurring?id=" + encodeURIComponent(id), { method: "PATCH", body: { status: "ACTIVE" } }),
    cancel: async (id) => apiFetch("/api/billing/recurring?id=" + encodeURIComponent(id), { method: "DELETE" }),
  };

  // Audit P7.7: NIC e-Way bills.
  const ewayBills = {
    list: async (params) => apiFetch("/api/eway_bills" + (params ? "?" + new URLSearchParams(params).toString() : "")),
    get: async (id) => apiFetch("/api/eway_bills?id=" + encodeURIComponent(id)),
    create: async (payload) => apiFetch("/api/eway_bills", { method: "POST", body: payload }),
    update: async (id, patch) => apiFetch("/api/eway_bills?id=" + encodeURIComponent(id), { method: "PATCH", body: patch }),
    sendToNic: async (id) => apiFetch("/api/eway_bills?id=" + encodeURIComponent(id), { method: "PATCH", body: { action: "send_to_nic" } }),
    markGeneratedManually: async (id, payload) => apiFetch("/api/eway_bills?id=" + encodeURIComponent(id), { method: "PATCH", body: { action: "mark_generated_manually", ...(payload || {}) } }),
    updateVehicle: async (id, payload) => apiFetch("/api/eway_bills?id=" + encodeURIComponent(id), { method: "PATCH", body: { action: "update_vehicle", ...(payload || {}) } }),
    extendValidity: async (id, payload) => apiFetch("/api/eway_bills?id=" + encodeURIComponent(id), { method: "PATCH", body: { action: "extend_validity", ...(payload || {}) } }),
    cancel: async (id, payload) => apiFetch("/api/eway_bills?id=" + encodeURIComponent(id), { method: "PATCH", body: { action: "cancel", ...(payload || {}) } }),
    revertToDraft: async (id) => apiFetch("/api/eway_bills?id=" + encodeURIComponent(id), { method: "PATCH", body: { action: "revert_to_draft" } }),
    remove: async (id) => apiFetch("/api/eway_bills?id=" + encodeURIComponent(id), { method: "DELETE" }),
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
    // Audit P5.4: Haiku per-flag anomaly explainer.
    explain: async (findingId) => apiFetch("/api/anomaly/explain?finding_id=" + encodeURIComponent(findingId)),
  };

  const evalSuite = {
    run: async (suite, cases) => apiFetch("/api/eval/run", { method: "POST", body: { suite, cases } }),
  };

  const authMethods = {
    requestMagicLink: async (email, redirectTo) => apiFetch("/api/auth/magic_link", { method: "POST", body: { email, redirectTo } }),
    verifyToken: async (access_token) => apiFetch("/api/auth/verify", { method: "POST", body: { access_token } }),
    signup: async (payload) => apiFetch("/api/auth/signup", { method: "POST", body: payload }),
    // passwordLogin accepts an optional totp_code so the second
    // step of the MFA dance reuses the same endpoint. The server
    // returns { mfa_required: true } when a code is needed.
    passwordLogin: async (email, password, totp_code) =>
      apiFetch("/api/auth/password_login", { method: "POST", body: { email, password, totp_code } }),
    requestReset: async (email, redirect_to) =>
      apiFetch("/api/auth/request_reset", { method: "POST", body: { email, redirect_to } }),
    completeReset: async (access_token, new_password) =>
      apiFetch("/api/auth/complete_reset", { method: "POST", body: { access_token, new_password } }),
    mfaSettings: async () => apiFetch("/api/auth/mfa"),
    mfaEnroll: async () => apiFetch("/api/auth/mfa", { method: "POST", body: { action: "enroll" } }),
    mfaVerify: async (code) => apiFetch("/api/auth/mfa", { method: "POST", body: { action: "verify", code } }),
    mfaUnenroll: async (code) => apiFetch("/api/auth/mfa", { method: "POST", body: { action: "unenroll", code } }),
    passkeyRegisterBegin: async (label) =>
      apiFetch("/api/auth/passkey/register/begin", { method: "POST", body: { label } }),
    passkeyRegisterFinish: async (pending_id, response) =>
      apiFetch("/api/auth/passkey/register/finish", { method: "POST", body: { pending_id, response } }),
    passkeyAuthBegin: async (email) =>
      apiFetch("/api/auth/passkey/auth/begin", { method: "POST", body: { email } }),
    passkeyAuthFinish: async (email, challenge_id, response) =>
      apiFetch("/api/auth/passkey/auth/finish", { method: "POST", body: { email, challenge_id, response } }),
    passkeyList: async () => apiFetch("/api/auth/passkey/list"),
    passkeyRemove: async (id) => apiFetch("/api/auth/passkey/list?id=" + encodeURIComponent(id), { method: "DELETE" }),
    getProfile: async () => apiFetch("/api/auth/profile"),
    updateProfile: async (patch) => apiFetch("/api/auth/profile", { method: "PATCH", body: patch }),
  };

  // Access-requests + notifications surface (Phase: access approvals).
  const accessRequests = {
    list: async (params) => {
      const qs = new URLSearchParams(params || {}).toString();
      return apiFetch("/api/admin/access_requests" + (qs ? "?" + qs : ""));
    },
    approve: async (user_id, role) => apiFetch("/api/admin/access_requests", { method: "POST", body: { user_id, action: "approve", role } }),
    deny: async (user_id, reason) => apiFetch("/api/admin/access_requests", { method: "POST", body: { user_id, action: "deny", reason } }),
    modify: async (user_id, patch) => apiFetch("/api/admin/access_requests", { method: "POST", body: { user_id, action: "modify", ...(patch || {}) } }),
  };

  const notifications = {
    list: async () => apiFetch("/api/admin/notifications"),
    markRead: async (id) => apiFetch("/api/admin/notifications", { method: "POST", body: { id, action: "mark_read" } }),
    markAllRead: async () => apiFetch("/api/admin/notifications", { method: "POST", body: { action: "mark_all_read" } }),
    resolve: async (id, note) => apiFetch("/api/admin/notifications", { method: "POST", body: { id, action: "resolve", note } }),
  };

  // Phase 6 (C.2): Vertical pack installer. Loads paper-converting /
  // fasteners / pvf / electrical / hvac configuration into the
  // tenant's seed tables. Idempotent per content_hash.
  const verticalPacks = {
    install: async (vertical_id) =>
      apiFetch("/api/admin/install_vertical_pack", { method: "POST", body: { vertical_id } }),
  };

  // Phase 6 (C.1): SOC 2 audit-trail export and access review.
  const accessReview = {
    snapshot: async () => apiFetch("/api/admin/access_review"),
    sign:     async (acknowledgement_text, notes) =>
      apiFetch("/api/admin/access_review", { method: "POST", body: { acknowledgement_text, notes } }),
  };
  // Phase 6 (C.3): Agent eval / drift harness.
  const agentEval = {
    list: async () => apiFetch("/api/eval/agent_eval"),
    run:  async (since) => apiFetch("/api/eval/agent_eval", { method: "POST", body: { since: since || null } }),
  };

  // Phase 6 (C.4): Per-customer DocAI router.
  const docaiRoute = {
    decide:  async (customer_id) => apiFetch("/api/docai/route?customer_id=" + encodeURIComponent(customer_id)),
    apply:   async (customer_id, payload) =>
      apiFetch("/api/docai/route", { method: "POST", body: { customer_id, payload } }),
  };

  // Phase 6 (C.6): Outbound prospecting.
  const prospecting = {
    listCampaigns: async () => apiFetch("/api/prospecting/campaigns"),
    createCampaign: async (payload) => apiFetch("/api/prospecting/campaigns", { method: "POST", body: payload }),
    updateCampaign: async (id, patch) => apiFetch("/api/prospecting/campaigns", { method: "PATCH", body: { id, ...patch } }),
    listTargets: async (campaign_id, status) => {
      const qs = new URLSearchParams();
      if (campaign_id) qs.set("campaign_id", campaign_id);
      if (status) qs.set("status", status);
      return apiFetch("/api/prospecting/targets" + (qs.toString() ? "?" + qs.toString() : ""));
    },
    addTargets: async (campaign_id, targets) =>
      apiFetch("/api/prospecting/targets", { method: "POST", body: { campaign_id, targets } }),
    approve: async (id) => apiFetch("/api/prospecting/targets", { method: "PATCH", body: { id, action: "approve" } }),
    deny:    async (id) => apiFetch("/api/prospecting/targets", { method: "PATCH", body: { id, action: "deny" } }),
    unsubscribe: async (id, notes) => apiFetch("/api/prospecting/targets", { method: "PATCH", body: { id, action: "unsubscribe", notes } }),
    runNow:  async () => apiFetch("/api/prospecting/run", { method: "POST" }),
  };

  // Phase 6 (C.5): AP 3-way match + short-pay deductions.
  const ap = {
    listInvoices: async () => apiFetch("/api/ap/match"),
    matchInvoice: async (ap_invoice_id) =>
      apiFetch("/api/ap/match", { method: "POST", body: { ap_invoice_id } }),
    listDeductions: async (status) => {
      const qs = status ? "?status=" + encodeURIComponent(status) : "";
      return apiFetch("/api/ap/deductions" + qs);
    },
    recordPayment: async (invoice_id, paid_amount, opts = {}) =>
      apiFetch("/api/ap/deductions", { method: "POST", body: { invoice_id, paid_amount, ...opts } }),
    resolveDeduction: async (id, status, notes) =>
      apiFetch("/api/ap/deductions", { method: "PATCH", body: { id, status, notes } }),
  };

  const auditExport = {
    // Returns the ndjson stream as text. Caller can split lines and
    // parse each line as JSON; the trailing meta record carries the
    // HMAC signature and row count.
    pull: async ({ from, to, types, limit } = {}) => {
      const qs = new URLSearchParams();
      if (from) qs.set("from", from);
      if (to) qs.set("to", to);
      if (types && types.length) qs.set("types", Array.isArray(types) ? types.join(",") : String(types));
      if (limit) qs.set("limit", String(limit));
      // Use raw fetch so the ndjson body is preserved as-is.
      const cfg = readConfig();
      if (!cfg.url) throw new Error("Backend URL not configured");
      const session = readSession();
      const headers = { Accept: "application/x-ndjson" };
      if (session?.access_token) headers.Authorization = "Bearer " + session.access_token;
      const resp = await fetch(cfg.url.replace(/\/+$/, "") + "/api/audit/export" + (qs.toString() ? "?" + qs.toString() : ""), { headers });
      if (!resp.ok) {
        const body = await resp.text();
        throw new Error("audit export " + resp.status + " " + body.slice(0, 200));
      }
      return resp.text();
    },
  };

  const ocr = {
    // Trigger Mistral OCR on a document. orderId is optional: when
    // omitted the evidence rows write back as document-scoped (no
    // associated order yet). The documents-detail "Run OCR" button
    // takes this path so an operator can review the bbox overlay
    // without first creating an order.
    run: async (documentId, orderId) => apiFetch("/api/documents/ocr", {
      method: "POST",
      body: { documentId, orderId: orderId || null },
    }),
  };

  const scan = {
    run: async (documentId, opts) => apiFetch("/api/documents/scan", { method: "POST", body: { documentId, ...opts } }),
  };

  // Voice AI namespace. Wraps configure / outbound / consent +
  // a list shim that reads voice_calls via the orders-style
  // "/api/voice/calls" path (a follow-up); for now the screen
  // can hit voice_calls directly via the supabase client where
  // present. The config + consent + outbound endpoints are the
  // operator-facing surface.
  const voice = {
    listConfigs: async () => apiFetch("/api/voice/configure"),
    upsertConfig: async (cfg) => apiFetch("/api/voice/configure", { method: "POST", body: cfg }),
    placeOutbound: async (payload) => apiFetch("/api/voice/outbound", { method: "POST", body: payload }),
    listConsent: async (phone) => apiFetch("/api/voice/consent" + (phone ? "?phone=" + encodeURIComponent(phone) : "")),
    recordConsent: async (payload) => apiFetch("/api/voice/consent", { method: "POST", body: payload }),
    withdrawConsent: async (id) => apiFetch("/api/voice/consent?id=" + encodeURIComponent(id), { method: "DELETE" }),
    listDnd: async (params) => {
      const qs = new URLSearchParams(params || {}).toString();
      return apiFetch("/api/voice/dnd" + (qs ? "?" + qs : ""));
    },
    addDnd: async (payload) => apiFetch("/api/voice/dnd", { method: "POST", body: payload }),
    bulkAddDnd: async (rows, source) => apiFetch("/api/voice/dnd", { method: "POST", body: { rows, source: source || "tenant_manual" } }),
    removeDnd: async (id) => apiFetch("/api/voice/dnd?id=" + encodeURIComponent(id), { method: "DELETE" }),
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

    // Inventory-planning module (Phase 2). All endpoints are tenant-
    // scoped + RLS-guarded; the apiFetch helper attaches the caller's
    // Authorization + tenant headers.
    positions: async (params) => {
      const qs = new URLSearchParams(params || {}).toString();
      return apiFetch("/api/inventory/positions" + (qs ? "?" + qs : ""));
    },
    forecasts: async (params) => {
      const qs = new URLSearchParams(params || {}).toString();
      return apiFetch("/api/inventory/forecasts" + (qs ? "?" + qs : ""));
    },
    forecastRuns: async (limit) => apiFetch("/api/inventory/forecast_runs" + (limit ? "?limit=" + limit : "")),
    forecastRun: async (id) => apiFetch("/api/inventory/forecast_runs?id=" + encodeURIComponent(id)),
    plans: {
      list: async (params) => {
        const qs = new URLSearchParams(params || {}).toString();
        return apiFetch("/api/inventory/plans" + (qs ? "?" + qs : ""));
      },
      approve: async (id) => apiFetch("/api/inventory/plans/" + encodeURIComponent(id) + "/approve", { method: "POST" }),
      release: async (id) => apiFetch("/api/inventory/plans/" + encodeURIComponent(id) + "/release", { method: "POST" }),
      cancel: async (id, reason) => apiFetch("/api/inventory/plans/" + encodeURIComponent(id) + "/cancel", { method: "POST", body: { reason } }),
      explain: async (planId) => apiFetch("/api/inventory/explain", { method: "POST", body: { plan_id: planId } }),
    },
    exceptions: {
      list: async (params) => {
        const qs = new URLSearchParams(params || {}).toString();
        return apiFetch("/api/inventory/exceptions" + (qs ? "?" + qs : ""));
      },
      ack:      async (id) => apiFetch("/api/inventory/exceptions/" + encodeURIComponent(id) + "/ack", { method: "POST" }),
      resolve:  async (id, note) => apiFetch("/api/inventory/exceptions/" + encodeURIComponent(id) + "/resolve", { method: "POST", body: { note } }),
      suppress: async (id, note) => apiFetch("/api/inventory/exceptions/" + encodeURIComponent(id) + "/suppress", { method: "POST", body: { note } }),
    },
    allocations: {
      list:   async (params) => {
        const qs = new URLSearchParams(params || {}).toString();
        return apiFetch("/api/inventory/allocations" + (qs ? "?" + qs : ""));
      },
      create: async (payload) => apiFetch("/api/inventory/allocations", { method: "POST", body: payload }),
      update: async (id, payload) => apiFetch("/api/inventory/allocations/" + encodeURIComponent(id), { method: "PATCH", body: payload }),
    },
    replan: async () => apiFetch("/api/inventory/replan", { method: "POST" }),
    // Phase 3.5: calibration + suppliers.
    calibration: async () => apiFetch("/api/inventory/calibration"),
    suppliers: {
      list: async () => apiFetch("/api/inventory/suppliers"),
      upsert: async (payload) => apiFetch("/api/inventory/suppliers", { method: "POST", body: payload }),
      update: async (id, payload) => apiFetch("/api/inventory/suppliers/" + encodeURIComponent(id), { method: "PATCH", body: payload }),
    },
    // Bet 3: conformal-prediction diagnostics + per-SKU override.
    conformalDiagnostics: async (partNo) => apiFetch(
      "/api/inventory/conformal_diagnostics" + (partNo ? "?part_no=" + encodeURIComponent(partNo) : ""),
    ),
    setConformalOverride: async (partNo, patch) => apiFetch(
      "/api/inventory/conformal_diagnostics?part_no=" + encodeURIComponent(partNo),
      { method: "PATCH", body: patch },
    ),
  };

  const masterData = {
    graph: async (params) => {
      const qs = new URLSearchParams(params || {}).toString();
      return apiFetch("/api/master_data/graph" + (qs ? "?" + qs : ""));
    },
  };

  // Bet 7: BRSR value-chain reporting. Two surfaces: supplier-side
  // disclosure CRUD + buyer-side rollup / export.
  const brsr = {
    periods: async (params) => {
      const qs = new URLSearchParams(params || {}).toString();
      return apiFetch("/api/brsr/period" + (qs ? "?" + qs : ""));
    },
    createPeriod: async (payload) => apiFetch("/api/brsr/period", { method: "POST", body: payload }),
    disclosure: async (periodId) => apiFetch("/api/brsr/disclosure?period_id=" + encodeURIComponent(periodId)),
    saveDisclosure: async (payload) => apiFetch("/api/brsr/disclosure", { method: "POST", body: payload }),
    submitDisclosure: async (payload) => apiFetch("/api/brsr/disclosure/submit", { method: "POST", body: payload }),
    prefill: async (fromFy) => apiFetch("/api/brsr/prefill?from_fy=" + encodeURIComponent(fromFy)),
    relationships: async () => apiFetch("/api/brsr/relationship"),
    invite: async (payload) => apiFetch("/api/brsr/relationship/invite", { method: "POST", body: payload }),
    acceptInvite: async (id) => apiFetch("/api/brsr/relationship/accept", { method: "POST", body: { id } }),
    rejectInvite: async (id) => apiFetch("/api/brsr/relationship/reject", { method: "POST", body: { id } }),
    revokeRelationship: async (id) => apiFetch("/api/brsr/relationship/revoke", { method: "POST", body: { id } }),
    buyerDashboard: async (fy) => apiFetch("/api/brsr/buyer/dashboard" + (fy ? "?fy=" + encodeURIComponent(fy) : "")),
    exportUrl: (fy, format) => {
      const qs = new URLSearchParams({ fy: fy || "", format: format || "csv" }).toString();
      return "/api/brsr/buyer/export?" + qs;
    },
  };

  // Bet 6: AA (Account Aggregator) + TReDS (Trade Receivables
  // Discounting System) receivables loop. Sandbox-mode methods
  // talk to mocked Setu / M1xchange backends when the tenant has
  // not configured a real partner yet.
  const aa = {
    list: async () => apiFetch("/api/aa/consent"),
    get: async (id) => apiFetch("/api/aa/consent?id=" + encodeURIComponent(id)),
    request: async (payload) => apiFetch("/api/aa/consent", { method: "POST", body: payload }),
    poll: async (id) => apiFetch("/api/aa/consent", { method: "PATCH", body: { id } }),
  };
  const treds = {
    list: async () => apiFetch("/api/treds/list"),
    offers: async (params) => {
      const qs = new URLSearchParams(params || {}).toString();
      return apiFetch("/api/treds/offer" + (qs ? "?" + qs : ""));
    },
    submitOffer: async (payload) => apiFetch("/api/treds/offer", { method: "POST", body: payload }),
    refreshOffer: async (id) => apiFetch("/api/treds/offer", { method: "PATCH", body: { id } }),
    acceptOffer: async (offerId) => apiFetch("/api/treds/accept", { method: "POST", body: { offer_id: offerId } }),
    eligibleBuyers: async () => apiFetch("/api/treds/eligible_buyers"),
    refreshEligibleBuyers: async () => apiFetch("/api/treds/eligible_buyers/refresh", { method: "POST" }),
  };

  // Bet 2: format-template marketplace.
  const marketplace = {
    list: async (params) => {
      const qs = new URLSearchParams(params || {}).toString();
      return apiFetch("/api/marketplace/list" + (qs ? "?" + qs : ""));
    },
    publish: async (payload) => apiFetch("/api/marketplace/publish", { method: "POST", body: payload }),
    revoke: async (globalId, reason) => apiFetch("/api/marketplace/revoke", {
      method: "POST", body: { global_id: globalId, reason },
    }),
    imports: async () => apiFetch("/api/marketplace/imports"),
    confirmImport: async (importId) => apiFetch("/api/marketplace/imports/confirm", {
      method: "POST", body: { import_id: importId },
    }),
    revertImport: async (importId, reason) => apiFetch("/api/marketplace/imports/revert", {
      method: "POST", body: { import_id: importId, reason },
    }),
    report: async (globalId, reason, evidence) => apiFetch("/api/marketplace/report", {
      method: "POST", body: { global_id: globalId, reason, evidence },
    }),
    reviewQueue: async () => apiFetch("/api/marketplace/review"),
    reviewDecide: async (globalId, decision, reason) => apiFetch("/api/marketplace/review", {
      method: "POST", body: { global_id: globalId, decision, reason },
    }),
    superAdminRevoke: async (globalId, reason) => apiFetch("/api/marketplace/review/revoke", {
      method: "POST", body: { global_id: globalId, reason },
    }),
  };

  const bom = {
    list: async (params) => {
      const qs = new URLSearchParams(params || {}).toString();
      return apiFetch("/api/bom" + (qs ? "?" + qs : ""));
    },
    upsert: async (rows) => apiFetch("/api/bom", { method: "POST", body: Array.isArray(rows) ? { rows } : rows }),
    remove: async (id) => apiFetch("/api/bom?id=" + encodeURIComponent(id), { method: "DELETE" }),
    // BOM ingestion (Phase 1): asset + lines import deriving item_master
    // + bill_of_materials, with provenance + project linkage.
    importBom: async (payload) => apiFetch("/api/bom/import", { method: "POST", body: payload }),
    assets: async (params) => {
      const qs = new URLSearchParams(params || {}).toString();
      return apiFetch("/api/bom/assets" + (qs ? "?" + qs : ""));
    },
    asset: async (id) => apiFetch("/api/bom/assets?id=" + encodeURIComponent(id)),
    assetByCode: async (code) => apiFetch("/api/bom/assets?asset_code=" + encodeURIComponent(code)),
    linkProject: async (payload) => apiFetch("/api/bom/asset_projects", { method: "POST", body: payload }),
    unlinkProject: async (assetId, projectId) =>
      apiFetch("/api/bom/asset_projects?asset_id=" + encodeURIComponent(assetId) + "&project_id=" + encodeURIComponent(projectId), { method: "DELETE" }),
    // Phase 2: tenant-configurable source-format registry + server-side
    // detect/column-map of a parsed sheet.
    sourceFormats: async () => apiFetch("/api/bom/source_formats"),
    saveSourceFormat: async (payload) => apiFetch("/api/bom/source_formats", { method: "PUT", body: payload }),
    deleteSourceFormat: async (key) => apiFetch("/api/bom/source_formats?key=" + encodeURIComponent(key), { method: "DELETE" }),
    parse: async (payload) => apiFetch("/api/bom/parse", { method: "POST", body: payload }),
  };

  // Operator actions (PR4): governed checklist for API-less steps with
  // evidence + reconcile-back. Flag-gated server-side.
  const operatorActions = {
    list: async (params) => { const qs = new URLSearchParams(params || {}).toString(); return apiFetch("/api/operator_actions" + (qs ? "?" + qs : "")); },
    get: async (id) => apiFetch("/api/operator_actions?id=" + encodeURIComponent(id)),
    create: async (payload) => apiFetch("/api/operator_actions", { method: "POST", body: payload }),
    advance: async (payload) => apiFetch("/api/operator_actions/advance", { method: "POST", body: payload }),
    attachEvidence: async (payload) => apiFetch("/api/operator_actions/evidence", { method: "POST", body: payload }),
    reconcile: async (payload) => apiFetch("/api/operator_actions/reconcile", { method: "POST", body: payload }),
  };

  // Copilot safe actions (PR2): list pending proposals, confirm (execute)
  // or cancel a proposed write action created by a write.* copilot tool.
  const copilot = {
    proposals: async () => apiFetch("/api/copilot/proposals"),
    confirm: async (confirmToken) => apiFetch("/api/copilot/confirm", { method: "POST", body: { confirm_token: confirmToken } }),
    cancel: async (confirmToken) => apiFetch("/api/copilot/confirm", { method: "POST", body: { confirm_token: confirmToken, cancel: true } }),
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
    // Phase F.6: drift-check mode + GET helpers + finding resolve.
    driftCheck: async (payload) => apiFetch("/api/tally/reconcile", {
      method: "POST",
      body: { mode: "drift_check", ...(payload || {}) },
    }),
    reconcileMark: async (payload) => apiFetch("/api/tally/reconcile", {
      method: "POST",
      body: { mode: "mark", ...(payload || {}) },
    }),
    listReconRuns: async (limit) => apiFetch("/api/tally/reconcile?scope=runs" + (limit ? "&limit=" + limit : "")),
    listReconFindings: async (limit) => apiFetch("/api/tally/reconcile?scope=findings" + (limit ? "&limit=" + limit : "")),
    getReconRun: async (runId) => apiFetch("/api/tally/reconcile?run_id=" + encodeURIComponent(runId)),
    getOrderRecon: async (orderId) => apiFetch("/api/tally/reconcile?order_id=" + encodeURIComponent(orderId)),
    resolveFinding: async (findingId) => apiFetch("/api/tally/reconcile?finding_id=" + encodeURIComponent(findingId), { method: "PATCH" }),
    // Bet 5: state lookup (latest run + addon flag + tolerance + auto-fix).
    // Drives the upsell card / first-run experience on tally-reconcile.tsx.
    getReconState: async () => apiFetch("/api/tally/reconcile"),
    enableDriftAddon: async (plan) => apiFetch("/api/tally/drift_addon", { method: "POST", body: { plan: plan || "trial" } }),
    disableDriftAddon: async () => apiFetch("/api/tally/drift_addon", { method: "DELETE" }),
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
    create: async (payload) => apiFetch("/api/source_pos", { method: "POST", body: payload }),
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
    // List communications for an order or source PO. ThreadDrawer
    // populates its comms panel from this endpoint; was missing,
    // so the comms timeline rendered empty regardless of how many
    // emails the order had attached.
    list: async (orderId) => {
      const qs = orderId ? "?order_id=" + encodeURIComponent(orderId) : "";
      return apiFetch("/api/communications" + qs);
    },
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
    // Audit P7.1: Haiku lead scoring. id triggers single-lead score;
    // omit id to trigger a batch drain (admin only).
    scoreLead: async (id) => apiFetch("/api/sales/score_lead" + (id ? "?id=" + encodeURIComponent(id) : "")),
    rescoreLeads: async () => apiFetch("/api/sales/score_lead", { method: "POST" }),
    listOpportunities: async (params) => apiFetch("/api/sales/opportunities" + (params ? "?" + new URLSearchParams(params).toString() : "")),
    createOpportunity: async (payload) => apiFetch("/api/sales/opportunities", { method: "POST", body: payload }),
    updateOpportunity: async (payload) => apiFetch("/api/sales/opportunities", { method: "PATCH", body: payload }),
    deleteOpportunity: async (id) => apiFetch("/api/sales/opportunities?id=" + encodeURIComponent(id), { method: "DELETE" }),
    // Migration 086 line items: feeds inventory pipeline-demand calculation.
    listOpportunityLines: async (opportunity_id) => apiFetch("/api/opportunities/line_items?opportunity_id=" + encodeURIComponent(opportunity_id)),
    createOpportunityLine: async (payload) => apiFetch("/api/opportunities/line_items", { method: "POST", body: payload }),
    updateOpportunityLine: async (id, payload) => apiFetch("/api/opportunities/line_items?id=" + encodeURIComponent(id), { method: "PATCH", body: payload }),
    deleteOpportunityLine: async (id) => apiFetch("/api/opportunities/line_items?id=" + encodeURIComponent(id), { method: "DELETE" }),
    // Audit P7.2: Haiku close-probability prediction.
    predictOpportunity: async (id) => apiFetch("/api/sales/predict_opportunity" + (id ? "?id=" + encodeURIComponent(id) : "")),
    repredictOpportunities: async () => apiFetch("/api/sales/predict_opportunity", { method: "POST" }),
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
    // Per-role left-nav visibility (admin chooses which nav items are
    // activated for each role). GET is read-level; update is approve-level.
    navSettings:       async () => apiFetch("/api/admin/nav_settings"),
    updateNavSettings: async (patch) => apiFetch("/api/admin/nav_settings", { method: "PATCH", body: patch }),
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
    listPricingProfiles: async () => apiFetch("/api/admin/pricing_profiles"),
    upsertPricingProfile: async (payload) => apiFetch("/api/admin/pricing_profiles", { method: "POST", body: payload }),
    deletePricingProfile: async (id) => apiFetch("/api/admin/pricing_profiles?id=" + encodeURIComponent(id), { method: "DELETE" }),
    // P3 account/supplier-aware pricing bindings.
    listPricingBindings: async (params) => apiFetch("/api/admin/pricing_profile_bindings" + (params ? "?" + new URLSearchParams(params).toString() : "")),
    upsertPricingBinding: async (payload) => apiFetch("/api/admin/pricing_profile_bindings", { method: "POST", body: payload }),
    deletePricingBinding: async (id) => apiFetch("/api/admin/pricing_profile_bindings?id=" + encodeURIComponent(id), { method: "DELETE" }),
    // P3 raw-material price reference (market-tracking material costs).
    listMaterialPrices: async (params) => apiFetch("/api/admin/material_price_references" + (params ? "?" + new URLSearchParams(params).toString() : "")),
    upsertMaterialPrice: async (payload) => apiFetch("/api/admin/material_price_references", { method: "POST", body: payload }),
    deleteMaterialPrice: async (id) => apiFetch("/api/admin/material_price_references?id=" + encodeURIComponent(id), { method: "DELETE" }),
    listPriceComposition: async (quote_id) => apiFetch("/api/admin/price_composition_lines?quote_id=" + encodeURIComponent(quote_id)),
    recomputePriceComposition: async (payload) => apiFetch("/api/admin/price_composition_lines?action=recompute", { method: "POST", body: payload }),
    // P2 recipe-authoring: drawing-derived raw-material breakup per
    // composition line; POST syncs into bill_of_materials.
    listCompositionMaterials: async (quote_id) => apiFetch("/api/admin/composition_material_lines?quote_id=" + encodeURIComponent(quote_id)),
    saveCompositionMaterials: async (payload) => apiFetch("/api/admin/composition_material_lines", { method: "POST", body: payload }),
    deleteCompositionMaterial: async (id) => apiFetch("/api/admin/composition_material_lines?id=" + encodeURIComponent(id), { method: "DELETE" }),
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

  // P4 logistics: freight consolidation + LCL/FCL bidding.
  const logistics = {
    listConsolidations: async (params) => apiFetch("/api/logistics/consolidations" + (params ? "?" + new URLSearchParams(params).toString() : "")),
    buildConsolidations: async (payload) => apiFetch("/api/logistics/consolidations", { method: "POST", body: { action: "build", ...(payload || {}) } }),
    setConsolidationStatus: async (id, status) => apiFetch("/api/logistics/consolidations", { method: "POST", body: { id, status } }),
    listBids: async (consolidationId) => apiFetch("/api/logistics/freight_bids?consolidation_id=" + encodeURIComponent(consolidationId)),
    addBid: async (payload) => apiFetch("/api/logistics/freight_bids", { method: "POST", body: payload }),
    awardBid: async (id) => apiFetch("/api/logistics/freight_bids", { method: "POST", body: { action: "award", id } }),
    deleteBid: async (id) => apiFetch("/api/logistics/freight_bids?id=" + encodeURIComponent(id), { method: "DELETE" }),
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
    sageX3,
    ifs,
    oracleFusion,
    ramco,
    jde,
    plex,
    jobboss,
    oracleEbs,
    proalpha,
    razorpay,
    push,
    portal,
    portalCustomer,
    travelers,
    analytics,
    supplierRfq,
    reconcile,
    catalog,
    kb,
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
    logistics,
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
    accessRequests,
    verticalPacks,
    accessReview,
    auditExport,
    ap,
    agentEval,
    docaiRoute,
    prospecting,
    notifications,
    ocr,
    scan,
    voice,
    fx,
    delivery,
    inventory,
    masterData,
    brsr,
    aa,
    treds,
    marketplace,
    bom,
    copilot,
    operatorActions,
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
    // Audit P7.5 / P7.6 / P7.7 client surfaces.
    creditNotes,
    billingRecurring,
    ewayBills,
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
