import React, { useEffect, useState } from "react";
import { ageLabel, fmtINRShort, useFetch } from "../lib/helpers";
import { Banner, Btn, Card, Chip, KV, WSTabs, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { ObaraBackend } from "../lib/api";
import { RBAC, MATRIX, ACTIONS } from "../lib/rbac";
import { Prefs } from "../lib/preferences";

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
// All admin-only. Backend methods on ObaraBackend.admin (already
// in src/client/obara-client.js):
//   listHolidays/upsertHoliday/deleteHoliday
//   listLeadTimes/upsertLeadTime/deleteLeadTime
//   listApprovalThresholds/upsertApprovalThreshold/deleteApprovalThreshold
//   listCustomerLocations/upsertCustomerLocation/deleteCustomerLocation
//   listContracts/upsertContract/deleteContract
//   listItemMaster/upsertItemMaster/bulkItemMaster/deleteItemMaster
//   diagnostics()
// ============================================================

const ADMIN_CRUD_TABS = [
  { id: "members",   label: "Members" },
  { id: "profile",   label: "My profile" },
  { id: "roles",     label: "Roles & permissions" },
  { id: "settings",  label: "Settings" },
  { id: "holidays",  label: "Holidays" },
  { id: "leadtimes", label: "Lead times" },
  { id: "fx",        label: "FX rates" },
  { id: "thresh",    label: "Approval thresholds" },
  { id: "locations", label: "Customer locations" },
  { id: "contracts", label: "Contracts" },
  { id: "items",     label: "Item master" },
  { id: "diag",      label: "Diagnostics" },
];

const ADMIN_ROLES = ["sales_engineer", "sales_manager", "procurement", "finance", "admin", "operator", "viewer"];
const ADMIN_DRAWING_BASE_KEY = "obara:drawing_base_url";
const CONTRACT_TYPES = ["ARC", "BLANKET", "AMC", "PROJECT"];

const adminCrudFetch = async (path: string, opts: { method?: string; body?: any; headers?: Record<string, string> } = {}) => {
  const cfg = (() => { try { return JSON.parse(localStorage.getItem("obara:backend_config") || "{}"); } catch (_) { return {}; } })();
  const session = (() => { try { return JSON.parse(localStorage.getItem("obara:backend_session") || "null"); } catch (_) { return null; } })();
  const headers: Record<string, string> = { "Content-Type": "application/json", ...((opts.headers as Record<string, string>) || {}) };
  if (session?.access_token) headers.Authorization = "Bearer " + session.access_token;
  if (cfg.tenantId) headers["x-obara-tenant"] = cfg.tenantId;
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
    const session = JSON.parse(localStorage.getItem("obara:backend_session") || "null");
    if (session?.user?.id) return String(session.user.id);
  } catch (_) { /* ignore */ }
  return null;
};

