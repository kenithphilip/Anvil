import React, { useEffect, useMemo, useState } from "react";
import { Banner, Btn, Card, Chip, KPI, KPIRow, WSTitle } from "../lib/primitives.jsx";
import { Icon } from "../lib/icons.jsx";
import { ObaraBackend } from "../lib/api.js";
import { RBAC } from "../lib/rbac.js";

// ============================================================
// ANVIL v3 — AMC Schedule CRUD overlay
// Adds bulk-seed-from-contract, single create/edit, per-row
// generate-visit (turns SCHEDULED into a service_visits row +
// flips status to VISIT_CREATED), and per-row delete on top of
// the read-only summary in wired-amc-c.jsx. Wins via load-order.
//
// Backend shape: amc_schedules is ONE ROW PER SCHEDULED VISIT
// (not per contract). Status state machine:
//   SCHEDULED -> VISIT_CREATED -> COMPLETED
//                              \-> SKIPPED / CANCELLED
//
// Backend methods on ObaraBackend.service:
//   listAmcSchedules({ contract_id?, customer_id?, status?, from?, to? })
//   createAmcSchedule(row)
//   bulkSeedAmcSchedule({ contract_id, frequency, start_date, count, visit_label })
//   updateAmcSchedule({ id, ...patch })
//   generateAmcVisit(id)         -> PATCH { id, generate_visit: true }
//   deleteAmcSchedule(id)
// ============================================================

const AMC_STATUSES = ["SCHEDULED", "VISIT_CREATED", "COMPLETED", "SKIPPED", "CANCELLED"];
const AMC_VISIT_TYPES = ["PREVENTIVE", "EMERGENCY", "TRAINING", "AUDIT"];
const AMC_FREQS = [
  { id: "MONTHLY",   t: "Monthly (~30d)" },
  { id: "QUARTERLY", t: "Quarterly (~91d)" },
  { id: "BIANNUAL",  t: "Biannual (~182d)" },
  { id: "ANNUAL",    t: "Annual (365d)" },
];

const amcReadParams = () => {
  const hash = window.location.hash || "";
  const q = hash.split("?")[1];
  return new URLSearchParams(q || "");
};

const amcCrudFetch = async (path, opts = {}) => {
  const cfg = (() => { try { return JSON.parse(localStorage.getItem("obara:backend_config") || "{}"); } catch (_) { return {}; } })();
  const session = (() => { try { return JSON.parse(localStorage.getItem("obara:backend_session") || "null"); } catch (_) { return null; } })();
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
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

const AMC_FORM_BLANK = () => ({
  contract_id: "",
  customer_id: "",
  customer_location_id: "",
  scheduled_date: new Date().toISOString().slice(0, 10),
  visit_label: "",
  duration_days: 1,
  visit_type: "PREVENTIVE",
  status: "SCHEDULED",
  remarks: "",
});

const AMC_SEED_BLANK = () => ({
  contract_id: "",
  frequency: "QUARTERLY",
  start_date: new Date().toISOString().slice(0, 10),
  count: 4,
  visit_label: "",
});

const amcStatusChip = (s) => {
  if (s === "COMPLETED")     return { k: "good",  label: "completed" };
  if (s === "VISIT_CREATED") return { k: "live",  label: "visit created" };
  if (s === "SKIPPED")       return { k: "warn",  label: "skipped" };
  if (s === "CANCELLED")     return { k: "ghost", label: "cancelled" };
  return { k: "info", label: "scheduled" };
};

const amcDateLabel = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const target = new Date(d); target.setHours(0, 0, 0, 0);
  const days = Math.round((target - today) / 86400000);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  if (days > 0 && days <= 30) return `in ${days}d`;
  if (days < 0 && days >= -30) return `${-days}d ago`;
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "2-digit" });
};

