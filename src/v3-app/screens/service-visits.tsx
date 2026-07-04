import React, { useEffect, useMemo, useState } from "react";
import { Banner, Btn, Card, Chip, WSTabs, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { AnvilBackend } from "../lib/api";

// ============================================================
// ANVIL v3 — Service Visits CRUD overlay
// Adds plan-visit form + check-in / check-out / report submit /
// delete actions on top of the read-only list in
// wired-service-visits-c.jsx. Wins via load-order.
//
// Backend: AnvilBackend.service.{listVisits, createVisit,
// updateVisit, deleteVisit} (api/service/visits).
// Status state machine (from backend):
//   PLANNED -> CHECKED_IN -> CHECKED_OUT -> REPORT_SUBMITTED -> CLOSED
// ============================================================

const SVC_STATUSES = ["PLANNED", "CHECKED_IN", "CHECKED_OUT", "REPORT_SUBMITTED", "CLOSED"];

const SVC_FORM_BLANK = () => ({
  customer_id: "",
  customer_location_id: "",
  visit_date: new Date().toISOString().slice(0, 10),
  line_or_station: "",
  purpose: "",
  observation: "",
  possible_cause: "",
  action_taken: "",
  followup_action: "",
  notes: "",
  status: "PLANNED",
});

const svReadParams = () => {
  const hash = window.location.hash || "";
  const q = hash.split("?")[1];
  return new URLSearchParams(q || "");
};

const svFetch = async (path: string, opts: { method?: string; body?: any; headers?: Record<string, string> } = {}) => {
  const cfg = (AnvilBackend?.getConfig?.() || {});
  const session = (AnvilBackend?.getSession?.() || null);
  const headers: Record<string, string> = { "Content-Type": "application/json", ...((opts.headers as Record<string, string>) || {}) };
  if (session?.access_token) headers.Authorization = "Bearer " + session.access_token;
  if (cfg.tenantId) headers["x-obara-tenant"] = cfg.tenantId;
  const url = (cfg.url || "").replace(/\/+$/, "") + path;
  const resp = await fetch(url, { ...opts, headers });
  if (!resp.ok) throw new Error("HTTP " + resp.status + ": " + (await resp.text()));
  return resp.json();
};

// Friendly name for a status
const svStatusChip = (s) => {
  if (s === "CLOSED" || s === "REPORT_SUBMITTED") return { k: "good", label: s.toLowerCase().replace(/_/g, " ") };
  if (s === "CHECKED_IN" || s === "CHECKED_OUT") return { k: "live", label: s.toLowerCase().replace(/_/g, " ") };
  return { k: "info", label: (s || "PLANNED").toLowerCase().replace(/_/g, " ") };
};

// Compact relative date label (today / N days)
const svDateLabel = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const target = new Date(d); target.setHours(0, 0, 0, 0);
  const days = Math.round((target.getTime() - today.getTime()) / 86400000);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  if (days > 0 && days <= 7) return `in ${days}d`;
  if (days < 0 && days >= -7) return `${-days}d ago`;
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
};