const WiredAdminCRUD = () => {
  const { useState: u, useEffect: e } = React;
  const isAdmin = !!(RBAC && RBAC.isAdmin && RBAC.isAdmin());
  const currentUserId = readCurrentUserId();

  const [active, setActive] = u("members");
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
  const [holidayForm, setHolidayForm] = u({ country: "IN", date: "", name: "" });
  const [leadTimeForm, setLeadTimeForm] = u({ type: "supplier", entity_id: "", days: "", notes: "" });
  const [threshForm, setThreshForm] = u(null);
  const [locForm, setLocForm] = u(null);
  const [contractForm, setContractForm] = u(null);
  const [itemForm, setItemForm] = u(null);
  const [csvBusy, setCsvBusy] = u(false);
  const [drawingBase, setDrawingBase] = u(() => { try { return localStorage.getItem(ADMIN_DRAWING_BASE_KEY) || ""; } catch (_) { return ""; } });
  const [drawingDraft, setDrawingDraft] = u(() => { try { return localStorage.getItem(ADMIN_DRAWING_BASE_KEY) || ""; } catch (_) { return ""; } });

  const flashOk = (msg) => setFlash({ kind: "good", msg });
  const flashErr = (err) => setFlash({ kind: "bad", msg: String(err.message || err) });

  // Data fetchers
  const members = useFetch(
    () => fetch("/api/admin/members").then((r) => r.ok ? r.json() : { members: [] }).catch(() => ({ members: [] })),
    []
  );
  const holidays = useFetch(
    () => ObaraBackend?.admin?.listHolidays?.()
          || fetch("/api/admin/holidays").then((r) => r.ok ? r.json() : { holidays: [] }).catch(() => ({ holidays: [] })),
    []
  );
  const leadTimes = useFetch(
    () => ObaraBackend?.admin?.listLeadTimes?.(leadTimeForm.type)
          || fetch("/api/admin/lead_times?type=" + encodeURIComponent(leadTimeForm.type))
              .then((r) => r.ok ? r.json() : { lead_times: [] }).catch(() => ({ lead_times: [] })),
    [leadTimeForm.type]
  );
  const fxRates = useFetch(
    () => ObaraBackend?.fx?.lookup?.({ pairs: ["USD/INR", "JPY/INR", "CNY/INR"] }) || Promise.resolve({ rates: [] }),
    []
  );
  const thresholds = useFetch(
    () => ObaraBackend?.admin?.listApprovalThresholds?.()
          || adminCrudFetch("/api/admin/quote_approvals?type=thresholds"),
    []
  );
  const customers = useFetch(
    () => ObaraBackend?.customers?.list?.() || adminCrudFetch("/api/customers"),
    []
  );
  const locations = useFetch(
    () => ObaraBackend?.admin?.listCustomerLocations?.() || adminCrudFetch("/api/admin/customer_locations"),
    []
  );
  const contracts = useFetch(
    () => ObaraBackend?.admin?.listContracts?.() || adminCrudFetch("/api/admin/contracts"),
    []
  );
  const itemMaster = useFetch(
    () => ObaraBackend?.admin?.listItemMaster?.({ limit: 500 })
          || adminCrudFetch("/api/admin/item_master?limit=500"),
    []
  );
  const diagnostics = useFetch(
    () => ObaraBackend?.admin?.diagnostics?.()
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

  const tenantSlug = (ObaraBackend && ObaraBackend.getConfig
    && ObaraBackend.getConfig().tenantId)
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
      await (ObaraBackend?.admin?.upsertHoliday?.(holidayForm)
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
      await (ObaraBackend?.admin?.deleteHoliday?.(id)
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
      await (ObaraBackend?.admin?.upsertLeadTime?.(leadTimeForm.type, payload)
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
      await (ObaraBackend?.admin?.deleteLeadTime?.(leadTimeForm.type, id)
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
      await ObaraBackend?.fx?.refresh?.();
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
      await (ObaraBackend?.admin?.upsertApprovalThreshold?.(threshForm)
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
      await (ObaraBackend?.admin?.deleteApprovalThreshold?.(id)
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
      await (ObaraBackend?.admin?.upsertCustomerLocation?.(locForm)
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
      await (ObaraBackend?.admin?.deleteCustomerLocation?.(id)
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
      await (ObaraBackend?.admin?.upsertContract?.(contractForm)
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
      await (ObaraBackend?.admin?.deleteContract?.(id)
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
      await (ObaraBackend?.admin?.upsertItemMaster?.(itemForm)
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
      await (ObaraBackend?.admin?.deleteItemMaster?.(id)
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
      await (ObaraBackend?.admin?.bulkItemMaster?.(items)
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
      <WSTabs tabs={ADMIN_CRUD_TABS} active={active} onChange={setActive} />

      <div className="ws-content">
        {flash && (
          <Banner kind={flash.kind} icon={flash.kind === "bad" ? Icon.alert : Icon.check}
                  title={flash.kind === "bad" ? "Action failed" : "Action complete"}
                  action={<Btn sm onClick={() => setFlash(null)}>Dismiss</Btn>}>
            <span className="mono-sm">{flash.msg}</span>
          </Banner>
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
                          <td className="mono-sm">{(m.joined_at || m.created_at) ? new Date(m.joined_at || m.created_at).toLocaleDateString("en-IN") : "—"}</td>
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

        {active === "settings" && (
          <>
            <Card title="Tenant settings" eyebrow="read-only · edit via API">
              <KV rows={[
                ["Display name", tenantSlug],
                ["Slug", String(tenantSlug).toLowerCase()],
                ["Backend", ObaraBackend?.isReady?.() ? "connected" : "not configured"],
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
          </>
        )}

        {active === "holidays" && (
          <>
            {holidays.error && (
              <Banner kind="bad" icon={Icon.alert} title="Failed to load holidays" action={<Btn sm onClick={holidays.reload}>Retry</Btn>}>
                <span className="mono-sm">{String(holidays.error.message || holidays.error)}</span>
              </Banner>
            )}
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
                  <thead><tr><th>{leadTimeForm.type === "supplier" ? "Supplier" : "Customer"}</th><th className="r">Days</th><th>Notes</th><th></th></tr></thead>
                  <tbody>
                    {leadTimeRows.map((r, i) => (
                      <tr key={r.id || i}>
                        <td>{r.customer_name || r.supplier_name || r.name || r.entity_name || customerName(r.customer_id) || "—"}</td>
                        <td className="r mono">{r.days != null ? r.days : (r.lead_time_days != null ? r.lead_time_days : "—")}</td>
                        <td className="mono-sm">{r.notes || r.description || "—"}</td>
                        <td>
                          {r.id && (
                            <Btn sm kind="ghost" disabled={busy} onClick={() => onDeleteLeadTime(r.id)}>{Icon.trash}</Btn>
                          )}
                        </td>
                      </tr>
                    ))}
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
                ["Backend ready", String(!!ObaraBackend?.isReady?.())],
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
