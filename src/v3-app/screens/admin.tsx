import React, { useEffect, useState } from "react";
import { ageLabel, fmtDate, fmtINRShort, useFetch } from "../lib/helpers";
import { Banner, Btn, Card, Chip, KV, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { AnvilBackend } from "../lib/api";
import { RBAC, MATRIX, ACTIONS } from "../lib/rbac";
import { Prefs } from "../lib/preferences";
import { PricingProfilesAdmin } from "../components/PricingProfilesAdmin";
import { NavVisibilityAdmin } from "../components/NavVisibilityAdmin";
import { OptionListEditor } from "../components/OptionListEditor";

// ============================================================
// ANVIL v3 — Admin Center CRUD overlay
// Replaces wired-admin-f.jsx via load-order. Keeps every existing
// tab working and adds:
//   - Holiday delete (per-row)
//   - Lead time create/delete
//   - Approval thresholds CRUD (was read-only)
//   - Customer locations tab (CRUD)
//   - Contracts tab (CRUD: ARC / BLANKET / AMC types)
//   - Item master tab (inline edit + delete + CSV bulk import)
//   - Live diagnostics from /api/admin/diagnostics
//
// All admin-only. Backend methods on AnvilBackend.admin (already
// in src/client/anvil-client.js):
//   listHolidays/upsertHoliday/deleteHoliday
//   listLeadTimes/upsertLeadTime/deleteLeadTime
//   listApprovalThresholds/upsertApprovalThreshold/deleteApprovalThreshold
//   listCustomerLocations/upsertCustomerLocation/deleteCustomerLocation
//   listContracts/upsertContract/deleteContract
//   listItemMaster/upsertItemMaster/bulkItemMaster/deleteItemMaster
//   diagnostics()
// ============================================================

const ADMIN_CRUD_TABS = [
  { id: "access",    label: "Access requests" },
  { id: "members",   label: "Members" },
  { id: "profile",   label: "My profile" },
  { id: "security",  label: "Security" },
  { id: "roles",     label: "Roles & permissions" },
  { id: "navigation",label: "Navigation" },
  { id: "billing",   label: "Billing" },
  { id: "netsuite",  label: "NetSuite" },
  { id: "tally",     label: "Tally" },
  { id: "sage_x3",   label: "Sage X3" },
  { id: "ifs",            label: "IFS Cloud" },
  { id: "oracle_fusion",  label: "Oracle Fusion" },
  { id: "ramco",          label: "Ramco" },
  { id: "jde",            label: "JD Edwards" },
  { id: "plex",           label: "Plex" },
  { id: "jobboss",        label: "JobBoss" },
  { id: "oracle_ebs",     label: "Oracle EBS" },
  { id: "proalpha",       label: "proALPHA" },
  { id: "plm",       label: "PLM" },
  { id: "voice",     label: "Voice" },
  { id: "chat",      label: "Chat channels" },
  { id: "settings",  label: "Settings" },
  { id: "holidays",  label: "Holidays" },
  { id: "leadtimes", label: "Lead times" },
  { id: "fx",        label: "FX rates" },
  { id: "thresh",    label: "Approval thresholds" },
  { id: "locations", label: "Customer locations" },
  { id: "contracts", label: "Contracts" },
  { id: "items",     label: "Item master" },
  { id: "item_fields", label: "Item fields" },
  { id: "doc_templates", label: "Document templates" },
  { id: "freight", label: "Freight rates" },
  { id: "pricing", label: "Pricing settings" },
  { id: "pricing_profiles", label: "Pricing profiles" },
  { id: "vendor_codes", label: "Vendor codes" },
  { id: "customer_parts", label: "Customer parts" },
  { id: "terms_packs", label: "Customer terms" },
  { id: "docai_cost", label: "DocAI cost" },
  { id: "diag",      label: "Diagnostics" },
];

// Group the (~39) admin tabs into categories so the nav is a short category
// row + only the selected category's tabs, instead of one long horizontally
// scrolling strip.
const ADMIN_TAB_GROUPS: { label: string; ids: string[] }[] = [
  { label: "Team & access", ids: ["access", "members", "profile", "security", "roles", "navigation", "billing"] },
  { label: "ERP connectors", ids: ["netsuite", "tally", "sage_x3", "ifs", "oracle_fusion", "ramco", "jde", "plex", "jobboss", "oracle_ebs", "proalpha", "plm"] },
  { label: "Channels", ids: ["voice", "chat"] },
  { label: "Sales & quotes", ids: ["settings", "holidays", "leadtimes", "fx", "thresh", "doc_templates", "terms_packs"] },
  { label: "Master data", ids: ["locations", "contracts", "items", "item_fields", "vendor_codes", "customer_parts"] },
  { label: "Pricing & freight", ids: ["pricing", "pricing_profiles", "freight"] },
  { label: "AI & diagnostics", ids: ["docai_cost", "diag"] },
];
const ADMIN_TAB_LABEL: Record<string, string> = Object.fromEntries(ADMIN_CRUD_TABS.map((t) => [t.id, t.label]));
const adminGroupOf = (id: string): string => (ADMIN_TAB_GROUPS.find((g) => g.ids.includes(id)) || ADMIN_TAB_GROUPS[0]).label;

const ADMIN_ROLES = ["sales_engineer", "sales_manager", "procurement", "finance", "admin", "operator", "viewer"];
const ADMIN_DRAWING_BASE_KEY = "obara:drawing_base_url";
const CONTRACT_TYPES = ["ARC", "BLANKET", "AMC", "PROJECT"];

const adminCrudFetch = async (path: string, opts: { method?: string; body?: any; headers?: Record<string, string> } = {}) => {
  const cfg = (AnvilBackend?.getConfig?.() || {}) as { url?: string; tenantId?: string };
  const session = (AnvilBackend?.getSession?.() || null) as { access_token?: string } | null;
  const headers: Record<string, string> = { "Content-Type": "application/json", ...((opts.headers as Record<string, string>) || {}) };
  if (session?.access_token) headers.Authorization = "Bearer " + session.access_token;
  if (cfg.tenantId) headers["x-anvil-tenant"] = cfg.tenantId;
  const url = (cfg.url || "").replace(/\/+$/, "") + path;
  const resp = await fetch(url, {
    ...opts,
    headers,
    body: opts.body && typeof opts.body !== "string" ? JSON.stringify(opts.body) : opts.body,
  });
  if (!resp.ok) throw new Error("HTTP " + resp.status + ": " + (await resp.text()));
  if (resp.status === 204) return null;
  return resp.json();
};

const adminCrudRows = (resp, key) => {
  if (!resp) return [];
  if (Array.isArray(resp)) return resp;
  if (key && Array.isArray(resp[key])) return resp[key];
  if (Array.isArray(resp.rows)) return resp.rows;
  return [];
};

const adminFxRowsFromResp = (resp) => {
  if (!resp) return [];
  if (Array.isArray(resp)) return resp;
  if (Array.isArray(resp.rates)) return resp.rates;
  if (Array.isArray(resp.rows)) return resp.rows;
  if (resp.pairs && typeof resp.pairs === "object") {
    return Object.entries(resp.pairs).map(([pair, info]: [string, any]) => ({
      pair,
      rate: typeof info === "object" ? (info?.rate ?? info?.spot) : info,
      as_of: typeof info === "object" ? (info?.as_of ?? info?.timestamp) : null,
    }));
  }
  return [];
};

// Minimal CSV parser. Handles quoted fields + escaped quotes.
const parseCSV = (text) => {
  const rows = [];
  let cur = [];
  let field = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQ = false;
      else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { cur.push(field); field = ""; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        cur.push(field); rows.push(cur); cur = []; field = "";
      }
      else field += c;
    }
  }
  if (field.length > 0 || cur.length > 0) { cur.push(field); rows.push(cur); }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ""));
};

// Read the currently signed-in user id from the cached profile (or the
// session payload) so we can decorate the row that represents "you" in
// the Members table. Without this, last-sign-in for the user actively
// using the app shows the timestamp of when their last fresh sign-in
// happened (Supabase only updates `last_sign_in_at` on session create,
// not on every refresh), which the user reads as "stale".
const readCurrentUserId = (): string | null => {
  try {
    const cached = JSON.parse(localStorage.getItem("obara:auth_profile") || "null");
    if (cached?.user?.id) return String(cached.user.id);
  } catch (_) { /* ignore */ }
  try {
    const session = (AnvilBackend?.getSession?.() || null) as { user?: { id?: string } } | null;
    if (session?.user?.id) return String(session.user.id);
  } catch (_) { /* ignore */ }
  return null;
};