const WiredAmcCRUD = () => {
  const { useState: u, useEffect: e, useMemo: m } = React;
  const params = amcReadParams();
  const editId = params.get("id");
  const isNew = params.get("new") === "1";
  const isSeed = params.get("seed") === "1";

  const [list, setList] = u({ rows: [], loading: true, error: null });
  const [contracts, setContracts] = u([]);
  const [customers, setCustomers] = u([]);
  const [locations, setLocations] = u([]);
  const [active, setActive] = u("upcoming");
  const [editing, setEditing] = u(null);
  const [form, setForm] = u(null);
  const [seeding, setSeeding] = u(false);
  const [seedForm, setSeedForm] = u(null);
  const [busy, setBusy] = u(false);
  const [err, setErr] = u(null);
  const [okMsg, setOkMsg] = u(null);
  const [genBusy, setGenBusy] = u(null); // row id of in-flight generate
  const [delBusy, setDelBusy] = u(null);

  const canWrite = RBAC?.canDo?.("service.write") ?? true;
  const canAdmin = RBAC?.canDo?.("service.admin") ?? canWrite;

  const reload = () => {
    setList((s) => ({ ...s, loading: true }));
    Promise.resolve(
      ObaraBackend?.service?.listAmcSchedules?.()
      || amcCrudFetch("/api/service/amc")
    )
      .then((r) => {
        const rows = Array.isArray(r) ? r : (r?.amc_schedules || r?.schedules || r?.rows || []);
        setList({ rows, loading: false, error: null });
      })
      .catch((error) => setList({ rows: [], loading: false, error }));
  };

  e(reload, []);

  e(() => {
    Promise.resolve(
      ObaraBackend?.admin?.listContracts?.()
      || amcCrudFetch("/api/admin/contracts")
    )
      .then((r) => {
        const rows = Array.isArray(r) ? r : (r?.contracts || r?.rows || []);
        setContracts(rows);
      })
      .catch(() => setContracts([]));
  }, []);

  e(() => {
    Promise.resolve(
      ObaraBackend?.customers?.list?.()
      || amcCrudFetch("/api/customers")
    )
      .then((r) => {
        const rows = Array.isArray(r) ? r : (r?.customers || r?.rows || []);
        setCustomers(rows);
      })
      .catch(() => setCustomers([]));
  }, []);

  e(() => {
    if (!form?.customer_id) { setLocations([]); return; }
    Promise.resolve(
      ObaraBackend?.admin?.listCustomerLocations?.(form.customer_id)
      || amcCrudFetch("/api/admin/customer_locations?customer_id=" + encodeURIComponent(form.customer_id))
    )
      .then((r) => {
        const rows = Array.isArray(r) ? r : (r?.locations || r?.rows || []);
        setLocations(rows);
      })
      .catch(() => setLocations([]));
  }, [form?.customer_id]);

  // Open the right form when the URL says so.
  e(() => {
    if (isSeed) {
      setSeeding(true);
      setSeedForm(AMC_SEED_BLANK());
      return;
    }
    if (isNew) {
      setForm(AMC_FORM_BLANK());
      setEditing("__new__");
      return;
    }
    if (editId) {
      const found = list.rows.find((r) => r.id === editId);
      if (found) {
        setForm({ ...AMC_FORM_BLANK(), ...found });
        setEditing(editId);
      }
    }
  }, [isNew, isSeed, editId, list.rows.length]);

  const closeForm = () => {
    setEditing(null);
    setForm(null);
    setSeeding(false);
    setSeedForm(null);
    setErr(null);
    const hash = window.location.hash.split("?")[0];
    window.location.hash = hash;
  };

  const customerName = (id) => customers.find((c) => c.id === id)?.customer_name || customers.find((c) => c.id === id)?.name || (id ? id.slice(0, 8) : "—");
  const contractLabel = (id) => {
    const c = contracts.find((x) => x.id === id);
    if (!c) return id ? id.slice(0, 8) : "—";
    return c.contract_number || c.title || c.id?.slice(0, 8) || "—";
  };

  const filtered = m(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const rows = list.rows;
    if (active === "upcoming") {
      return rows.filter((r) => {
        if (r.status !== "SCHEDULED") return false;
        const d = r.scheduled_date ? new Date(r.scheduled_date) : null;
        return d && d >= today;
      });
    }
    if (active === "due") {
      return rows.filter((r) => {
        if (r.status !== "SCHEDULED") return false;
        const d = r.scheduled_date ? new Date(r.scheduled_date) : null;
        if (!d) return false;
        const days = Math.round((d - today) / 86400000);
        return days >= 0 && days <= 30;
      });
    }
    if (active === "overdue") {
      return rows.filter((r) => {
        if (r.status !== "SCHEDULED") return false;
        const d = r.scheduled_date ? new Date(r.scheduled_date) : null;
        return d && d < today;
      });
    }
    if (active === "active") {
      return rows.filter((r) => r.status === "VISIT_CREATED");
    }
    if (active === "closed") {
      return rows.filter((r) => r.status === "COMPLETED" || r.status === "SKIPPED" || r.status === "CANCELLED");
    }
    return rows;
  }, [list.rows, active]);

  const counts = m(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const c = { all: list.rows.length, upcoming: 0, due: 0, overdue: 0, active: 0, closed: 0 };
    for (const r of list.rows) {
      const d = r.scheduled_date ? new Date(r.scheduled_date) : null;
      if (r.status === "SCHEDULED" && d) {
        const days = Math.round((d - today) / 86400000);
        if (days < 0) c.overdue += 1; else c.upcoming += 1;
        if (days >= 0 && days <= 30) c.due += 1;
      }
      if (r.status === "VISIT_CREATED") c.active += 1;
      if (r.status === "COMPLETED" || r.status === "SKIPPED" || r.status === "CANCELLED") c.closed += 1;
    }
    return c;
  }, [list.rows]);

  const valueWindow = m(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const horizon = new Date(today.getTime() + 90 * 86400 * 1000);
    return list.rows.filter((r) => {
      if (r.status !== "SCHEDULED") return false;
      const d = r.scheduled_date ? new Date(r.scheduled_date) : null;
      return d && d >= today && d <= horizon;
    }).length;
  }, [list.rows]);

  const submit = async () => {
    if (!form) return;
    if (!form.customer_id || !form.scheduled_date) {
      setErr(new Error("Customer and scheduled date are required"));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const payload = {
        contract_id: form.contract_id || null,
        customer_id: form.customer_id,
        customer_location_id: form.customer_location_id || null,
        scheduled_date: form.scheduled_date,
        visit_label: form.visit_label || null,
        duration_days: Number(form.duration_days) || 1,
        visit_type: form.visit_type || "PREVENTIVE",
        status: form.status || "SCHEDULED",
        remarks: form.remarks || null,
      };
      if (editing && editing !== "__new__") {
        const body = { id: editing, ...payload };
        await (ObaraBackend?.service?.updateAmcSchedule?.(body)
               || amcCrudFetch("/api/service/amc", { method: "PATCH", body }));
        setOkMsg("Schedule updated");
      } else {
        await (ObaraBackend?.service?.createAmcSchedule?.(payload)
               || amcCrudFetch("/api/service/amc", { method: "POST", body: payload }));
        setOkMsg("Schedule created");
      }
      closeForm();
      reload();
    } catch (error) {
      setErr(error);
    } finally {
      setBusy(false);
    }
  };

  const submitSeed = async () => {
    if (!seedForm) return;
    if (!seedForm.contract_id || !seedForm.frequency || !seedForm.start_date) {
      setErr(new Error("Contract, frequency, start date are required"));
      return;
    }
    const count = Math.max(1, Math.min(24, Number(seedForm.count) || 4));
    setBusy(true);
    setErr(null);
    try {
      const payload = {
        contract_id: seedForm.contract_id,
        frequency: seedForm.frequency,
        start_date: seedForm.start_date,
        count,
        visit_label: seedForm.visit_label || null,
      };
      await (ObaraBackend?.service?.bulkSeedAmcSchedule?.(payload)
             || amcCrudFetch("/api/service/amc", { method: "POST", body: { bulk_seed: payload } }));
      setOkMsg(`${count} visit(s) seeded`);
      closeForm();
      reload();
    } catch (error) {
      setErr(error);
    } finally {
      setBusy(false);
    }
  };

  const generateVisit = async (id) => {
    if (!confirm("Generate a service visit row for this AMC schedule? Status will flip to VISIT_CREATED.")) return;
    setGenBusy(id);
    setErr(null);
    try {
      await (ObaraBackend?.service?.generateAmcVisit?.(id)
             || amcCrudFetch("/api/service/amc", { method: "PATCH", body: { id, generate_visit: true } }));
      setOkMsg("Service visit generated");
      reload();
    } catch (error) {
      setErr(error);
    } finally {
      setGenBusy(null);
    }
  };

  const removeRow = async (id) => {
    if (!confirm("Delete this AMC schedule row? This cannot be undone.")) return;
    setDelBusy(id);
    setErr(null);
    try {
      await (ObaraBackend?.service?.deleteAmcSchedule?.(id)
             || amcCrudFetch("/api/service/amc?id=" + encodeURIComponent(id), { method: "DELETE" }));
      setOkMsg("Schedule deleted");
      reload();
    } catch (error) {
      setErr(error);
    } finally {
      setDelBusy(null);
    }
  };

  const cancelSchedule = async (id) => {
    if (!confirm("Cancel this AMC schedule row? Status flips to CANCELLED.")) return;
    setBusy(true);
    setErr(null);
    try {
      await (ObaraBackend?.service?.updateAmcSchedule?.({ id, status: "CANCELLED" })
             || amcCrudFetch("/api/service/amc", { method: "PATCH", body: { id, status: "CANCELLED" } }));
      reload();
    } catch (error) {
      setErr(error);
    } finally {
      setBusy(false);
    }
  };

  if (list.loading) {
    return (
      <div className="ws ws-no-rail">
        <WSTitle eyebrow="Service · AMC" title="AMC schedule" meta="loading…" />
        <div className="ws-content"><Card><div className="body">Loading AMC schedule…</div></Card></div>
      </div>
    );
  }

  if (list.error) {
    return (
      <div className="ws ws-no-rail">
        <WSTitle eyebrow="Service · AMC" title="AMC schedule" meta="error" />
        <div className="ws-content">
          <Banner kind="bad" icon={Icon.alert} title="Could not load AMC schedule"
                  action={<Btn sm onClick={reload}>Retry</Btn>}>
            <span className="mono-sm">{String(list.error.message || list.error)}</span>
          </Banner>
        </div>
      </div>
    );
  }

  return (
    <>
      <WSTitle
        eyebrow="Service · AMC"
        title="AMC schedule"
        meta={`${list.rows.length} rows · ${counts.upcoming} upcoming · ${counts.overdue} overdue`}
        right={<>
          <Btn icon kind="ghost" sm onClick={reload} title="Refresh">{Icon.cycle}</Btn>
          {canWrite && (
            <>
              <Btn sm onClick={() => { window.location.hash = "#/service/amc?seed=1"; }} title="Bulk-seed visits from a contract">
                {Icon.bolt} Seed from contract
              </Btn>
              <Btn sm kind="primary" onClick={() => { window.location.hash = "#/service/amc?new=1"; }}>
                {Icon.plus} New schedule
              </Btn>
            </>
          )}
        </>}
      />

      <div className="ws-content">
        {okMsg && (
          <Banner kind="good" icon={Icon.check} title={okMsg} action={<Btn sm onClick={() => setOkMsg(null)}>Dismiss</Btn>}>
            <span className="mono-sm">{new Date().toLocaleTimeString()}</span>
          </Banner>
        )}
        {err && (
          <Banner kind="bad" icon={Icon.alert} title="Action failed" action={<Btn sm onClick={() => setErr(null)}>Dismiss</Btn>}>
            <span className="mono-sm">{String(err.message || err)}</span>
          </Banner>
        )}

        <KPIRow cols={4}>
          <KPI lbl="Total" v={String(counts.all)} d="all rows" />
          <KPI lbl="Upcoming" v={String(counts.upcoming)} d={`${counts.due} due 30d`} live={counts.due > 0} />
          <KPI lbl="Overdue" v={String(counts.overdue)} d="past scheduled" dKind={counts.overdue > 0 ? "down" : ""} />
          <KPI lbl="Visits 90d" v={String(valueWindow)} d="seed window" />
        </KPIRow>

        <div className="tabs" style={{ marginBottom: 12 }}>
          {[
            ["upcoming", `Upcoming (${counts.upcoming})`],
            ["due",      `Due 30d (${counts.due})`],
            ["overdue",  `Overdue (${counts.overdue})`],
            ["active",   `Visit created (${counts.active})`],
            ["closed",   `Closed (${counts.closed})`],
            ["all",      `All (${counts.all})`],
          ].map(([k, label]) => (
            <button
              key={k}
              className={`tab ${active === k ? "on" : ""}`}
              onClick={() => setActive(k)}
            >
              {label}
            </button>
          ))}
        </div>

        <Card flush>
          <table className="tbl">
            <thead><tr>
              <th>Date</th>
              <th>Customer</th>
              <th>Contract</th>
              <th>Label</th>
              <th>Type</th>
              <th>Status</th>
              <th></th>
            </tr></thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={7} className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
                  No rows in this view.
                </td></tr>
              ) : filtered.map((r) => {
                const chip = amcStatusChip(r.status);
                const isSched = r.status === "SCHEDULED";
                return (
                  <tr key={r.id}>
                    <td className="mono-sm">{amcDateLabel(r.scheduled_date)}</td>
                    <td>{r.customer_name || customerName(r.customer_id)}</td>
                    <td className="mono-sm">{r.contract_number || contractLabel(r.contract_id)}</td>
                    <td>{r.visit_label || "—"}</td>
                    <td className="mono-sm">{r.visit_type || "PREVENTIVE"}</td>
                    <td><Chip k={chip.k}>{chip.label}</Chip></td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      {canWrite && isSched && (
                        <Btn sm
                             disabled={genBusy === r.id}
                             onClick={() => generateVisit(r.id)}
                             title="Generate a service_visits row + flip to VISIT_CREATED">
                          {genBusy === r.id ? "…" : <>{Icon.bolt} Generate</>}
                        </Btn>
                      )}
                      {r.generated_visit_id && (
                        <Btn sm kind="ghost" onClick={() => { window.location.hash = `#/service/visits?id=${r.generated_visit_id}`; }} title="Open generated visit">
                          {Icon.arrowR} Visit
                        </Btn>
                      )}
                      {canWrite && (
                        <Btn sm kind="ghost" onClick={() => { window.location.hash = `#/service/amc?id=${r.id}`; }}>
                          {Icon.edit} Edit
                        </Btn>
                      )}
                      {canWrite && isSched && (
                        <Btn sm kind="ghost" disabled={busy} onClick={() => cancelSchedule(r.id)}>
                          Cancel
                        </Btn>
                      )}
                      {canAdmin && (
                        <Btn sm kind="ghost"
                             disabled={delBusy === r.id}
                             onClick={() => removeRow(r.id)}
                             title="Delete row (admin)">
                          {delBusy === r.id ? "…" : Icon.trash}
                        </Btn>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      </div>

      {seeding && seedForm && (
        <div className="modal-backdrop" onClick={closeForm}>
          <div className="modal" onClick={(ev) => ev.stopPropagation()} style={{ maxWidth: 560 }}>
            <div className="modal-h">
              <span className="ti">Bulk-seed visits from contract</span>
              <Btn icon kind="ghost" sm onClick={closeForm}>{Icon.close}</Btn>
            </div>
            <div className="modal-body" style={{ display: "grid", gap: 10 }}>
              <label className="lbl">Contract
                <select value={seedForm.contract_id}
                        onChange={(ev) => setSeedForm({ ...seedForm, contract_id: ev.target.value })}>
                  <option value="">— pick contract —</option>
                  {contracts.map((c) => (
                    <option key={c.id} value={c.id}>
                      {(c.contract_number || c.title || c.id?.slice(0, 8))} · {c.customer_name || customerName(c.customer_id)}
                    </option>
                  ))}
                </select>
              </label>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <label className="lbl">Frequency
                  <select value={seedForm.frequency}
                          onChange={(ev) => setSeedForm({ ...seedForm, frequency: ev.target.value })}>
                    {AMC_FREQS.map((f) => <option key={f.id} value={f.id}>{f.t}</option>)}
                  </select>
                </label>
                <label className="lbl">Visit count (1-24)
                  <input type="number" min={1} max={24} value={seedForm.count}
                         onChange={(ev) => setSeedForm({ ...seedForm, count: ev.target.value })} />
                </label>
              </div>

              <label className="lbl">Start date
                <input type="date" value={seedForm.start_date}
                       onChange={(ev) => setSeedForm({ ...seedForm, start_date: ev.target.value })} />
              </label>

              <label className="lbl">Visit label prefix (optional)
                <input type="text" placeholder='e.g. "Q1 PM"' value={seedForm.visit_label}
                       onChange={(ev) => setSeedForm({ ...seedForm, visit_label: ev.target.value })} />
              </label>

              <div className="hint mono-sm" style={{ color: "var(--ink-3)" }}>
                Backend stamps each row as PREVENTIVE, status SCHEDULED, dated stride apart.
                Frequency stride: monthly 30d, quarterly 91d, biannual 182d, annual 365d.
              </div>
            </div>
            <div className="modal-f">
              <Btn kind="ghost" onClick={closeForm}>Cancel</Btn>
              <Btn kind="primary" disabled={busy} onClick={submitSeed}>
                {busy ? "Seeding…" : "Seed visits"}
              </Btn>
            </div>
          </div>
        </div>
      )}

      {editing && form && !seeding && (
        <div className="modal-backdrop" onClick={closeForm}>
          <div className="modal" onClick={(ev) => ev.stopPropagation()} style={{ maxWidth: 640 }}>
            <div className="modal-h">
              <span className="ti">{editing === "__new__" ? "New AMC schedule" : "Edit AMC schedule"}</span>
              <Btn icon kind="ghost" sm onClick={closeForm}>{Icon.close}</Btn>
            </div>
            <div className="modal-body" style={{ display: "grid", gap: 10 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <label className="lbl">Customer
                  <select value={form.customer_id}
                          onChange={(ev) => setForm({ ...form, customer_id: ev.target.value, customer_location_id: "" })}>
                    <option value="">— pick customer —</option>
                    {customers.map((c) => (
                      <option key={c.id} value={c.id}>{c.customer_name || c.name || c.id?.slice(0, 8)}</option>
                    ))}
                  </select>
                </label>
                <label className="lbl">Location
                  <select value={form.customer_location_id || ""}
                          onChange={(ev) => setForm({ ...form, customer_location_id: ev.target.value })}
                          disabled={!form.customer_id}>
                    <option value="">— optional —</option>
                    {locations.map((loc) => (
                      <option key={loc.id} value={loc.id}>
                        {loc.location_name || loc.name || loc.address || loc.id?.slice(0, 8)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <label className="lbl">Contract (optional)
                <select value={form.contract_id || ""}
                        onChange={(ev) => setForm({ ...form, contract_id: ev.target.value })}>
                  <option value="">— none —</option>
                  {contracts
                    .filter((c) => !form.customer_id || c.customer_id === form.customer_id)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {(c.contract_number || c.title || c.id?.slice(0, 8))} · {c.customer_name || customerName(c.customer_id)}
                      </option>
                    ))}
                </select>
              </label>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                <label className="lbl">Scheduled date
                  <input type="date" value={form.scheduled_date}
                         onChange={(ev) => setForm({ ...form, scheduled_date: ev.target.value })} />
                </label>
                <label className="lbl">Duration (days)
                  <input type="number" min={1} value={form.duration_days || 1}
                         onChange={(ev) => setForm({ ...form, duration_days: ev.target.value })} />
                </label>
                <label className="lbl">Visit type
                  <select value={form.visit_type}
                          onChange={(ev) => setForm({ ...form, visit_type: ev.target.value })}>
                    {AMC_VISIT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </label>
              </div>

              <label className="lbl">Visit label
                <input type="text" placeholder='e.g. "Q1 PM 2026"' value={form.visit_label || ""}
                       onChange={(ev) => setForm({ ...form, visit_label: ev.target.value })} />
              </label>

              <label className="lbl">Status
                <select value={form.status}
                        onChange={(ev) => setForm({ ...form, status: ev.target.value })}
                        disabled={editing === "__new__"}>
                  {AMC_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>

              <label className="lbl">Remarks
                <textarea rows={3} value={form.remarks || ""}
                          onChange={(ev) => setForm({ ...form, remarks: ev.target.value })} />
              </label>
            </div>
            <div className="modal-f">
              <Btn kind="ghost" onClick={closeForm}>Cancel</Btn>
              <Btn kind="primary" disabled={busy} onClick={submit}>
                {busy ? "Saving…" : (editing === "__new__" ? "Create schedule" : "Save changes")}
              </Btn>
            </div>
          </div>
        </div>
      )}
    </>
  );
};


export default WiredAmcCRUD;