const WiredServiceVisitsCRUD = () => {
  const { useState: u, useEffect: e, useMemo: m } = React;
  const params = svReadParams();
  const editId = params.get("id");
  const isNew = params.get("new") === "1";

  const [list, setList] = u({ rows: [], loading: true, error: null });
  const [customers, setCustomers] = u([]);
  const [locations, setLocations] = u([]);
  const [active, setActive] = u("scheduled");
  const [editing, setEditing] = u(null);
  const [form, setForm] = u(null);
  const [busy, setBusy] = u(false);

  const reload = () => {
    setList((s) => ({ ...s, loading: true }));
    Promise.resolve(AnvilBackend?.service?.listVisits?.() || svFetch("/api/service/visits"))
      .then((r) => {
        const rows = Array.isArray(r) ? r : (r?.visits || r?.rows || []);
        setList({ rows, loading: false, error: null });
      })
      .catch((err) => setList({ rows: [], loading: false, error: err }));
  };

  e(reload, []);
  e(() => {
    Promise.resolve(AnvilBackend?.customers?.list?.() || [])
      .then((r) => setCustomers(Array.isArray(r) ? r : (r?.rows || [])));
  }, []);
  e(() => {
    if (!form?.customer_id) { setLocations([]); return; }
    Promise.resolve(AnvilBackend?.admin?.listCustomerLocations?.(form.customer_id) || [])
      .then((r) => {
        const list = Array.isArray(r) ? r : (r?.locations || r?.rows || []);
        setLocations(list);
      });
  }, [form?.customer_id]);

  e(() => {
    if (isNew) {
      setForm(SVC_FORM_BLANK());
      setEditing("__new__");
      return;
    }
    if (editId) {
      const found = list.rows.find((r) => r.id === editId);
      if (found) {
        setForm({ ...SVC_FORM_BLANK(), ...found });
        setEditing(editId);
      }
      return;
    }
    setForm(null);
    setEditing(null);
  }, [editId, isNew, list.rows.length]);

  const closeForm = () => {
    setForm(null);
    setEditing(null);
    window.location.hash = "#/svc-visits";
  };

  const submit = async () => {
    if (!form) return;
    if (!form.visit_date) {
      window.notifyError?.("Visit date is required");
      return;
    }
    if (!form.customer_id) {
      window.notifyError?.("Customer is required");
      return;
    }
    setBusy(true);
    try {
      const fn = (editing && editing !== "__new__")
        ? AnvilBackend?.service?.updateVisit
        : AnvilBackend?.service?.createVisit;
      const payload = { ...form };
      if (editing && editing !== "__new__") payload.id = editing;
      let result;
      if (typeof fn === "function") {
        result = await fn(payload);
      } else {
        result = await svFetch("/api/service/visits", {
          method: editing && editing !== "__new__" ? "PATCH" : "POST",
          body: JSON.stringify(payload),
        });
      }
      window.notifySuccess?.(
        editing === "__new__" ? "Visit planned" : "Visit updated",
        result?.visit?.purpose || form.purpose || form.line_or_station || "saved",
      );
      reload();
      closeForm();
    } catch (err) {
      window.notifyError?.("Save failed", err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const checkIn = async (id) => {
    setBusy(true);
    try {
      const fn = AnvilBackend?.service?.updateVisit;
      if (typeof fn === "function") await fn({ id, checkin: true });
      else await svFetch("/api/service/visits", { method: "PATCH", body: JSON.stringify({ id, checkin: true }) });
      window.notifySuccess?.("Checked in");
      reload();
    } catch (err) {
      window.notifyError?.("Check-in failed", err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const checkOut = async (id) => {
    setBusy(true);
    try {
      const fn = AnvilBackend?.service?.updateVisit;
      if (typeof fn === "function") await fn({ id, checkout: true });
      else await svFetch("/api/service/visits", { method: "PATCH", body: JSON.stringify({ id, checkout: true }) });
      window.notifySuccess?.("Checked out");
      reload();
    } catch (err) {
      window.notifyError?.("Check-out failed", err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const submitReport = async (id) => {
    setBusy(true);
    try {
      const fn = AnvilBackend?.service?.updateVisit;
      const payload = { id, status: "REPORT_SUBMITTED" };
      if (typeof fn === "function") await fn(payload);
      else await svFetch("/api/service/visits", { method: "PATCH", body: JSON.stringify(payload) });
      window.notifySuccess?.("Report submitted");
      reload();
    } catch (err) {
      window.notifyError?.("Submit failed", err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id, label) => {
    if (!window.confirm(`Delete service visit ${label || id}?`)) return;
    setBusy(true);
    try {
      const fn = AnvilBackend?.service?.deleteVisit;
      if (typeof fn === "function") await fn(id);
      else await svFetch("/api/service/visits?id=" + encodeURIComponent(id), { method: "DELETE" });
      window.notifySuccess?.("Visit deleted");
      reload();
      closeForm();
    } catch (err) {
      window.notifyError?.("Delete failed", err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const tabs = [
    { id: "all",        label: "All",        match: () => true },
    { id: "scheduled",  label: "Scheduled",  match: (r) => r.status === "PLANNED" },
    { id: "active",     label: "Active",     match: (r) => r.status === "CHECKED_IN" || r.status === "CHECKED_OUT" },
    { id: "submitted",  label: "Submitted",  match: (r) => r.status === "REPORT_SUBMITTED" },
    { id: "closed",     label: "Closed",     match: (r) => r.status === "CLOSED" },
  ];
  const matcher = tabs.find((t) => t.id === active)?.match || (() => true);
  const filtered = list.rows.filter(matcher);
  const counts = Object.fromEntries(tabs.map((t) => [t.id, list.rows.filter(t.match).length]));

  const customerName = (id) => customers.find((c) => c.id === id)?.customer_name || (id ? id.slice(0, 8) : "—");

  return (
    <>
      <WSTitle
        eyebrow="Service · Visits"
        title="Service visits"
        meta={`${list.rows.length} total · ${counts.scheduled || 0} scheduled · ${counts.active || 0} active`}
        right={<>
          <Btn icon kind="ghost" sm onClick={reload} title="Refresh">{Icon.cycle}</Btn>
          <Btn sm kind="primary" onClick={() => window.location.hash = "#/svc-visits?new=1"}>{Icon.plus} Plan visit</Btn>
        </>}
      />
      <WSTabs tabs={tabs.map((t) => ({ id: t.id, label: t.label, count: counts[t.id] }))} active={active} onChange={setActive} />

      <div className="ws-content">
        {list.error && (
          <Banner kind="bad" icon={Icon.alert} title="Could not load visits"
                  action={<Btn sm onClick={reload}>Retry</Btn>}>
            <span className="mono-sm">{String(list.error.message || list.error)}</span>
          </Banner>
        )}

        {form && (
          <Card title={editing === "__new__" ? "Plan a visit" : "Edit visit"}
                eyebrow="form"
                right={<Btn sm icon kind="ghost" onClick={closeForm} aria-label="Close">{Icon.x}</Btn>}>
            <div className="form-grid">
              <div>
                <label htmlFor="sv-customer" className="label">Customer *</label>
                <select id="sv-customer" className="select" value={form.customer_id}
                        onChange={(ev) => setForm({ ...form, customer_id: ev.target.value, customer_location_id: "" })}>
                  <option value="">Pick customer…</option>
                  {customers.map((c) => <option key={c.id} value={c.id}>{c.customer_name || c.customer_key}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="sv-location" className="label">Location</label>
                <select id="sv-location" className="select" value={form.customer_location_id}
                        onChange={(ev) => setForm({ ...form, customer_location_id: ev.target.value })} disabled={!form.customer_id}>
                  <option value="">— any —</option>
                  {locations.map((l) => <option key={l.id} value={l.id}>{l.plant_name || l.location_code}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="sv-date" className="label">Visit date *</label>
                <input id="sv-date" type="date" className="input mono" value={(form.visit_date || "").slice(0, 10)}
                       onChange={(ev) => setForm({ ...form, visit_date: ev.target.value })} />
              </div>
              <div>
                <label htmlFor="sv-status" className="label">Status</label>
                <select id="sv-status" className="select" value={form.status}
                        onChange={(ev) => setForm({ ...form, status: ev.target.value })}>
                  {SVC_STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, " ").toLowerCase()}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="sv-line" className="label">Line / station</label>
                <input id="sv-line" className="input" value={form.line_or_station || ""}
                       onChange={(ev) => setForm({ ...form, line_or_station: ev.target.value })}
                       placeholder="e.g. FCA 556 / SRTC-K6133-IND" />
              </div>
              <div>
                <label htmlFor="sv-purpose" className="label">Purpose</label>
                <input id="sv-purpose" className="input" value={form.purpose || ""}
                       onChange={(ev) => setForm({ ...form, purpose: ev.target.value })}
                       placeholder="Routine maintenance / breakdown / commissioning" />
              </div>
              <div className="span-2">
                <label htmlFor="sv-obs" className="label">Observation</label>
                <textarea id="sv-obs" className="input" rows={2} value={form.observation || ""}
                          onChange={(ev) => setForm({ ...form, observation: ev.target.value })} />
              </div>
              <div className="span-2">
                <label htmlFor="sv-cause" className="label">Possible cause</label>
                <textarea id="sv-cause" className="input" rows={2} value={form.possible_cause || ""}
                          onChange={(ev) => setForm({ ...form, possible_cause: ev.target.value })} />
              </div>
              <div className="span-2">
                <label htmlFor="sv-action" className="label">Action taken</label>
                <textarea id="sv-action" className="input" rows={2} value={form.action_taken || ""}
                          onChange={(ev) => setForm({ ...form, action_taken: ev.target.value })} />
              </div>
              <div className="span-2">
                <label htmlFor="sv-follow" className="label">Follow-up action</label>
                <textarea id="sv-follow" className="input" rows={2} value={form.followup_action || ""}
                          onChange={(ev) => setForm({ ...form, followup_action: ev.target.value })} />
              </div>
              <div className="span-2">
                <label htmlFor="sv-notes" className="label">Notes</label>
                <textarea id="sv-notes" className="input" rows={2} value={form.notes || ""}
                          onChange={(ev) => setForm({ ...form, notes: ev.target.value })} />
              </div>
            </div>
            <div className="row" style={{ gap: 8, marginTop: 12, flexWrap: "wrap" }}>
              <Btn kind="primary" disabled={busy} onClick={submit}>{busy ? "Saving…" : editing === "__new__" ? "Plan visit" : "Save"}</Btn>
              <Btn kind="ghost" onClick={closeForm}>Cancel</Btn>
              {editing && editing !== "__new__" && (
                <>
                  {form.status === "PLANNED" && (
                    <Btn kind="live" disabled={busy} onClick={() => checkIn(editing)}>{Icon.check} Check in</Btn>
                  )}
                  {form.status === "CHECKED_IN" && (
                    <Btn kind="live" disabled={busy} onClick={() => checkOut(editing)}>{Icon.check} Check out</Btn>
                  )}
                  {form.status === "CHECKED_OUT" && (
                    <Btn kind="primary" disabled={busy} onClick={() => submitReport(editing)}>{Icon.send} Submit report</Btn>
                  )}
                </>
              )}
              <span style={{ flex: 1 }} />
              {editing && editing !== "__new__" && (
                <Btn kind="danger" disabled={busy} onClick={() => remove(editing, form.purpose)}>{Icon.x} Delete</Btn>
              )}
            </div>
          </Card>
        )}

        <Card flush>
          {list.loading ? (
            <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>Loading visits…</div>
          ) : filtered.length === 0 ? (
            <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
              {list.rows.length === 0 ? "No visits planned yet. Use Plan visit." :
                <>No visits in this view. <button type="button" onClick={() => setActive("all")} className="link-btn" style={{ color: "var(--ink)", cursor: "pointer", textDecoration: "underline" }}>show all</button></>}
            </div>
          ) : (
            <table className="tbl">
              <thead><tr>
                <th>Customer</th>
                <th>Line / station</th>
                <th>Purpose</th>
                <th>Date</th>
                <th>Status</th>
                <th>Check in / out</th>
                <th></th>
              </tr></thead>
              <tbody>
                {filtered.slice(0, 200).map((r) => {
                  const sc = svStatusChip(r.status);
                  return (
                    <tr key={r.id}>
                      <td><span className="pri">{customerName(r.customer_id)}</span></td>
                      <td className="mono-sm">{r.line_or_station || "—"}</td>
                      <td>{r.purpose || "—"}</td>
                      <td className="mono-sm">{svDateLabel(r.visit_date)}</td>
                      <td><Chip k={sc.k}>{sc.label}</Chip></td>
                      <td className="mono-sm">
                        {r.check_in_at ? new Date(r.check_in_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : "—"}
                        {" / "}
                        {r.check_out_at ? new Date(r.check_out_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : "—"}
                      </td>
                      <td>
                        <div className="row" style={{ gap: 4, justifyContent: "flex-end" }}>
                          <Btn sm kind="ghost" onClick={() => window.location.hash = `#/svc-visits?id=${r.id}`} title="Edit">{Icon.eye}</Btn>
                          {r.status === "PLANNED" && (
                            <Btn sm kind="ghost" onClick={() => checkIn(r.id)} disabled={busy} title="Check in">{Icon.check}</Btn>
                          )}
                          {r.status === "CHECKED_IN" && (
                            <Btn sm kind="ghost" onClick={() => checkOut(r.id)} disabled={busy} title="Check out">{Icon.check}</Btn>
                          )}
                          <Btn sm kind="ghost" onClick={() => remove(r.id, r.purpose)} disabled={busy} title="Delete">{Icon.x}</Btn>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </>
  );
};


export default WiredServiceVisitsCRUD;