const WiredAdminCRUD = () => {
  const { useState: u, useEffect: e } = React;
  const isAdmin = !!(RBAC && RBAC.isAdmin && RBAC.isAdmin());
  const currentUserId = readCurrentUserId();

  // Read the initial tab from the URL hash so notifications and
  // /admin?tab=<x> deep-links land on the right panel.
  const initialTab = (() => {
    try {
      const q = (window.location.hash.split("?")[1] || "");
      const params = new URLSearchParams(q);
      const want = params.get("tab");
      if (want && ADMIN_CRUD_TABS.some((t) => t.id === want)) return want;
    } catch (_) { /* fallthrough */ }
    return "members";
  })();
  const [active, setActive] = u(initialTab);
  // Which settings category is shown in the nav. Derived from the active tab
  // so deep-links / ?tab= land on the right category.
  const [cat, setCat] = u(() => adminGroupOf(initialTab));
  const selectCategory = (label: string) => {
    setCat(label);
    const g = ADMIN_TAB_GROUPS.find((x) => x.label === label);
    if (g && !g.ids.includes(active)) setActive(g.ids[0]);
  };
  const [busy, setBusy] = u(false);
  const [flash, setFlash] = u(null);
  const [memberForm, setMemberForm] = u({ email: "", role: "sales_engineer" });
  // After a successful invite, hold onto the action_link so the admin can
  // copy it and forward it manually when SMTP is misconfigured. Cleared on
  // any subsequent flash or form change.
  const [inviteLink, setInviteLink] = u<string | null>(null);
  // Confirm-revoke dialog. We replaced window.confirm() so the modal
  // matches the rest of the design system.
  const [revokeFor, setRevokeFor] = u<{ user_id: string; email: string } | null>(null);
  // My Profile tab state. Loaded from /api/auth/profile on mount once
  // the user opens the tab, persisted via PATCH on the same route.
  const [profile, setProfile] = u<{ user?: any; memberships?: any[] } | null>(null);
  const [profileName, setProfileName] = u("");
  const [profileBusy, setProfileBusy] = u(false);
  // Billing tab state. Loaded lazily; the billing endpoint is read-only.
  const [billing, setBilling] = u<any>(null);
  const [billingFrom, setBillingFrom] = u<string>("month-to-date");
  // Stripe Connect status loaded alongside billing.
  const [stripe, setStripe] = u<any>(null);
  const [stripeBusy, setStripeBusy] = u(false);
  // NetSuite tenant state loaded when the operator opens the tab.
  const [netsuite, setNetsuite] = u<any>(null);
  const [nsBusy, setNsBusy] = u(false);
  const [nsForm, setNsForm] = u({
    account_id: "", consumer_key: "", consumer_secret: "", token_id: "", token_secret: "",
    subsidiary_id: "", default_location_id: "",
  });
  const [nsDiag, setNsDiag] = u<any>(null);
  const [nsDiagBusy, setNsDiagBusy] = u(false);
  const [nsSyncBusy, setNsSyncBusy] = u(false);
  const [nsRetryBusy, setNsRetryBusy] = u(false);
  const [nsFieldMapDraft, setNsFieldMapDraft] = u<string>("{}");
  const [nsFieldMapBusy, setNsFieldMapBusy] = u(false);
  const [holidayForm, setHolidayForm] = u({ country: "IN", date: "", name: "" });
  const [leadTimeForm, setLeadTimeForm] = u({ type: "supplier", entity_id: "", days: "", notes: "" });
  const [threshForm, setThreshForm] = u(null);
  const [locForm, setLocForm] = u(null);
  const [contractForm, setContractForm] = u(null);
  const [itemForm, setItemForm] = u(null);
  const [csvBusy, setCsvBusy] = u(false);
  const [drawingBase, setDrawingBase] = u(() => { try { return localStorage.getItem(ADMIN_DRAWING_BASE_KEY) || ""; } catch (_) { return ""; } });
  const [drawingDraft, setDrawingDraft] = u(() => { try { return localStorage.getItem(ADMIN_DRAWING_BASE_KEY) || ""; } catch (_) { return ""; } });
  // Tenant quote defaults + line-item option lists (backend tenant_settings).
  // Loaded when the Settings tab opens. *Draft holds the editable value;
  // *Saved is the last persisted snapshot used for the dirty check.
  const [quoteValidity, setQuoteValidity] = u<string>("");
  const [quoteValidityDraft, setQuoteValidityDraft] = u<string>("");
  const [quoteUnits, setQuoteUnits] = u<string[]>([]);
  const [quoteUnitsSaved, setQuoteUnitsSaved] = u<string[]>([]);
  const [quoteSources, setQuoteSources] = u<string[]>([]);
  const [quoteSourcesSaved, setQuoteSourcesSaved] = u<string[]>([]);
  const [quoteCurrencies, setQuoteCurrencies] = u<string[]>([]);
  const [quoteCurrenciesSaved, setQuoteCurrenciesSaved] = u<string[]>([]);
  const [quoteSettingsSaving, setQuoteSettingsSaving] = u(false);
  const [quoteSettingsLoaded, setQuoteSettingsLoaded] = u(false);

  const flashOk = (msg) => setFlash({ kind: "good", msg });
  const flashErr = (err) => setFlash({ kind: "bad", msg: String(err.message || err) });

  // Data fetchers
  const members = useFetch(
    () => fetch("/api/admin/members").then((r) => r.ok ? r.json() : { members: [] }).catch(() => ({ members: [] })),
    []
  );
  const holidays = useFetch(
    () => AnvilBackend?.admin?.listHolidays?.()
          || fetch("/api/admin/holidays").then((r) => r.ok ? r.json() : { holidays: [] }).catch(() => ({ holidays: [] })),
    []
  );
  const leadTimes = useFetch(
    () => AnvilBackend?.admin?.listLeadTimes?.(leadTimeForm.type)
          || fetch("/api/admin/lead_times?type=" + encodeURIComponent(leadTimeForm.type))
              .then((r) => r.ok ? r.json() : { lead_times: [] }).catch(() => ({ lead_times: [] })),
    [leadTimeForm.type]
  );
  const fxRates = useFetch(
    () => AnvilBackend?.fx?.lookup?.({ pairs: ["USD/INR", "JPY/INR", "CNY/INR"] }) || Promise.resolve({ rates: [] }),
    []
  );
  const thresholds = useFetch(
    () => AnvilBackend?.admin?.listApprovalThresholds?.()
          || adminCrudFetch("/api/admin/quote_approvals?type=thresholds"),
    []
  );
  const customers = useFetch(
    () => AnvilBackend?.customers?.list?.() || adminCrudFetch("/api/customers"),
    []
  );
  const locations = useFetch(
    () => AnvilBackend?.admin?.listCustomerLocations?.() || adminCrudFetch("/api/admin/customer_locations"),
    []
  );
  const contracts = useFetch(
    () => AnvilBackend?.admin?.listContracts?.() || adminCrudFetch("/api/admin/contracts"),
    []
  );
  const itemMaster = useFetch(
    () => AnvilBackend?.admin?.listItemMaster?.({ limit: 500 })
          || adminCrudFetch("/api/admin/item_master?limit=500"),
    []
  );
  const diagnostics = useFetch(
    () => AnvilBackend?.admin?.diagnostics?.()
          || adminCrudFetch("/api/admin/diagnostics"),
    []
  );

  if (!isAdmin) {
    return (
      <div className="ws ws-no-rail">
        <WSTitle eyebrow="Admin" title="Restricted" meta="admin only" />
        <div className="ws-content">
          <Banner kind="warn" icon={Icon.lock} title="Insufficient permissions">
            <span className="mono-sm">Admin Center is only available to users with the admin role.</span>
          </Banner>
        </div>
      </div>
    );
  }

  const memberRows = adminCrudRows(members.data, "members");
  const holidayRows = adminCrudRows(holidays.data, "holidays");
  const leadTimeRows = adminCrudRows(leadTimes.data, "lead_times");
  const fxRows = adminFxRowsFromResp(fxRates.data);
  const thresholdRows = adminCrudRows(thresholds.data, "thresholds");
  const customerRows = adminCrudRows(customers.data, "customers");
  const locationRows = adminCrudRows(locations.data, "locations");
  const contractRows = adminCrudRows(contracts.data, "contracts");
  const itemRows = adminCrudRows(itemMaster.data, "items");

  const tenantSlug = (AnvilBackend && AnvilBackend.getConfig
    && AnvilBackend.getConfig().tenantId)
    || localStorage.getItem("obara:v3_tenant_code") || "—";

  const customerName = (id) => {
    const c = customerRows.find((x) => x.id === id);
    return c?.customer_name || c?.customer_key || (id ? id.slice(0, 8) : "—");
  };

  // ---------- Members ----------
  // RFC 5322 simplified: any non-space, @, any non-space, dot, any non-space.
  // Good enough to catch typos without rejecting valid edge cases.
  const isValidEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

  const onAddMember = async (ev) => {
    ev.preventDefault();
    const email = memberForm.email.trim();
    if (!isValidEmail(email)) return flashErr(new Error("Enter a valid email address"));
    setBusy(true); setFlash(null); setInviteLink(null);
    try {
      const resp = await adminCrudFetch("/api/admin/members", { method: "POST", body: { email, role: memberForm.role } });
      flashOk(`Invited ${email}`);
      setInviteLink(resp?.action_link || null);
      setMemberForm({ email: "", role: "sales_engineer" });
      members.reload();
    } catch (err) { flashErr(err); }
    finally { setBusy(false); }
  };

  const onResendInvite = async (email: string) => {
    setBusy(true); setFlash(null); setInviteLink(null);
    try {
      const resp = await adminCrudFetch("/api/admin/members", { method: "POST", body: { email, resend: true } });
      flashOk(`Invite link regenerated for ${email}`);
      setInviteLink(resp?.action_link || null);
    } catch (err) { flashErr(err); }
    finally { setBusy(false); }
  };

  const onCopyInviteLink = async () => {
    if (!inviteLink) return;
    try {
      await navigator.clipboard.writeText(inviteLink);
      flashOk("Invite link copied to clipboard");
    } catch (_) {
      // Clipboard API can be blocked (insecure context). Fall back to a
      // visible textarea so the admin can copy manually.
      flashErr(new Error("Could not access clipboard. Select the link below and copy it manually."));
    }
  };

  const onChangeRole = async (userId, role) => {
    setBusy(true); setFlash(null);
    try {
      await adminCrudFetch("/api/admin/members", { method: "PATCH", body: { user_id: userId, role } });
      flashOk("Role updated");
      members.reload();
    } catch (err) { flashErr(err); }
    finally { setBusy(false); }
  };

  const onRemoveMember = async () => {
    if (!revokeFor) return;
    setBusy(true); setFlash(null);
    try {
      await adminCrudFetch(`/api/admin/members?user_id=${encodeURIComponent(revokeFor.user_id)}`, { method: "DELETE" });
      flashOk(`Removed ${revokeFor.email}`);
      setRevokeFor(null);
      members.reload();
    } catch (err) { flashErr(err); }
    finally { setBusy(false); }
  };

  // ---------- My profile ----------
  const loadProfile = async () => {
    try {
      const resp = await adminCrudFetch("/api/auth/profile");
      setProfile(resp);
      setProfileName(resp?.user?.display_name || "");
    } catch (err) { flashErr(err); }
  };

  e(() => {
    if (active === "profile" && !profile) loadProfile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const loadBilling = async (from?: string) => {
    try {
      const params: Record<string, string> = {};
      if (from && from !== "month-to-date") params.from = from;
      const resp = await AnvilBackend?.billing?.usage?.(params);
      setBilling(resp);
    } catch (err) { flashErr(err); }
  };

  const loadStripe = async () => {
    try {
      const resp = await AnvilBackend?.billing?.stripe?.status?.();
      setStripe(resp);
    } catch (err) { flashErr(err); }
  };

  const onStripeConnect = async () => {
    setStripeBusy(true);
    try {
      const resp: any = await AnvilBackend?.billing?.stripe?.onboard?.();
      if (resp?.onboarding_url) window.open(resp.onboarding_url, "_blank", "noopener");
    } catch (err) { flashErr(err); }
    finally { setStripeBusy(false); }
  };

  const loadNetsuite = async () => {
    try {
      const resp = await AnvilBackend?.netsuite?.health?.();
      setNetsuite(resp);
      if (resp?.field_map) {
        try { setNsFieldMapDraft(JSON.stringify(resp.field_map, null, 2)); }
        catch (_e) { setNsFieldMapDraft("{}"); }
      }
    } catch (err) { flashErr(err); }
  };

  const onNsConnect = async (ev) => {
    ev.preventDefault();
    if (!nsForm.account_id || !nsForm.consumer_key) return flashErr(new Error("All fields are required"));
    setNsBusy(true);
    try {
      const resp: any = await AnvilBackend?.netsuite?.connect?.(nsForm);
      if (resp?.ok) {
        flashOk("NetSuite probe succeeded; credentials stored " + (resp?.storage_mode || "plaintext") + ". Sync runs every 30 minutes.");
      } else {
        flashErr(new Error("NetSuite probe failed: " + JSON.stringify(resp?.probe_error || resp).slice(0, 200)));
      }
      setNetsuite(null);
      loadNetsuite();
      setNsForm({ account_id: "", consumer_key: "", consumer_secret: "", token_id: "", token_secret: "", subsidiary_id: "", default_location_id: "" });
    } catch (err) { flashErr(err); }
    finally { setNsBusy(false); }
  };

  const onNsRunDiagnostics = async () => {
    setNsDiagBusy(true);
    try {
      const resp = await AnvilBackend?.netsuite?.diagnostics?.();
      setNsDiag(resp);
      if (resp?.summary?.all_ok) flashOk("All probes passed in " + (resp?.probes || []).length + " entities");
      else flashErr(new Error((resp?.summary?.failed || 0) + " probe(s) failed; see diagnostics table"));
    } catch (err) { flashErr(err); }
    finally { setNsDiagBusy(false); }
  };

  const onNsSyncNow = async (entity: string | null, full: boolean) => {
    setNsSyncBusy(true);
    try {
      const body: any = {};
      if (entity) body.entity = entity;
      if (full) body.full = true;
      const resp = await AnvilBackend?.netsuite?.syncNow?.(body);
      flashOk("Manual sync ran for " + ((resp?.results || []).length || 0) + " entities");
      loadNetsuite();
    } catch (err) { flashErr(err); }
    finally { setNsSyncBusy(false); }
  };

  const onNsRetryNow = async () => {
    setNsRetryBusy(true);
    try {
      const resp = await AnvilBackend?.netsuite?.retry?.();
      flashOk("Replayed " + ((resp?.processed || 0)) + " queued pushes");
      loadNetsuite();
    } catch (err) { flashErr(err); }
    finally { setNsRetryBusy(false); }
  };

  const onNsSaveFieldMap = async () => {
    setNsFieldMapBusy(true);
    try {
      let parsed: any = {};
      try { parsed = JSON.parse(nsFieldMapDraft || "{}"); }
      catch (_e) { throw new Error("Field map must be valid JSON"); }
      await AnvilBackend?.netsuite?.saveFieldMap?.(parsed);
      flashOk("Field map saved (" + Object.keys(parsed).length + " entries)");
      loadNetsuite();
    } catch (err) { flashErr(err); }
    finally { setNsFieldMapBusy(false); }
  };

  // Tally v2 state.
  const [tally, setTally] = u<any>(null);
  const [tallyDiag, setTallyDiag] = u<any>(null);
  const [tallyDiagBusy, setTallyDiagBusy] = u(false);
  const [tallySyncBusy, setTallySyncBusy] = u(false);
  const [tallyRetryBusy, setTallyRetryBusy] = u(false);
  const [tallyCompanyForm, setTallyCompanyForm] = u<any>({
    name: "", bridge_url: "", bridge_token: "", gstin: "",
    default_voucher_series: "", default_sales_ledger: "",
  });
  const [tallyCompanyBusy, setTallyCompanyBusy] = u(false);

  // ---------- Security: TOTP MFA + passkeys ----------
  const [security, setSecurity] = u<any>(null);
  const [securityBusy, setSecurityBusy] = u(false);
  // The QR-rendering state. enrollData carries { secret, otpauth_uri, expires_at }
  // returned by /api/auth/mfa enroll. enrollCode is the 6-digit code the
  // user types from their authenticator. unenrollCode is the same shape
  // for the disable path.
  const [enrollData, setEnrollData] = u<{ secret: string; otpauth_uri: string; expires_at: string } | null>(null);
  const [enrollCode, setEnrollCode] = u("");
  const [unenrollCode, setUnenrollCode] = u("");

  const loadSecurity = async () => {
    try {
      const resp: any = await AnvilBackend?.auth?.mfaSettings?.();
      setSecurity(resp);
    } catch (err) { flashErr(err); }
  };
  const onMfaStart = async () => {
    setSecurityBusy(true);
    try {
      const resp: any = await AnvilBackend?.auth?.mfaEnroll?.();
      setEnrollData(resp);
      setEnrollCode("");
      flashOk("Scan the QR with Authy / Google Authenticator / 1Password and enter the 6-digit code below.");
    } catch (err: any) {
      flashErr(err); window.notifyError?.("Could not start MFA enrolment", err?.message);
    } finally { setSecurityBusy(false); }
  };
  const onMfaVerify = async () => {
    const code = enrollCode.replace(/\D/g, "");
    if (code.length !== 6) return flashErr(new Error("Code must be 6 digits"));
    setSecurityBusy(true);
    try {
      await AnvilBackend?.auth?.mfaVerify?.(code);
      flashOk("Two-factor authentication is on. From now on you'll need a code at sign-in.");
      window.notifySuccess?.("MFA enabled", "Two-factor authentication is active");
      setEnrollData(null);
      setEnrollCode("");
      loadSecurity();
    } catch (err: any) {
      flashErr(err); window.notifyError?.("MFA verification failed", err?.message);
    } finally { setSecurityBusy(false); }
  };
  // ---------- Passkeys (WebAuthn) ----------
  const [passkeys, setPasskeys] = u<any[]>([]);
  const [passkeyLabel, setPasskeyLabel] = u("");
  const [passkeyBusy, setPasskeyBusy] = u(false);

  const loadPasskeys = async () => {
    try {
      const resp: any = await AnvilBackend?.auth?.passkeyList?.();
      setPasskeys(resp?.passkeys || []);
    } catch (err) { flashErr(err); }
  };
  const onPasskeyRegister = async () => {
    if (!window.PublicKeyCredential) {
      return flashErr(new Error("This browser doesn't support passkeys (WebAuthn)."));
    }
    setPasskeyBusy(true);
    try {
      const begin: any = await AnvilBackend?.auth?.passkeyRegisterBegin?.(passkeyLabel.trim() || null);
      // Lazy-load @simplewebauthn/browser to keep the main bundle small.
      const { startRegistration } = await import("@simplewebauthn/browser");
      const att = await startRegistration(begin.options);
      await AnvilBackend?.auth?.passkeyRegisterFinish?.(begin.pending_id, att);
      flashOk("Passkey registered.");
      window.notifySuccess?.("Passkey registered", passkeyLabel || "Default");
      setPasskeyLabel("");
      loadPasskeys();
      loadSecurity();
    } catch (err: any) {
      flashErr(err);
      window.notifyError?.("Passkey registration failed", err?.message);
    } finally { setPasskeyBusy(false); }
  };
  const onPasskeyRemove = async (row: any) => {
    if (!window.confirm(`Remove the passkey "${row.label || "this device"}"? You'll need at least one other way to sign in.`)) return;
    setPasskeyBusy(true);
    try {
      await AnvilBackend?.auth?.passkeyRemove?.(row.id);
      flashOk("Passkey removed.");
      loadPasskeys(); loadSecurity();
    } catch (err: any) {
      flashErr(err); window.notifyError?.("Could not remove passkey", err?.message);
    } finally { setPasskeyBusy(false); }
  };

  const onMfaDisable = async () => {
    const code = unenrollCode.replace(/\D/g, "");
    if (code.length !== 6) return flashErr(new Error("Enter the current 6-digit code from your authenticator"));
    if (!window.confirm("Disable two-factor authentication for your account? You'll be able to sign in with just your password until you re-enable it.")) return;
    setSecurityBusy(true);
    try {
      await AnvilBackend?.auth?.mfaUnenroll?.(code);
      flashOk("Two-factor authentication is off.");
      window.notifySuccess?.("MFA disabled", "");
      setUnenrollCode("");
      loadSecurity();
    } catch (err: any) {
      flashErr(err); window.notifyError?.("Could not disable MFA", err?.message);
    } finally { setSecurityBusy(false); }
  };

  // ---------- Access requests (approval flow) ----------
  const [accessRequests, setAccessRequests] = u<any>(null);
  const [accessBusy, setAccessBusy] = u<string | null>(null);
  const [accessFilter, setAccessFilter] = u<"pending" | "approved" | "denied" | "all">("pending");
  const [accessEdits, setAccessEdits] = u<Record<string, { role?: string; display_name?: string; reason?: string }>>({});

  const loadAccessRequests = async () => {
    try {
      const params: Record<string, string> = {};
      if (accessFilter !== "all") params.status = accessFilter;
      const resp: any = await AnvilBackend?.accessRequests?.list?.(params);
      setAccessRequests(resp);
    } catch (err) { flashErr(err); }
  };

  const onAccessApprove = async (row: any) => {
    setAccessBusy(row.user_id);
    try {
      const edit = accessEdits[row.user_id] || {};
      const role = edit.role || row.requested_role || row.role || "sales_engineer";
      // If the admin renamed the user / changed email in the row,
      // first send a modify, then approve. Modify is idempotent.
      if (edit.display_name && edit.display_name !== (row.request_display_name || row.meta_name)) {
        await AnvilBackend?.accessRequests?.modify?.(row.user_id, { display_name: edit.display_name });
      }
      await AnvilBackend?.accessRequests?.approve?.(row.user_id, role);
      window.notifySuccess?.("Access approved", row.user_email || row.request_email);
      setAccessEdits((prev) => { const next = { ...prev }; delete next[row.user_id]; return next; });
      loadAccessRequests();
    } catch (err: any) {
      flashErr(err); window.notifyError?.("Approve failed", err?.message);
    } finally { setAccessBusy(null); }
  };

  const onAccessDeny = async (row: any) => {
    const reason = (accessEdits[row.user_id]?.reason || "").trim();
    if (!window.confirm(`Deny access for ${row.user_email || row.request_email}?` + (reason ? `\n\nReason: ${reason}` : ""))) return;
    setAccessBusy(row.user_id);
    try {
      await AnvilBackend?.accessRequests?.deny?.(row.user_id, reason || null);
      window.notifySuccess?.("Access denied", row.user_email || row.request_email);
      setAccessEdits((prev) => { const next = { ...prev }; delete next[row.user_id]; return next; });
      loadAccessRequests();
    } catch (err: any) {
      flashErr(err); window.notifyError?.("Deny failed", err?.message);
    } finally { setAccessBusy(null); }
  };

  const onAccessReinstate = async (row: any) => {
    if (!window.confirm(`Reinstate access for ${row.user_email || row.request_email}? They will be able to sign in immediately.`)) return;
    setAccessBusy(row.user_id);
    try {
      const role = row.requested_role || row.role || "sales_engineer";
      await AnvilBackend?.accessRequests?.approve?.(row.user_id, role);
      window.notifySuccess?.("Access reinstated", row.user_email || row.request_email);
      loadAccessRequests();
    } catch (err: any) {
      flashErr(err); window.notifyError?.("Reinstate failed", err?.message);
    } finally { setAccessBusy(null); }
  };

  // ---------- Phase 5 connector state ----------
  // Sage X3 (5.4a)
  const [sageX3, setSageX3] = u<any>(null);
  const [sageX3Busy, setSageX3Busy] = u(false);
  const [sageX3Form, setSageX3Form] = u<any>({
    base_url: "", token_url: "", solution: "X3", company: "", locale: "ENG",
    client_id: "", client_secret: "",
  });
  // Phase 5.4b cluster A (OAuth2): IFS / Oracle Fusion / Ramco.
  // Each follows the same connect-probe + sync + retry rhythm as
  // Sage X3 above. The form fields differ per ERP (token URL,
  // tenant qualifier, business unit, etc.) so we keep three distinct
  // shapes rather than over-generalising.
  const [ifsState, setIfsState] = u<any>(null);
  const [ifsBusy, setIfsBusy] = u(false);
  const [ifsForm, setIfsForm] = u<any>({
    base_url: "", token_url: "", scope: "openid profile INTEGRATION",
    company: "", projection: "CustomerOrder.svc",
    client_id: "", client_secret: "",
  });
  const [oracleFusionState, setOracleFusionState] = u<any>(null);
  const [oracleFusionBusy, setOracleFusionBusy] = u(false);
  const [oracleFusionForm, setOracleFusionForm] = u<any>({
    base_url: "", token_url: "",
    scope: "urn:opc:resource:consumer::all",
    api_version: "11.13.18.05", business_unit: "",
    client_id: "", client_secret: "",
  });
  const [ramcoState, setRamcoState] = u<any>(null);
  const [ramcoBusy, setRamcoBusy] = u(false);
  const [ramcoForm, setRamcoForm] = u<any>({
    base_url: "", token_url: "", scope: "api",
    org_unit: "", company: "",
    client_id: "", client_secret: "",
  });
  // Phase 5.4b cluster B (token-pair): JDE, Plex, JobBoss.
  const [jdeState, setJdeState] = u<any>(null);
  const [jdeBusy, setJdeBusy] = u(false);
  const [jdeForm, setJdeForm] = u<any>({
    base_url: "", environment: "", role: "*ALL", device: "Anvil",
    username: "", password: "",
  });
  const [plexState, setPlexState] = u<any>(null);
  const [plexBusy, setPlexBusy] = u(false);
  const [plexForm, setPlexForm] = u<any>({
    base_url: "https://api.plex.com", customer_id: "", pcn: "", api_key: "",
  });
  const [jobbossState, setJobbossState] = u<any>(null);
  const [jobbossBusy, setJobbossBusy] = u(false);
  const [jobbossForm, setJobbossForm] = u<any>({
    base_url: "", company: "", token: "",
  });
  // Phase 5.4b cluster C (HTTP Basic): Oracle EBS, proALPHA.
  const [oracleEbsState, setOracleEbsState] = u<any>(null);
  const [oracleEbsBusy, setOracleEbsBusy] = u(false);
  const [oracleEbsForm, setOracleEbsForm] = u<any>({
    base_url: "", responsibility: "", org_id: "",
    username: "", password: "",
  });
  const [proalphaState, setProalphaState] = u<any>(null);
  const [proalphaBusy, setProalphaBusy] = u(false);
  const [proalphaForm, setProalphaForm] = u<any>({
    base_url: "", company: "",
    username: "", password: "",
  });
  // PLM (5.5)
  const [plm, setPlm] = u<any>(null);
  const [plmBusy, setPlmBusy] = u(false);
  const [plmForm, setPlmForm] = u<any>({
    system: "windchill", base_url: "", display_name: "",
    username: "", password: "", api_key: "",
  });
  // Voice (5.1)
  const [voice, setVoice] = u<any>(null);
  const [voiceBusy, setVoiceBusy] = u(false);
  const [voiceForm, setVoiceForm] = u<any>({
    provider: "vapi", display_name: "", phone_number: "",
    assistant_id: "", api_key: "", webhook_secret: "",
    handoff_phone_number: "", voice_persona: "", system_prompt: "",
  });
  // Chat (5.2)
  const [chat, setChat] = u<any>(null);
  const [chatBusy, setChatBusy] = u(false);
  const [chatForm, setChatForm] = u<any>({
    channel: "whatsapp", display_name: "",
    creds: { account_sid: "", auth_token: "", from_number: "" },
  });

  const loadTally = async () => {
    try {
      const resp = await AnvilBackend?.tally?.health?.();
      setTally(resp);
    } catch (err) { flashErr(err); }
  };

  const onTallyAddCompany = async (ev) => {
    ev.preventDefault();
    if (!tallyCompanyForm.name) return flashErr(new Error("name required"));
    setTallyCompanyBusy(true);
    try {
      await AnvilBackend?.tally?.createCompany?.(tallyCompanyForm);
      flashOk("Company added");
      setTallyCompanyForm({
        name: "", bridge_url: "", bridge_token: "", gstin: "",
        default_voucher_series: "", default_sales_ledger: "",
      });
      loadTally();
    } catch (err) { flashErr(err); }
    finally { setTallyCompanyBusy(false); }
  };

  const onTallySetDefault = async (id: string) => {
    try {
      await AnvilBackend?.tally?.updateCompany?.(id, { is_default: true });
      flashOk("Default updated");
      loadTally();
    } catch (err) { flashErr(err); }
  };

  const onTallyDeleteCompany = async (id: string) => {
    if (!confirm("Remove this Tally company? Vouchers stay; the bridge config is removed.")) return;
    try {
      await AnvilBackend?.tally?.deleteCompany?.(id);
      flashOk("Company removed");
      loadTally();
    } catch (err) { flashErr(err); }
  };

  const onTallyDiagnostics = async (companyId?: string) => {
    setTallyDiagBusy(true);
    try {
      const resp = await AnvilBackend?.tally?.diagnostics?.(companyId);
      setTallyDiag(resp);
      if (resp?.summary?.all_ok) flashOk("All Tally bridge probes passed");
      else flashErr(new Error("Bridge probes failed: " + ((resp?.probes || []).filter((p:any)=>!p.ok).map((p:any)=>p.probe).join(", "))));
    } catch (err) { flashErr(err); }
    finally { setTallyDiagBusy(false); }
  };

  const onTallySyncNow = async (entity: string | null, full: boolean) => {
    setTallySyncBusy(true);
    try {
      const body: any = {};
      if (entity) body.entity = entity;
      if (full) body.full = true;
      const resp = await AnvilBackend?.tally?.syncNow?.(body);
      flashOk("Tally sync ran (" + ((resp?.results || []).length || 0) + " entities)");
      loadTally();
    } catch (err) { flashErr(err); }
    finally { setTallySyncBusy(false); }
  };

  const onTallyRetryNow = async () => {
    setTallyRetryBusy(true);
    try {
      const resp = await AnvilBackend?.tally?.retry?.();
      flashOk("Replayed " + (resp?.processed || 0) + " queued vouchers");
      loadTally();
    } catch (err) { flashErr(err); }
    finally { setTallyRetryBusy(false); }
  };

  // ---------- Phase 5: Sage X3 ----------
  const loadSageX3 = async () => {
    try {
      const resp = await adminCrudFetch("/api/sage_x3/health");
      setSageX3(resp);
    } catch (err) { flashErr(err); }
  };
  const onSageX3Connect = async () => {
    if (!sageX3Form.base_url || !sageX3Form.token_url || !sageX3Form.client_id || !sageX3Form.client_secret) {
      return flashErr(new Error("base_url, token_url, client_id, client_secret are required"));
    }
    setSageX3Busy(true);
    try {
      const resp = await adminCrudFetch("/api/sage_x3/connect", { method: "POST", body: sageX3Form });
      if (resp?.ok) flashOk("Sage X3 connected (probe ok)");
      else flashErr(new Error(resp?.probe_error || "Probe failed"));
      window.notifySuccess?.("Sage X3 saved", resp?.ok ? "probe ok" : "probe failed");
      loadSageX3();
    } catch (err: any) { flashErr(err); window.notifyError?.("Sage X3 connect failed", err?.message); }
    finally { setSageX3Busy(false); }
  };
  const onSageX3SyncNow = async () => {
    setSageX3Busy(true);
    try {
      const resp = await adminCrudFetch("/api/sage_x3/sync", { method: "POST", body: {} });
      flashOk("Sync triggered");
      window.notifySuccess?.("Sage X3 sync started", `${resp?.results?.length || 0} entities`);
      loadSageX3();
    } catch (err: any) { flashErr(err); window.notifyError?.("Sync failed", err?.message); }
    finally { setSageX3Busy(false); }
  };
  const onSageX3RetryNow = async () => {
    setSageX3Busy(true);
    try {
      const resp = await adminCrudFetch("/api/sage_x3/retry", { method: "POST", body: {} });
      flashOk(`Replayed ${resp?.processed || 0} queued pushes`);
      window.notifySuccess?.("Retry queue drained", `${resp?.processed || 0} replayed`);
      loadSageX3();
    } catch (err: any) { flashErr(err); window.notifyError?.("Retry failed", err?.message); }
    finally { setSageX3Busy(false); }
  };

  // ---------- Phase 5.4b: IFS Cloud ----------
  const loadIfs = async () => {
    try { setIfsState(await adminCrudFetch("/api/ifs/health")); }
    catch (err) { flashErr(err); }
  };
  const onIfsConnect = async () => {
    if (!ifsForm.base_url || !ifsForm.token_url || !ifsForm.client_id || !ifsForm.client_secret) {
      return flashErr(new Error("base_url, token_url, client_id, client_secret are required"));
    }
    setIfsBusy(true);
    try {
      const resp = await adminCrudFetch("/api/ifs/connect", { method: "POST", body: ifsForm });
      if (resp?.ok) flashOk("IFS Cloud connected (probe ok)");
      else flashErr(new Error(resp?.probe_error || "Probe failed"));
      window.notifySuccess?.("IFS saved", resp?.ok ? "probe ok" : "probe failed");
      loadIfs();
    } catch (err: any) { flashErr(err); window.notifyError?.("IFS connect failed", err?.message); }
    finally { setIfsBusy(false); }
  };
  const onIfsSyncNow = async () => {
    setIfsBusy(true);
    try {
      const resp = await adminCrudFetch("/api/ifs/sync", { method: "POST", body: {} });
      flashOk("Sync triggered");
      window.notifySuccess?.("IFS sync started", `${resp?.results?.length || 0} entities`);
      loadIfs();
    } catch (err: any) { flashErr(err); window.notifyError?.("Sync failed", err?.message); }
    finally { setIfsBusy(false); }
  };
  const onIfsRetryNow = async () => {
    setIfsBusy(true);
    try {
      const resp = await adminCrudFetch("/api/ifs/retry", { method: "POST", body: {} });
      flashOk(`Replayed ${resp?.processed || 0} queued pushes`);
      window.notifySuccess?.("Retry queue drained", `${resp?.processed || 0} replayed`);
      loadIfs();
    } catch (err: any) { flashErr(err); window.notifyError?.("Retry failed", err?.message); }
    finally { setIfsBusy(false); }
  };

  // ---------- Phase 5.4b: Oracle Fusion ----------
  const loadOracleFusion = async () => {
    try { setOracleFusionState(await adminCrudFetch("/api/oracle_fusion/health")); }
    catch (err) { flashErr(err); }
  };
  const onOracleFusionConnect = async () => {
    if (!oracleFusionForm.base_url || !oracleFusionForm.token_url ||
        !oracleFusionForm.client_id || !oracleFusionForm.client_secret) {
      return flashErr(new Error("base_url, token_url, client_id, client_secret are required"));
    }
    setOracleFusionBusy(true);
    try {
      const resp = await adminCrudFetch("/api/oracle_fusion/connect", { method: "POST", body: oracleFusionForm });
      if (resp?.ok) flashOk("Oracle Fusion connected (probe ok)");
      else flashErr(new Error(resp?.probe_error || "Probe failed"));
      window.notifySuccess?.("Oracle Fusion saved", resp?.ok ? "probe ok" : "probe failed");
      loadOracleFusion();
    } catch (err: any) { flashErr(err); window.notifyError?.("Oracle Fusion connect failed", err?.message); }
    finally { setOracleFusionBusy(false); }
  };
  const onOracleFusionSyncNow = async () => {
    setOracleFusionBusy(true);
    try {
      const resp = await adminCrudFetch("/api/oracle_fusion/sync", { method: "POST", body: {} });
      flashOk("Sync triggered");
      window.notifySuccess?.("Oracle Fusion sync started", `${resp?.results?.length || 0} entities`);
      loadOracleFusion();
    } catch (err: any) { flashErr(err); window.notifyError?.("Sync failed", err?.message); }
    finally { setOracleFusionBusy(false); }
  };
  const onOracleFusionRetryNow = async () => {
    setOracleFusionBusy(true);
    try {
      const resp = await adminCrudFetch("/api/oracle_fusion/retry", { method: "POST", body: {} });
      flashOk(`Replayed ${resp?.processed || 0} queued pushes`);
      window.notifySuccess?.("Retry queue drained", `${resp?.processed || 0} replayed`);
      loadOracleFusion();
    } catch (err: any) { flashErr(err); window.notifyError?.("Retry failed", err?.message); }
    finally { setOracleFusionBusy(false); }
  };

  // ---------- Phase 5.4b: Ramco ----------
  const loadRamco = async () => {
    try { setRamcoState(await adminCrudFetch("/api/ramco/health")); }
    catch (err) { flashErr(err); }
  };
  const onRamcoConnect = async () => {
    if (!ramcoForm.base_url || !ramcoForm.token_url || !ramcoForm.client_id || !ramcoForm.client_secret) {
      return flashErr(new Error("base_url, token_url, client_id, client_secret are required"));
    }
    setRamcoBusy(true);
    try {
      const resp = await adminCrudFetch("/api/ramco/connect", { method: "POST", body: ramcoForm });
      if (resp?.ok) flashOk("Ramco connected (probe ok)");
      else flashErr(new Error(resp?.probe_error || "Probe failed"));
      window.notifySuccess?.("Ramco saved", resp?.ok ? "probe ok" : "probe failed");
      loadRamco();
    } catch (err: any) { flashErr(err); window.notifyError?.("Ramco connect failed", err?.message); }
    finally { setRamcoBusy(false); }
  };
  const onRamcoSyncNow = async () => {
    setRamcoBusy(true);
    try {
      const resp = await adminCrudFetch("/api/ramco/sync", { method: "POST", body: {} });
      flashOk("Sync triggered");
      window.notifySuccess?.("Ramco sync started", `${resp?.results?.length || 0} entities`);
      loadRamco();
    } catch (err: any) { flashErr(err); window.notifyError?.("Sync failed", err?.message); }
    finally { setRamcoBusy(false); }
  };
  const onRamcoRetryNow = async () => {
    setRamcoBusy(true);
    try {
      const resp = await adminCrudFetch("/api/ramco/retry", { method: "POST", body: {} });
      flashOk(`Replayed ${resp?.processed || 0} queued pushes`);
      window.notifySuccess?.("Retry queue drained", `${resp?.processed || 0} replayed`);
      loadRamco();
    } catch (err: any) { flashErr(err); window.notifyError?.("Retry failed", err?.message); }
    finally { setRamcoBusy(false); }
  };

  // ---------- Phase 5.4b cluster B: JDE / Plex / JobBoss ----------
  // Each ERP shares the same load+connect+sync+retry shape; we call
  // a single helper so the 30 handlers below collapse to one code
  // path. The vendor-specific bits (form payload + state setter)
  // are passed in; everything else (audit, sync state poll, retry
  // queue refresh) is identical to the Sage X3 / IFS / Oracle Fusion
  // / Ramco handlers above.
  const erpAdminFns = (prefix: string, getForm: () => any, setBusy: (b: boolean) => void, setState: (s: any) => void, label: string) => {
    const load = async () => {
      try { setState(await adminCrudFetch(`/api/${prefix}/health`)); }
      catch (err) { flashErr(err); }
    };
    const connect = async () => {
      const form = getForm();
      // Required-field check is per-ERP and handled below; we only
      // run the call here.
      setBusy(true);
      try {
        const resp = await adminCrudFetch(`/api/${prefix}/connect`, { method: "POST", body: form });
        if (resp?.ok) flashOk(`${label} connected (probe ok)`);
        else flashErr(new Error(resp?.probe_error || "Probe failed"));
        window.notifySuccess?.(`${label} saved`, resp?.ok ? "probe ok" : "probe failed");
        load();
      } catch (err: any) { flashErr(err); window.notifyError?.(`${label} connect failed`, err?.message); }
      finally { setBusy(false); }
    };
    const syncNow = async () => {
      setBusy(true);
      try {
        const resp = await adminCrudFetch(`/api/${prefix}/sync`, { method: "POST", body: {} });
        flashOk("Sync triggered");
        window.notifySuccess?.(`${label} sync started`, `${resp?.results?.length || 0} entities`);
        load();
      } catch (err: any) { flashErr(err); window.notifyError?.("Sync failed", err?.message); }
      finally { setBusy(false); }
    };
    const retryNow = async () => {
      setBusy(true);
      try {
        const resp = await adminCrudFetch(`/api/${prefix}/retry`, { method: "POST", body: {} });
        flashOk(`Replayed ${resp?.processed || 0} queued pushes`);
        window.notifySuccess?.("Retry queue drained", `${resp?.processed || 0} replayed`);
        load();
      } catch (err: any) { flashErr(err); window.notifyError?.("Retry failed", err?.message); }
      finally { setBusy(false); }
    };
    return { load, connect, syncNow, retryNow };
  };

  const jdeFns = erpAdminFns("jde", () => jdeForm, setJdeBusy, setJdeState, "JDE");
  const plexFns = erpAdminFns("plex", () => plexForm, setPlexBusy, setPlexState, "Plex");
  const jobbossFns = erpAdminFns("jobboss", () => jobbossForm, setJobbossBusy, setJobbossState, "JobBoss");
  const oracleEbsFns = erpAdminFns("oracle_ebs", () => oracleEbsForm, setOracleEbsBusy, setOracleEbsState, "Oracle EBS");
  const proalphaFns = erpAdminFns("proalpha", () => proalphaForm, setProalphaBusy, setProalphaState, "proALPHA");

  // ---------- Phase 5: PLM ----------
  const loadPlm = async () => {
    try {
      const resp = await adminCrudFetch("/api/plm/health");
      setPlm(resp);
    } catch (err) { flashErr(err); }
  };
  const onPlmConnect = async () => {
    if (!plmForm.base_url) return flashErr(new Error("base_url is required"));
    if (plmForm.system === "windchill" && (!plmForm.username || !plmForm.password)) {
      return flashErr(new Error("Windchill needs username + password"));
    }
    if (plmForm.system === "arena" && !plmForm.api_key) {
      return flashErr(new Error("Arena needs api_key"));
    }
    setPlmBusy(true);
    try {
      const resp = await adminCrudFetch("/api/plm/connect", { method: "POST", body: plmForm });
      if (resp?.probed) {
        flashOk("PLM connected (probe ok)");
        window.notifySuccess?.("PLM saved", `${plmForm.system} probe ok`);
      } else {
        flashErr(new Error(resp?.probe_error || "Probe failed"));
        window.notifyError?.("PLM probe failed", resp?.probe_error || "");
      }
      loadPlm();
    } catch (err: any) { flashErr(err); window.notifyError?.("PLM connect failed", err?.message); }
    finally { setPlmBusy(false); }
  };
  const onPlmSyncNow = async (systemId: string) => {
    setPlmBusy(true);
    try {
      const resp = await adminCrudFetch("/api/plm/sync", { method: "POST", body: { system_id: systemId } });
      flashOk(`Synced ${resp?.boms || 0} BOMs · ${resp?.changes || 0} ECOs`);
      window.notifySuccess?.("PLM sync complete", `${resp?.boms || 0} BOMs, ${resp?.changes || 0} ECOs`);
      loadPlm();
    } catch (err: any) { flashErr(err); window.notifyError?.("PLM sync failed", err?.message); }
    finally { setPlmBusy(false); }
  };

  // ---------- Phase 5: Voice ----------
  const loadVoice = async () => {
    try {
      const resp = await adminCrudFetch("/api/voice/configure");
      setVoice(resp);
    } catch (err) { flashErr(err); }
  };
  const onVoiceSave = async () => {
    if (!voiceForm.phone_number) return flashErr(new Error("phone_number (E.164) is required"));
    setVoiceBusy(true);
    try {
      await adminCrudFetch("/api/voice/configure", { method: "POST", body: voiceForm });
      flashOk("Voice config saved");
      window.notifySuccess?.("Voice config saved", `${voiceForm.provider} · ${voiceForm.phone_number}`);
      setVoiceForm({ ...voiceForm, api_key: "", webhook_secret: "" });
      loadVoice();
    } catch (err: any) { flashErr(err); window.notifyError?.("Voice save failed", err?.message); }
    finally { setVoiceBusy(false); }
  };
  const onVoiceDeactivate = async (id: string) => {
    if (!window.confirm("Deactivate this voice config? Inbound calls to its number will stop being handled.")) return;
    setVoiceBusy(true);
    try {
      await adminCrudFetch("/api/voice/configure?id=" + encodeURIComponent(id), { method: "DELETE" });
      flashOk("Voice config deactivated");
      window.notifySuccess?.("Voice config deactivated", "");
      loadVoice();
    } catch (err: any) { flashErr(err); window.notifyError?.("Deactivate failed", err?.message); }
    finally { setVoiceBusy(false); }
  };

  // ---------- Phase 5: Chat ----------
  const loadChat = async () => {
    try {
      const resp = await adminCrudFetch("/api/inbound/chat/configure");
      setChat(resp);
    } catch (err) { flashErr(err); }
  };
  const onChatSave = async () => {
    if (!chatForm.channel) return flashErr(new Error("Pick a channel"));
    setChatBusy(true);
    try {
      await adminCrudFetch("/api/inbound/chat/configure", { method: "POST", body: {
        channel: chatForm.channel,
        display_name: chatForm.display_name || null,
        creds: chatForm.creds || {},
      } });
      flashOk(`${chatForm.channel} channel saved`);
      window.notifySuccess?.("Chat channel saved", chatForm.channel);
      // Wipe credential fields after save so they aren't visible.
      setChatForm({ ...chatForm, creds: {} });
      loadChat();
    } catch (err: any) { flashErr(err); window.notifyError?.("Chat save failed", err?.message); }
    finally { setChatBusy(false); }
  };
  const onChatDeactivate = async (channel: string) => {
    if (!window.confirm(`Deactivate the ${channel} channel? Inbound messages will stop being processed.`)) return;
    setChatBusy(true);
    try {
      await adminCrudFetch("/api/inbound/chat/configure?channel=" + encodeURIComponent(channel), { method: "DELETE" });
      flashOk(`${channel} channel deactivated`);
      window.notifySuccess?.("Channel deactivated", channel);
      loadChat();
    } catch (err: any) { flashErr(err); window.notifyError?.("Deactivate failed", err?.message); }
    finally { setChatBusy(false); }
  };

  e(() => {
    if (active === "access") loadAccessRequests();
    if (active === "security" && !security) loadSecurity();
    if (active === "security" && passkeys.length === 0) loadPasskeys();
    if (active === "billing" && !billing) loadBilling(billingFrom);
    if (active === "billing" && !stripe) loadStripe();
    if (active === "netsuite" && !netsuite) loadNetsuite();
    if (active === "tally" && !tally) loadTally();
    if (active === "sage_x3" && !sageX3) loadSageX3();
    if (active === "ifs" && !ifsState) loadIfs();
    if (active === "oracle_fusion" && !oracleFusionState) loadOracleFusion();
    if (active === "ramco" && !ramcoState) loadRamco();
    if (active === "jde" && !jdeState) jdeFns.load();
    if (active === "plex" && !plexState) plexFns.load();
    if (active === "jobboss" && !jobbossState) jobbossFns.load();
    if (active === "oracle_ebs" && !oracleEbsState) oracleEbsFns.load();
    if (active === "proalpha" && !proalphaState) proalphaFns.load();
    if (active === "plm" && !plm) loadPlm();
    if (active === "voice" && !voice) loadVoice();
    if (active === "chat" && !chat) loadChat();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, accessFilter]);

  const saveProfile = async (ev) => {
    ev.preventDefault();
    if (!profileName.trim()) return flashErr(new Error("Name is required"));
    setProfileBusy(true); setFlash(null);
    try {
      const resp = await adminCrudFetch("/api/auth/profile", {
        method: "PATCH",
        body: { display_name: profileName.trim() },
      });
      setProfile((p) => ({ ...(p || {}), user: { ...(p?.user || {}), display_name: resp?.user?.display_name } }));
      // Update the cached profile so the shell avatar refreshes without
      // a page reload. The telemetry hook reads obara:auth_profile.
      try {
        const cached = JSON.parse(localStorage.getItem("obara:auth_profile") || "null") || {};
        cached.user = { ...(cached.user || {}), display_name: resp?.user?.display_name };
        localStorage.setItem("obara:auth_profile", JSON.stringify(cached));
      } catch (_) {}
      flashOk("Profile updated");
      members.reload();
    } catch (err) { flashErr(err); }
    finally { setProfileBusy(false); }
  };

  // ---------- Holidays ----------
  const onAddHoliday = async (ev) => {
    ev.preventDefault();
    if (!holidayForm.date || !holidayForm.name) return flashErr(new Error("Date and name required"));
    setBusy(true); setFlash(null);
    try {
      await (AnvilBackend?.admin?.upsertHoliday?.(holidayForm)
             || adminCrudFetch("/api/admin/holidays", { method: "POST", body: holidayForm }));
      flashOk(`Added holiday "${holidayForm.name}"`);
      setHolidayForm({ country: "IN", date: "", name: "" });
      holidays.reload();
    } catch (err) { flashErr(err); }
    finally { setBusy(false); }
  };

  const onDeleteHoliday = async (id) => {
    if (!confirm("Delete this holiday?")) return;
    setBusy(true); setFlash(null);
    try {
      await (AnvilBackend?.admin?.deleteHoliday?.(id)
             || adminCrudFetch("/api/admin/holidays?id=" + encodeURIComponent(id), { method: "DELETE" }));
      flashOk("Holiday deleted");
      holidays.reload();
    } catch (err) { flashErr(err); }
    finally { setBusy(false); }
  };

  // ---------- Lead times ----------
  const onAddLeadTime = async (ev) => {
    ev.preventDefault();
    if (!leadTimeForm.entity_id || !leadTimeForm.days) return flashErr(new Error("Entity and days required"));
    setBusy(true); setFlash(null);
    try {
      const payload = {
        [leadTimeForm.type === "supplier" ? "supplier_id" : "customer_id"]: leadTimeForm.entity_id,
        days: Number(leadTimeForm.days),
        notes: leadTimeForm.notes || null,
      };
      await (AnvilBackend?.admin?.upsertLeadTime?.(leadTimeForm.type, payload)
             || adminCrudFetch("/api/admin/lead_times?type=" + encodeURIComponent(leadTimeForm.type), { method: "POST", body: payload }));
      flashOk("Lead time saved");
      setLeadTimeForm({ ...leadTimeForm, entity_id: "", days: "", notes: "" });
      leadTimes.reload();
    } catch (err) { flashErr(err); }
    finally { setBusy(false); }
  };

  const onDeleteLeadTime = async (id) => {
    if (!confirm("Delete this lead time?")) return;
    setBusy(true); setFlash(null);
    try {
      await (AnvilBackend?.admin?.deleteLeadTime?.(leadTimeForm.type, id)
             || adminCrudFetch("/api/admin/lead_times?type=" + encodeURIComponent(leadTimeForm.type) + "&id=" + encodeURIComponent(id), { method: "DELETE" }));
      flashOk("Lead time deleted");
      leadTimes.reload();
    } catch (err) { flashErr(err); }
    finally { setBusy(false); }
  };

  // ---------- FX ----------
  const refreshFx = async () => {
    setBusy(true); setFlash(null);
    try {
      await AnvilBackend?.fx?.refresh?.();
      flashOk("FX rates refreshed");
      fxRates.reload();
    } catch (err) { flashErr(err); }
    finally { setBusy(false); }
  };

  // ---------- Approval thresholds ----------
  const submitThreshold = async () => {
    if (!threshForm) return;
    if (!threshForm.role) return flashErr(new Error("Role required"));
    setBusy(true); setFlash(null);
    try {
      await (AnvilBackend?.admin?.upsertApprovalThreshold?.(threshForm)
             || adminCrudFetch("/api/admin/quote_approvals?type=thresholds", { method: "POST", body: threshForm }));
      flashOk("Threshold saved");
      setThreshForm(null);
      thresholds.reload();
    } catch (err) { flashErr(err); }
    finally { setBusy(false); }
  };

  const deleteThreshold = async (id) => {
    if (!confirm("Delete this approval threshold?")) return;
    setBusy(true); setFlash(null);
    try {
      await (AnvilBackend?.admin?.deleteApprovalThreshold?.(id)
             || adminCrudFetch("/api/admin/quote_approvals?type=thresholds&id=" + encodeURIComponent(id), { method: "DELETE" }));
      flashOk("Threshold deleted");
      thresholds.reload();
    } catch (err) { flashErr(err); }
    finally { setBusy(false); }
  };

  // ---------- Customer locations ----------
  const submitLocation = async () => {
    if (!locForm) return;
    if (!locForm.customer_id || !locForm.location_name) return flashErr(new Error("Customer and location name required"));
    setBusy(true); setFlash(null);
    try {
      await (AnvilBackend?.admin?.upsertCustomerLocation?.(locForm)
             || adminCrudFetch("/api/admin/customer_locations", { method: "POST", body: locForm }));
      flashOk("Location saved");
      setLocForm(null);
      locations.reload();
    } catch (err) { flashErr(err); }
    finally { setBusy(false); }
  };

  const deleteLocation = async (id) => {
    if (!confirm("Delete this customer location?")) return;
    setBusy(true); setFlash(null);
    try {
      await (AnvilBackend?.admin?.deleteCustomerLocation?.(id)
             || adminCrudFetch("/api/admin/customer_locations?id=" + encodeURIComponent(id), { method: "DELETE" }));
      flashOk("Location deleted");
      locations.reload();
    } catch (err) { flashErr(err); }
    finally { setBusy(false); }
  };

  // ---------- Contracts ----------
  const submitContract = async () => {
    if (!contractForm) return;
    if (!contractForm.customer_id || !contractForm.contract_type) return flashErr(new Error("Customer and type required"));
    setBusy(true); setFlash(null);
    try {
      await (AnvilBackend?.admin?.upsertContract?.(contractForm)
             || adminCrudFetch("/api/admin/contracts", { method: "POST", body: contractForm }));
      flashOk("Contract saved");
      setContractForm(null);
      contracts.reload();
    } catch (err) { flashErr(err); }
    finally { setBusy(false); }
  };

  const deleteContract = async (id) => {
    if (!confirm("Delete this contract?")) return;
    setBusy(true); setFlash(null);
    try {
      await (AnvilBackend?.admin?.deleteContract?.(id)
             || adminCrudFetch("/api/admin/contracts?id=" + encodeURIComponent(id), { method: "DELETE" }));
      flashOk("Contract deleted");
      contracts.reload();
    } catch (err) { flashErr(err); }
    finally { setBusy(false); }
  };

  // ---------- Item master ----------
  const submitItem = async () => {
    if (!itemForm) return;
    if (!itemForm.tally_item_name) return flashErr(new Error("tally_item_name required"));
    setBusy(true); setFlash(null);
    try {
      await (AnvilBackend?.admin?.upsertItemMaster?.(itemForm)
             || adminCrudFetch("/api/admin/item_master", { method: "POST", body: itemForm }));
      flashOk("Item saved");
      setItemForm(null);
      itemMaster.reload();
    } catch (err) { flashErr(err); }
    finally { setBusy(false); }
  };

  const deleteItem = async (id) => {
    if (!confirm("Delete this item master row?")) return;
    setBusy(true); setFlash(null);
    try {
      await (AnvilBackend?.admin?.deleteItemMaster?.(id)
             || adminCrudFetch("/api/admin/item_master?id=" + encodeURIComponent(id), { method: "DELETE" }));
      flashOk("Item deleted");
      itemMaster.reload();
    } catch (err) { flashErr(err); }
    finally { setBusy(false); }
  };

  const onCsvImport = async (file) => {
    if (!file) return;
    setCsvBusy(true); setFlash(null);
    try {
      const text = await file.text();
      const rows = parseCSV(text);
      if (rows.length < 2) throw new Error("CSV needs header + 1 row");
      const header = rows[0].map((h) => h.trim());
      const items = rows.slice(1).map((r) => {
        const o: Record<string, string> = {};
        header.forEach((h, i) => { if (h) o[h] = r[i]; });
        return o;
      }).filter((o) => o.tally_item_name);
      if (items.length === 0) throw new Error("No rows with tally_item_name");
      await (AnvilBackend?.admin?.bulkItemMaster?.(items)
             || adminCrudFetch("/api/admin/item_master", { method: "POST", body: { rows: items } }));
      flashOk(`Imported ${items.length} items`);
      itemMaster.reload();
    } catch (err) { flashErr(err); }
    finally { setCsvBusy(false); }
  };

  // ---------- Settings ----------
  const onSaveDrawingBase = () => {
    try {
      localStorage.setItem(ADMIN_DRAWING_BASE_KEY, drawingDraft);
      setDrawingBase(drawingDraft);
      flashOk("Drawing base URL saved (local browser only)");
    } catch (err) { flashErr(err); }
  };

  // Load tenant quote defaults + option lists when the Settings tab opens.
  e(() => {
    if (active !== "settings" || quoteSettingsLoaded) return;
    (async () => {
      try {
        const r: any = await AnvilBackend?.admin?.quoteSettings?.();
        const v = r?.quote_default_validity_days;
        const s = v == null ? "" : String(v);
        setQuoteValidity(s);
        setQuoteValidityDraft(s);
        const units = Array.isArray(r?.quote_line_units) ? r.quote_line_units : [];
        const srcs = Array.isArray(r?.quote_line_source_countries) ? r.quote_line_source_countries : [];
        const curs = Array.isArray(r?.quote_currencies) ? r.quote_currencies : [];
        setQuoteUnits(units); setQuoteUnitsSaved(units);
        setQuoteSources(srcs); setQuoteSourcesSaved(srcs);
        setQuoteCurrencies(curs); setQuoteCurrenciesSaved(curs);
      } catch (_) { /* leave blank on failure */ }
      finally { setQuoteSettingsLoaded(true); }
    })();
  }, [active, quoteSettingsLoaded]);

  const quoteSettingsDirty = quoteValidityDraft !== quoteValidity
    || JSON.stringify(quoteUnits) !== JSON.stringify(quoteUnitsSaved)
    || JSON.stringify(quoteSources) !== JSON.stringify(quoteSourcesSaved)
    || JSON.stringify(quoteCurrencies) !== JSON.stringify(quoteCurrenciesSaved);

  const onSaveQuoteSettings = async () => {
    setQuoteSettingsSaving(true);
    try {
      const raw = quoteValidityDraft.trim();
      const r: any = await AnvilBackend?.admin?.updateQuoteSettings?.({
        quote_default_validity_days: raw === "" ? null : Number(raw),
        quote_line_units: quoteUnits,
        quote_line_source_countries: quoteSources,
        quote_currencies: quoteCurrencies,
      });
      const v = r?.quote_default_validity_days;
      const s = v == null ? "" : String(v);
      const units = Array.isArray(r?.quote_line_units) ? r.quote_line_units : quoteUnits;
      const srcs = Array.isArray(r?.quote_line_source_countries) ? r.quote_line_source_countries : quoteSources;
      const curs = Array.isArray(r?.quote_currencies) ? r.quote_currencies : quoteCurrencies;
      setQuoteValidity(s); setQuoteValidityDraft(s);
      setQuoteUnits(units); setQuoteUnitsSaved(units);
      setQuoteSources(srcs); setQuoteSourcesSaved(srcs);
      setQuoteCurrencies(curs); setQuoteCurrenciesSaved(curs);
      flashOk("Quote settings saved");
    } catch (err) { flashErr(err); }
    finally { setQuoteSettingsSaving(false); }
  };

  return (
    <>
      <WSTitle
        eyebrow="Admin · Settings"
        title="Admin Center"
        meta={`${memberRows.length} members · ${locationRows.length} locations · ${contractRows.length} contracts · ${itemRows.length} items`}
        right={<>
          <Btn icon kind="ghost" sm
               onClick={() => { members.reload(); holidays.reload(); leadTimes.reload(); fxRates.reload(); thresholds.reload(); locations.reload(); contracts.reload(); itemMaster.reload(); diagnostics.reload(); }}
               title="Refresh all">{Icon.cycle}</Btn>
        </>}
      />
      {/* Two-tier settings nav: category row, then only that category's
          tabs - both wrap, so no long horizontal scroll. */}
      <div style={{ padding: "8px 18px 0", display: "flex", gap: 6, flexWrap: "wrap" }}>
        {ADMIN_TAB_GROUPS.map((g) => (
          <Btn key={g.label} sm kind={cat === g.label ? "primary" : "ghost"} onClick={() => selectCategory(g.label)}>{g.label}</Btn>
        ))}
      </div>
      <div style={{ padding: "8px 18px", display: "flex", gap: 6, flexWrap: "wrap", borderBottom: "1px solid var(--hairline)" }}>
        {(ADMIN_TAB_GROUPS.find((g) => g.label === cat)?.ids || []).map((id) => (
          <Btn key={id} sm kind={active === id ? "primary" : "ghost"} onClick={() => setActive(id)}>{ADMIN_TAB_LABEL[id] || id}</Btn>
        ))}
      </div>

      <div className="ws-content">
        {flash && (
          <Banner kind={flash.kind} icon={flash.kind === "bad" ? Icon.alert : Icon.check}
                  title={flash.kind === "bad" ? "Action failed" : "Action complete"}
                  action={<Btn sm onClick={() => setFlash(null)}>Dismiss</Btn>}>
            <span className="mono-sm">{flash.msg}</span>
          </Banner>
        )}

        {active === "access" && (
          <>
            <Card title="Access requests"
                  eyebrow={`${accessRequests?.counts?.pending || 0} pending · ${accessRequests?.counts?.approved || 0} approved · ${accessRequests?.counts?.denied || 0} denied`}
                  right={<>
                    {(["pending", "approved", "denied", "all"] as const).map((s) => (
                      <Btn key={s} sm kind={accessFilter === s ? "primary" : "ghost"}
                           onClick={() => setAccessFilter(s)}
                           title={"Show " + s + " requests"}>
                        {s}
                      </Btn>
                    ))}
                    <Btn icon kind="ghost" sm onClick={loadAccessRequests} title="Refresh">{Icon.cycle}</Btn>
                  </>}>
              {!accessRequests ? (
                <div className="body" style={{ padding: 22, color: "var(--ink-3)" }}>Loading access requests…</div>
              ) : (accessRequests.requests || []).length === 0 ? (
                <div className="body" style={{ padding: 28, textAlign: "center", color: "var(--ink-3)" }}>
                  {accessFilter === "pending"
                    ? <>No pending access requests. New signups will appear here for review.</>
                    : <>No {accessFilter} access requests in this tenant.</>}
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {accessRequests.requests.map((row: any) => {
                    const edits = accessEdits[row.user_id] || {};
                    const editedDisplayName = edits.display_name ?? (row.request_display_name || row.meta_name || "");
                    const editedRole = edits.role || row.requested_role || row.role || "sales_engineer";
                    const editedReason = edits.reason ?? "";
                    const isPending = row.status === "pending";
                    const isApproved = row.status === "approved";
                    const isDenied = row.status === "denied";
                    const updateEdit = (patch: any) => setAccessEdits((prev) => ({
                      ...prev,
                      [row.user_id]: { ...prev[row.user_id], ...patch },
                    }));
                    return (
                      <Card key={row.user_id} className="access-request-card">
                        <div className="row" style={{ gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                          <div style={{ flex: 1, minWidth: 220 }}>
                            <div style={{ fontWeight: 600 }}>
                              {row.request_display_name || row.meta_name || row.user_email || row.request_email}
                            </div>
                            <div className="mono-sm" style={{ color: "var(--ink-3)" }}>
                              {row.user_email || row.request_email}
                            </div>
                          </div>
                          <Chip k={isPending ? "warn" : isApproved ? "good" : isDenied ? "bad" : "ghost"}>{row.status}</Chip>
                          <span className="mono-sm" style={{ color: "var(--ink-3)" }}>
                            requested {ageLabel(row.requested_at)} ago
                          </span>
                        </div>

                        {row.request_notes && (
                          <div className="mono-sm" style={{ marginTop: 8, padding: 10, background: "var(--paper-2)", borderRadius: 4, color: "var(--ink-2)" }}>
                            {row.request_notes}
                          </div>
                        )}

                        <div className="form-grid" style={{ marginTop: 12 }}>
                          <label className="lbl">Display name
                            <input value={editedDisplayName}
                                   onChange={(ev) => updateEdit({ display_name: ev.target.value })}
                                   disabled={!isPending && !isApproved} />
                          </label>
                          <label className="lbl">Email (read-only)
                            <input value={row.user_email || row.request_email || ""} disabled />
                          </label>
                          <label className="lbl">Role to assign
                            <select value={editedRole}
                                    onChange={(ev) => updateEdit({ role: ev.target.value })}
                                    disabled={accessBusy === row.user_id}>
                              {ADMIN_ROLES.map((r) => <option key={r} value={r}>{r.replace(/_/g, " ")}</option>)}
                            </select>
                          </label>
                          {row.requested_role && row.requested_role !== editedRole && (
                            <div className="mono-sm" style={{ color: "var(--ink-3)", alignSelf: "end" }}>
                              user requested <strong>{row.requested_role.replace(/_/g, " ")}</strong>
                            </div>
                          )}
                        </div>

                        {isPending && (
                          <label className="lbl" style={{ marginTop: 8 }}>Denial reason (optional, shown to user)
                            <input value={editedReason}
                                   onChange={(ev) => updateEdit({ reason: ev.target.value })}
                                   placeholder="e.g. We'll re-evaluate next quarter." />
                          </label>
                        )}

                        {isDenied && row.denied_reason && (
                          <div className="mono-sm" style={{ marginTop: 8, color: "var(--rust)" }}>
                            denied: {row.denied_reason}
                          </div>
                        )}

                        <div className="row gap-sm" style={{ marginTop: 12, flexWrap: "wrap" }}>
                          {isPending && (
                            <>
                              <Btn kind="primary" sm
                                   disabled={accessBusy === row.user_id}
                                   onClick={() => onAccessApprove(row)}
                                   title={"Approve and grant " + editedRole.replace(/_/g, " ") + " access"}>
                                {Icon.shieldCheck} approve as {editedRole.replace(/_/g, " ")}
                              </Btn>
                              <Btn kind="danger" sm
                                   disabled={accessBusy === row.user_id}
                                   onClick={() => onAccessDeny(row)}
                                   title="Deny access. The user will see the reason on their next sign-in attempt.">
                                {Icon.x} deny
                              </Btn>
                            </>
                          )}
                          {isApproved && row.user_id !== currentUserId && (
                            <Btn sm kind="ghost"
                                 disabled={accessBusy === row.user_id}
                                 onClick={() => onAccessDeny(row)}
                                 title="Revoke access. The user will be signed out on next request.">
                              {Icon.x} revoke access
                            </Btn>
                          )}
                          {isDenied && (
                            <Btn sm kind="ghost"
                                 disabled={accessBusy === row.user_id}
                                 onClick={() => onAccessReinstate(row)}
                                 title="Reinstate this user. They will be able to sign in immediately.">
                              {Icon.cycle} reinstate
                            </Btn>
                          )}
                        </div>
                      </Card>
                    );
                  })}
                </div>
              )}
            </Card>
          </>
        )}

        {active === "members" && (
          <>
            {members.error && (
              <Banner kind="bad" icon={Icon.alert} title="Failed to load members" action={<Btn sm onClick={members.reload}>Retry</Btn>}>
                <span className="mono-sm">{String(members.error.message || members.error)}</span>
              </Banner>
            )}
            <Card flush>
              {members.loading ? (
                <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>Loading members…</div>
              ) : memberRows.length === 0 ? (
                <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>No members yet.</div>
              ) : (
                <table className="tbl">
                  <thead><tr>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Role</th>
                    <th>Status</th>
                    <th>Last sign-in</th>
                    <th>Joined</th>
                    <th style={{ width: 240 }}></th>
                  </tr></thead>
                  <tbody>
                    {memberRows.map((m) => {
                      const lastSignIn = m.last_sign_in_at || null;
                      const pending = !lastSignIn;
                      const email = m.email || m.user_email || "—";
                      const name = m.display_name || m.name || (email !== "—" ? email.split("@")[0] : "—");
                      const userId = m.user_id || m.id;
                      const isMe = currentUserId && userId === currentUserId;
                      return (
                        <tr key={userId || email} style={isMe ? { background: "var(--paper-2)" } : undefined}>
                          <td>{name}{isMe && <span className="mono-sm" style={{ marginLeft: 6, color: "var(--ink-3)" }}>(you)</span>}</td>
                          <td className="mono-sm">{email}</td>
                          <td>
                            <select className="input" value={m.role || "viewer"}
                                    onChange={(ev) => onChangeRole(userId, ev.target.value)}
                                    disabled={busy} style={{ height: 26 }}>
                              {ADMIN_ROLES.map((r) => <option key={r} value={r}>{r.replace(/_/g, " ")}</option>)}
                            </select>
                          </td>
                          <td>
                            {isMe
                              ? <Chip k="live">active now</Chip>
                              : pending
                                ? <Chip k="ghost">pending</Chip>
                                : <Chip k="live">active</Chip>}
                          </td>
                          <td className="mono-sm" title={lastSignIn ? new Date(lastSignIn).toLocaleString("en-IN") : ""}>
                            {isMe
                              ? "in this session"
                              : lastSignIn ? ageLabel(lastSignIn) : "—"}
                          </td>
                          <td className="mono-sm">{fmtDate(m.joined_at || m.created_at)}</td>
                          <td>
                            <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                              {pending && email !== "—" && (
                                <Btn sm kind="ghost" disabled={busy} onClick={() => onResendInvite(email)}>resend</Btn>
                              )}
                              <Btn sm kind="ghost" disabled={busy || !userId} onClick={() => setRevokeFor({ user_id: userId, email })}>remove</Btn>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </Card>
            <Card title="Invite member" eyebrow="email + role">
              <form onSubmit={onAddMember} style={{ display: "grid", gridTemplateColumns: "2fr 1fr auto", gap: 8, alignItems: "end" }}>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span className="mono-sm" style={{ color: "var(--ink-3)" }}>Email</span>
                  <input className="input" type="email" required value={memberForm.email}
                         onChange={(ev) => setMemberForm({ ...memberForm, email: ev.target.value })} style={{ height: 30 }} />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span className="mono-sm" style={{ color: "var(--ink-3)" }}>Role</span>
                  <select className="input" value={memberForm.role}
                          onChange={(ev) => setMemberForm({ ...memberForm, role: ev.target.value })} style={{ height: 30 }}>
                    {ADMIN_ROLES.map((r) => <option key={r} value={r}>{r.replace(/_/g, " ")}</option>)}
                  </select>
                </label>
                <Btn type="submit" kind="primary" sm disabled={busy}>{busy ? "inviting…" : <>{Icon.plus} invite</>}</Btn>
              </form>
              {inviteLink && (
                <div style={{ marginTop: 12, padding: 10, background: "var(--paper-3)", borderRadius: 6, border: "1px solid var(--hairline-2)" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 6 }}>
                    <span className="mono-sm" style={{ color: "var(--ink-2)" }}>
                      Invite link (forward manually if email did not arrive):
                    </span>
                    <Btn sm kind="ghost" onClick={onCopyInviteLink}>copy</Btn>
                  </div>
                  <textarea readOnly className="input mono-sm" value={inviteLink}
                            style={{ width: "100%", minHeight: 56, resize: "vertical", fontSize: 11 }} />
                </div>
              )}
            </Card>

            {revokeFor && (
              <div className="modal-backdrop" onClick={() => !busy && setRevokeFor(null)}>
                <div className="modal" onClick={(ev) => ev.stopPropagation()}
                     role="dialog" aria-modal="true" aria-labelledby="revoke-title" style={{ maxWidth: 420 }}>
                  <div className="modal-h"><span id="revoke-title">Remove member</span></div>
                  <div className="modal-body">
                    <p className="body" style={{ margin: 0 }}>
                      Remove <b>{revokeFor.email}</b> from this tenant? They will lose access immediately.
                      Their auth account is preserved; you can re-invite them later.
                    </p>
                  </div>
                  <div className="modal-f" style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                    <Btn sm kind="ghost" onClick={() => setRevokeFor(null)} disabled={busy}>cancel</Btn>
                    <Btn sm kind="primary" onClick={onRemoveMember} disabled={busy}>{busy ? "removing…" : "remove"}</Btn>
                  </div>
                </div>
              </div>
            )}
          </>
        )}

        {active === "security" && (
          <>
            <Card title="Sign-in security" eyebrow="protect your account">
              <KV rows={[
                ["Two-factor authentication (TOTP)", security?.totp_enrolled ? "Enabled" : "Not enabled"],
                ["Passkeys", security?.passkey_enrolled ? "Enabled" : "Not enabled"],
                ["MFA required at sign-in", security?.require_mfa ? "Yes" : "No"],
                ["Last security change", security?.last_security_change_at ? fmtDate(security.last_security_change_at, "medium") : "—"],
              ]} />
            </Card>

            {!security?.totp_enrolled && !enrollData && (
              <Card title="Set up authenticator app" eyebrow="TOTP · Authy / Google Authenticator / 1Password">
                <p className="body" style={{ color: "var(--ink-2)", lineHeight: 1.55 }}>
                  Adds a second factor at sign-in: a 6-digit code that refreshes every 30 seconds, generated by an
                  authenticator app you install on your phone. Recommended.
                </p>
                <Btn kind="primary" disabled={securityBusy} onClick={onMfaStart}
                     title="Generate a fresh QR code and start the enrolment flow.">
                  {securityBusy ? "Working…" : <>{Icon.shieldCheck} Set up two-factor</>}
                </Btn>
              </Card>
            )}

            {enrollData && (
              <Card title="Scan and verify" eyebrow="step 2 of 2">
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18, alignItems: "start" }}>
                  <div>
                    <div className="mono-sm" style={{ color: "var(--ink-3)", marginBottom: 8 }}>
                      Open Authy or Google Authenticator and scan this QR code, or paste the secret manually.
                    </div>
                    {/*
                      We render the QR via an external chart service for
                      now. The client never sends the secret to a third
                      party because the URL itself contains the secret;
                      this is a deliberate trade-off for keeping the
                      bundle small. Operators with a security policy
                      can replace this with a self-hosted renderer.
                    */}
                    <img
                      alt="TOTP QR code"
                      src={`https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(enrollData.otpauth_uri)}`}
                      style={{ width: 240, height: 240, border: "1px solid var(--hairline)", borderRadius: 6 }}
                    />
                    <div className="mono-sm" style={{ marginTop: 8, color: "var(--ink-3)" }}>
                      Or enter manually: <code style={{ background: "var(--paper-2)", padding: "2px 6px", borderRadius: 3 }}>{enrollData.secret}</code>
                    </div>
                  </div>
                  <div>
                    <label className="lbl">Code from your authenticator
                      <input
                        value={enrollCode}
                        onChange={(ev) => setEnrollCode(ev.target.value.replace(/\D/g, "").slice(0, 6))}
                        maxLength={6}
                        placeholder="123456"
                        autoFocus
                        style={{ letterSpacing: "0.4em", fontFamily: "var(--mono)", fontSize: 18, textAlign: "center" }}
                      />
                    </label>
                    <div className="row gap-sm" style={{ marginTop: 12 }}>
                      <Btn kind="primary" disabled={securityBusy || enrollCode.length !== 6} onClick={onMfaVerify}>
                        {securityBusy ? "Verifying…" : <>{Icon.shieldCheck} Verify and enable</>}
                      </Btn>
                      <Btn kind="ghost" onClick={() => { setEnrollData(null); setEnrollCode(""); }}
                           title="Discard this enrollment attempt. The pending secret is dropped on the server.">
                        {Icon.x} cancel
                      </Btn>
                    </div>
                    <div className="mono-sm" style={{ marginTop: 8, color: "var(--ink-3)" }}>
                      The pending secret expires {ageLabel(enrollData.expires_at)} from now. After that you'll need to start over.
                    </div>
                  </div>
                </div>
              </Card>
            )}

            <Card title="Passkeys" eyebrow="WebAuthn · phishing-resistant sign-in">
              <p className="body" style={{ color: "var(--ink-2)", lineHeight: 1.55 }}>
                Passkeys replace passwords with a key bound to your device (TouchID, FaceID, Windows Hello, a hardware
                security key). Strongly recommended for admins. You can keep your password as a fallback.
              </p>
              <div className="row gap-sm" style={{ alignItems: "end", marginBottom: 12, flexWrap: "wrap" }}>
                <label className="lbl" style={{ flex: "1 1 220px" }}>Label
                  <input value={passkeyLabel}
                         onChange={(ev) => setPasskeyLabel(ev.target.value.slice(0, 64))}
                         placeholder="e.g. MacBook Pro"
                         maxLength={64} />
                </label>
                <Btn kind="primary" disabled={passkeyBusy} onClick={onPasskeyRegister}
                     title="Register a passkey using your device's authenticator (TouchID, Windows Hello, hardware key).">
                  {passkeyBusy ? "Working…" : <>{Icon.shieldCheck} Register passkey</>}
                </Btn>
              </div>
              {passkeys.length === 0 ? (
                <div className="mono-sm" style={{ color: "var(--ink-3)" }}>No passkeys yet.</div>
              ) : (
                <table className="tbl mono-sm">
                  <thead><tr>
                    <th>Label</th>
                    <th>Device</th>
                    <th>Registered</th>
                    <th>Last used</th>
                    <th></th>
                  </tr></thead>
                  <tbody>
                    {passkeys.map((p: any) => (
                      <tr key={p.id}>
                        <td>{p.label || "—"}</td>
                        <td>{p.device_type || "—"}</td>
                        <td>{p.created_at ? fmtDate(p.created_at, "medium") : "—"}</td>
                        <td>{p.last_used_at ? ageLabel(p.last_used_at) + " ago" : "never"}</td>
                        <td>
                          <Btn sm kind="danger" disabled={passkeyBusy} onClick={() => onPasskeyRemove(p)}>
                            {Icon.x} remove
                          </Btn>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>

            {security?.totp_enrolled && (
              <Card title="Disable two-factor" eyebrow="enter your current code">
                <p className="body" style={{ color: "var(--ink-2)", lineHeight: 1.55 }}>
                  We require the current 6-digit code so a stolen session can't disable MFA without your authenticator.
                </p>
                <label className="lbl" style={{ maxWidth: 220 }}>Current code
                  <input
                    value={unenrollCode}
                    onChange={(ev) => setUnenrollCode(ev.target.value.replace(/\D/g, "").slice(0, 6))}
                    maxLength={6}
                    placeholder="123456"
                    style={{ letterSpacing: "0.4em", fontFamily: "var(--mono)", fontSize: 18, textAlign: "center" }}
                  />
                </label>
                <div className="row gap-sm" style={{ marginTop: 12 }}>
                  <Btn kind="danger" disabled={securityBusy || unenrollCode.length !== 6} onClick={onMfaDisable}>
                    {Icon.x} Disable two-factor
                  </Btn>
                </div>
              </Card>
            )}
          </>
        )}

        {active === "profile" && (
          <>
            {!profile ? (
              <Card><div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>Loading your profile…</div></Card>
            ) : (
              <>
                <Card title="My profile" eyebrow="who you are in Anvil">
                  <form onSubmit={saveProfile} style={{ display: "grid", gridTemplateColumns: "2fr auto", gap: 12, alignItems: "end" }}>
                    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <span className="mono-sm" style={{ color: "var(--ink-3)" }}>Display name</span>
                      <input className="input" type="text" required value={profileName}
                             onChange={(ev) => setProfileName(ev.target.value)}
                             placeholder="How your name appears across Anvil" style={{ height: 30 }} />
                    </label>
                    <Btn type="submit" kind="primary" sm disabled={profileBusy}>
                      {profileBusy ? "saving…" : "save"}
                    </Btn>
                  </form>
                </Card>
                <Card title="Account details" eyebrow="read-only">
                  <KV rows={[
                    ["Email", profile.user?.email || "—"],
                    ["User ID", profile.user?.id || "—"],
                    ["Last sign-in", profile.user?.last_sign_in_at ? new Date(profile.user.last_sign_in_at).toLocaleString("en-IN") : "—"],
                    ["Account created", profile.user?.created_at ? new Date(profile.user.created_at).toLocaleString("en-IN") : "—"],
                    ["Tenant memberships", String(profile.memberships?.length || 0)],
                  ]} />
                </Card>
                {/* Bug fix May 2026 (magic-link-only user lockout):
                    users who signed up via CLI or magic link only
                    never set a password, so the sign-in screen's
                    password field is unusable for them. The
                    recovery email path was broken on the route
                    side too. This card lets the logged-in user
                    trigger a recovery email for their own account,
                    completing the flow without needing to log out
                    first. The email link lands on /auth/callback.html
                    which hands off to /#/reset via sessionStorage. */}
                <Card title="Set or change password" eyebrow="for sign-in without magic link">
                  <div className="body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    <span className="mono-sm" style={{ color: "var(--ink-3)" }}>
                      A reset link will be emailed to <b>{profile.user?.email || "your account"}</b>.
                      The link is single-use and expires in 1 hour. Use it to set a password so you can sign in
                      without a magic link.
                    </span>
                    <Btn sm kind="primary" onClick={async () => {
                      try {
                        const cfg = (AnvilBackend?.getConfig?.() || {}) as { url?: string };
                        const origin = (typeof window !== "undefined" && window.location.origin) || (cfg.url || "");
                        const redirect = origin.replace(/\/+$/, "") + "/auth/callback.html";
                        const session = (AnvilBackend?.getSession?.() || null) as { access_token?: string } | null;
                        const headers: Record<string, string> = { "Content-Type": "application/json" };
                        if (session?.access_token) headers["Authorization"] = "Bearer " + session.access_token;
                        const resp = await fetch((cfg.url || "").replace(/\/+$/, "") + "/api/auth/request_reset", {
                          method: "POST",
                          headers,
                          body: JSON.stringify({ email: profile.user?.email, redirect_to: redirect }),
                        });
                        const body = await resp.json().catch(() => null);
                        if (!resp.ok) throw new Error(body?.error?.message || "Could not send reset email");
                        window.notifySuccess?.("Reset link sent", body?.message || "Check your inbox.");
                      } catch (err: any) {
                        window.notifyError?.("Could not send reset email", err?.message || String(err));
                      }
                    }}>Email me a password-set link</Btn>
                  </div>
                </Card>
                {Array.isArray(profile.memberships) && profile.memberships.length > 0 && (
                  <Card title="Your roles" eyebrow="across all tenants you belong to">
                    <table className="tbl">
                      <thead><tr><th>Tenant</th><th>Role</th></tr></thead>
                      <tbody>
                        {profile.memberships.map((m: any) => (
                          <tr key={m.tenant_id}>
                            <td>{m.tenants?.display_name || m.tenants?.slug || m.tenant_id}</td>
                            <td>{String(m.role || "viewer").replace(/_/g, " ")}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </Card>
                )}
              </>
            )}
          </>
        )}

        {active === "roles" && (
          <>
            <Card title="Permission matrix" eyebrow="who can do what · canonical source">
              <p className="body" style={{ margin: "0 0 12px 0", color: "var(--ink-3)" }}>
                Read = <code>r</code>, Write = <code>w</code>, Approve = <code>a</code>, Admin-only = <code>x</code>, blank = hidden.
                The same matrix is enforced server-side via <code>requirePermission(ctx, level)</code>.
                Changes here require editing <code>src/v3-app/lib/rbac.ts</code> + <code>src/api/_lib/auth.js</code> together.
              </p>
              <div style={{ overflow: "auto" }}>
                <table className="tbl mono-sm" style={{ minWidth: 720 }}>
                  <thead>
                    <tr>
                      <th style={{ position: "sticky", left: 0, background: "var(--paper)" }}>Screen</th>
                      {RBAC.ROLES.map((r) => (
                        <th key={r} style={{ textAlign: "center" }}>{r.replace(/_/g, " ")}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {Object.keys(MATRIX).sort().map((navId) => {
                      const row: Record<string, string> = MATRIX[navId];
                      return (
                        <tr key={navId}>
                          <td style={{ position: "sticky", left: 0, background: "var(--paper)" }}>{navId}</td>
                          {RBAC.ROLES.map((r) => {
                            const cell = row[r] || "";
                            const k = cell.includes("x") ? "warn"
                              : cell.includes("a") ? "live"
                              : cell.includes("w") ? "info"
                              : cell.includes("r") ? "ghost"
                              : null;
                            return (
                              <td key={r} style={{ textAlign: "center" }}>
                                {k ? <Chip k={k}>{cell}</Chip> : <span style={{ color: "var(--ink-4)" }}>—</span>}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>

            <Card title="Action gates" eyebrow="fine-grained checks beyond the matrix">
              <p className="body" style={{ margin: "0 0 8px 0", color: "var(--ink-3)" }}>
                Some actions are gated by an explicit allow-list, independent of the screen-level matrix.
                Examples: <code>tally.push</code>, <code>einvoice.generate</code>, <code>so.approve</code>.
              </p>
              <table className="tbl mono-sm">
                <thead><tr><th>Action</th><th>Allowed roles</th></tr></thead>
                <tbody>
                  {Object.keys(ACTIONS).sort().map((a) => (
                    <tr key={a}>
                      <td>{a}</td>
                      <td>{ACTIONS[a].map((r) => <Chip key={r} k="ghost">{r.replace(/_/g, " ")}</Chip>)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </>
        )}

        {active === "navigation" && <NavVisibilityAdmin />}

        {active === "billing" && (
          <>
            <Card title="Outcome meter" eyebrow="what your tenant has actually done · billable units">
              <div className="row" style={{ gap: 8, alignItems: "end", marginBottom: 12 }}>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span className="mono-sm" style={{ color: "var(--ink-3)" }}>From</span>
                  <select className="input" value={billingFrom}
                          onChange={(ev) => { setBillingFrom(ev.target.value); setBilling(null); loadBilling(ev.target.value); }}
                          style={{ height: 30 }}>
                    <option value="month-to-date">Month to date</option>
                    <option value={new Date(Date.now() - 7 * 86400000).toISOString()}>Last 7 days</option>
                    <option value={new Date(Date.now() - 30 * 86400000).toISOString()}>Last 30 days</option>
                    <option value={new Date(Date.now() - 90 * 86400000).toISOString()}>Last 90 days</option>
                  </select>
                </label>
                <Btn sm kind="ghost" onClick={() => { setBilling(null); loadBilling(billingFrom); }}>{Icon.cycle} refresh</Btn>
                <span style={{ flex: 1 }} />
                {billing?.generated_at && (
                  <span className="mono-sm" style={{ color: "var(--ink-4)" }}>
                    as of {new Date(billing.generated_at).toLocaleString("en-IN")}
                  </span>
                )}
              </div>

              {!billing ? (
                <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>Loading usage…</div>
              ) : (
                <>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14, marginBottom: 14 }}>
                    <Card title="Total outcomes" eyebrow="this period">
                      <div className="h1" style={{ margin: 0, fontFeatureSettings: "'tnum'" }}>{billing.total_outcomes}</div>
                      <div className="mono-sm" style={{ color: "var(--ink-3)" }}>billable units</div>
                    </Card>
                    <Card title="Spend" eyebrow="USD this period">
                      <div className="h1" style={{ margin: 0, fontFeatureSettings: "'tnum'" }}>
                        ${(billing.total_cents / 100).toFixed(2)}
                      </div>
                      <div className="mono-sm" style={{ color: "var(--ink-3)" }}>at public price card</div>
                    </Card>
                    <Card title="Window" eyebrow="UTC">
                      <div className="mono-sm" style={{ color: "var(--ink-2)" }}>
                        {fmtDate(billing.from, "medium")}
                      </div>
                      <div className="mono-sm" style={{ color: "var(--ink-3)" }}>to</div>
                      <div className="mono-sm" style={{ color: "var(--ink-2)" }}>
                        {fmtDate(billing.to, "medium")}
                      </div>
                    </Card>
                  </div>
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>Outcome</th>
                        <th className="r">Count</th>
                        <th className="r">Unit price</th>
                        <th className="r">Subtotal</th>
                      </tr>
                    </thead>
                    <tbody>
                      {billing.lines.map((l: any) => (
                        <tr key={l.id} style={l.count === 0 ? { opacity: 0.5 } : undefined}>
                          <td>{l.label}</td>
                          <td className="r mono">{l.count}</td>
                          <td className="r mono">${(l.unit_price_cents / 100).toFixed(2)}</td>
                          <td className="r mono">${(l.subtotal_cents / 100).toFixed(2)}</td>
                        </tr>
                      ))}
                      <tr style={{ borderTop: "2px solid var(--hairline)", fontWeight: 600 }}>
                        <td>Total</td>
                        <td className="r mono">{billing.total_outcomes}</td>
                        <td></td>
                        <td className="r mono">${(billing.total_cents / 100).toFixed(2)}</td>
                      </tr>
                    </tbody>
                  </table>
                  <div className="body mono-sm" style={{ color: "var(--ink-3)", marginTop: 10 }}>
                    Outcomes are derived from <code>audit_events</code> via the public mapping in
                    <code> src/api/_lib/outcomes.js</code>. Pricing is the public price card; tenant-specific
                    overrides land in tenant_settings in a follow-up.
                  </div>
                </>
              )}
            </Card>

            <Card title="Stripe Connect" eyebrow="payment rails for non-India tenants">
              {!stripe ? (
                <div className="body mono-sm" style={{ color: "var(--ink-3)" }}>Loading Stripe status…</div>
              ) : !stripe.configured ? (
                <Banner kind="warn" icon={Icon.alert} title="Stripe not configured on the platform">
                  <span className="mono-sm">
                    Set <code>STRIPE_SECRET_KEY</code> + <code>STRIPE_WEBHOOK_SECRET</code> in Vercel to enable
                    payment collection. Tenants then onboard their own connected accounts here.
                  </span>
                </Banner>
              ) : !stripe.account_id ? (
                <>
                  <div className="body" style={{ marginBottom: 10 }}>
                    No Stripe Connect account on file for this tenant. Click below to start onboarding;
                    Stripe walks you through identity + bank-account setup. The window opens in a new tab.
                  </div>
                  <Btn sm kind="primary" onClick={onStripeConnect} disabled={stripeBusy}>
                    {stripeBusy ? "starting…" : <>{Icon.send} Connect Stripe</>}
                  </Btn>
                </>
              ) : (
                <>
                  <div className="row" style={{ gap: 6, marginBottom: 10 }}>
                    {stripe.charges_enabled
                      ? <Chip k="live">charges enabled</Chip>
                      : <Chip k="warn">charges disabled</Chip>}
                    {stripe.payouts_enabled
                      ? <Chip k="live">payouts enabled</Chip>
                      : <Chip k="warn">payouts disabled</Chip>}
                    {stripe.details_submitted
                      ? <Chip k="ghost">details submitted</Chip>
                      : <Chip k="warn">details pending</Chip>}
                    <span style={{ flex: 1 }} />
                    <Btn sm kind="ghost" onClick={() => { setStripe(null); loadStripe(); }}>{Icon.cycle} refresh</Btn>
                  </div>
                  <KV rows={[
                    ["Account id", stripe.account_id],
                    ["Country", stripe.country || "—"],
                    ["Default currency", String(stripe.default_currency || "usd").toUpperCase()],
                    ["Requirements due", (stripe.requirements_currently_due || []).join(", ") || "—"],
                  ]} />
                  {(stripe.requirements_currently_due || []).length > 0 && (
                    <div style={{ marginTop: 10 }}>
                      <Btn sm kind="ghost" onClick={onStripeConnect} disabled={stripeBusy}>
                        {stripeBusy ? "opening…" : "Continue onboarding"}
                      </Btn>
                    </div>
                  )}
                </>
              )}
            </Card>
          </>
        )}

        {active === "netsuite" && (
          <>
            <Card title="NetSuite Connect" eyebrow="ERP read + push, encrypted at rest, retry on failure">
              {!netsuite ? (
                <div className="body" style={{ padding: 16, textAlign: "center", color: "var(--ink-3)" }}>Loading…</div>
              ) : netsuite.configured ? (
                <>
                  <div className="row" style={{ gap: 6, marginBottom: 10, alignItems: "center", flexWrap: "wrap" }}>
                    <Chip k="live">connected</Chip>
                    {netsuite.storage_mode === "encrypted"
                      ? <Chip k="ghost">encrypted</Chip>
                      : netsuite.storage_mode === "plaintext"
                        ? <Chip k="warn">plaintext (set ANVIL_SECRETS_KEY to encrypt)</Chip>
                        : null}
                    <span className="mono-sm" style={{ color: "var(--ink-3)" }}>
                      account {netsuite.account_id}
                      {netsuite.subsidiary_id ? " · sub " + netsuite.subsidiary_id : ""}
                      {netsuite.connected_at ? " · since " + fmtDate(netsuite.connected_at, "medium") : ""}
                    </span>
                  </div>
                  {(netsuite.retry_pending || netsuite.retry_gave_up) ? (
                    <Banner kind={netsuite.retry_gave_up ? "bad" : "warn"} icon={Icon.alert}
                            title={"Retry queue: " + (netsuite.retry_pending || 0) + " pending, " + (netsuite.retry_gave_up || 0) + " gave up"}>
                      <div className="row" style={{ gap: 8 }}>
                        <Btn sm kind="ghost" onClick={onNsRetryNow} disabled={nsRetryBusy}>
                          {nsRetryBusy ? "replaying…" : <>{Icon.cycle} Retry now</>}
                        </Btn>
                      </div>
                    </Banner>
                  ) : null}
                  <table className="tbl mono-sm">
                    <thead><tr>
                      <th>Entity</th><th>Last sync</th><th>High water</th><th>Status</th>
                      <th className="r">Pulled</th><th className="r">Updated</th>
                      <th>Error</th><th>Sync</th>
                    </tr></thead>
                    <tbody>
                      {(netsuite.sync_state || []).length === 0 ? (
                        <tr><td colSpan={8} style={{ textAlign: "center", color: "var(--ink-3)" }}>No syncs yet. Cron runs every 30 minutes.</td></tr>
                      ) : (netsuite.sync_state || []).map((s: any) => (
                        <tr key={s.entity}>
                          <td>{s.entity}</td>
                          <td>{s.last_sync_at ? fmtDate(s.last_sync_at, "medium") + " " + new Date(s.last_sync_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : "—"}</td>
                          <td style={{ color: "var(--ink-3)" }}>{fmtDate(s.last_modified_high_water, "medium")}</td>
                          <td>
                            {s.status === "running" ? <Chip k="warn">running</Chip>
                              : s.status === "error" ? <Chip k="bad">error</Chip>
                              : <Chip k="ghost">idle</Chip>}
                          </td>
                          <td className="r">{s.rows_pulled || 0}</td>
                          <td className="r">{s.records_updated || 0}</td>
                          <td style={{ color: "var(--rust)", fontSize: 11 }}>{s.error ? String(s.error).slice(0, 80) : ""}</td>
                          <td>
                            <Btn sm kind="ghost" onClick={() => onNsSyncNow(s.entity, false)} disabled={nsSyncBusy}>delta</Btn>{" "}
                            <Btn sm kind="ghost" onClick={() => onNsSyncNow(s.entity, true)} disabled={nsSyncBusy}>full</Btn>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="row" style={{ marginTop: 10, gap: 8, flexWrap: "wrap" }}>
                    <Btn sm kind="ghost" onClick={() => { setNetsuite(null); loadNetsuite(); }}>{Icon.cycle} refresh</Btn>
                    <Btn sm kind="primary" onClick={() => onNsSyncNow(null, false)} disabled={nsSyncBusy}>
                      {nsSyncBusy ? "syncing…" : "Sync all (delta)"}
                    </Btn>
                    <Btn sm kind="ghost" onClick={() => onNsSyncNow(null, true)} disabled={nsSyncBusy}>
                      Full re-sync
                    </Btn>
                    <Btn sm kind="ghost" onClick={onNsRunDiagnostics} disabled={nsDiagBusy}>
                      {nsDiagBusy ? "probing…" : <>{Icon.shieldCheck} Run diagnostics</>}
                    </Btn>
                  </div>
                </>
              ) : (
                <Banner kind="warn" icon={Icon.alert} title="No NetSuite credentials on file">
                  <span className="mono-sm">Set the TBA credentials below to enable read sync + SO push.</span>
                </Banner>
              )}
            </Card>

            {netsuite?.configured && nsDiag && (
              <Card title="Diagnostics" eyebrow={"ran at " + (nsDiag.ran_at ? new Date(nsDiag.ran_at).toLocaleTimeString("en-US") : "—")}>
                <table className="tbl mono-sm">
                  <thead><tr><th>Entity</th><th>Status</th><th className="r">HTTP</th><th className="r">Latency</th><th className="r">Rows</th><th>Error</th></tr></thead>
                  <tbody>
                    {(nsDiag.probes || []).map((p: any) => (
                      <tr key={p.entity}>
                        <td>{p.entity}</td>
                        <td>{p.ok ? <Chip k="live">ok</Chip> : <Chip k="bad">fail</Chip>}</td>
                        <td className="r">{p.status}</td>
                        <td className="r">{p.latency_ms} ms</td>
                        <td className="r">{p.rows_returned}</td>
                        <td style={{ color: "var(--rust)", fontSize: 11 }}>{p.error ? String(p.error).slice(0, 120) : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            )}

            {netsuite?.configured && (
              <Card title="Recent sync runs" eyebrow="last 20 ticks across cron + manual">
                {(netsuite.recent_runs || []).length === 0 ? (
                  <div className="body" style={{ padding: 12, color: "var(--ink-3)" }}>No runs recorded yet.</div>
                ) : (
                  <table className="tbl mono-sm">
                    <thead><tr><th>Started</th><th>Entity</th><th>Status</th><th>Trigger</th><th className="r">Pulled</th><th className="r">Errored</th><th>Error</th></tr></thead>
                    <tbody>
                      {(netsuite.recent_runs || []).map((r: any, idx: number) => (
                        <tr key={idx}>
                          <td>{new Date(r.run_started_at).toLocaleTimeString("en-US")}</td>
                          <td>{r.entity}</td>
                          <td>
                            {r.status === "ok" ? <Chip k="live">ok</Chip>
                              : r.status === "error" ? <Chip k="bad">error</Chip>
                              : r.status === "partial" ? <Chip k="warn">partial</Chip>
                              : <Chip k="ghost">running</Chip>}
                          </td>
                          <td>{r.triggered_by}</td>
                          <td className="r">{r.rows_pulled || 0}</td>
                          <td className="r">{r.rows_errored || 0}</td>
                          <td style={{ color: "var(--rust)", fontSize: 11 }}>{r.error ? String(r.error).slice(0, 100) : ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>
            )}

            {netsuite?.configured && (
              <Card title="Field map" eyebrow="JSON: source path -> target path on the SO payload">
                <textarea
                  className="input mono-sm"
                  rows={8}
                  value={nsFieldMapDraft}
                  onChange={(ev) => setNsFieldMapDraft(ev.target.value)}
                  style={{ width: "100%", fontFamily: "var(--mono)" }}
                  placeholder='{"memo": "custbody_short_memo"}'
                />
                <div className="row" style={{ marginTop: 8, gap: 8 }}>
                  <Btn sm kind="primary" onClick={onNsSaveFieldMap} disabled={nsFieldMapBusy}>
                    {nsFieldMapBusy ? "saving…" : "Save field map"}
                  </Btn>
                  <span className="mono-sm" style={{ color: "var(--ink-3)", alignSelf: "center" }}>
                    Up to 50 entries. Source paths reference the rendered SO payload; targets are where to move the value.
                  </span>
                </div>
              </Card>
            )}

            <Card title="Configure NetSuite credentials" eyebrow="TBA · stored in tenant_settings">
              <form onSubmit={onNsConnect} style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span className="mono-sm" style={{ color: "var(--ink-3)" }}>Account id</span>
                  <input className="input mono-sm" type="text" required value={nsForm.account_id}
                         onChange={(ev) => setNsForm({ ...nsForm, account_id: ev.target.value })}
                         placeholder="1234567 or 1234567_SB1" />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span className="mono-sm" style={{ color: "var(--ink-3)" }}>Consumer key</span>
                  <input className="input mono-sm" type="text" required value={nsForm.consumer_key}
                         onChange={(ev) => setNsForm({ ...nsForm, consumer_key: ev.target.value })} />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span className="mono-sm" style={{ color: "var(--ink-3)" }}>Consumer secret</span>
                  <input className="input mono-sm" type="password" required value={nsForm.consumer_secret}
                         onChange={(ev) => setNsForm({ ...nsForm, consumer_secret: ev.target.value })} />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span className="mono-sm" style={{ color: "var(--ink-3)" }}>Token id</span>
                  <input className="input mono-sm" type="text" required value={nsForm.token_id}
                         onChange={(ev) => setNsForm({ ...nsForm, token_id: ev.target.value })} />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 4, gridColumn: "1 / -1" }}>
                  <span className="mono-sm" style={{ color: "var(--ink-3)" }}>Token secret</span>
                  <input className="input mono-sm" type="password" required value={nsForm.token_secret}
                         onChange={(ev) => setNsForm({ ...nsForm, token_secret: ev.target.value })} />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span className="mono-sm" style={{ color: "var(--ink-3)" }}>Subsidiary id (optional)</span>
                  <input className="input mono-sm" type="text" value={nsForm.subsidiary_id}
                         onChange={(ev) => setNsForm({ ...nsForm, subsidiary_id: ev.target.value })}
                         placeholder="numeric id" />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span className="mono-sm" style={{ color: "var(--ink-3)" }}>Default location id (optional)</span>
                  <input className="input mono-sm" type="text" value={nsForm.default_location_id}
                         onChange={(ev) => setNsForm({ ...nsForm, default_location_id: ev.target.value })}
                         placeholder="numeric id" />
                </label>
                <div style={{ gridColumn: "1 / -1", display: "flex", gap: 8 }}>
                  <Btn type="submit" kind="primary" sm disabled={nsBusy}>
                    {nsBusy ? "probing…" : <>{Icon.shieldCheck} Save and probe</>}
                  </Btn>
                  <span className="mono-sm" style={{ color: "var(--ink-3)", alignSelf: "center" }}>
                    Credentials encrypt with AES-256-GCM if ANVIL_SECRETS_KEY is set; otherwise stored as plaintext.
                  </span>
                </div>
              </form>
            </Card>
          </>
        )}

        {active === "tally" && (
          <>
            <Card title="Tally Connect" eyebrow="multi-company XML bridge with retry + reverse sync">
              {!tally ? (
                <div className="body" style={{ padding: 16, textAlign: "center", color: "var(--ink-3)" }}>Loading…</div>
              ) : (tally.companies || []).length === 0 && !tally.configured ? (
                <Banner kind="warn" icon={Icon.alert} title="No Tally companies configured">
                  <span className="mono-sm">Add at least one company below to enable XML push, retry queue, and reverse sync.</span>
                </Banner>
              ) : (
                <>
                  <div className="row" style={{ gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
                    <Chip k={tally.configured ? "live" : "warn"}>{tally.configured ? "configured" : "legacy env bridge"}</Chip>
                    <span className="mono-sm" style={{ color: "var(--ink-3)" }}>
                      {tally.companies?.length || 0} compan{(tally.companies?.length || 0) === 1 ? "y" : "ies"}
                      {" · " + (tally.voucher_state_count || 0) + " mirrored vouchers"}
                      {" · " + (tally.payment_count || 0) + " payments"}
                      {tally.payment_total ? " (₹" + Number(tally.payment_total).toLocaleString("en-IN") + ")" : ""}
                    </span>
                  </div>
                  {(tally.retry_pending || tally.retry_gave_up) ? (
                    <Banner kind={tally.retry_gave_up ? "bad" : "warn"} icon={Icon.alert}
                            title={"Retry queue: " + (tally.retry_pending || 0) + " pending, " + (tally.retry_gave_up || 0) + " gave up"}>
                      <Btn sm kind="ghost" onClick={onTallyRetryNow} disabled={tallyRetryBusy}>
                        {tallyRetryBusy ? "replaying…" : <>{Icon.cycle} Retry now</>}
                      </Btn>
                    </Banner>
                  ) : null}
                  <table className="tbl mono-sm">
                    <thead><tr><th>Company</th><th>Bridge URL</th><th>Token</th><th>Last health</th><th>GSTIN</th><th></th></tr></thead>
                    <tbody>
                      {(tally.companies || []).length === 0 ? (
                        <tr><td colSpan={6} style={{ textAlign: "center", color: "var(--ink-3)" }}>No companies; using TALLY_BRIDGE_URL env legacy fallback if set.</td></tr>
                      ) : (tally.companies || []).map((c: any) => (
                        <tr key={c.id}>
                          <td>
                            {c.is_default ? <Chip k="live">default</Chip> : null}{" "}
                            {c.name}
                          </td>
                          <td style={{ color: "var(--ink-3)", fontSize: 11 }}>{c.bridge_url || "—"}</td>
                          <td>{c.bridge_token_set ? <Chip k="ghost">set</Chip> : <Chip k="warn">none</Chip>}</td>
                          <td>
                            {c.last_health_status === "ok" ? <Chip k="live">ok</Chip>
                             : c.last_health_status === "down" ? <Chip k="bad">down</Chip>
                             : c.last_health_status === "degraded" ? <Chip k="warn">degraded</Chip>
                             : <Chip k="ghost">—</Chip>}
                          </td>
                          <td>{c.gstin || "—"}</td>
                          <td>
                            <Btn sm kind="ghost" onClick={() => onTallyDiagnostics(c.id)} disabled={tallyDiagBusy}>probe</Btn>{" "}
                            {!c.is_default && <Btn sm kind="ghost" onClick={() => onTallySetDefault(c.id)}>set default</Btn>}{" "}
                            <Btn sm kind="ghost" onClick={() => onTallyDeleteCompany(c.id)}>remove</Btn>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="row" style={{ marginTop: 10, gap: 8, flexWrap: "wrap" }}>
                    <Btn sm kind="ghost" onClick={() => { setTally(null); loadTally(); }}>{Icon.cycle} refresh</Btn>
                    <Btn sm kind="primary" onClick={() => onTallySyncNow(null, false)} disabled={tallySyncBusy}>
                      {tallySyncBusy ? "syncing…" : "Reverse-sync (delta)"}
                    </Btn>
                    <Btn sm kind="ghost" onClick={() => onTallySyncNow(null, true)} disabled={tallySyncBusy}>
                      Full reverse-sync
                    </Btn>
                    <Btn sm kind="ghost" onClick={() => onTallyDiagnostics(undefined)} disabled={tallyDiagBusy}>
                      {tallyDiagBusy ? "probing…" : <>{Icon.shieldCheck} Probe default bridge</>}
                    </Btn>
                  </div>
                </>
              )}
            </Card>

            <Card title="Add Tally company" eyebrow="bridge token encrypted at rest if ANVIL_SECRETS_KEY is set">
              <form onSubmit={onTallyAddCompany} style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span className="mono-sm" style={{ color: "var(--ink-3)" }}>Company name</span>
                  <input className="input mono-sm" type="text" required value={tallyCompanyForm.name}
                         onChange={(ev) => setTallyCompanyForm({ ...tallyCompanyForm, name: ev.target.value })}
                         placeholder="Anvil Industries Pvt Ltd" />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span className="mono-sm" style={{ color: "var(--ink-3)" }}>GSTIN (optional)</span>
                  <input className="input mono-sm" type="text" value={tallyCompanyForm.gstin}
                         onChange={(ev) => setTallyCompanyForm({ ...tallyCompanyForm, gstin: ev.target.value })} />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 4, gridColumn: "1 / -1" }}>
                  <span className="mono-sm" style={{ color: "var(--ink-3)" }}>Bridge URL</span>
                  <input className="input mono-sm" type="url" value={tallyCompanyForm.bridge_url}
                         onChange={(ev) => setTallyCompanyForm({ ...tallyCompanyForm, bridge_url: ev.target.value })}
                         placeholder="https://tally-bridge.local:8000" />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span className="mono-sm" style={{ color: "var(--ink-3)" }}>Bridge token (optional)</span>
                  <input className="input mono-sm" type="password" value={tallyCompanyForm.bridge_token}
                         onChange={(ev) => setTallyCompanyForm({ ...tallyCompanyForm, bridge_token: ev.target.value })} />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span className="mono-sm" style={{ color: "var(--ink-3)" }}>Default voucher series</span>
                  <input className="input mono-sm" type="text" value={tallyCompanyForm.default_voucher_series}
                         onChange={(ev) => setTallyCompanyForm({ ...tallyCompanyForm, default_voucher_series: ev.target.value })}
                         placeholder="SO/2026/" />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span className="mono-sm" style={{ color: "var(--ink-3)" }}>Default sales ledger</span>
                  <input className="input mono-sm" type="text" value={tallyCompanyForm.default_sales_ledger}
                         onChange={(ev) => setTallyCompanyForm({ ...tallyCompanyForm, default_sales_ledger: ev.target.value })}
                         placeholder="Sales (Domestic)" />
                </label>
                <div style={{ gridColumn: "1 / -1", display: "flex", gap: 8 }}>
                  <Btn type="submit" kind="primary" sm disabled={tallyCompanyBusy}>
                    {tallyCompanyBusy ? "saving…" : <>{Icon.shieldCheck} Add company</>}
                  </Btn>
                </div>
              </form>
            </Card>

            {tally?.recent_runs?.length > 0 && (
              <Card title="Recent Tally sync runs">
                <table className="tbl mono-sm">
                  <thead><tr><th>Started</th><th>Entity</th><th>Status</th><th>Trigger</th><th className="r">Pulled</th><th className="r">Updated</th><th>Error</th></tr></thead>
                  <tbody>
                    {(tally.recent_runs || []).map((r: any, idx: number) => (
                      <tr key={idx}>
                        <td>{new Date(r.run_started_at).toLocaleTimeString("en-US")}</td>
                        <td>{r.entity}</td>
                        <td>
                          {r.status === "ok" ? <Chip k="live">ok</Chip>
                            : r.status === "error" ? <Chip k="bad">error</Chip>
                            : r.status === "partial" ? <Chip k="warn">partial</Chip>
                            : <Chip k="ghost">running</Chip>}
                        </td>
                        <td>{r.triggered_by}</td>
                        <td className="r">{r.rows_pulled || 0}</td>
                        <td className="r">{(r.rows_updated || 0) + (r.rows_inserted || 0)}</td>
                        <td style={{ color: "var(--rust)", fontSize: 11 }}>{r.error ? String(r.error).slice(0, 100) : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            )}

            {tallyDiag && (
              <Card title="Tally diagnostics" eyebrow={tallyDiag.company || "default"}>
                <table className="tbl mono-sm">
                  <thead><tr><th>Probe</th><th>Status</th><th className="r">HTTP</th><th className="r">Latency</th><th>Detail</th></tr></thead>
                  <tbody>
                    {(tallyDiag.probes || []).map((p: any, idx: number) => (
                      <tr key={idx}>
                        <td>{p.probe}</td>
                        <td>{p.ok ? <Chip k="live">ok</Chip> : <Chip k="bad">fail</Chip>}</td>
                        <td className="r">{p.status}</td>
                        <td className="r">{p.latency_ms || 0} ms</td>
                        <td style={{ fontSize: 11, color: "var(--ink-3)" }}>
                          {p.vouchers_returned !== undefined ? "vouchers=" + p.vouchers_returned : ""}
                          {p.receipts_returned !== undefined ? "receipts=" + p.receipts_returned : ""}
                          {p.body && typeof p.body === "object"
                            ? " " + JSON.stringify(p.body).slice(0, 120) : ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            )}
          </>
        )}

        {active === "sage_x3" && (
          <>
            <Card title="Sage X3 (Sage Enterprise Management)" eyebrow="OAuth2 client_credentials · SData REST">
              <div className="form-grid">
                <label className="lbl">Base URL
                  <input value={sageX3Form.base_url} onChange={(ev) => setSageX3Form({ ...sageX3Form, base_url: ev.target.value })}
                    placeholder="https://x3.example.com" />
                </label>
                <label className="lbl">Token URL
                  <input value={sageX3Form.token_url} onChange={(ev) => setSageX3Form({ ...sageX3Form, token_url: ev.target.value })}
                    placeholder="https://idp.example.com/.../token" />
                </label>
                <label className="lbl">Solution
                  <input value={sageX3Form.solution} onChange={(ev) => setSageX3Form({ ...sageX3Form, solution: ev.target.value })} placeholder="X3" />
                </label>
                <label className="lbl">Folder / company
                  <input value={sageX3Form.company} onChange={(ev) => setSageX3Form({ ...sageX3Form, company: ev.target.value })} placeholder="SEED" />
                </label>
                <label className="lbl">Locale
                  <input value={sageX3Form.locale} onChange={(ev) => setSageX3Form({ ...sageX3Form, locale: ev.target.value })} placeholder="ENG" />
                </label>
                <label className="lbl">Client ID
                  <input value={sageX3Form.client_id} onChange={(ev) => setSageX3Form({ ...sageX3Form, client_id: ev.target.value })} />
                </label>
                <label className="lbl span-2">Client secret
                  <input type="password" value={sageX3Form.client_secret} onChange={(ev) => setSageX3Form({ ...sageX3Form, client_secret: ev.target.value })} />
                </label>
              </div>
              <div className="row gap-sm" style={{ marginTop: 12 }}>
                <Btn kind="primary" disabled={sageX3Busy} onClick={onSageX3Connect}
                  title="Save credentials and probe the connection">
                  {sageX3Busy ? "Working…" : <>{Icon.shieldCheck} Save & probe</>}
                </Btn>
                <Btn kind="ghost" disabled={sageX3Busy || !sageX3?.configured} onClick={onSageX3SyncNow}
                  title={sageX3?.configured ? "Pull customers, items, and sales orders from Sage X3" : "Save credentials first"}>
                  {Icon.cycle} Sync now
                </Btn>
                <Btn kind="ghost" disabled={sageX3Busy || !sageX3?.configured || !sageX3?.retry_pending} onClick={onSageX3RetryNow}
                  title={sageX3?.retry_pending ? "Replay queued pushes" : "Retry queue is empty"}>
                  {Icon.cycle} Retry queue ({sageX3?.retry_pending || 0})
                </Btn>
              </div>
            </Card>

            {sageX3 && (
              <Card title="Status" eyebrow="from /api/sage_x3/health">
                <KV rows={[
                  ["Configured", String(sageX3.configured ?? false)],
                  ["Probe ok", sageX3.probe_ok == null ? "—" : String(sageX3.probe_ok)],
                  ["Connected at", sageX3.connected_at || "—"],
                  ["Retry queue pending", String(sageX3.retry_pending || 0)],
                  ["Probe error", sageX3.probe_error || "—"],
                ]} />
                {Array.isArray(sageX3.sync_state) && sageX3.sync_state.length > 0 && (
                  <table className="tbl mono-sm" style={{ marginTop: 12 }}>
                    <thead><tr><th>Entity</th><th>Status</th><th>Last sync</th><th className="r">Pulled</th><th>Error</th></tr></thead>
                    <tbody>
                      {sageX3.sync_state.map((s: any) => (
                        <tr key={s.entity}>
                          <td>{s.entity}</td>
                          <td>{s.status}</td>
                          <td>{s.last_sync_at ? new Date(s.last_sync_at).toLocaleString("en-IN") : "—"}</td>
                          <td className="r">{s.rows_pulled || 0}</td>
                          <td style={{ color: "var(--rust)" }}>{s.last_error || ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>
            )}
          </>
        )}

        {active === "ifs" && (
          <>
            <Card title="IFS Cloud" eyebrow="OAuth2 client_credentials · OData v4 projection API">
              <div className="form-grid">
                <label className="lbl">Base URL
                  <input value={ifsForm.base_url} onChange={(ev) => setIfsForm({ ...ifsForm, base_url: ev.target.value })}
                    placeholder="https://ifs.example.com" />
                </label>
                <label className="lbl">Token URL
                  <input value={ifsForm.token_url} onChange={(ev) => setIfsForm({ ...ifsForm, token_url: ev.target.value })}
                    placeholder="https://iam.example.com/auth/realms/<realm>/protocol/openid-connect/token" />
                </label>
                <label className="lbl">Scope
                  <input value={ifsForm.scope} onChange={(ev) => setIfsForm({ ...ifsForm, scope: ev.target.value })}
                    placeholder="openid profile INTEGRATION" />
                </label>
                <label className="lbl">Company
                  <input value={ifsForm.company} onChange={(ev) => setIfsForm({ ...ifsForm, company: ev.target.value })}
                    placeholder="optional, sent as IFS-Company header" />
                </label>
                <label className="lbl span-2">Projection module
                  <input value={ifsForm.projection} onChange={(ev) => setIfsForm({ ...ifsForm, projection: ev.target.value })}
                    placeholder="CustomerOrder.svc" />
                </label>
                <label className="lbl">Client ID
                  <input value={ifsForm.client_id} onChange={(ev) => setIfsForm({ ...ifsForm, client_id: ev.target.value })} />
                </label>
                <label className="lbl">Client secret
                  <input type="password" value={ifsForm.client_secret} onChange={(ev) => setIfsForm({ ...ifsForm, client_secret: ev.target.value })} />
                </label>
              </div>
              <div className="row gap-sm" style={{ marginTop: 12 }}>
                <Btn kind="primary" disabled={ifsBusy} onClick={onIfsConnect}>
                  {ifsBusy ? "Working…" : <>{Icon.shieldCheck} Save & probe</>}
                </Btn>
                <Btn kind="ghost" disabled={ifsBusy || !ifsState?.configured} onClick={onIfsSyncNow}>
                  {Icon.cycle} Sync now
                </Btn>
                <Btn kind="ghost" disabled={ifsBusy || !ifsState?.configured || !ifsState?.retry_pending} onClick={onIfsRetryNow}>
                  {Icon.cycle} Retry queue ({ifsState?.retry_pending || 0})
                </Btn>
              </div>
            </Card>
            {ifsState && (
              <Card title="Status" eyebrow="from /api/ifs/health">
                <KV rows={[
                  ["Configured", String(ifsState.configured ?? false)],
                  ["Probe ok", ifsState.probe_ok == null ? "—" : String(ifsState.probe_ok)],
                  ["Connected at", ifsState.connected_at || "—"],
                  ["Retry queue pending", String(ifsState.retry_pending || 0)],
                  ["Probe error", ifsState.probe_error || "—"],
                ]} />
              </Card>
            )}
          </>
        )}

        {active === "oracle_fusion" && (
          <>
            <Card title="Oracle Fusion Cloud ERP" eyebrow="OAuth2 client_credentials · REST salesOrdersForOrderHub">
              <div className="form-grid">
                <label className="lbl">Base URL
                  <input value={oracleFusionForm.base_url} onChange={(ev) => setOracleFusionForm({ ...oracleFusionForm, base_url: ev.target.value })}
                    placeholder="https://<your-pod>.oracleoutsourcing.com" />
                </label>
                <label className="lbl">Token URL
                  <input value={oracleFusionForm.token_url} onChange={(ev) => setOracleFusionForm({ ...oracleFusionForm, token_url: ev.target.value })}
                    placeholder="https://idcs-<id>.identity.oraclecloud.com/oauth2/v1/token" />
                </label>
                <label className="lbl">Scope
                  <input value={oracleFusionForm.scope} onChange={(ev) => setOracleFusionForm({ ...oracleFusionForm, scope: ev.target.value })} />
                </label>
                <label className="lbl">API version
                  <input value={oracleFusionForm.api_version} onChange={(ev) => setOracleFusionForm({ ...oracleFusionForm, api_version: ev.target.value })} />
                </label>
                <label className="lbl span-2">Business unit
                  <input value={oracleFusionForm.business_unit} onChange={(ev) => setOracleFusionForm({ ...oracleFusionForm, business_unit: ev.target.value })}
                    placeholder="Vision Operations" />
                </label>
                <label className="lbl">Client ID
                  <input value={oracleFusionForm.client_id} onChange={(ev) => setOracleFusionForm({ ...oracleFusionForm, client_id: ev.target.value })} />
                </label>
                <label className="lbl">Client secret
                  <input type="password" value={oracleFusionForm.client_secret} onChange={(ev) => setOracleFusionForm({ ...oracleFusionForm, client_secret: ev.target.value })} />
                </label>
              </div>
              <div className="row gap-sm" style={{ marginTop: 12 }}>
                <Btn kind="primary" disabled={oracleFusionBusy} onClick={onOracleFusionConnect}>
                  {oracleFusionBusy ? "Working…" : <>{Icon.shieldCheck} Save & probe</>}
                </Btn>
                <Btn kind="ghost" disabled={oracleFusionBusy || !oracleFusionState?.configured} onClick={onOracleFusionSyncNow}>
                  {Icon.cycle} Sync now
                </Btn>
                <Btn kind="ghost" disabled={oracleFusionBusy || !oracleFusionState?.configured || !oracleFusionState?.retry_pending} onClick={onOracleFusionRetryNow}>
                  {Icon.cycle} Retry queue ({oracleFusionState?.retry_pending || 0})
                </Btn>
              </div>
            </Card>
            {oracleFusionState && (
              <Card title="Status" eyebrow="from /api/oracle_fusion/health">
                <KV rows={[
                  ["Configured", String(oracleFusionState.configured ?? false)],
                  ["Probe ok", oracleFusionState.probe_ok == null ? "—" : String(oracleFusionState.probe_ok)],
                  ["Connected at", oracleFusionState.connected_at || "—"],
                  ["Retry queue pending", String(oracleFusionState.retry_pending || 0)],
                  ["Probe error", oracleFusionState.probe_error || "—"],
                ]} />
              </Card>
            )}
          </>
        )}

        {active === "jde" && (
          <>
            <Card title="JD Edwards EnterpriseOne" eyebrow="AIS REST · Basic auth + token-pair">
              <div className="form-grid">
                <label className="lbl">Base URL
                  <input value={jdeForm.base_url} onChange={(ev) => setJdeForm({ ...jdeForm, base_url: ev.target.value })}
                    placeholder="https://jde.example.com" />
                </label>
                <label className="lbl">Environment
                  <input value={jdeForm.environment} onChange={(ev) => setJdeForm({ ...jdeForm, environment: ev.target.value })}
                    placeholder="JDV920" />
                </label>
                <label className="lbl">Role
                  <input value={jdeForm.role} onChange={(ev) => setJdeForm({ ...jdeForm, role: ev.target.value })} />
                </label>
                <label className="lbl">Device name
                  <input value={jdeForm.device} onChange={(ev) => setJdeForm({ ...jdeForm, device: ev.target.value })} />
                </label>
                <label className="lbl">Username
                  <input value={jdeForm.username} onChange={(ev) => setJdeForm({ ...jdeForm, username: ev.target.value })} />
                </label>
                <label className="lbl">Password
                  <input type="password" value={jdeForm.password} onChange={(ev) => setJdeForm({ ...jdeForm, password: ev.target.value })} />
                </label>
              </div>
              <div className="row gap-sm" style={{ marginTop: 12 }}>
                <Btn kind="primary" disabled={jdeBusy} onClick={() => {
                  if (!jdeForm.base_url || !jdeForm.environment || !jdeForm.role || !jdeForm.username || !jdeForm.password) {
                    return flashErr(new Error("base_url, environment, role, username, password required"));
                  }
                  jdeFns.connect();
                }}>{jdeBusy ? "Working…" : <>{Icon.shieldCheck} Save & probe</>}</Btn>
                <Btn kind="ghost" disabled={jdeBusy || !jdeState?.configured} onClick={jdeFns.syncNow}>{Icon.cycle} Sync now</Btn>
                <Btn kind="ghost" disabled={jdeBusy || !jdeState?.configured || !jdeState?.retry_pending} onClick={jdeFns.retryNow}>
                  {Icon.cycle} Retry queue ({jdeState?.retry_pending || 0})
                </Btn>
              </div>
            </Card>
            {jdeState && (
              <Card title="Status" eyebrow="from /api/jde/health">
                <KV rows={[
                  ["Configured", String(jdeState.configured ?? false)],
                  ["Probe ok", jdeState.probe_ok == null ? "—" : String(jdeState.probe_ok)],
                  ["Environment", jdeState.environment || "—"],
                  ["Connected at", jdeState.connected_at || "—"],
                  ["Retry queue pending", String(jdeState.retry_pending || 0)],
                  ["Probe error", jdeState.probe_error || "—"],
                ]} />
              </Card>
            )}
          </>
        )}

        {active === "plex" && (
          <>
            <Card title="Plex Smart Manufacturing Platform" eyebrow="Rockwell · Basic auth (API key)">
              <div className="form-grid">
                <label className="lbl span-2">Base URL
                  <input value={plexForm.base_url} onChange={(ev) => setPlexForm({ ...plexForm, base_url: ev.target.value })}
                    placeholder="https://api.plex.com" />
                </label>
                <label className="lbl">Customer ID
                  <input value={plexForm.customer_id} onChange={(ev) => setPlexForm({ ...plexForm, customer_id: ev.target.value })}
                    placeholder="numeric customer id" />
                </label>
                <label className="lbl">PCN (optional)
                  <input value={plexForm.pcn} onChange={(ev) => setPlexForm({ ...plexForm, pcn: ev.target.value })}
                    placeholder="plant control number" />
                </label>
                <label className="lbl span-2">API key
                  <input type="password" value={plexForm.api_key} onChange={(ev) => setPlexForm({ ...plexForm, api_key: ev.target.value })} />
                </label>
              </div>
              <div className="row gap-sm" style={{ marginTop: 12 }}>
                <Btn kind="primary" disabled={plexBusy} onClick={() => {
                  if (!plexForm.base_url || !plexForm.customer_id || !plexForm.api_key) {
                    return flashErr(new Error("base_url, customer_id, api_key required"));
                  }
                  plexFns.connect();
                }}>{plexBusy ? "Working…" : <>{Icon.shieldCheck} Save & probe</>}</Btn>
                <Btn kind="ghost" disabled={plexBusy || !plexState?.configured} onClick={plexFns.syncNow}>{Icon.cycle} Sync now</Btn>
                <Btn kind="ghost" disabled={plexBusy || !plexState?.configured || !plexState?.retry_pending} onClick={plexFns.retryNow}>
                  {Icon.cycle} Retry queue ({plexState?.retry_pending || 0})
                </Btn>
              </div>
            </Card>
            {plexState && (
              <Card title="Status" eyebrow="from /api/plex/health">
                <KV rows={[
                  ["Configured", String(plexState.configured ?? false)],
                  ["Probe ok", plexState.probe_ok == null ? "—" : String(plexState.probe_ok)],
                  ["Customer ID", plexState.customer_id || "—"],
                  ["PCN", plexState.pcn || "—"],
                  ["Connected at", plexState.connected_at || "—"],
                  ["Retry queue pending", String(plexState.retry_pending || 0)],
                  ["Probe error", plexState.probe_error || "—"],
                ]} />
              </Card>
            )}
          </>
        )}

        {active === "jobboss" && (
          <>
            <Card title="JobBoss² (ECi)" eyebrow="REST · Bearer token issued via ECi customer portal">
              <div className="form-grid">
                <label className="lbl">Base URL
                  <input value={jobbossForm.base_url} onChange={(ev) => setJobbossForm({ ...jobbossForm, base_url: ev.target.value })}
                    placeholder="https://api.jobboss.com" />
                </label>
                <label className="lbl">Company
                  <input value={jobbossForm.company} onChange={(ev) => setJobbossForm({ ...jobbossForm, company: ev.target.value })}
                    placeholder="optional, X-JobBoss-Company header" />
                </label>
                <label className="lbl span-2">Bearer token
                  <input type="password" value={jobbossForm.token} onChange={(ev) => setJobbossForm({ ...jobbossForm, token: ev.target.value })} />
                </label>
              </div>
              <div className="row gap-sm" style={{ marginTop: 12 }}>
                <Btn kind="primary" disabled={jobbossBusy} onClick={() => {
                  if (!jobbossForm.base_url || !jobbossForm.token) {
                    return flashErr(new Error("base_url and token required"));
                  }
                  jobbossFns.connect();
                }}>{jobbossBusy ? "Working…" : <>{Icon.shieldCheck} Save & probe</>}</Btn>
                <Btn kind="ghost" disabled={jobbossBusy || !jobbossState?.configured} onClick={jobbossFns.syncNow}>{Icon.cycle} Sync now</Btn>
                <Btn kind="ghost" disabled={jobbossBusy || !jobbossState?.configured || !jobbossState?.retry_pending} onClick={jobbossFns.retryNow}>
                  {Icon.cycle} Retry queue ({jobbossState?.retry_pending || 0})
                </Btn>
              </div>
            </Card>
            {jobbossState && (
              <Card title="Status" eyebrow="from /api/jobboss/health">
                <KV rows={[
                  ["Configured", String(jobbossState.configured ?? false)],
                  ["Probe ok", jobbossState.probe_ok == null ? "—" : String(jobbossState.probe_ok)],
                  ["Company", jobbossState.company || "—"],
                  ["Connected at", jobbossState.connected_at || "—"],
                  ["Retry queue pending", String(jobbossState.retry_pending || 0)],
                  ["Probe error", jobbossState.probe_error || "—"],
                ]} />
              </Card>
            )}
          </>
        )}

        {active === "oracle_ebs" && (
          <>
            <Card title="Oracle E-Business Suite" eyebrow="Integrated SOA Gateway · HTTP Basic">
              <div className="form-grid">
                <label className="lbl">Base URL
                  <input value={oracleEbsForm.base_url} onChange={(ev) => setOracleEbsForm({ ...oracleEbsForm, base_url: ev.target.value })}
                    placeholder="https://ebs.example.com" />
                </label>
                <label className="lbl">Responsibility
                  <input value={oracleEbsForm.responsibility} onChange={(ev) => setOracleEbsForm({ ...oracleEbsForm, responsibility: ev.target.value })}
                    placeholder="Order Management Super User" />
                </label>
                <label className="lbl">Org ID
                  <input value={oracleEbsForm.org_id} onChange={(ev) => setOracleEbsForm({ ...oracleEbsForm, org_id: ev.target.value })} placeholder="204" />
                </label>
                <label className="lbl">Username
                  <input value={oracleEbsForm.username} onChange={(ev) => setOracleEbsForm({ ...oracleEbsForm, username: ev.target.value })} />
                </label>
                <label className="lbl span-2">Password
                  <input type="password" value={oracleEbsForm.password} onChange={(ev) => setOracleEbsForm({ ...oracleEbsForm, password: ev.target.value })} />
                </label>
              </div>
              <div className="row gap-sm" style={{ marginTop: 12 }}>
                <Btn kind="primary" disabled={oracleEbsBusy} onClick={() => {
                  if (!oracleEbsForm.base_url || !oracleEbsForm.username || !oracleEbsForm.password) {
                    return flashErr(new Error("base_url, username, password required"));
                  }
                  oracleEbsFns.connect();
                }}>{oracleEbsBusy ? "Working…" : <>{Icon.shieldCheck} Save & probe</>}</Btn>
                <Btn kind="ghost" disabled={oracleEbsBusy || !oracleEbsState?.configured} onClick={oracleEbsFns.syncNow}>{Icon.cycle} Sync now</Btn>
                <Btn kind="ghost" disabled={oracleEbsBusy || !oracleEbsState?.configured || !oracleEbsState?.retry_pending} onClick={oracleEbsFns.retryNow}>
                  {Icon.cycle} Retry queue ({oracleEbsState?.retry_pending || 0})
                </Btn>
              </div>
            </Card>
            {oracleEbsState && (
              <Card title="Status" eyebrow="from /api/oracle_ebs/health">
                <KV rows={[
                  ["Configured", String(oracleEbsState.configured ?? false)],
                  ["Probe ok", oracleEbsState.probe_ok == null ? "—" : String(oracleEbsState.probe_ok)],
                  ["Responsibility", oracleEbsState.responsibility || "—"],
                  ["Org ID", oracleEbsState.org_id || "—"],
                  ["Connected at", oracleEbsState.connected_at || "—"],
                  ["Retry queue pending", String(oracleEbsState.retry_pending || 0)],
                  ["Probe error", oracleEbsState.probe_error || "—"],
                ]} />
              </Card>
            )}
          </>
        )}

        {active === "proalpha" && (
          <>
            <Card title="proALPHA" eyebrow="BC-REST-API · HTTP Basic">
              <div className="form-grid">
                <label className="lbl">Base URL
                  <input value={proalphaForm.base_url} onChange={(ev) => setProalphaForm({ ...proalphaForm, base_url: ev.target.value })}
                    placeholder="https://erp.example.com" />
                </label>
                <label className="lbl">Company
                  <input value={proalphaForm.company} onChange={(ev) => setProalphaForm({ ...proalphaForm, company: ev.target.value })}
                    placeholder="optional, multi-company header" />
                </label>
                <label className="lbl">Username
                  <input value={proalphaForm.username} onChange={(ev) => setProalphaForm({ ...proalphaForm, username: ev.target.value })} />
                </label>
                <label className="lbl">Password
                  <input type="password" value={proalphaForm.password} onChange={(ev) => setProalphaForm({ ...proalphaForm, password: ev.target.value })} />
                </label>
              </div>
              <div className="row gap-sm" style={{ marginTop: 12 }}>
                <Btn kind="primary" disabled={proalphaBusy} onClick={() => {
                  if (!proalphaForm.base_url || !proalphaForm.username || !proalphaForm.password) {
                    return flashErr(new Error("base_url, username, password required"));
                  }
                  proalphaFns.connect();
                }}>{proalphaBusy ? "Working…" : <>{Icon.shieldCheck} Save & probe</>}</Btn>
                <Btn kind="ghost" disabled={proalphaBusy || !proalphaState?.configured} onClick={proalphaFns.syncNow}>{Icon.cycle} Sync now</Btn>
                <Btn kind="ghost" disabled={proalphaBusy || !proalphaState?.configured || !proalphaState?.retry_pending} onClick={proalphaFns.retryNow}>
                  {Icon.cycle} Retry queue ({proalphaState?.retry_pending || 0})
                </Btn>
              </div>
            </Card>
            {proalphaState && (
              <Card title="Status" eyebrow="from /api/proalpha/health">
                <KV rows={[
                  ["Configured", String(proalphaState.configured ?? false)],
                  ["Probe ok", proalphaState.probe_ok == null ? "—" : String(proalphaState.probe_ok)],
                  ["Company", proalphaState.company || "—"],
                  ["Connected at", proalphaState.connected_at || "—"],
                  ["Retry queue pending", String(proalphaState.retry_pending || 0)],
                  ["Probe error", proalphaState.probe_error || "—"],
                ]} />
              </Card>
            )}
          </>
        )}

        {active === "ramco" && (
          <>
            <Card title="Ramco ERP" eyebrow="OAuth2 client_credentials · REST tenant-scoped">
              <div className="form-grid">
                <label className="lbl">Base URL
                  <input value={ramcoForm.base_url} onChange={(ev) => setRamcoForm({ ...ramcoForm, base_url: ev.target.value })}
                    placeholder="https://<tenant>.ramco.com" />
                </label>
                <label className="lbl">Token URL
                  <input value={ramcoForm.token_url} onChange={(ev) => setRamcoForm({ ...ramcoForm, token_url: ev.target.value })}
                    placeholder="https://auth.ramco.com/oauth2/token" />
                </label>
                <label className="lbl">Scope
                  <input value={ramcoForm.scope} onChange={(ev) => setRamcoForm({ ...ramcoForm, scope: ev.target.value })} />
                </label>
                <label className="lbl">Org unit
                  <input value={ramcoForm.org_unit} onChange={(ev) => setRamcoForm({ ...ramcoForm, org_unit: ev.target.value })}
                    placeholder="default" />
                </label>
                <label className="lbl span-2">Company
                  <input value={ramcoForm.company} onChange={(ev) => setRamcoForm({ ...ramcoForm, company: ev.target.value })}
                    placeholder="optional, sent as X-Ramco-Company" />
                </label>
                <label className="lbl">Client ID
                  <input value={ramcoForm.client_id} onChange={(ev) => setRamcoForm({ ...ramcoForm, client_id: ev.target.value })} />
                </label>
                <label className="lbl">Client secret
                  <input type="password" value={ramcoForm.client_secret} onChange={(ev) => setRamcoForm({ ...ramcoForm, client_secret: ev.target.value })} />
                </label>
              </div>
              <div className="row gap-sm" style={{ marginTop: 12 }}>
                <Btn kind="primary" disabled={ramcoBusy} onClick={onRamcoConnect}>
                  {ramcoBusy ? "Working…" : <>{Icon.shieldCheck} Save & probe</>}
                </Btn>
                <Btn kind="ghost" disabled={ramcoBusy || !ramcoState?.configured} onClick={onRamcoSyncNow}>
                  {Icon.cycle} Sync now
                </Btn>
                <Btn kind="ghost" disabled={ramcoBusy || !ramcoState?.configured || !ramcoState?.retry_pending} onClick={onRamcoRetryNow}>
                  {Icon.cycle} Retry queue ({ramcoState?.retry_pending || 0})
                </Btn>
              </div>
            </Card>
            {ramcoState && (
              <Card title="Status" eyebrow="from /api/ramco/health">
                <KV rows={[
                  ["Configured", String(ramcoState.configured ?? false)],
                  ["Probe ok", ramcoState.probe_ok == null ? "—" : String(ramcoState.probe_ok)],
                  ["Connected at", ramcoState.connected_at || "—"],
                  ["Retry queue pending", String(ramcoState.retry_pending || 0)],
                  ["Probe error", ramcoState.probe_error || "—"],
                ]} />
              </Card>
            )}
          </>
        )}

        {active === "plm" && (
          <>
            <Card title="PLM connectors" eyebrow="Windchill · Arena (read-only mirror)">
              <div className="form-grid">
                <label className="lbl">System
                  <select value={plmForm.system} onChange={(ev) => setPlmForm({ ...plmForm, system: ev.target.value })}>
                    <option value="windchill">PTC Windchill</option>
                    <option value="arena">Arena</option>
                  </select>
                </label>
                <label className="lbl">Display name
                  <input value={plmForm.display_name} onChange={(ev) => setPlmForm({ ...plmForm, display_name: ev.target.value })} placeholder="Optional label" />
                </label>
                <label className="lbl span-2">Base URL
                  <input value={plmForm.base_url} onChange={(ev) => setPlmForm({ ...plmForm, base_url: ev.target.value })}
                    placeholder={plmForm.system === "windchill" ? "https://plm.example.com" : "https://api.arenasolutions.com"} />
                </label>
                {plmForm.system === "windchill" ? (
                  <>
                    <label className="lbl">Username
                      <input value={plmForm.username} onChange={(ev) => setPlmForm({ ...plmForm, username: ev.target.value })} />
                    </label>
                    <label className="lbl">Password
                      <input type="password" value={plmForm.password} onChange={(ev) => setPlmForm({ ...plmForm, password: ev.target.value })} />
                    </label>
                  </>
                ) : (
                  <label className="lbl span-2">API key
                    <input type="password" value={plmForm.api_key} onChange={(ev) => setPlmForm({ ...plmForm, api_key: ev.target.value })} />
                  </label>
                )}
              </div>
              <div className="row gap-sm" style={{ marginTop: 12 }}>
                <Btn kind="primary" disabled={plmBusy} onClick={onPlmConnect}
                  title="Save credentials and probe the PLM endpoint">
                  {plmBusy ? "Working…" : <>{Icon.shieldCheck} Save & probe</>}
                </Btn>
              </div>
            </Card>

            {plm && (Array.isArray(plm.systems) && plm.systems.length > 0) ? (
              <Card title="Connected systems" eyebrow="from /api/plm/health">
                <table className="tbl mono-sm">
                  <thead><tr><th>System</th><th>Base URL</th><th>Active</th><th>Last error</th><th>Action</th></tr></thead>
                  <tbody>
                    {plm.systems.map((s: any) => (
                      <tr key={s.id}>
                        <td>{s.system}</td>
                        <td>{s.base_url}</td>
                        <td>{s.active ? "yes" : "no"}</td>
                        <td style={{ color: "var(--rust)" }}>{s.last_error || ""}</td>
                        <td>
                          <Btn sm kind="ghost" disabled={plmBusy} onClick={() => onPlmSyncNow(s.id)} title="Pull BOMs + ECOs now">
                            {Icon.cycle} sync
                          </Btn>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {Array.isArray(plm.sync_state) && plm.sync_state.length > 0 && (
                  <>
                    <div className="divider" />
                    <table className="tbl mono-sm">
                      <thead><tr><th>System</th><th>Entity</th><th>Status</th><th>Last sync</th><th className="r">Rows</th></tr></thead>
                      <tbody>
                        {plm.sync_state.map((s: any) => (
                          <tr key={s.system_id + s.entity}>
                            <td>{(plm.systems.find((x: any) => x.id === s.system_id) || {}).system || "—"}</td>
                            <td>{s.entity}</td>
                            <td>{s.status}</td>
                            <td>{s.last_sync_at ? new Date(s.last_sync_at).toLocaleString("en-IN") : "—"}</td>
                            <td className="r">{s.rows_pulled || 0}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                )}
              </Card>
            ) : null}
          </>
        )}

        {active === "voice" && (
          <>
            <Card title="Voice agent" eyebrow="Vapi · Retell">
              <div className="form-grid">
                <label className="lbl">Provider
                  <select value={voiceForm.provider} onChange={(ev) => setVoiceForm({ ...voiceForm, provider: ev.target.value })}>
                    <option value="vapi">Vapi</option>
                    <option value="retell">Retell</option>
                  </select>
                </label>
                <label className="lbl">Display name
                  <input value={voiceForm.display_name} onChange={(ev) => setVoiceForm({ ...voiceForm, display_name: ev.target.value })} placeholder="Sales hotline" />
                </label>
                <label className="lbl">Phone number (E.164)
                  <input value={voiceForm.phone_number} onChange={(ev) => setVoiceForm({ ...voiceForm, phone_number: ev.target.value })} placeholder="+15551234567" />
                </label>
                <label className="lbl">Assistant / agent ID
                  <input value={voiceForm.assistant_id} onChange={(ev) => setVoiceForm({ ...voiceForm, assistant_id: ev.target.value })} />
                </label>
                <label className="lbl span-2">API key
                  <input type="password" value={voiceForm.api_key} onChange={(ev) => setVoiceForm({ ...voiceForm, api_key: ev.target.value })} />
                </label>
                <label className="lbl span-2">Webhook secret
                  <input type="password" value={voiceForm.webhook_secret} onChange={(ev) => setVoiceForm({ ...voiceForm, webhook_secret: ev.target.value })} />
                </label>
                <label className="lbl">Handoff number
                  <input value={voiceForm.handoff_phone_number} onChange={(ev) => setVoiceForm({ ...voiceForm, handoff_phone_number: ev.target.value })} placeholder="+15555550100" />
                </label>
                <label className="lbl">Voice persona
                  <input value={voiceForm.voice_persona} onChange={(ev) => setVoiceForm({ ...voiceForm, voice_persona: ev.target.value })} placeholder="Friendly inside-sales rep" />
                </label>
                <label className="lbl span-2">System prompt
                  <textarea rows={3} value={voiceForm.system_prompt} onChange={(ev) => setVoiceForm({ ...voiceForm, system_prompt: ev.target.value })}
                    placeholder="You are an inside-sales agent for Acme Distributors..." />
                </label>
              </div>
              <div className="row gap-sm" style={{ marginTop: 12 }}>
                <Btn kind="primary" disabled={voiceBusy} onClick={onVoiceSave}
                  title="Save the voice configuration. The webhook URL to point your provider at is /api/voice/webhook?provider=<provider>.">
                  {voiceBusy ? "Saving…" : <>{Icon.shieldCheck} Save</>}
                </Btn>
                <span className="mono-sm" style={{ color: "var(--ink-3)" }}>
                  Webhook URL: <code>/api/voice/webhook?provider={voiceForm.provider}</code>
                </span>
              </div>
            </Card>

            {Array.isArray(voice?.configs) && voice.configs.length > 0 && (
              <Card title="Configured numbers" eyebrow="active inbound voice agents">
                <table className="tbl mono-sm">
                  <thead><tr><th>Provider</th><th>Number</th><th>Display name</th><th>Active</th><th>Action</th></tr></thead>
                  <tbody>
                    {voice.configs.map((c: any) => (
                      <tr key={c.id}>
                        <td>{c.provider}</td>
                        <td>{c.phone_number}</td>
                        <td>{c.display_name || "—"}</td>
                        <td>{c.active ? "yes" : "no"}</td>
                        <td>
                          {c.active && (
                            <Btn sm kind="danger" disabled={voiceBusy} onClick={() => onVoiceDeactivate(c.id)}
                              title="Stop receiving inbound calls on this number">
                              {Icon.x} deactivate
                            </Btn>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            )}
          </>
        )}

        {active === "chat" && (
          <>
            <Card title="Inbound chat channels" eyebrow="WhatsApp · Slack · Teams">
              <div className="form-grid">
                <label className="lbl">Channel
                  <select value={chatForm.channel}
                    onChange={(ev) => setChatForm({ ...chatForm, channel: ev.target.value, creds: {} })}>
                    <option value="whatsapp">WhatsApp (Twilio)</option>
                    <option value="slack">Slack</option>
                    <option value="teams">Microsoft Teams</option>
                  </select>
                </label>
                <label className="lbl">Display name
                  <input value={chatForm.display_name} onChange={(ev) => setChatForm({ ...chatForm, display_name: ev.target.value })} placeholder="Optional label" />
                </label>

                {chatForm.channel === "whatsapp" && (
                  <>
                    <label className="lbl">Twilio Account SID
                      <input value={chatForm.creds.account_sid || ""}
                        onChange={(ev) => setChatForm({ ...chatForm, creds: { ...chatForm.creds, account_sid: ev.target.value } })} />
                    </label>
                    <label className="lbl">Twilio Auth Token
                      <input type="password" value={chatForm.creds.auth_token || ""}
                        onChange={(ev) => setChatForm({ ...chatForm, creds: { ...chatForm.creds, auth_token: ev.target.value } })} />
                    </label>
                    <label className="lbl span-2">From number (E.164, optionally prefixed "whatsapp:")
                      <input value={chatForm.creds.from_number || ""}
                        onChange={(ev) => setChatForm({ ...chatForm, creds: { ...chatForm.creds, from_number: ev.target.value } })}
                        placeholder="whatsapp:+15551234567" />
                    </label>
                  </>
                )}

                {chatForm.channel === "slack" && (
                  <>
                    <label className="lbl">Slack Bot Token
                      <input type="password" value={chatForm.creds.bot_token || ""}
                        onChange={(ev) => setChatForm({ ...chatForm, creds: { ...chatForm.creds, bot_token: ev.target.value } })}
                        placeholder="xoxb-..." />
                    </label>
                    <label className="lbl">Signing secret
                      <input type="password" value={chatForm.creds.signing_secret || ""}
                        onChange={(ev) => setChatForm({ ...chatForm, creds: { ...chatForm.creds, signing_secret: ev.target.value } })} />
                    </label>
                    <label className="lbl span-2">Workspace team_id
                      <input value={chatForm.creds.team_id || ""}
                        onChange={(ev) => setChatForm({ ...chatForm, creds: { ...chatForm.creds, team_id: ev.target.value } })}
                        placeholder="T0123456" />
                    </label>
                  </>
                )}

                {chatForm.channel === "teams" && (
                  <>
                    <label className="lbl">Bot app ID
                      <input value={chatForm.creds.app_id || ""}
                        onChange={(ev) => setChatForm({ ...chatForm, creds: { ...chatForm.creds, app_id: ev.target.value } })} />
                    </label>
                    <label className="lbl">Azure tenant ID
                      <input value={chatForm.creds.azure_tenant_id || ""}
                        onChange={(ev) => setChatForm({ ...chatForm, creds: { ...chatForm.creds, azure_tenant_id: ev.target.value } })} />
                    </label>
                    <label className="lbl span-2">Webhook secret
                      <input type="password" value={chatForm.creds.webhook_secret || ""}
                        onChange={(ev) => setChatForm({ ...chatForm, creds: { ...chatForm.creds, webhook_secret: ev.target.value } })} />
                    </label>
                  </>
                )}
              </div>
              <div className="row gap-sm" style={{ marginTop: 12 }}>
                <Btn kind="primary" disabled={chatBusy} onClick={onChatSave}
                  title="Save channel credentials. Provider webhook should target /api/inbound/<channel>/webhook.">
                  {chatBusy ? "Saving…" : <>{Icon.shieldCheck} Save channel</>}
                </Btn>
                <span className="mono-sm" style={{ color: "var(--ink-3)" }}>
                  Webhook URL: <code>/api/inbound/{chatForm.channel}/webhook</code>
                </span>
              </div>
            </Card>

            {Array.isArray(chat?.configs) && chat.configs.length > 0 && (
              <Card title="Configured channels" eyebrow="active inbound chat channels">
                <table className="tbl mono-sm">
                  <thead><tr><th>Channel</th><th>Display name</th><th>Active</th><th>Last seen</th><th>Action</th></tr></thead>
                  <tbody>
                    {chat.configs.map((c: any) => (
                      <tr key={c.id}>
                        <td>{c.channel}</td>
                        <td>{c.display_name || "—"}</td>
                        <td>{c.active ? "yes" : "no"}</td>
                        <td>{c.last_seen_at ? new Date(c.last_seen_at).toLocaleString("en-IN") : "—"}</td>
                        <td>
                          {c.active && (
                            <Btn sm kind="danger" disabled={chatBusy} onClick={() => onChatDeactivate(c.channel)}
                              title="Stop processing inbound messages on this channel">
                              {Icon.x} deactivate
                            </Btn>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            )}
          </>
        )}

        {active === "settings" && (
          <>
            <Card title="Tenant settings" eyebrow="read-only · edit via API">
              <KV rows={[
                ["Display name", tenantSlug],
                ["Slug", String(tenantSlug).toLowerCase()],
                ["Backend", AnvilBackend?.isReady?.() ? "connected" : "not configured"],
                ["Theme", Prefs?.theme?.() || "default"],
              ]} />
            </Card>
            <Card title="Drawing PDF base URL" eyebrow="local browser only">
              <div style={{ display: "grid", gap: 8 }}>
                <label className="lbl mono-sm">
                  Base URL (e.g. https://onedrive.example.com/drawings)
                  <input type="url" className="input" value={drawingDraft}
                         onChange={(ev) => setDrawingDraft(ev.target.value)} />
                </label>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <Btn sm kind="primary" onClick={onSaveDrawingBase} disabled={drawingDraft === drawingBase}>Save</Btn>
                  <span className="mono-sm" style={{ color: "var(--ink-3)" }}>
                    Composes <span className="mono">{drawingBase || "—"}/&lt;drawing_no&gt;.pdf</span>
                  </span>
                </div>
              </div>
            </Card>
            <Card title="Quote settings" eyebrow="defaults + line-item option lists">
              <div style={{ display: "grid", gap: 16 }}>
                <label className="lbl mono-sm">
                  Default validity (days) — leave blank to use 30
                  <input type="number" min={1} max={3650} className="input" style={{ maxWidth: 160 }}
                         value={quoteValidityDraft}
                         placeholder="30"
                         onChange={(ev) => setQuoteValidityDraft(ev.target.value)} />
                </label>
                <OptionListEditor
                  label="Units (UoM) dropdown"
                  values={quoteUnits}
                  onChange={setQuoteUnits}
                  placeholder="e.g. NO, SET, KG, M"
                  hint="Shown as the Units dropdown in the quote Lines editor."
                />
                <OptionListEditor
                  label="Source country dropdown"
                  values={quoteSources}
                  onChange={setQuoteSources}
                  placeholder="e.g. O-KOREA, INDIA, CHINA"
                  hint="Shown as the Source country dropdown in the quote Lines editor."
                />
                <OptionListEditor
                  label="Currencies dropdown"
                  values={quoteCurrencies}
                  onChange={setQuoteCurrencies}
                  placeholder="e.g. INR, USD, EUR, CNY, KRW, JPY"
                  hint="Currency dropdown for new quotes, composition supplier prices, and RFQ capture."
                />
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <Btn sm kind="primary" onClick={onSaveQuoteSettings} disabled={quoteSettingsSaving || !quoteSettingsDirty}>{quoteSettingsSaving ? "Saving…" : "Save quote settings"}</Btn>
                  <span className="mono-sm" style={{ color: "var(--ink-3)" }}>
                    Validity precedence: explicit &gt; customer &gt; tenant &gt; 30. Empty lists leave the field free-text.
                  </span>
                </div>
              </div>
            </Card>
          </>
        )}

        {active === "holidays" && (
          <>
            {holidays.error && (
              <Banner kind="bad" icon={Icon.alert} title="Failed to load holidays" action={<Btn sm onClick={holidays.reload}>Retry</Btn>}>
                <span className="mono-sm">{String(holidays.error.message || holidays.error)}</span>
              </Banner>
            )}
            {/* Audit P13.B.1.3: live banner showing the next upcoming
                holiday so operators don't lose visibility of an
                imminent close-day. Falls silent when no future
                holiday is on file. */}
            {(() => {
              const today = new Date(); today.setHours(0, 0, 0, 0);
              const upcoming = holidayRows
                .map((h) => ({ ...h, _ms: new Date(h.date || h.holiday_date || 0).getTime() }))
                .filter((h) => h._ms >= today.getTime())
                .sort((a, b) => a._ms - b._ms);
              const next = upcoming[0];
              if (!next) return null;
              const days = Math.round((next._ms - today.getTime()) / 86400000);
              const sameDay = days === 0;
              return (
                <Banner kind={sameDay ? "warn" : "info"} icon={Icon.flag} title={sameDay ? "Today is a holiday" : `Next holiday in ${days} day${days === 1 ? "" : "s"}`}>
                  <span className="mono-sm">
                    {next.country || "—"} · {next.date || next.holiday_date || "—"} · {next.name || "—"}
                  </span>
                </Banner>
              );
            })()}
            <Card flush>
              {holidays.loading ? (
                <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>Loading holidays…</div>
              ) : holidayRows.length === 0 ? (
                <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>No holidays defined.</div>
              ) : (
                <table className="tbl">
                  <thead><tr><th>Country</th><th>Date</th><th>Name</th><th></th></tr></thead>
                  <tbody>
                    {holidayRows.map((h, i) => (
                      <tr key={h.id || i}>
                        <td className="mono-sm">{h.country || "—"}</td>
                        <td className="mono-sm">{h.date || h.holiday_date || "—"}</td>
                        <td>{h.name || "—"}</td>
                        <td>
                          {h.id && (
                            <Btn sm kind="ghost" disabled={busy} onClick={() => onDeleteHoliday(h.id)}>{Icon.trash}</Btn>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
            <Card title="Add holiday" eyebrow="country + date + name">
              <form onSubmit={onAddHoliday} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 2fr auto", gap: 8, alignItems: "end" }}>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span className="mono-sm" style={{ color: "var(--ink-3)" }}>Country</span>
                  <input className="input" value={holidayForm.country}
                         onChange={(ev) => setHolidayForm({ ...holidayForm, country: ev.target.value })} style={{ height: 30 }} />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span className="mono-sm" style={{ color: "var(--ink-3)" }}>Date</span>
                  <input type="date" className="input" required value={holidayForm.date}
                         onChange={(ev) => setHolidayForm({ ...holidayForm, date: ev.target.value })} style={{ height: 30 }} />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span className="mono-sm" style={{ color: "var(--ink-3)" }}>Name</span>
                  <input className="input" required value={holidayForm.name}
                         onChange={(ev) => setHolidayForm({ ...holidayForm, name: ev.target.value })} style={{ height: 30 }} />
                </label>
                <Btn type="submit" kind="primary" sm disabled={busy}>{busy ? "adding…" : <>{Icon.plus} add</>}</Btn>
              </form>
            </Card>
          </>
        )}

        {active === "leadtimes" && (
          <>
            <Card title="Lead times" eyebrow="supplier or customer · days"
                  right={<select value={leadTimeForm.type}
                                 onChange={(ev) => setLeadTimeForm({ ...leadTimeForm, type: ev.target.value, entity_id: "" })}>
                    <option value="supplier">Supplier</option>
                    <option value="customer">Customer</option>
                  </select>}>
              {leadTimes.loading ? (
                <div className="body" style={{ color: "var(--ink-3)" }}>Loading lead times…</div>
              ) : leadTimeRows.length === 0 ? (
                <div className="body" style={{ color: "var(--ink-3)" }}>No lead times configured.</div>
              ) : (
                <table className="tbl">
                  <thead><tr><th>{leadTimeForm.type === "supplier" ? "Supplier" : "Customer"}</th><th className="r">Days</th><th>Notes</th><th>Last reviewed</th><th></th></tr></thead>
                  <tbody>
                    {leadTimeRows.map((r, i) => {
                      // Audit P13.B.1.3: surface a "stale" chip when
                      // a lead-time hasn't been reviewed in 6 months.
                      // The schema's updated_at column gives us this
                      // for free; the chip pushes operators to refresh
                      // a value they may have copied from a long-gone
                      // tariff.
                      const reviewed = r.updated_at || r.created_at;
                      const reviewedMs = reviewed ? new Date(reviewed).getTime() : 0;
                      const stale = reviewedMs > 0 && (Date.now() - reviewedMs) > 6 * 30 * 86400 * 1000;
                      return (
                        <tr key={r.id || i}>
                          <td>{r.customer_name || r.supplier_name || r.name || r.entity_name || customerName(r.customer_id) || "—"}</td>
                          <td className="r mono">{r.days != null ? r.days : (r.lead_time_days != null ? r.lead_time_days : "—")}</td>
                          <td className="mono-sm">{r.notes || r.description || "—"}</td>
                          <td>
                            {reviewed ? (
                              <span title={new Date(reviewed).toLocaleDateString("en-IN")} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                                <span className="mono-sm" style={{ color: "var(--ink-3)" }}>{ageLabel(reviewed)}</span>
                                {stale && <Chip k="warn">stale</Chip>}
                              </span>
                            ) : <span className="mono-sm" style={{ color: "var(--ink-4)" }}>—</span>}
                          </td>
                          <td>
                            {r.id && (
                              <Btn sm kind="ghost" disabled={busy} onClick={() => onDeleteLeadTime(r.id)}>{Icon.trash}</Btn>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </Card>
            <Card title="Add lead time" eyebrow="entity + days">
              <form onSubmit={onAddLeadTime} style={{ display: "grid", gridTemplateColumns: "2fr 1fr 2fr auto", gap: 8, alignItems: "end" }}>
                <label className="lbl">{leadTimeForm.type === "supplier" ? "Supplier ID" : "Customer ID"}
                  <input type="text" className="input" required value={leadTimeForm.entity_id}
                         onChange={(ev) => setLeadTimeForm({ ...leadTimeForm, entity_id: ev.target.value })} />
                </label>
                <label className="lbl">Days
                  <input type="number" min={1} className="input" required value={leadTimeForm.days}
                         onChange={(ev) => setLeadTimeForm({ ...leadTimeForm, days: ev.target.value })} />
                </label>
                <label className="lbl">Notes
                  <input type="text" className="input" value={leadTimeForm.notes}
                         onChange={(ev) => setLeadTimeForm({ ...leadTimeForm, notes: ev.target.value })} />
                </label>
                <Btn type="submit" kind="primary" sm disabled={busy}>{busy ? "saving…" : <>{Icon.plus} add</>}</Btn>
              </form>
            </Card>
          </>
        )}

        {active === "fx" && (
          <Card title="FX rates" eyebrow="USD · JPY · CNY against INR"
                right={<Btn sm kind="primary" disabled={busy} onClick={refreshFx}>{busy ? "refreshing…" : <>{Icon.cycle} manual refresh</>}</Btn>}>
            {fxRates.loading ? (
              <div className="body" style={{ color: "var(--ink-3)" }}>Loading rates…</div>
            ) : fxRows.length === 0 ? (
              <div className="body" style={{ color: "var(--ink-3)" }}>No FX rates available.</div>
            ) : (
              <table className="tbl">
                <thead><tr><th>Pair</th><th className="r">Rate</th><th>As of</th></tr></thead>
                <tbody>
                  {fxRows.map((r, i) => (
                    <tr key={r.pair || i}>
                      <td className="mono"><span className="pri">{r.pair || `${r.base}/${r.quote}`}</span></td>
                      <td className="r mono">{r.rate != null ? Number(r.rate).toFixed(4) : "—"}</td>
                      <td className="mono-sm">{r.as_of ? new Date(r.as_of).toLocaleString("en-IN") : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        )}

        {active === "thresh" && (
          <>
            <Card title="Approval thresholds" eyebrow="who must approve at what amount or margin"
                  right={<Btn sm kind="primary" onClick={() => setThreshForm({ role: "sales_manager", min_amount: 0, max_amount: null, margin_below_pct: null })}>{Icon.plus} New rule</Btn>}>
              {thresholds.loading ? (
                <div className="body" style={{ color: "var(--ink-3)" }}>Loading thresholds…</div>
              ) : thresholdRows.length === 0 ? (
                <div className="body" style={{ color: "var(--ink-3)" }}>No approval thresholds configured.</div>
              ) : (
                <table className="tbl">
                  <thead><tr><th>Role</th><th className="r">Min amount</th><th className="r">Max amount</th><th className="r">Margin below %</th><th></th></tr></thead>
                  <tbody>
                    {thresholdRows.map((t) => (
                      <tr key={t.id}>
                        <td><Chip k="info">{(t.role || "—").replace(/_/g, " ")}</Chip></td>
                        <td className="r mono">{t.min_amount != null ? fmtINRShort(t.min_amount) : "—"}</td>
                        <td className="r mono">{t.max_amount != null ? fmtINRShort(t.max_amount) : "—"}</td>
                        <td className="r mono">{t.margin_below_pct != null ? Number(t.margin_below_pct).toFixed(1) + "%" : "—"}</td>
                        <td style={{ whiteSpace: "nowrap" }}>
                          <Btn sm kind="ghost" onClick={() => setThreshForm({ ...t })}>{Icon.edit}</Btn>
                          <Btn sm kind="ghost" disabled={busy} onClick={() => deleteThreshold(t.id)}>{Icon.trash}</Btn>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </>
        )}

        {active === "locations" && (
          <Card title="Customer locations" eyebrow="ship-to + bill-to addresses"
                right={<Btn sm kind="primary"
                            onClick={() => setLocForm({ customer_id: "", location_name: "", address: "", state_code: "", gstin: "", contact_name: "", contact_phone: "", contact_email: "" })}>
                  {Icon.plus} New location
                </Btn>}>
            {locations.loading ? (
              <div className="body" style={{ color: "var(--ink-3)" }}>Loading locations…</div>
            ) : locationRows.length === 0 ? (
              <div className="body" style={{ color: "var(--ink-3)" }}>No customer locations yet.</div>
            ) : (
              <table className="tbl">
                <thead><tr><th>Customer</th><th>Location</th><th>State</th><th>GSTIN</th><th>Contact</th><th></th></tr></thead>
                <tbody>
                  {locationRows.map((l) => (
                    <tr key={l.id}>
                      <td>{l.customer_name || customerName(l.customer_id)}</td>
                      <td>{l.location_name || l.name || "—"}</td>
                      <td className="mono-sm">{l.state_code || "—"}</td>
                      <td className="mono-sm">{l.gstin || "—"}</td>
                      <td className="mono-sm">{l.contact_name ? `${l.contact_name} · ${l.contact_phone || l.contact_email || ""}` : "—"}</td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        <Btn sm kind="ghost" onClick={() => setLocForm({ ...l })}>{Icon.edit}</Btn>
                        <Btn sm kind="ghost" disabled={busy} onClick={() => deleteLocation(l.id)}>{Icon.trash}</Btn>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        )}

        {active === "contracts" && (
          <Card title="Contracts" eyebrow="ARC · Blanket · AMC · Project"
                right={<Btn sm kind="primary"
                            onClick={() => setContractForm({ customer_id: "", contract_type: "AMC", contract_number: "", title: "", start_date: "", end_date: "", value_inr: "", notes: "" })}>
                  {Icon.plus} New contract
                </Btn>}>
            {contracts.loading ? (
              <div className="body" style={{ color: "var(--ink-3)" }}>Loading contracts…</div>
            ) : contractRows.length === 0 ? (
              <div className="body" style={{ color: "var(--ink-3)" }}>No contracts yet.</div>
            ) : (
              <table className="tbl">
                <thead><tr><th>Number</th><th>Type</th><th>Customer</th><th>Period</th><th className="r">Value</th><th></th></tr></thead>
                <tbody>
                  {contractRows.map((c) => (
                    <tr key={c.id}>
                      <td className="mono"><span className="pri">{c.contract_number || c.id?.slice(0, 8)}</span></td>
                      <td><Chip k="info">{c.contract_type}</Chip></td>
                      <td>{c.customer_name || customerName(c.customer_id)}</td>
                      <td className="mono-sm">{(c.start_date || "—") + " → " + (c.end_date || "—")}</td>
                      <td className="r mono">{c.value_inr != null ? fmtINRShort(c.value_inr) : "—"}</td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        <Btn sm kind="ghost" onClick={() => setContractForm({ ...c })}>{Icon.edit}</Btn>
                        <Btn sm kind="ghost" disabled={busy} onClick={() => deleteContract(c.id)}>{Icon.trash}</Btn>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        )}

        {active === "items" && (
          <Card title="Item master" eyebrow={`${itemRows.length} items`}
                right={<>
                  <label className="btn btn-sm" style={{ cursor: csvBusy ? "wait" : "pointer" }} title="CSV must include header row with tally_item_name column">
                    {csvBusy ? "importing…" : <>{Icon.upload || "↑"} Bulk CSV</>}
                    <input type="file" accept=".csv,text/csv" disabled={csvBusy} style={{ display: "none" }}
                           onChange={(ev) => { const f = ev.target.files?.[0]; ev.target.value = ""; onCsvImport(f); }} />
                  </label>
                  <Btn sm kind="primary"
                       onClick={() => setItemForm({ tally_item_name: "", seller_part_no: "", description: "", hsn_code: "", uom: "Nos", standard_rate: "", drawing_no: "" })}>
                    {Icon.plus} New item
                  </Btn>
                </>}>
            {itemMaster.loading ? (
              <div className="body" style={{ color: "var(--ink-3)" }}>Loading item master…</div>
            ) : itemRows.length === 0 ? (
              <div className="body" style={{ color: "var(--ink-3)" }}>No items yet.</div>
            ) : (
              <table className="tbl">
                <thead><tr><th>Tally name</th><th>Seller part no</th><th>HSN</th><th>UOM</th><th className="r">Rate</th><th>Drawing</th><th></th></tr></thead>
                <tbody>
                  {itemRows.slice(0, 200).map((it) => (
                    <tr key={it.id}>
                      <td className="mono-sm"><span className="pri">{it.tally_item_name}</span></td>
                      <td className="mono-sm">{it.seller_part_no || "—"}</td>
                      <td className="mono-sm">{it.hsn_code || "—"}</td>
                      <td className="mono-sm">{it.uom || "Nos"}</td>
                      <td className="r mono">{it.standard_rate != null ? fmtINRShort(it.standard_rate) : "—"}</td>
                      <td className="mono-sm">{it.drawing_no || "—"}</td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        <Btn sm kind="ghost" onClick={() => setItemForm({ ...it })}>{Icon.edit}</Btn>
                        <Btn sm kind="ghost" disabled={busy} onClick={() => deleteItem(it.id)}>{Icon.trash}</Btn>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {itemRows.length > 200 && (
              <div className="mono-sm" style={{ padding: 8, color: "var(--ink-3)" }}>
                Showing first 200 of {itemRows.length}. Use the search nav for filtered views.
              </div>
            )}
          </Card>
        )}

        {active === "item_fields" && (
          <ItemFieldsPanel />
        )}

        {active === "doc_templates" && (
          <DocumentTemplatesPanel />
        )}

        {active === "freight" && (
          <FreightRatesPanel />
        )}

        {active === "pricing" && (
          <PricingSettingsPanel />
        )}

        {active === "pricing_profiles" && (
          <PricingProfilesAdmin />
        )}

        {active === "vendor_codes" && (
          <VendorCodesPanel />
        )}

        {active === "customer_parts" && (
          <CustomerPartsPanel />
        )}

        {active === "terms_packs" && (
          <CustomerTermsPanel />
        )}

        {active === "docai_cost" && (
          <DocAICostPanel />
        )}

        {active === "diag" && (
          <>
            {diagnostics.error && (
              <Banner kind="bad" icon={Icon.alert} title="Diagnostics endpoint unreachable" action={<Btn sm onClick={diagnostics.reload}>Retry</Btn>}>
                <span className="mono-sm">{String(diagnostics.error.message || diagnostics.error)}</span>
              </Banner>
            )}
            <Card title="Integration health" eyebrow="live from /api/admin/diagnostics">
              {diagnostics.loading ? (
                <div className="body" style={{ color: "var(--ink-3)" }}>Loading diagnostics…</div>
              ) : !diagnostics.data ? (
                <div className="body" style={{ color: "var(--ink-3)" }}>No data yet.</div>
              ) : (
                <KV rows={Object.entries(diagnostics.data).slice(0, 24).map(([k, v]) => [
                  k,
                  typeof v === "object" && v !== null ? JSON.stringify(v).slice(0, 80) : String(v),
                ])} />
              )}
            </Card>
            <Card title="Tenant" eyebrow="local browser snapshot">
              <KV rows={[
                ["Tenant slug", tenantSlug],
                ["Backend ready", String(!!AnvilBackend?.isReady?.())],
                ["FX last rate count", String(fxRows.length)],
                ["Item master sample size", String(itemRows.length)],
              ]} />
            </Card>
          </>
        )}
      </div>

      {threshForm && (
        <div className="modal-backdrop" onClick={() => setThreshForm(null)}>
          <div className="modal" role="dialog" aria-modal="true" onClick={(ev) => ev.stopPropagation()} style={{ maxWidth: 520 }}>
            <div className="modal-h">
              <span className="ti">{threshForm.id ? "Edit threshold" : "New approval threshold"}</span>
              <Btn icon kind="ghost" sm onClick={() => setThreshForm(null)} aria-label="Close dialog" title="Close (Esc)">{Icon.close}</Btn>
            </div>
            <div className="modal-body" style={{ display: "grid", gap: 10 }}>
              <label className="lbl">Role
                <select value={threshForm.role} onChange={(ev) => setThreshForm({ ...threshForm, role: ev.target.value })}>
                  {ADMIN_ROLES.map((r) => <option key={r} value={r}>{r.replace(/_/g, " ")}</option>)}
                </select>
              </label>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <label className="lbl">Min amount (INR)
                  <input type="number" value={threshForm.min_amount ?? ""} onChange={(ev) => setThreshForm({ ...threshForm, min_amount: ev.target.value === "" ? null : Number(ev.target.value) })} />
                </label>
                <label className="lbl">Max amount (INR, blank = no cap)
                  <input type="number" value={threshForm.max_amount ?? ""} onChange={(ev) => setThreshForm({ ...threshForm, max_amount: ev.target.value === "" ? null : Number(ev.target.value) })} />
                </label>
              </div>
              <label className="lbl">Margin below pct (blank = ignore)
                <input type="number" step="0.1" value={threshForm.margin_below_pct ?? ""} onChange={(ev) => setThreshForm({ ...threshForm, margin_below_pct: ev.target.value === "" ? null : Number(ev.target.value) })} />
              </label>
            </div>
            <div className="modal-f">
              <Btn kind="ghost" onClick={() => setThreshForm(null)}>Cancel</Btn>
              <Btn kind="primary" disabled={busy} onClick={submitThreshold}>{busy ? "Saving…" : "Save"}</Btn>
            </div>
          </div>
        </div>
      )}

      {locForm && (
        <div className="modal-backdrop" onClick={() => setLocForm(null)}>
          <div className="modal" role="dialog" aria-modal="true" onClick={(ev) => ev.stopPropagation()} style={{ maxWidth: 640 }}>
            <div className="modal-h">
              <span className="ti">{locForm.id ? "Edit location" : "New customer location"}</span>
              <Btn icon kind="ghost" sm onClick={() => setLocForm(null)} aria-label="Close dialog" title="Close (Esc)">{Icon.close}</Btn>
            </div>
            <div className="modal-body" style={{ display: "grid", gap: 10 }}>
              <label className="lbl">Customer
                <select value={locForm.customer_id} onChange={(ev) => setLocForm({ ...locForm, customer_id: ev.target.value })}>
                  <option value="">— pick customer —</option>
                  {customerRows.map((c) => <option key={c.id} value={c.id}>{c.customer_name || c.customer_key}</option>)}
                </select>
              </label>
              <label className="lbl">Location name
                <input type="text" value={locForm.location_name || ""} onChange={(ev) => setLocForm({ ...locForm, location_name: ev.target.value })} />
              </label>
              <label className="lbl">Address
                <textarea rows={2} value={locForm.address || ""} onChange={(ev) => setLocForm({ ...locForm, address: ev.target.value })} />
              </label>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <label className="lbl">State code
                  <input type="text" value={locForm.state_code || ""} onChange={(ev) => setLocForm({ ...locForm, state_code: ev.target.value })} />
                </label>
                <label className="lbl">GSTIN
                  <input type="text" value={locForm.gstin || ""} onChange={(ev) => setLocForm({ ...locForm, gstin: ev.target.value })} />
                </label>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                <label className="lbl">Contact name
                  <input type="text" value={locForm.contact_name || ""} onChange={(ev) => setLocForm({ ...locForm, contact_name: ev.target.value })} />
                </label>
                <label className="lbl">Phone
                  <input type="text" value={locForm.contact_phone || ""} onChange={(ev) => setLocForm({ ...locForm, contact_phone: ev.target.value })} />
                </label>
                <label className="lbl">Email
                  <input type="email" value={locForm.contact_email || ""} onChange={(ev) => setLocForm({ ...locForm, contact_email: ev.target.value })} />
                </label>
              </div>
            </div>
            <div className="modal-f">
              <Btn kind="ghost" onClick={() => setLocForm(null)}>Cancel</Btn>
              <Btn kind="primary" disabled={busy} onClick={submitLocation}>{busy ? "Saving…" : "Save"}</Btn>
            </div>
          </div>
        </div>
      )}

      {contractForm && (
        <div className="modal-backdrop" onClick={() => setContractForm(null)}>
          <div className="modal" role="dialog" aria-modal="true" onClick={(ev) => ev.stopPropagation()} style={{ maxWidth: 640 }}>
            <div className="modal-h">
              <span className="ti">{contractForm.id ? "Edit contract" : "New contract"}</span>
              <Btn icon kind="ghost" sm onClick={() => setContractForm(null)} aria-label="Close dialog" title="Close (Esc)">{Icon.close}</Btn>
            </div>
            <div className="modal-body" style={{ display: "grid", gap: 10 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <label className="lbl">Customer
                  <select value={contractForm.customer_id} onChange={(ev) => setContractForm({ ...contractForm, customer_id: ev.target.value })}>
                    <option value="">— pick customer —</option>
                    {customerRows.map((c) => <option key={c.id} value={c.id}>{c.customer_name || c.customer_key}</option>)}
                  </select>
                </label>
                <label className="lbl">Type
                  <select value={contractForm.contract_type} onChange={(ev) => setContractForm({ ...contractForm, contract_type: ev.target.value })}>
                    {CONTRACT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </label>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <label className="lbl">Contract number
                  <input type="text" value={contractForm.contract_number || ""} onChange={(ev) => setContractForm({ ...contractForm, contract_number: ev.target.value })} />
                </label>
                <label className="lbl">Title
                  <input type="text" value={contractForm.title || ""} onChange={(ev) => setContractForm({ ...contractForm, title: ev.target.value })} />
                </label>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                <label className="lbl">Start date
                  <input type="date" value={contractForm.start_date || ""} onChange={(ev) => setContractForm({ ...contractForm, start_date: ev.target.value })} />
                </label>
                <label className="lbl">End date
                  <input type="date" value={contractForm.end_date || ""} onChange={(ev) => setContractForm({ ...contractForm, end_date: ev.target.value })} />
                </label>
                <label className="lbl">Value (INR)
                  <input type="number" value={contractForm.value_inr || ""} onChange={(ev) => setContractForm({ ...contractForm, value_inr: ev.target.value === "" ? null : Number(ev.target.value) })} />
                </label>
              </div>
              <label className="lbl">Notes
                <textarea rows={2} value={contractForm.notes || ""} onChange={(ev) => setContractForm({ ...contractForm, notes: ev.target.value })} />
              </label>
            </div>
            <div className="modal-f">
              <Btn kind="ghost" onClick={() => setContractForm(null)}>Cancel</Btn>
              <Btn kind="primary" disabled={busy} onClick={submitContract}>{busy ? "Saving…" : "Save"}</Btn>
            </div>
          </div>
        </div>
      )}

      {itemForm && (
        <div className="modal-backdrop" onClick={() => setItemForm(null)}>
          <div className="modal" role="dialog" aria-modal="true" onClick={(ev) => ev.stopPropagation()} style={{ maxWidth: 640 }}>
            <div className="modal-h">
              <span className="ti">{itemForm.id ? "Edit item" : "New item"}</span>
              <Btn icon kind="ghost" sm onClick={() => setItemForm(null)} aria-label="Close dialog" title="Close (Esc)">{Icon.close}</Btn>
            </div>
            <div className="modal-body" style={{ display: "grid", gap: 10 }}>
              <label className="lbl">Tally item name (required)
                <input type="text" value={itemForm.tally_item_name || ""} onChange={(ev) => setItemForm({ ...itemForm, tally_item_name: ev.target.value })} />
              </label>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <label className="lbl">Seller part no
                  <input type="text" value={itemForm.seller_part_no || ""} onChange={(ev) => setItemForm({ ...itemForm, seller_part_no: ev.target.value })} />
                </label>
                <label className="lbl">HSN code
                  <input type="text" value={itemForm.hsn_code || ""} onChange={(ev) => setItemForm({ ...itemForm, hsn_code: ev.target.value })} />
                </label>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 2fr", gap: 10 }}>
                <label className="lbl">UOM
                  <input type="text" value={itemForm.uom || "Nos"} onChange={(ev) => setItemForm({ ...itemForm, uom: ev.target.value })} />
                </label>
                <label className="lbl">Standard rate (INR)
                  <input type="number" value={itemForm.standard_rate || ""} onChange={(ev) => setItemForm({ ...itemForm, standard_rate: ev.target.value === "" ? null : Number(ev.target.value) })} />
                </label>
                <label className="lbl">Drawing no
                  <input type="text" value={itemForm.drawing_no || ""} onChange={(ev) => setItemForm({ ...itemForm, drawing_no: ev.target.value })} />
                </label>
              </div>
              <label className="lbl">Description
                <textarea rows={2} value={itemForm.description || ""} onChange={(ev) => setItemForm({ ...itemForm, description: ev.target.value })} />
              </label>
            </div>
            <div className="modal-f">
              <Btn kind="ghost" onClick={() => setItemForm(null)}>Cancel</Btn>
              <Btn kind="primary" disabled={busy} onClick={submitItem}>{busy ? "Saving…" : "Save"}</Btn>
            </div>
          </div>
        </div>
      )}
    </>
  );
};


export default WiredAdminCRUD;

// ============================================================
// DocAI cost panel.
//
// Reads /api/docai/cost_status (today's per-adapter usage + 7-day
// trend + adapter health + per-tenant caps + recommended actions),
// and lets an admin PATCH /api/admin/docai_settings to update the
// cost levers (provider order, daily limits, anthropic + gemini
// model selectors) without writing SQL.
//
// Self-contained so admin.tsx stays readable.
// ============================================================

// Bet 1: mistral_ocr is now a first-class adapter row in the chain
// editor + cost panel. It runs as the OCR LAYER (image-only PDFs)
// not in the structured-extraction provider chain itself, but
// surfacing it here lets operators see usage + cost alongside the
// other adapters.
const DOCAI_ADAPTERS_LIST = [
  "gemini", "claude", "reducto", "azure_di", "unstructured",
  "docling", "marker", "mistral_ocr",
] as const;

type CostStatus = {
  date: string;
  window_days?: number;
  today_usage: Array<{ adapter: string; call_count: number; estimated_cost_usd: number; last_called_at?: string | null }>;
  trend_7d: { calls: number; cost: number };
  trend_window?: { calls: number; cost: number };
  trend_series?: {
    dates: string[];
    adapters: string[];
    series: Record<string, { calls: number[]; cost: number[] }>;
  };
  burn?: Record<string, { today_calls: number; median_n_calls: number; ratio: number | null; window_days: number }>;
  anomalies?: Array<{ adapter: string; date: string; calls: number; median: number; multiplier: number }>;
  forecast?: Record<string, { cap: number; used: number; remaining: number; rate_per_hour: number; hours_to_cap: number | null; will_hit_cap_today: boolean }>;
  provider_order: string[];
  provider_order_default: boolean;
  daily_limits: Record<string, number> | null;
  anthropic_model: string;
  // Bet 1 additions.
  gemini_model?: string;
  fallback_confidence?: number;
  mistral_ocr_batch?: boolean;
  gemini_media_resolution?: string;
  adapter_health: Record<string, boolean>;
  tenant_has_key: Record<string, boolean>;
  recommendations: Array<{ id: string; severity: string; title: string; body: string; action?: string }>;
  summary: { calls_today: number; cost_today_usd: number; free_friendly_calls_today: number; paid_calls_today: number; warnings: number; anomalies_count?: number; forecast_caps_at_risk_today?: number };
};

// Color palette for stacked-area chart series. Mirrors the brand
// tokens in styles.css; the order is stable so 'gemini' always
// gets the brand chartreuse, 'claude' always gets sage, etc.
const COST_CHART_COLORS: Record<string, string> = {
  gemini:       "var(--accent)",
  claude:       "var(--sage)",
  reducto:      "var(--lapis)",
  azure_di:     "var(--plum)",
  unstructured: "var(--amber)",
  docling:      "var(--accent-2)",
  marker:       "var(--rust)",
  // Bet 1: Mistral OCR 3 OCR layer.
  mistral_ocr:  "var(--lapis-2)",
};
const fallbackColor = (i: number) => {
  const fallback = ["var(--accent-3)", "var(--sage-3)", "var(--lapis-3)", "var(--plum-3)", "var(--amber-3)", "var(--rust-3)"];
  return fallback[i % fallback.length];
};

// Inline SVG stacked-area chart for the per-day cost trend. No
// external chart library; mirrors the inventory-item.tsx pattern
// (lines 140-189). The y-axis is total $ spend per day, with each
// adapter's contribution stacked. The cap line (if any) is the
// max of all per-adapter daily caps from docai_daily_limits.
const CostTrendChart: React.FC<{
  series: NonNullable<CostStatus["trend_series"]>;
  metric: "calls" | "cost";
  capLine?: number | null;
}> = ({ series, metric, capLine }) => {
  const W = 760;
  const H = 240;
  const padL = 36;
  const padR = 16;
  const padT = 10;
  const padB = 28;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const dates = series.dates;
  const adapters = series.adapters;

  const dailyTotals = dates.map((_, dayIdx) =>
    adapters.reduce((acc, a) => acc + (series.series[a]?.[metric][dayIdx] || 0), 0)
  );
  const yMaxRaw = Math.max(...dailyTotals, capLine != null ? capLine : 0, 1);
  const yMax = niceCeiling(yMaxRaw);
  const xStep = dates.length > 1 ? innerW / (dates.length - 1) : innerW;
  const xAt = (i: number) => padL + i * xStep;
  const yAt = (v: number) => padT + innerH - (v / yMax) * innerH;

  // Stacked layers: bottom-up. For each adapter compute the
  // running cumulative total at each date; build the polygon as
  // top edge (cumulative) + bottom edge (previous cumulative).
  const cum: number[] = dates.map(() => 0);
  const layers = adapters.map((adapter) => {
    const data = series.series[adapter]?.[metric] || dates.map(() => 0);
    const top = dates.map((_, i) => {
      cum[i] += data[i];
      return cum[i];
    });
    const bottom = dates.map((_, i) => cum[i] - data[i]);
    const points: [number, number][] = [];
    for (let i = 0; i < dates.length; i++) points.push([xAt(i), yAt(top[i])]);
    for (let i = dates.length - 1; i >= 0; i--) points.push([xAt(i), yAt(bottom[i])]);
    return { adapter, top, bottom, polygon: points.map((p) => p.join(",")).join(" ") };
  });

  const fmtY = (v: number) => metric === "cost" ? "$" + v.toFixed(2) : String(v);

  return (
    <div style={{ width: "100%", overflowX: "auto" }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: H, display: "block" }} role="img" aria-label="DocAI per-day usage chart">
        {/* gridlines */}
        {[0, 0.25, 0.5, 0.75, 1].map((t, i) => (
          <line key={i}
                x1={padL} y1={padT + innerH * (1 - t)}
                x2={W - padR} y2={padT + innerH * (1 - t)}
                stroke="var(--hairline-2)" strokeWidth={0.5} />
        ))}
        {/* y-axis labels */}
        {[0, 0.25, 0.5, 0.75, 1].map((t, i) => (
          <text key={i}
                x={padL - 4} y={padT + innerH * (1 - t) + 3}
                textAnchor="end" fontSize={10} fill="var(--ink-3)"
                fontFamily="monospace">
            {fmtY(yMax * t)}
          </text>
        ))}
        {/* stacked layers */}
        {layers.map((layer, i) => (
          <polygon key={layer.adapter}
                   points={layer.polygon}
                   fill={COST_CHART_COLORS[layer.adapter] || fallbackColor(i)}
                   fillOpacity={0.55}
                   stroke={COST_CHART_COLORS[layer.adapter] || fallbackColor(i)}
                   strokeWidth={1} />
        ))}
        {/* cap line overlay */}
        {capLine != null && capLine > 0 && capLine <= yMax && (
          <g>
            <line x1={padL} y1={yAt(capLine)} x2={W - padR} y2={yAt(capLine)}
                  stroke="var(--rust)" strokeWidth={1.5} strokeDasharray="4 3" />
            <text x={W - padR} y={yAt(capLine) - 4} textAnchor="end"
                  fontSize={10} fill="var(--rust)" fontFamily="monospace">
              cap {fmtY(capLine)}
            </text>
          </g>
        )}
        {/* x-axis labels: first, last, and every 5th day in between to avoid crowding */}
        {dates.map((d, i) => {
          const show = i === 0 || i === dates.length - 1 || i % Math.max(1, Math.floor(dates.length / 7)) === 0;
          if (!show) return null;
          return (
            <text key={d}
                  x={xAt(i)} y={H - 8}
                  textAnchor="middle" fontSize={10} fill="var(--ink-3)"
                  fontFamily="monospace">
              {d.slice(5)}
            </text>
          );
        })}
      </svg>
      {/* legend */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginTop: 6, padding: "0 8px" }}>
        {adapters.map((a, i) => (
          <span key={a} className="mono-sm" style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--ink-2)" }}>
            <span style={{
              width: 10, height: 10, borderRadius: 2,
              backgroundColor: COST_CHART_COLORS[a] || fallbackColor(i),
              opacity: 0.7,
            }} />
            {a}
          </span>
        ))}
      </div>
    </div>
  );
};

// Pick a "nice" axis ceiling (50 -> 50; 11 -> 12; 1.3 -> 2; etc.).
const niceCeiling = (v: number): number => {
  if (v <= 0) return 1;
  if (v <= 1) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / exp;
  if (f <= 1.5) return 1.5 * exp;
  if (f <= 2) return 2 * exp;
  if (f <= 5) return 5 * exp;
  return 10 * exp;
};

// Build a CSV from the trend series. Columns: date, then one
// per adapter for the chosen metric. Used for the Export button.
const buildTrendCsv = (series: NonNullable<CostStatus["trend_series"]>, metric: "calls" | "cost"): string => {
  const header = ["date", ...series.adapters].join(",");
  const rows = series.dates.map((d, i) => {
    const cells = [d, ...series.adapters.map((a) => String(series.series[a]?.[metric][i] ?? 0))];
    return cells.join(",");
  });
  return [header, ...rows].join("\n") + "\n";
};
const downloadCsv = (filename: string, content: string) => {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

// Item-master custom-field schema editor. Lets a tenant admin
// define their own extension fields for the Item Master without a
// code migration. Each field has a key, label, type, group, and
// visibility flags (invoice vs PO vs master) so the same field can
// be opted in/out of customer-facing or supplier-facing documents.
const ItemFieldsPanel: React.FC = () => {
  const [defs, setDefs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<any>(null);
  const [draft, setDraft] = useState<any>({
    field_label: "",
    field_type: "text",
    field_group: "engineering",
    field_required: false,
    is_visible_invoice: false,
    is_visible_po: false,
    is_visible_master: true,
  });

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await adminCrudFetch("/api/admin/item_field_definitions");
      setDefs(r.definitions || []);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { reload(); }, []);

  const save = async () => {
    if (!draft.field_label?.trim()) {
      window.notifyWarn?.("Field label required", "Give the field a human-readable label first.");
      return;
    }
    try {
      await adminCrudFetch("/api/admin/item_field_definitions", { method: "POST", body: draft });
      window.notifySuccess?.("Field saved", draft.field_label);
      setDraft({
        field_label: "",
        field_type: "text",
        field_group: "engineering",
        field_required: false,
        is_visible_invoice: false,
        is_visible_po: false,
        is_visible_master: true,
      });
      await reload();
    } catch (e: any) {
      window.notifyError?.("Could not save field", e?.message || String(e));
    }
  };

  const disableField = async (id: string) => {
    if (!window.confirm("Disable this field? Historical values are preserved. Use ?hard=1 for a destructive delete.")) return;
    try {
      await adminCrudFetch("/api/admin/item_field_definitions?id=" + encodeURIComponent(id), { method: "DELETE" });
      await reload();
    } catch (e: any) {
      window.notifyError?.("Could not disable field", e?.message || String(e));
    }
  };

  if (loading) return <Card><div className="body">Loading custom item fields...</div></Card>;
  if (error) return (
    <Banner kind="bad" icon={Icon.alert} title="Could not load item fields" action={<Btn sm onClick={reload}>Retry</Btn>}>
      <span className="mono-sm">{String((error as any)?.message || error)}</span>
    </Banner>
  );

  return (
    <>
      <Card title="Add or update a custom field" eyebrow="per-tenant Item Master extension">
        <div className="row" style={{ gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div>
            <label className="mono-sm" style={{ color: "var(--ink-3)", display: "block", marginBottom: 4 }}>Label</label>
            <input className="input" value={draft.field_label} onChange={(e) => setDraft({ ...draft, field_label: e.target.value })} placeholder="e.g., Gun Number" />
          </div>
          <div>
            <label className="mono-sm" style={{ color: "var(--ink-3)", display: "block", marginBottom: 4 }}>Type</label>
            <select className="select" value={draft.field_type} onChange={(e) => setDraft({ ...draft, field_type: e.target.value })}>
              <option value="text">Text</option>
              <option value="number">Number</option>
              <option value="boolean">Yes / No</option>
              <option value="select">Select (dropdown)</option>
              <option value="date">Date</option>
              <option value="url">URL</option>
              <option value="file">File</option>
            </select>
          </div>
          <div>
            <label className="mono-sm" style={{ color: "var(--ink-3)", display: "block", marginBottom: 4 }}>Group</label>
            <select className="select" value={draft.field_group} onChange={(e) => setDraft({ ...draft, field_group: e.target.value })}>
              <option value="identification">Identification</option>
              <option value="classification">Classification</option>
              <option value="tax">Tax</option>
              <option value="inventory">Inventory</option>
              <option value="engineering">Engineering</option>
              <option value="logistics">Logistics</option>
              <option value="custom">Custom</option>
            </select>
          </div>
          <label className="mono-sm row" style={{ gap: 6 }}>
            <input type="checkbox" checked={!!draft.field_required} onChange={(e) => setDraft({ ...draft, field_required: e.target.checked })} /> required
          </label>
          <label className="mono-sm row" style={{ gap: 6 }}>
            <input type="checkbox" checked={!!draft.is_visible_master} onChange={(e) => setDraft({ ...draft, is_visible_master: e.target.checked })} /> show on master
          </label>
          <label className="mono-sm row" style={{ gap: 6 }}>
            <input type="checkbox" checked={!!draft.is_visible_invoice} onChange={(e) => setDraft({ ...draft, is_visible_invoice: e.target.checked })} /> show on invoice
          </label>
          <label className="mono-sm row" style={{ gap: 6 }}>
            <input type="checkbox" checked={!!draft.is_visible_po} onChange={(e) => setDraft({ ...draft, is_visible_po: e.target.checked })} /> show on PO
          </label>
          <Btn sm kind="primary" onClick={save}>{Icon.plus} save field</Btn>
        </div>
        {draft.field_type === "select" && (
          <div style={{ marginTop: 8 }}>
            <label className="mono-sm" style={{ color: "var(--ink-3)" }}>Select options (one per line, format: value or value=label)</label>
            <textarea
              className="input"
              rows={4}
              style={{ width: "100%" }}
              value={(draft.field_options || []).map((o: any) => o.value === o.label ? o.value : `${o.value}=${o.label}`).join("\n")}
              onChange={(e) => {
                const lines = e.target.value.split("\n").map((s) => s.trim()).filter(Boolean);
                const options = lines.map((line) => {
                  const [v, l] = line.split("=");
                  return { value: v.trim(), label: (l || v).trim() };
                });
                setDraft({ ...draft, field_options: options });
              }}
            />
          </div>
        )}
      </Card>

      <Card flush>
        {defs.length === 0 ? (
          <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
            No custom item fields defined yet. Add one above to extend the item master schema for your tenant.
          </div>
        ) : (
          <table className="tbl">
            <thead><tr>
              <th>Key</th><th>Label</th><th>Type</th><th>Group</th>
              <th className="r">Required</th><th className="r">Master</th><th className="r">Invoice</th><th className="r">PO</th>
              <th className="r">Status</th><th></th>
            </tr></thead>
            <tbody>
              {defs.map((d) => (
                <tr key={d.id}>
                  <td className="mono"><span className="pri">{d.field_key}</span></td>
                  <td>{d.field_label}</td>
                  <td className="mono-sm">{d.field_type}</td>
                  <td className="mono-sm">{d.field_group}</td>
                  <td className="r">{d.field_required ? "yes" : "-"}</td>
                  <td className="r">{d.is_visible_master ? "yes" : "-"}</td>
                  <td className="r">{d.is_visible_invoice ? "yes" : "-"}</td>
                  <td className="r">{d.is_visible_po ? "yes" : "-"}</td>
                  <td className="r"><Chip k={d.is_active ? "good" : "ghost"}>{d.is_active ? "active" : "disabled"}</Chip></td>
                  <td className="r">
                    {d.is_active && <Btn sm kind="ghost" onClick={() => disableField(d.id)}>disable</Btn>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
};

// Per-tenant document templates editor (migration 106). Lets the
// tenant carry their own quotation / SO / PO / invoice / e-way bill
// boilerplate without code edits. Each doc type can have many
// templates with at most one default.
const DocumentTemplatesPanel: React.FC = () => {
  const [templates, setTemplates] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<any>(null);
  const [editing, setEditing] = useState<any | null>(null);

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await adminCrudFetch("/api/admin/document_templates");
      setTemplates(r.templates || []);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { reload(); }, []);

  const save = async () => {
    if (!editing?.template_name?.trim()) {
      window.notifyWarn?.("Template name required", "Give the template a label first.");
      return;
    }
    if (!editing?.doc_type) {
      window.notifyWarn?.("Document type required", "Pick a doc type (quotation, sales_order, etc.)");
      return;
    }
    try {
      await adminCrudFetch("/api/admin/document_templates", { method: "POST", body: editing });
      window.notifySuccess?.("Template saved", editing.template_name);
      setEditing(null);
      await reload();
    } catch (e: any) {
      window.notifyError?.("Could not save template", e?.message || String(e));
    }
  };

  if (loading) return <Card><div className="body">Loading templates...</div></Card>;
  if (error) return (
    <Banner kind="bad" icon={Icon.alert} title="Could not load document templates" action={<Btn sm onClick={reload}>Retry</Btn>}>
      <span className="mono-sm">{String((error as any)?.message || error)}</span>
    </Banner>
  );

  return (
    <>
      <div className="row" style={{ justifyContent: "flex-end", marginBottom: 8 }}>
        <Btn sm kind="primary" onClick={() => setEditing({ doc_type: "quotation", template_name: "", version: 1, is_active: true, is_default: false })}>
          {Icon.plus} New template
        </Btn>
      </div>
      <Card flush>
        {templates.length === 0 ? (
          <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
            No document templates yet. Click <b>New template</b> to add one.
          </div>
        ) : (
          <table className="tbl">
            <thead><tr>
              <th>Doc type</th><th>Name</th><th>Form code</th><th className="r">Version</th>
              <th className="r">Active</th><th className="r">Default</th><th></th>
            </tr></thead>
            <tbody>
              {templates.map((t) => (
                <tr key={t.id} style={{ cursor: "pointer" }} onClick={() => setEditing({ ...t })}>
                  <td className="mono-sm">{t.doc_type}</td>
                  <td><span className="pri">{t.template_name}</span></td>
                  <td className="mono-sm">{t.form_code || "-"}</td>
                  <td className="r mono">{t.version}</td>
                  <td className="r">{t.is_active ? "yes" : "-"}</td>
                  <td className="r">{t.is_default ? <Chip k="good">default</Chip> : "-"}</td>
                  <td className="r"><Btn sm kind="ghost" onClick={(e) => { e.stopPropagation(); setEditing({ ...t }); }}>edit</Btn></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {editing && (
        <div role="dialog" aria-modal="true" style={{ position: "fixed", inset: 0, background: "rgba(8,10,12,0.55)", display: "flex", justifyContent: "flex-end", zIndex: 200 }} onClick={() => setEditing(null)}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: "min(800px, 100vw)", height: "100vh", background: "var(--bg)", borderLeft: "1px solid var(--line)", padding: 18, overflowY: "auto" }}>
            <div className="row" style={{ alignItems: "center", marginBottom: 12 }}>
              <div style={{ flex: 1 }}>
                <div className="mono-sm" style={{ color: "var(--ink-3)" }}>Admin . Document template</div>
                <div style={{ fontSize: 16, fontWeight: 600 }}>{editing.id ? editing.template_name : "New template"}</div>
              </div>
              <Btn sm kind="ghost" onClick={() => setEditing(null)}>close</Btn>
            </div>
            <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
              <div>
                <label className="mono-sm">Doc type</label>
                <select className="select" value={editing.doc_type} onChange={(e) => setEditing({ ...editing, doc_type: e.target.value })}>
                  <option value="quotation">Quotation</option>
                  <option value="sales_order">Sales order</option>
                  <option value="purchase_order">Purchase order</option>
                  <option value="tax_invoice">Tax invoice</option>
                  <option value="proforma_invoice">Proforma invoice</option>
                  <option value="credit_note">Credit note</option>
                  <option value="eway_bill">E-way bill</option>
                  <option value="delivery_note">Delivery note</option>
                </select>
              </div>
              <div>
                <label className="mono-sm">Template name</label>
                <input className="input" value={editing.template_name || ""} onChange={(e) => setEditing({ ...editing, template_name: e.target.value })} />
              </div>
              <div>
                <label className="mono-sm">Form code</label>
                <input className="input mono" value={editing.form_code || ""} onChange={(e) => setEditing({ ...editing, form_code: e.target.value })} placeholder="e.g., OI/F/SP/19/R-00/020226" />
              </div>
              <div>
                <label className="mono-sm">Version</label>
                <input className="input mono r" type="number" value={editing.version || 1} onChange={(e) => setEditing({ ...editing, version: Number(e.target.value) })} />
              </div>
              <label className="mono-sm row" style={{ gap: 6, alignItems: "center" }}>
                <input type="checkbox" checked={!!editing.is_active} onChange={(e) => setEditing({ ...editing, is_active: e.target.checked })} /> active
              </label>
              <label className="mono-sm row" style={{ gap: 6, alignItems: "center" }}>
                <input type="checkbox" checked={!!editing.is_default} onChange={(e) => setEditing({ ...editing, is_default: e.target.checked })} /> default
              </label>
            </div>
            {[
              ["header_block", "Header block"],
              ["footer_block", "Footer block"],
              ["signatory_block", "Authorised signatory block"],
              ["standard_message", "Standard message (e.g., 7-day discrepancy notice)"],
              ["warranty_clause", "Warranty clause"],
              ["penalty_clause", "Penalty clause"],
              ["cancellation_clause", "Cancellation clause"],
              ["force_majeure_clause", "Force majeure clause"],
              ["payment_terms_clause", "Payment terms clause"],
              ["delivery_terms_clause", "Delivery terms clause"],
            ].map(([k, label]) => (
              <div key={k} style={{ marginTop: 10 }}>
                <label className="mono-sm" style={{ color: "var(--ink-3)" }}>{label}</label>
                <textarea className="input" rows={3} style={{ width: "100%" }} value={editing[k] || ""} onChange={(e) => setEditing({ ...editing, [k]: e.target.value })} />
              </div>
            ))}
            <div className="row" style={{ gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
              <Btn sm kind="ghost" onClick={() => setEditing(null)}>Cancel</Btn>
              <Btn sm kind="primary" onClick={save}>Save template</Btn>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

// Freight rate table editor (migration 106). Simple CRUD over the
// freight_rates table; rows feed the price-composition cockpit.
const FreightRatesPanel: React.FC = () => {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<any>(null);
  const [draft, setDraft] = useState<any>({ mode: "ocean", unit: "cbm", currency: "INR", rate_per_unit: 0, is_active: true });

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await adminCrudFetch("/api/admin/freight_rates");
      setRows(r.rates || []);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { reload(); }, []);

  const save = async () => {
    try {
      await adminCrudFetch("/api/admin/freight_rates", { method: "POST", body: draft });
      window.notifySuccess?.("Freight rate saved", `${draft.mode} . ${draft.unit}`);
      setDraft({ mode: "ocean", unit: "cbm", currency: "INR", rate_per_unit: 0, is_active: true });
      await reload();
    } catch (e: any) {
      window.notifyError?.("Could not save freight rate", e?.message || String(e));
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm("Delete this freight rate row?")) return;
    try {
      await adminCrudFetch("/api/admin/freight_rates?id=" + encodeURIComponent(id), { method: "DELETE" });
      await reload();
    } catch (e: any) {
      window.notifyError?.("Could not delete", e?.message || String(e));
    }
  };

  if (loading) return <Card><div className="body">Loading freight rates...</div></Card>;
  if (error) return (
    <Banner kind="bad" icon={Icon.alert} title="Could not load freight rates" action={<Btn sm onClick={reload}>Retry</Btn>}>
      <span className="mono-sm">{String((error as any)?.message || error)}</span>
    </Banner>
  );

  return (
    <>
      <Card title="Add freight rate" eyebrow="per-tenant air / ocean / road / courier rate table">
        <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div>
            <label className="mono-sm">Mode</label>
            <select className="select" value={draft.mode} onChange={(e) => setDraft({ ...draft, mode: e.target.value })}>
              <option value="ocean">Ocean</option>
              <option value="air">Air</option>
              <option value="road">Road</option>
              <option value="courier">Courier</option>
            </select>
          </div>
          <div>
            <label className="mono-sm">Origin</label>
            <input className="input mono" maxLength={2} value={draft.origin || ""} onChange={(e) => setDraft({ ...draft, origin: e.target.value.toUpperCase() })} placeholder="KR, JP, IN, ..." />
          </div>
          <div>
            <label className="mono-sm">Destination</label>
            <input className="input mono" maxLength={2} value={draft.destination || ""} onChange={(e) => setDraft({ ...draft, destination: e.target.value.toUpperCase() })} placeholder="IN" />
          </div>
          <div>
            <label className="mono-sm">Unit</label>
            <select className="select" value={draft.unit} onChange={(e) => setDraft({ ...draft, unit: e.target.value })}>
              <option value="kg">per kg</option>
              <option value="cbm">per CBM</option>
              <option value="container_20ft">per 20ft container</option>
              <option value="container_40ft">per 40ft container</option>
              <option value="set">per set</option>
            </select>
          </div>
          <div>
            <label className="mono-sm">Rate per unit</label>
            <input className="input mono r" type="number" step="0.01" value={draft.rate_per_unit ?? 0} onChange={(e) => setDraft({ ...draft, rate_per_unit: Number(e.target.value) })} />
          </div>
          <div>
            <label className="mono-sm">Packing fee</label>
            <input className="input mono r" type="number" step="0.01" value={draft.packing_fee ?? ""} onChange={(e) => setDraft({ ...draft, packing_fee: e.target.value === "" ? null : Number(e.target.value) })} />
          </div>
          <div>
            <label className="mono-sm">Currency</label>
            <input className="input mono" maxLength={3} value={draft.currency || "INR"} onChange={(e) => setDraft({ ...draft, currency: e.target.value.toUpperCase() })} />
          </div>
          <Btn sm kind="primary" onClick={save}>{Icon.plus} Add</Btn>
        </div>
      </Card>
      <Card flush>
        {rows.length === 0 ? (
          <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>No freight rates yet.</div>
        ) : (
          <table className="tbl">
            <thead><tr>
              <th>Mode</th><th>Origin</th><th>Destination</th><th>Unit</th>
              <th className="r">Rate</th><th className="r">Packing</th><th>Currency</th><th className="r">Active</th><th></th>
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="mono-sm">{r.mode}</td>
                  <td className="mono-sm">{r.origin || "-"}</td>
                  <td className="mono-sm">{r.destination || "-"}</td>
                  <td className="mono-sm">{r.unit}</td>
                  <td className="r mono"><span className="pri">{r.rate_per_unit}</span></td>
                  <td className="r mono">{r.packing_fee || "-"}</td>
                  <td className="mono-sm">{r.currency}</td>
                  <td className="r">{r.is_active ? "yes" : "-"}</td>
                  <td className="r"><Btn sm kind="ghost" onClick={() => remove(r.id)}>delete</Btn></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
};

// Tenant-wide pricing settings (migration 106). Backs the price
// composition cockpit defaults. Single row per tenant.
const PricingSettingsPanel: React.FC = () => {
  const [settings, setSettings] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<any>(null);
  const [factorEdit, setFactorEdit] = useState("");

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await adminCrudFetch("/api/admin/tenant_pricing_settings");
      const s = r.settings || {
        target_margin_pct: 0.35,
        default_conversion_factor: 1.0,
        multiplication_factors: {},
        default_freight_mode: "ocean",
        enable_landed_cost: true,
        rounding_rule: "NEAREST_1",
        show_supplier_price_in_quote: false,
        show_reference_price_in_quote: false,
      };
      setSettings(s);
      setFactorEdit(JSON.stringify(s.multiplication_factors || {}, null, 2));
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { reload(); }, []);

  const save = async () => {
    let factors = {};
    try { factors = JSON.parse(factorEdit || "{}"); } catch (e: any) {
      window.notifyError?.("Multiplication factors not valid JSON", e?.message || String(e));
      return;
    }
    try {
      await adminCrudFetch("/api/admin/tenant_pricing_settings", { method: "POST", body: { ...settings, multiplication_factors: factors } });
      window.notifySuccess?.("Pricing settings saved", "tenant-wide defaults updated");
      await reload();
    } catch (e: any) {
      window.notifyError?.("Could not save pricing settings", e?.message || String(e));
    }
  };

  if (loading) return <Card><div className="body">Loading pricing settings...</div></Card>;
  if (error) return (
    <Banner kind="bad" icon={Icon.alert} title="Could not load pricing settings" action={<Btn sm onClick={reload}>Retry</Btn>}>
      <span className="mono-sm">{String((error as any)?.message || error)}</span>
    </Banner>
  );
  if (!settings) return null;

  return (
    <Card title="Pricing defaults" eyebrow="tenant-wide. Price-composition cockpit uses these unless overridden per quote.">
      <div className="row" style={{ gap: 14, flexWrap: "wrap" }}>
        <div>
          <label className="mono-sm">Target margin %</label>
          <input className="input mono r" type="number" step="0.01" value={settings.target_margin_pct ?? 0} onChange={(e) => setSettings({ ...settings, target_margin_pct: Number(e.target.value) })} />
        </div>
        <div>
          <label className="mono-sm">Default conversion factor</label>
          <input className="input mono r" type="number" step="0.001" value={settings.default_conversion_factor ?? 1} onChange={(e) => setSettings({ ...settings, default_conversion_factor: Number(e.target.value) })} />
        </div>
        <div>
          <label className="mono-sm">Default freight mode</label>
          <select className="select" value={settings.default_freight_mode || "ocean"} onChange={(e) => setSettings({ ...settings, default_freight_mode: e.target.value })}>
            <option value="ocean">Ocean</option><option value="air">Air</option><option value="road">Road</option><option value="courier">Courier</option>
          </select>
        </div>
        <div>
          <label className="mono-sm">Rounding rule</label>
          <select className="select" value={settings.rounding_rule || "NEAREST_1"} onChange={(e) => setSettings({ ...settings, rounding_rule: e.target.value })}>
            <option value="NONE">None</option><option value="NEAREST_1">Nearest 1</option><option value="NEAREST_10">Nearest 10</option><option value="NEAREST_100">Nearest 100</option>
          </select>
        </div>
        <label className="mono-sm row" style={{ gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={!!settings.enable_landed_cost} onChange={(e) => setSettings({ ...settings, enable_landed_cost: e.target.checked })} /> enable landed cost
        </label>
        <label className="mono-sm row" style={{ gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={!!settings.show_supplier_price_in_quote} onChange={(e) => setSettings({ ...settings, show_supplier_price_in_quote: e.target.checked })} /> show supplier price
        </label>
        <label className="mono-sm row" style={{ gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={!!settings.show_reference_price_in_quote} onChange={(e) => setSettings({ ...settings, show_reference_price_in_quote: e.target.checked })} /> show reference price
        </label>
      </div>
      <div style={{ marginTop: 14 }}>
        <label className="mono-sm" style={{ color: "var(--ink-3)" }}>Multiplication factors per currency (JSON object, e.g., {"{ \"USD\": 126.6, \"CNY\": 18.5, \"JPY\": 0.86 }"})</label>
        <textarea className="input mono" rows={6} style={{ width: "100%" }} value={factorEdit} onChange={(e) => setFactorEdit(e.target.value)} />
      </div>
      <div className="row" style={{ justifyContent: "flex-end", marginTop: 12 }}>
        <Btn sm kind="primary" onClick={save}>Save</Btn>
      </div>
    </Card>
  );
};

// Vendor codes editor (migration 106). Records how each customer
// refers to the tenant. Inbound POs can be matched on this code so
// the intake flow can auto-resolve the customer.
const VendorCodesPanel: React.FC = () => {
  const [customers, setCustomers] = useState<any[]>([]);
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<any>(null);
  const [draft, setDraft] = useState<any>({ customer_id: "", vendor_code: "", is_primary: true, notes: "" });

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      const [cs, vc] = await Promise.all([
        adminCrudFetch("/api/customers"),
        adminCrudFetch("/api/admin/customer_vendor_codes"),
      ]);
      setCustomers(cs.customers || []);
      setRows(vc.mappings || []);
    } catch (e) { setError(e); } finally { setLoading(false); }
  };
  useEffect(() => { reload(); }, []);

  const save = async () => {
    if (!draft.customer_id || !draft.vendor_code) {
      window.notifyWarn?.("Customer + vendor code required", "Pick a customer and enter the code they use for this tenant.");
      return;
    }
    try {
      await adminCrudFetch("/api/admin/customer_vendor_codes", { method: "POST", body: draft });
      window.notifySuccess?.("Vendor code saved", draft.vendor_code);
      setDraft({ customer_id: "", vendor_code: "", is_primary: true, notes: "" });
      await reload();
    } catch (e: any) { window.notifyError?.("Could not save", e?.message || String(e)); }
  };

  const remove = async (customer_id: string, vendor_code: string) => {
    if (!window.confirm(`Delete vendor code "${vendor_code}"?`)) return;
    try {
      await adminCrudFetch(`/api/admin/customer_vendor_codes?customer_id=${customer_id}&vendor_code=${encodeURIComponent(vendor_code)}`, { method: "DELETE" });
      await reload();
    } catch (e: any) { window.notifyError?.("Could not delete", e?.message || String(e)); }
  };

  if (loading) return <Card><div className="body">Loading vendor codes...</div></Card>;
  if (error) return <Banner kind="bad" icon={Icon.alert} title="Could not load" action={<Btn sm onClick={reload}>Retry</Btn>}><span className="mono-sm">{String((error as any)?.message || error)}</span></Banner>;

  return (
    <>
      <Card title="Add vendor code" eyebrow="how each customer refers to this tenant as their supplier">
        <div className="row" style={{ gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div>
            <label className="mono-sm">Customer</label>
            <select className="select" value={draft.customer_id} onChange={(e) => setDraft({ ...draft, customer_id: e.target.value })}>
              <option value="">Select...</option>
              {customers.map((c: any) => <option key={c.id} value={c.id}>{c.customer_name}</option>)}
            </select>
          </div>
          <div>
            <label className="mono-sm">Vendor code</label>
            <input className="input mono" value={draft.vendor_code} onChange={(e) => setDraft({ ...draft, vendor_code: e.target.value })} placeholder="e.g., TH1M" />
          </div>
          <label className="mono-sm row" style={{ gap: 6, alignItems: "center" }}>
            <input type="checkbox" checked={!!draft.is_primary} onChange={(e) => setDraft({ ...draft, is_primary: e.target.checked })} /> primary
          </label>
          <div style={{ flex: 1 }}>
            <label className="mono-sm">Notes</label>
            <input className="input" value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
          </div>
          <Btn sm kind="primary" onClick={save}>{Icon.plus} Add</Btn>
        </div>
      </Card>
      <Card flush>
        {rows.length === 0 ? (
          <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
            No vendor codes mapped yet. Add the supplier code each customer uses for your tenant.
          </div>
        ) : (
          <table className="tbl">
            <thead><tr><th>Customer</th><th>Vendor code</th><th>Primary</th><th>Notes</th><th></th></tr></thead>
            <tbody>
              {rows.map((r) => {
                const c = customers.find((cc: any) => cc.id === r.customer_id);
                return (
                  <tr key={`${r.customer_id}:${r.vendor_code}`}>
                    <td>{c?.customer_name || r.customer_id.slice(0, 8)}</td>
                    <td className="mono"><span className="pri">{r.vendor_code}</span></td>
                    <td>{r.is_primary ? <Chip k="good">primary</Chip> : "-"}</td>
                    <td className="mono-sm">{r.notes || "-"}</td>
                    <td className="r"><Btn sm kind="ghost" onClick={() => remove(r.customer_id, r.vendor_code)}>delete</Btn></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
};

// Layer D: bulk + per-row CSV/XLSX import for item_customer_parts.
// Mirrors the VendorCodesPanel shape (load lists, add-row form,
// table) plus a hidden file input that parses CSV via the inline
// parseCSV at the top of this file or XLSX via the lazy-loaded
// SheetJS CDN bundle from bom-import.tsx. The endpoint at
// /api/admin/item_customer_parts already accepts both single and
// { rows: [...] } batch shapes per stage 2 of the plan; this
// panel calls the batch shape with parsedRows.
//
// CSV / XLSX columns recognised (any subset, case-insensitive):
//   customer_id | customer_name
//   item_master_id | item_master_part_no | part_no
//   customer_part_number   (required)
//   customer_part_description
//   customer_project
//   valid_from, valid_to     (YYYY-MM-DD)
//   is_primary               (truthy: "1", "true", "yes", "y")
//
// Errors are returned per-row by the server; the UI renders them
// inline below the import button without aborting the rest of the
// batch.
let __xlsxPanelPromise: Promise<any> | null = null;
const loadXLSXForCustomerParts = () => {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  if ((window as any).XLSX) return Promise.resolve((window as any).XLSX);
  if (__xlsxPanelPromise) return __xlsxPanelPromise;
  // xlsx is a bundled dep loaded via dynamic import (CSP blocks CDN scripts).
  __xlsxPanelPromise = import("xlsx").then((m: any) => {
    const XLSX = (m && m.read) ? m : (m.default || m);
    try { (window as any).XLSX = XLSX; } catch (_) { /* noop */ }
    return XLSX;
  });
  return __xlsxPanelPromise;
};

const PARTS_TRUTHY = new Set(["1", "true", "yes", "y", "t"]);
const normalizePartsRow = (raw: Record<string, any>) => {
  const obj: Record<string, any> = {};
  for (const k of Object.keys(raw || {})) {
    const v = raw[k];
    const key = String(k || "").trim().toLowerCase().replace(/\s+/g, "_");
    obj[key] = typeof v === "string" ? v.trim() : v;
  }
  return {
    customer_id: obj.customer_id || null,
    customer_name: obj.customer_name || obj.customer || null,
    item_master_id: obj.item_master_id || obj.item_id || null,
    item_master_part_no: obj.item_master_part_no || obj.part_no || obj.tally_item_name || null,
    customer_part_number: obj.customer_part_number || obj.customer_part || obj.part_number || obj.code || null,
    customer_part_description: obj.customer_part_description || obj.description || null,
    customer_project: obj.customer_project || obj.project || null,
    valid_from: obj.valid_from || null,
    valid_to: obj.valid_to || null,
    is_primary: obj.is_primary == null ? false : PARTS_TRUTHY.has(String(obj.is_primary).toLowerCase()),
  };
};

// Parse a CSV string into an array of normalised row objects,
// using the first row as the header. Reuses parseCSV defined at
// the top of admin.tsx.
const csvToPartsRows = (text: string): Array<Record<string, any>> => {
  const grid = parseCSV(text);
  if (!grid.length) return [];
  const header = grid[0].map((h: any) => String(h).trim());
  return grid.slice(1).map((cells: any[]) => {
    const obj: Record<string, any> = {};
    for (let i = 0; i < header.length; i++) obj[header[i]] = cells[i] != null ? cells[i] : "";
    return normalizePartsRow(obj);
  }).filter((r: any) => r.customer_part_number);
};

const xlsxToPartsRows = async (file: File): Promise<Array<Record<string, any>>> => {
  const XLSX = await loadXLSXForCustomerParts();
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array", raw: false, cellDates: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const json: any[] = XLSX.utils.sheet_to_json(ws, { defval: "" });
  return json.map(normalizePartsRow).filter((r: any) => r.customer_part_number);
};

interface PartsImportResult {
  ok: number;
  errors: Array<{ row_index: number; reason: string }>;
  total: number;
}

const CustomerPartsPanel: React.FC = () => {
  const [customers, setCustomers] = useState<any[]>([]);
  const [items, setItems] = useState<any[]>([]);
  const [rows, setRows] = useState<any[]>([]);
  const [filterCustomerId, setFilterCustomerId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<any>(null);
  const [draft, setDraft] = useState<any>({ customer_id: "", item_master_id: "", customer_part_number: "", customer_part_description: "", is_primary: false });
  const [busy, setBusy] = useState(false);
  const [importResult, setImportResult] = useState<PartsImportResult | null>(null);

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      const [cs, im] = await Promise.all([
        adminCrudFetch("/api/customers"),
        adminCrudFetch("/api/admin/item_master?limit=2000"),
      ]);
      setCustomers((cs as any).customers || []);
      setItems((im as any).items || []);
      // Pull mappings filtered by current customer (or none, which
      // returns all up to the server's 1000 cap).
      const mp = await adminCrudFetch(filterCustomerId
        ? `/api/admin/item_customer_parts?customer_id=${encodeURIComponent(filterCustomerId)}`
        : "/api/admin/item_customer_parts");
      setRows((mp as any).mappings || []);
    } catch (e) { setError(e); } finally { setLoading(false); }
  };
  useEffect(() => { reload(); }, [filterCustomerId]);

  const save = async () => {
    if (!draft.customer_id || !draft.item_master_id || !draft.customer_part_number) {
      window.notifyWarn?.("All three fields required", "Pick a customer, pick a canonical item, and enter the customer's part number.");
      return;
    }
    try {
      await adminCrudFetch("/api/admin/item_customer_parts", {
        method: "POST",
        body: {
          item_id: draft.item_master_id,
          customer_id: draft.customer_id,
          customer_part_number: String(draft.customer_part_number).trim(),
          customer_part_description: draft.customer_part_description || null,
          is_primary: !!draft.is_primary,
        },
      });
      window.notifySuccess?.("Mapping saved", draft.customer_part_number);
      setDraft({ customer_id: draft.customer_id, item_master_id: "", customer_part_number: "", customer_part_description: "", is_primary: false });
      await reload();
    } catch (e: any) { window.notifyError?.("Could not save", e?.message || String(e)); }
  };

  const remove = async (m: any) => {
    if (!window.confirm(`Delete mapping ${m.customer_part_number}?`)) return;
    try {
      await adminCrudFetch(`/api/admin/item_customer_parts?item_id=${m.item_id}&customer_id=${m.customer_id}&customer_part_number=${encodeURIComponent(m.customer_part_number)}`, { method: "DELETE" });
      await reload();
    } catch (e: any) { window.notifyError?.("Could not delete", e?.message || String(e)); }
  };

  const onImport = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setImportResult(null);
    try {
      const isXlsx = /\.(xlsx|xls)$/i.test(file.name);
      const parsed = isXlsx ? await xlsxToPartsRows(file) : csvToPartsRows(await file.text());
      if (!parsed.length) {
        window.notifyWarn?.("No rows parsed", "The file had no rows with a customer_part_number. Check the header row.");
        return;
      }
      const resp = await adminCrudFetch("/api/admin/item_customer_parts", {
        method: "POST",
        body: { rows: parsed },
      });
      const out: PartsImportResult = {
        ok: (resp as any).ok || 0,
        errors: (resp as any).errors || [],
        total: parsed.length,
      };
      setImportResult(out);
      if (out.ok > 0) window.notifySuccess?.("Imported " + out.ok + " mapping" + (out.ok === 1 ? "" : "s"), out.errors.length ? out.errors.length + " row" + (out.errors.length === 1 ? "" : "s") + " skipped" : undefined);
      else window.notifyError?.("No rows imported", "All rows failed. See the result table below.");
      await reload();
    } catch (e: any) {
      window.notifyError?.("Import failed", e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Card><div className="body">Loading customer parts...</div></Card>;
  if (error) return <Banner kind="bad" icon={Icon.alert} title="Could not load" action={<Btn sm onClick={reload}>Retry</Btn>}><span className="mono-sm">{String((error as any)?.message || error)}</span></Banner>;

  const filteredRows = rows;

  return (
    <>
      <Card title="Add customer part" eyebrow="customer-specific code that maps to your canonical item">
        <div className="row" style={{ gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div>
            <label className="mono-sm">Customer</label>
            <select className="select" value={draft.customer_id} onChange={(e) => setDraft({ ...draft, customer_id: e.target.value })}>
              <option value="">Select...</option>
              {customers.map((c: any) => <option key={c.id} value={c.id}>{c.customer_name}</option>)}
            </select>
          </div>
          <div>
            <label className="mono-sm">Canonical item</label>
            <select className="select" value={draft.item_master_id} onChange={(e) => setDraft({ ...draft, item_master_id: e.target.value })}>
              <option value="">Select...</option>
              {items.slice(0, 500).map((it: any) => (
                <option key={it.id} value={it.id}>{it.part_no}{it.alias ? " (" + it.alias + ")" : ""}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mono-sm">Customer part #</label>
            <input className="input mono" value={draft.customer_part_number} onChange={(e) => setDraft({ ...draft, customer_part_number: e.target.value })} placeholder="e.g., GD544202603190008" />
          </div>
          <div style={{ flex: 1, minWidth: 220 }}>
            <label className="mono-sm">Description (optional)</label>
            <input className="input" value={draft.customer_part_description} onChange={(e) => setDraft({ ...draft, customer_part_description: e.target.value })} />
          </div>
          <label className="mono-sm row" style={{ gap: 6, alignItems: "center" }}>
            <input type="checkbox" checked={!!draft.is_primary} onChange={(e) => setDraft({ ...draft, is_primary: e.target.checked })} /> primary
          </label>
          <Btn sm kind="primary" onClick={save}>{Icon.plus} Add</Btn>
        </div>
      </Card>

      <Card title="Bulk import" eyebrow="CSV or XLSX with one mapping per row" right={
        <label className="btn btn-sm" style={{ cursor: busy ? "wait" : "pointer" }}>
          {busy ? "importing…" : <>{Icon.upload || "↑"} Upload CSV / XLSX</>}
          <input type="file" accept=".csv,text/csv,.xlsx,.xls" disabled={busy} style={{ display: "none" }}
                 onChange={(ev) => { const f = ev.target.files?.[0]; ev.target.value = ""; onImport(f); }} />
        </label>
      }>
        <div className="mono-sm" style={{ color: "var(--ink-3)", lineHeight: 1.5 }}>
          Required column: <span className="mono">customer_part_number</span>. Plus one of:{" "}
          <span className="mono">customer_id</span> or <span className="mono">customer_name</span>,
          and one of <span className="mono">item_master_id</span> or <span className="mono">item_master_part_no</span>.{" "}
          Optional: <span className="mono">customer_part_description</span>, <span className="mono">customer_project</span>,
          <span className="mono">valid_from</span>, <span className="mono">valid_to</span>, <span className="mono">is_primary</span>.
        </div>
        {importResult && (
          <div style={{ marginTop: 12 }}>
            <Banner
              kind={importResult.errors.length === 0 ? "good" : "warn"}
              title={`Imported ${importResult.ok} of ${importResult.total} row${importResult.total === 1 ? "" : "s"}`}
            >
              {importResult.errors.length > 0 && (
                <table className="tbl" style={{ marginTop: 8 }}>
                  <thead><tr><th>Row</th><th>Reason</th></tr></thead>
                  <tbody>
                    {importResult.errors.slice(0, 50).map((er, j) => (
                      <tr key={j}>
                        <td className="mono-sm">{er.row_index + 2}</td>
                        <td className="mono-sm">{er.reason}</td>
                      </tr>
                    ))}
                    {importResult.errors.length > 50 && (
                      <tr><td colSpan={2} className="mono-sm" style={{ color: "var(--ink-3)" }}>
                        ...and {importResult.errors.length - 50} more.
                      </td></tr>
                    )}
                  </tbody>
                </table>
              )}
            </Banner>
          </div>
        )}
      </Card>

      <Card title="Existing mappings" eyebrow={`${rows.length} row${rows.length === 1 ? "" : "s"}`} right={
        <select className="select" value={filterCustomerId} onChange={(e) => setFilterCustomerId(e.target.value)}>
          <option value="">All customers</option>
          {customers.map((c: any) => <option key={c.id} value={c.id}>{c.customer_name}</option>)}
        </select>
      }>
        {filteredRows.length === 0 ? (
          <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
            No mappings to show.
          </div>
        ) : (
          <table className="tbl">
            <thead><tr>
              <th>Customer</th>
              <th>Their part #</th>
              <th>Canonical item</th>
              <th>Source</th>
              <th>Confidence</th>
              <th>Confirmed</th>
              <th>Primary</th>
              <th></th>
            </tr></thead>
            <tbody>
              {filteredRows.map((m: any, i: number) => {
                const c = customers.find((cc: any) => cc.id === m.customer_id);
                const it = items.find((ii: any) => ii.id === m.item_id);
                const cv = m.created_via || "legacy";
                const tone: any = (cv === "manual" || cv === "bulk_import") ? "good"
                  : (cv === "quote_sent" || cv === "llm_suggest" || cv === "quote_accepted") ? "info"
                  : "ghost";
                return (
                  <tr key={i}>
                    <td>{c?.customer_name || m.customer_id.slice(0, 8)}</td>
                    <td className="mono"><span className="pri">{m.customer_part_number}</span></td>
                    <td className="mono-sm">{it?.part_no || m.item_id.slice(0, 8)}</td>
                    <td><Chip k={tone}>{cv.replace(/_/g, " ")}</Chip></td>
                    <td className="mono-sm">{m.confidence_pct != null ? Math.round(Number(m.confidence_pct)) + "%" : "—"}</td>
                    <td className="mono-sm">{m.confirmed_at ? new Date(m.confirmed_at).toISOString().slice(0, 10) : "—"}</td>
                    <td>{m.is_primary ? <Chip k="good">primary</Chip> : "—"}</td>
                    <td className="r"><Btn sm kind="ghost" onClick={() => remove(m)}>delete</Btn></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
};

// Customer terms pack editor (migration 106). Per-customer T&C
// library: MMIL's 15-clause boilerplate becomes a pack with 15
// clauses. Surfaces on the order PDF and on the operator review
// screen when an order is opened for that customer.
const CustomerTermsPanel: React.FC = () => {
  const [customers, setCustomers] = useState<any[]>([]);
  const [customerId, setCustomerId] = useState("");
  const [packs, setPacks] = useState<any[]>([]);
  const [clauses, setClauses] = useState<any[]>([]);
  const [packDraft, setPackDraft] = useState<any>({ pack_name: "", version: 1, is_active: true });
  const [clauseDraft, setClauseDraft] = useState<any>({ pack_id: "", clause_index: 1, heading: "", body: "", is_blocking: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<any>(null);

  useEffect(() => {
    (async () => {
      try {
        const cs = await adminCrudFetch("/api/customers");
        setCustomers(cs.customers || []);
      } catch (e) { setError(e); } finally { setLoading(false); }
    })();
  }, []);

  const reloadForCustomer = async (cid: string) => {
    if (!cid) return;
    try {
      const r = await adminCrudFetch(`/api/admin/customer_terms?customer_id=${cid}`);
      setPacks(r.packs || []);
      setClauses(r.clauses || []);
    } catch (e) { setError(e); }
  };

  useEffect(() => { if (customerId) reloadForCustomer(customerId); }, [customerId]);

  const savePack = async () => {
    if (!packDraft.pack_name.trim()) { window.notifyWarn?.("Pack name required", "Give the pack a label."); return; }
    try {
      await adminCrudFetch("/api/admin/customer_terms/pack", { method: "POST", body: { ...packDraft, customer_id: customerId } });
      window.notifySuccess?.("Pack saved", packDraft.pack_name);
      setPackDraft({ pack_name: "", version: 1, is_active: true });
      await reloadForCustomer(customerId);
    } catch (e: any) { window.notifyError?.("Could not save", e?.message || String(e)); }
  };

  const saveClause = async () => {
    if (!clauseDraft.pack_id || !clauseDraft.body.trim()) { window.notifyWarn?.("Pack and body required", "Pick a pack and enter the clause text."); return; }
    try {
      await adminCrudFetch("/api/admin/customer_terms/clause", { method: "POST", body: clauseDraft });
      window.notifySuccess?.("Clause saved", `#${clauseDraft.clause_index}`);
      setClauseDraft({ pack_id: clauseDraft.pack_id, clause_index: (clauseDraft.clause_index || 0) + 1, heading: "", body: "", is_blocking: false });
      await reloadForCustomer(customerId);
    } catch (e: any) { window.notifyError?.("Could not save", e?.message || String(e)); }
  };

  if (loading) return <Card><div className="body">Loading customers...</div></Card>;
  if (error) return <Banner kind="bad" icon={Icon.alert} title="Could not load"><span className="mono-sm">{String((error as any)?.message || error)}</span></Banner>;

  return (
    <>
      <Card title="Customer terms packs" eyebrow="MMIL-style T&C boilerplate, per customer">
        <div className="row" style={{ gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div>
            <label className="mono-sm">Customer</label>
            <select className="select" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
              <option value="">Select customer...</option>
              {customers.map((c: any) => <option key={c.id} value={c.id}>{c.customer_name}</option>)}
            </select>
          </div>
        </div>
      </Card>
      {customerId && (
        <>
          <Card title="Add pack" eyebrow="group clauses under a named version">
            <div className="row" style={{ gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
              <div><label className="mono-sm">Pack name</label><input className="input" value={packDraft.pack_name} onChange={(e) => setPackDraft({ ...packDraft, pack_name: e.target.value })} placeholder="e.g., MMIL Standard T&C" /></div>
              <div><label className="mono-sm">Version</label><input className="input mono r" type="number" value={packDraft.version} onChange={(e) => setPackDraft({ ...packDraft, version: Number(e.target.value) })} /></div>
              <Btn sm kind="primary" onClick={savePack}>Add pack</Btn>
            </div>
          </Card>
          {packs.length > 0 && (
            <Card flush>
              <table className="tbl">
                <thead><tr><th>Pack</th><th className="r">Version</th><th className="r">Active</th><th className="r">Clauses</th></tr></thead>
                <tbody>
                  {packs.map((p) => (
                    <tr key={p.id}>
                      <td><span className="pri">{p.pack_name}</span></td>
                      <td className="r mono">{p.version}</td>
                      <td className="r">{p.is_active ? "yes" : "-"}</td>
                      <td className="r">{clauses.filter((c) => c.pack_id === p.id).length}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
          {packs.length > 0 && (
            <Card title="Add clause" eyebrow="one row per numbered paragraph in the customer's T&C">
              <div className="row" style={{ gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
                <div><label className="mono-sm">Pack</label>
                  <select className="select" value={clauseDraft.pack_id} onChange={(e) => setClauseDraft({ ...clauseDraft, pack_id: e.target.value })}>
                    <option value="">Select...</option>
                    {packs.map((p) => <option key={p.id} value={p.id}>{p.pack_name} v{p.version}</option>)}
                  </select>
                </div>
                <div><label className="mono-sm">Clause #</label><input className="input mono r" type="number" value={clauseDraft.clause_index} onChange={(e) => setClauseDraft({ ...clauseDraft, clause_index: Number(e.target.value) })} /></div>
                <div style={{ flex: 1 }}><label className="mono-sm">Heading</label><input className="input" value={clauseDraft.heading} onChange={(e) => setClauseDraft({ ...clauseDraft, heading: e.target.value })} placeholder="e.g., GST input credit endorsement" /></div>
                <label className="mono-sm row" style={{ gap: 6, alignItems: "center" }}>
                  <input type="checkbox" checked={!!clauseDraft.is_blocking} onChange={(e) => setClauseDraft({ ...clauseDraft, is_blocking: e.target.checked })} /> blocking
                </label>
              </div>
              <div style={{ marginTop: 8 }}>
                <label className="mono-sm">Body</label>
                <textarea className="input" rows={3} style={{ width: "100%" }} value={clauseDraft.body} onChange={(e) => setClauseDraft({ ...clauseDraft, body: e.target.value })} />
              </div>
              <div className="row" style={{ justifyContent: "flex-end", marginTop: 8 }}>
                <Btn sm kind="primary" onClick={saveClause}>Add clause</Btn>
              </div>
            </Card>
          )}
          {clauses.length > 0 && (
            <Card flush>
              <table className="tbl">
                <thead><tr><th className="r">#</th><th>Heading</th><th>Body</th><th className="r">Blocking</th></tr></thead>
                <tbody>
                  {clauses.map((c) => (
                    <tr key={c.id}>
                      <td className="r mono">{c.clause_index}</td>
                      <td className="mono-sm"><span className="pri">{c.heading || "-"}</span></td>
                      <td style={{ maxWidth: 480, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.body}</td>
                      <td className="r">{c.is_blocking ? <Chip k="warn">blocking</Chip> : "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </>
      )}
    </>
  );
};

const DocAICostPanel: React.FC = () => {
  const [data, setData] = useState<CostStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<{
    docai_provider_order: string[];
    docai_daily_limits: Record<string, number | "">;
    docai_anthropic_model: string;
    docai_gemini_model: string;
    // Bet 1: confidence-fallback slider, Mistral OCR batch flag,
    // Gemini media_resolution picker.
    docai_fallback_confidence: number;
    docai_mistral_ocr_batch: boolean;
    docai_gemini_media_resolution: string;
  }>({
    docai_provider_order: [],
    docai_daily_limits: {},
    docai_anthropic_model: "",
    docai_gemini_model: "",
    docai_fallback_confidence: 0.85,
    docai_mistral_ocr_batch: true,
    docai_gemini_media_resolution: "high",
  });
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [chartMetric, setChartMetric] = useState<"calls" | "cost">("calls");

  const reload = React.useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const next = await (AnvilBackend as any)?.docai?.costStatus?.();
      setData(next);
      // Seed the editable form with the current values.
      // Bet 1: drop the legacy claude-sonnet-4-20250514 default
      // through to "" so the placeholder hint surfaces; same for
      // claude-haiku-4-5-20251001 (deprecated as a docai default).
      const legacyAnthropic = (m: string) =>
        /sonnet-4-20250514/.test(m) || /haiku-4-5-20251001/.test(m);
      // Bet 1: drop legacy gemini-2.5-flash through to "" so the
      // placeholder surfaces.
      const legacyGemini = (m: string) => /^gemini-2\.5/.test(m);
      setForm({
        docai_provider_order: Array.isArray(next?.provider_order) && !next?.provider_order_default
          ? next.provider_order
          : (next?.provider_order || []),
        docai_daily_limits: Object.fromEntries(
          Object.entries(next?.daily_limits || {}).map(([k, v]) => [k, Number(v)])
        ),
        docai_anthropic_model: next?.anthropic_model && !legacyAnthropic(next.anthropic_model)
          ? next.anthropic_model
          : "",
        docai_gemini_model: next?.gemini_model && !legacyGemini(next.gemini_model)
          ? next.gemini_model
          : "",
        docai_fallback_confidence: typeof next?.fallback_confidence === "number"
          ? next.fallback_confidence
          : 0.85,
        docai_mistral_ocr_batch: next?.mistral_ocr_batch !== false,
        docai_gemini_media_resolution: next?.gemini_media_resolution || "high",
      });
    } catch (e) {
      setError(e);
    } finally { setLoading(false); }
  }, []);

  React.useEffect(() => { reload(); }, [reload]);

  const submit = async () => {
    setSaving(true); setSaveErr(null);
    try {
      const patch: Record<string, any> = {};
      patch.docai_provider_order = form.docai_provider_order;
      // Convert "" / 0 / negative to absent; only forward positive ints.
      const limits: Record<string, number> = {};
      for (const [k, v] of Object.entries(form.docai_daily_limits)) {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) limits[k] = Math.floor(n);
      }
      patch.docai_daily_limits = Object.keys(limits).length ? limits : null;
      if (form.docai_anthropic_model) patch.docai_anthropic_model = form.docai_anthropic_model;
      else patch.docai_anthropic_model = null;
      if (form.docai_gemini_model) patch.docai_gemini_model = form.docai_gemini_model;
      else patch.docai_gemini_model = null;
      // Bet 1 fields. Send through unconditionally; backend
      // tolerates the same values being re-sent.
      const fc = Number(form.docai_fallback_confidence);
      if (Number.isFinite(fc) && fc >= 0.5 && fc <= 0.99) {
        patch.docai_fallback_confidence = Math.round(fc * 100) / 100;
      }
      patch.docai_mistral_ocr_batch = !!form.docai_mistral_ocr_batch;
      if (["low", "medium", "high", "ultra_high"].includes(form.docai_gemini_media_resolution)) {
        patch.docai_gemini_media_resolution = form.docai_gemini_media_resolution;
      }
      await (AnvilBackend as any)?.docai?.updateSettings?.(patch);
      setEditing(false);
      await reload();
    } catch (e: any) {
      setSaveErr(String(e?.message || e));
    } finally { setSaving(false); }
  };

  if (loading) return <Card><div className="body">Loading docai cost status…</div></Card>;
  if (error) return (
    <Banner kind="bad" icon={Icon.alert} title="DocAI cost status unreachable" action={<Btn sm onClick={reload}>Retry</Btn>}>
      <span className="mono-sm">{String((error as any)?.message || error)}</span>
    </Banner>
  );
  if (!data) return <Card><div className="body">No data.</div></Card>;

  const sevTone = (s: string): "good" | "warn" | "bad" | "info" =>
    s === "bad" ? "bad" : s === "warn" ? "warn" : "info";

  const moveOrder = (idx: number, dir: -1 | 1) => {
    const next = [...form.docai_provider_order];
    const j = idx + dir;
    if (j < 0 || j >= next.length) return;
    [next[idx], next[j]] = [next[j], next[idx]];
    setForm({ ...form, docai_provider_order: next });
  };
  const toggleAdapter = (name: string) => {
    const cur = form.docai_provider_order;
    if (cur.includes(name)) {
      setForm({ ...form, docai_provider_order: cur.filter((a) => a !== name) });
    } else {
      setForm({ ...form, docai_provider_order: [...cur, name] });
    }
  };

  return (
    <>
      {/* Top-line cost summary */}
      <Card title="Today's docai usage" eyebrow={"date " + data.date}>
        <KV rows={[
          ["Total calls",        String(data.summary.calls_today)],
          ["Estimated cost",     "$" + data.summary.cost_today_usd.toFixed(4)],
          ["Free-friendly calls", String(data.summary.free_friendly_calls_today)],
          ["Paid calls",         String(data.summary.paid_calls_today)],
          ["Warnings",           String(data.summary.warnings)],
        ]} />
      </Card>

      {/* Recommendations */}
      {data.recommendations.length > 0 && (
        <Card title="Recommendations" eyebrow={"actionable cost-saving steps (" + data.recommendations.length + ")"}>
          <div style={{ display: "grid", gap: 10 }}>
            {data.recommendations.map((r) => (
              <Banner key={r.id} kind={sevTone(r.severity)} icon={Icon.info} title={r.title}>
                <span className="mono-sm">{r.body}</span>
              </Banner>
            ))}
          </div>
        </Card>
      )}

      {/* Today's per-adapter table */}
      <Card flush>
        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--hairline-2)" }}>
          <span className="h2">Per-adapter usage today</span>
        </div>
        {data.today_usage.length === 0 ? (
          <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
            No extractions today.
          </div>
        ) : (
          <table className="tbl">
            <thead><tr>
              <th>Adapter</th>
              <th className="r">Calls</th>
              <th className="r">Cap</th>
              <th className="r">Remaining</th>
              <th className="r">$ today</th>
              <th>Last called</th>
            </tr></thead>
            <tbody>
              {data.today_usage.map((row) => {
                const cap = data.daily_limits?.[row.adapter];
                const remaining = (cap != null) ? Math.max(0, cap - row.call_count) : null;
                return (
                  <tr key={row.adapter}>
                    <td className="mono">{row.adapter}</td>
                    <td className="r mono">{row.call_count}</td>
                    <td className="r mono">{cap != null ? cap : "—"}</td>
                    <td className="r mono">{remaining != null ? remaining : "—"}</td>
                    <td className="r mono">${Number(row.estimated_cost_usd || 0).toFixed(4)}</td>
                    <td className="mono-sm">
                      {row.last_called_at
                        ? new Date(row.last_called_at).toLocaleString("en-IN", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" })
                        : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      {/* Adapter health */}
      <Card title="Adapter health" eyebrow="env vars + per-tenant keys">
        <table className="tbl">
          <thead><tr><th>Adapter</th><th>Env</th><th>Tenant key</th></tr></thead>
          <tbody>
            {DOCAI_ADAPTERS_LIST.map((a) => (
              <tr key={a}>
                <td className="mono">{a}</td>
                <td><Chip k={data.adapter_health[a] ? "good" : "bad"}>{data.adapter_health[a] ? "yes" : "no"}</Chip></td>
                <td><Chip k={data.tenant_has_key[a] ? "good" : "bad"}>{data.tenant_has_key[a] ? "yes" : "no"}</Chip></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {/* Configuration editor */}
      <Card
        title="Cost levers"
        eyebrow="adapter chain · daily limits · model selectors"
        right={
          <>
            {!editing && <Btn sm onClick={() => setEditing(true)}>Edit</Btn>}
            {editing && (
              <>
                <Btn sm kind="ghost" onClick={() => { setEditing(false); reload(); }}>Cancel</Btn>
                <Btn sm kind="primary" disabled={saving} onClick={submit}>{saving ? "Saving…" : "Save"}</Btn>
              </>
            )}
          </>
        }
      >
        {!editing && (
          <KV rows={[
            ["Provider order",   data.provider_order.join(" -> ") + (data.provider_order_default ? " (default)" : "")],
            ["Daily limits",     data.daily_limits
              ? Object.entries(data.daily_limits).map(([k, v]) => k + ":" + v).join(", ")
              : "(none — uncapped)"],
            ["Anthropic model",  data.anthropic_model],
          ]} />
        )}
        {editing && (
          <div style={{ display: "grid", gap: 14 }}>
            <div>
              <div className="lbl" style={{ marginBottom: 6 }}>Provider order (drag-equivalent: move up/down or toggle)</div>
              <div style={{ display: "grid", gap: 6 }}>
                {form.docai_provider_order.map((a, i) => (
                  <div key={a} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <span className="mono-sm" style={{ width: 24, color: "var(--ink-3)" }}>{i + 1}</span>
                    <span className="mono" style={{ flex: 1 }}>{a}</span>
                    <Btn sm kind="ghost" disabled={i === 0} onClick={() => moveOrder(i, -1)}>Up</Btn>
                    <Btn sm kind="ghost" disabled={i === form.docai_provider_order.length - 1} onClick={() => moveOrder(i, 1)}>Down</Btn>
                    <Btn sm kind="ghost" onClick={() => toggleAdapter(a)}>Remove</Btn>
                  </div>
                ))}
                <div className="mono-sm" style={{ color: "var(--ink-3)", marginTop: 4 }}>Add:</div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {DOCAI_ADAPTERS_LIST.filter((a) => !form.docai_provider_order.includes(a)).map((a) => (
                    <Btn key={a} sm kind="ghost" onClick={() => toggleAdapter(a)}>+ {a}</Btn>
                  ))}
                </div>
              </div>
            </div>

            <div>
              <div className="lbl" style={{ marginBottom: 6 }}>Daily caps per adapter (blank or 0 = uncapped)</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 120px", columnGap: 10, rowGap: 6, alignItems: "center" }}>
                {DOCAI_ADAPTERS_LIST.map((a) => (
                  <React.Fragment key={a}>
                    <span className="mono">{a}</span>
                    <input
                      type="number"
                      min={0}
                      step={1}
                      value={form.docai_daily_limits[a] ?? ""}
                      onChange={(ev) => setForm({
                        ...form,
                        docai_daily_limits: {
                          ...form.docai_daily_limits,
                          [a]: ev.target.value === "" ? "" : Number(ev.target.value),
                        },
                      })}
                    />
                  </React.Fragment>
                ))}
              </div>
            </div>

            <label className="lbl">Anthropic model (blank = ANTHROPIC_MODEL_DEFAULT env or Sonnet 4.6)
              <input
                type="text"
                value={form.docai_anthropic_model}
                placeholder="claude-sonnet-4-6"
                onChange={(ev) => setForm({ ...form, docai_anthropic_model: ev.target.value })}
              />
            </label>

            <label className="lbl">Gemini model (blank = GEMINI_MODEL_DEFAULT env or gemini-3-flash-preview)
              <input
                type="text"
                value={form.docai_gemini_model}
                placeholder="gemini-3-flash-preview"
                onChange={(ev) => setForm({ ...form, docai_gemini_model: ev.target.value })}
              />
            </label>

            {/* Bet 1 (May 2026): Sonnet fallback threshold +
                Mistral OCR batch flag + Gemini media_resolution. */}
            <label className="lbl">Confidence fallback threshold ({Number(form.docai_fallback_confidence).toFixed(2)})
              <input
                type="range"
                min={0.5}
                max={0.99}
                step={0.01}
                value={form.docai_fallback_confidence}
                onChange={(ev) => setForm({ ...form, docai_fallback_confidence: Number(ev.target.value) })}
              />
              <div className="mono-sm" style={{ color: "var(--ink-3)", fontSize: 11 }}>
                Below this confidence, Gemini 3 Flash extractions fall through to Sonnet 4.6 for a second pass. Default 0.85.
              </div>
            </label>

            <label className="lbl">Mistral OCR endpoint
              <select
                value={form.docai_mistral_ocr_batch ? "batch" : "realtime"}
                onChange={(ev) => setForm({ ...form, docai_mistral_ocr_batch: ev.target.value === "batch" })}
              >
                <option value="batch">Batch (50% cheaper, slight latency)</option>
                <option value="realtime">Realtime (lower latency, full price)</option>
              </select>
            </label>

            <label className="lbl">Gemini media resolution
              <select
                value={form.docai_gemini_media_resolution}
                onChange={(ev) => setForm({ ...form, docai_gemini_media_resolution: ev.target.value })}
              >
                <option value="low">Low (~280 tokens/image; cheapest, fine-text legibility lost)</option>
                <option value="medium">Medium (~560 tokens/image)</option>
                <option value="high">High (~1120 tokens/image; default, dense PO PDFs)</option>
                <option value="ultra_high">Ultra-high (most tokens; only when high fails)</option>
              </select>
            </label>

            {saveErr && (
              <Banner kind="bad" icon={Icon.alert} title="Could not save">
                <span className="mono-sm">{saveErr}</span>
              </Banner>
            )}
          </div>
        )}
      </Card>

      {/* Per-day per-adapter trend chart. Draws an inline-SVG
          stacked-area chart over the configurable window. Three
          metrics: calls, cost, plus a CSV export. Cap line is
          the max per-adapter daily limit so the operator can
          see how today is tracking against budget. */}
      {data.trend_series && data.trend_series.dates.length > 0 && (
        <Card
          title={"Usage trend"}
          eyebrow={(data.window_days || 7) + "-day per-adapter stacked"}
          right={
            <>
              <Btn sm kind={chartMetric === "calls" ? "primary" : "ghost"} onClick={() => setChartMetric("calls")}>Calls</Btn>
              <Btn sm kind={chartMetric === "cost" ? "primary" : "ghost"} onClick={() => setChartMetric("cost")}>Cost</Btn>
              <Btn sm kind="ghost" onClick={() => {
                if (!data.trend_series) return;
                downloadCsv(
                  "docai-usage-" + chartMetric + "-" + data.date + ".csv",
                  buildTrendCsv(data.trend_series, chartMetric),
                );
              }}>CSV</Btn>
            </>
          }
        >
          <CostTrendChart
            series={data.trend_series}
            metric={chartMetric}
            capLine={chartMetric === "calls" && data.daily_limits
              ? Math.max(0, ...Object.values(data.daily_limits).map(Number).filter(Number.isFinite))
              : null}
          />
        </Card>
      )}

      {/* Per-adapter burn + forecast. Tells the operator at a
          glance which adapter is on track to hit its cap today. */}
      {(data.burn || data.forecast) && (
        <Card title="Burn + forecast" eyebrow="today vs window-median, cap projection">
          <table className="tbl">
            <thead><tr>
              <th>Adapter</th>
              <th className="r">Today calls</th>
              <th className="r">Window median</th>
              <th className="r">Ratio</th>
              <th className="r">Cap</th>
              <th className="r">Remaining</th>
              <th className="r">Hours to cap</th>
              <th>At risk today</th>
            </tr></thead>
            <tbody>
              {Object.keys({ ...(data.burn || {}), ...(data.forecast || {}) }).sort().map((adapter) => {
                const b = data.burn?.[adapter];
                const f = data.forecast?.[adapter];
                return (
                  <tr key={adapter}>
                    <td className="mono">{adapter}</td>
                    <td className="r mono">{b?.today_calls ?? "—"}</td>
                    <td className="r mono">{b?.median_n_calls ?? "—"}</td>
                    <td className="r mono">{b?.ratio == null ? "—" : (b.ratio.toFixed(2) + "x")}</td>
                    <td className="r mono">{f?.cap ?? "—"}</td>
                    <td className="r mono">{f?.remaining ?? "—"}</td>
                    <td className="r mono">{f?.hours_to_cap == null ? "—" : f.hours_to_cap.toFixed(1)}</td>
                    <td>
                      <Chip k={f?.will_hit_cap_today ? "bad" : "good"}>
                        {f?.will_hit_cap_today ? "yes" : "no"}
                      </Chip>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}

      {/* Anomaly highlights: any day in the window where calls
          spiked >= 2x that adapter's window median. */}
      {data.anomalies && data.anomalies.length > 0 && (
        <Card title="Anomalies" eyebrow={data.anomalies.length + " day(s) >=2x median"}>
          <table className="tbl">
            <thead><tr>
              <th>Date</th>
              <th>Adapter</th>
              <th className="r">Calls</th>
              <th className="r">Median</th>
              <th className="r">Multiplier</th>
            </tr></thead>
            <tbody>
              {data.anomalies.map((a, i) => (
                <tr key={a.date + a.adapter + i}>
                  <td className="mono-sm">{a.date}</td>
                  <td className="mono-sm">{a.adapter}</td>
                  <td className="r mono">{a.calls}</td>
                  <td className="r mono">{a.median}</td>
                  <td className="r mono">{a.multiplier.toFixed(2)}x</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {/* 7-day rollup totals (kept for back-compat + at-a-glance) */}
      <Card title={(data.window_days || 7) + "-day rollup"} eyebrow="cumulative across all adapters">
        <KV rows={[
          ["Calls", String(data.trend_window?.calls ?? data.trend_7d.calls)],
          ["Estimated cost", "$" + Number(data.trend_window?.cost ?? data.trend_7d.cost).toFixed(4)],
        ]} />
      </Card>
    </>
  );
};
