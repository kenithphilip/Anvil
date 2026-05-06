import React, { useEffect, useState } from "react";
import { useFetch } from "../lib/helpers";
import { Banner, Btn, Card, Chip, WSTabs, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { ObaraBackend } from "../lib/api";

// ============================================================
// ANVIL v3 — wired CAR Reports (Corrective Action Reports)
// ============================================================

const CAR_TABS = [
  { id: "open",          label: "Open",          match: (s) => ["OPEN", "DRAFT", "CONTAINMENT"].includes(s) },
  { id: "investigating", label: "Investigating", match: (s) => ["INVESTIGATING", "ROOT_CAUSE", "VERIFICATION"].includes(s) },
  { id: "resolved",      label: "Resolved",      match: (s) => ["RESOLVED", "EFFECTIVE"].includes(s) },
  { id: "closed",        label: "Closed",        match: (s) => ["CLOSED", "CANCELLED"].includes(s) },
];

const CAR_STATUS_CHIP = {
  OPEN:           { label: "open",          k: "warn" },
  DRAFT:          { label: "draft",         k: "ghost" },
  CONTAINMENT:    { label: "containment",   k: "warn" },
  INVESTIGATING:  { label: "investigating", k: "warn" },
  ROOT_CAUSE:     { label: "root cause",    k: "warn" },
  VERIFICATION:   { label: "verification",  k: "info" },
  RESOLVED:       { label: "resolved",      k: "good" },
  EFFECTIVE:      { label: "effective",     k: "good" },
  CLOSED:         { label: "closed",        k: "ghost" },
  CANCELLED:      { label: "cancelled",     k: "ghost" },
};

const CAR_SEVERITY_CHIP = {
  CRITICAL: { label: "critical", k: "bad" },
  HIGH:     { label: "high",     k: "bad" },
  MED:      { label: "med",      k: "warn" },
  MEDIUM:   { label: "medium",   k: "warn" },
  LOW:      { label: "low",      k: "info" },
};

const carFmtDate = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "2-digit" });
};

const carFetchPath = async (path) => {
  const cfg = (ObaraBackend?.getConfig?.() || {}) as { url?: string; tenantId?: string };
  if (!cfg.url) return [];
  const session = (ObaraBackend?.getSession?.() || null) as { access_token?: string } | null;
  const headers = { "Content-Type": "application/json" };
  if (session?.access_token) headers["Authorization"] = "Bearer " + session.access_token;
  if (cfg.tenantId) headers["x-obara-tenant"] = cfg.tenantId;
  const resp = await fetch(cfg.url.replace(/\/+$/, "") + path, { headers });
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  return resp.json();
};

const WiredCAR = () => {
  const { useState: uC } = React;
  const [active, setActive] = uC("open");

  // Inline create CAR (replaces dead-button bug per audit).
  const [creating, setCreating] = uC(false);
  const [draft, setDraft] = uC({
    customer_id: "", original_po_no: "", original_so_no: "", part_no: "",
    qty_rejected: "", root_cause: "", status: "OPEN",
  });
  const [submitErr, setSubmitErr] = uC(null);
  const [submitBusy, setSubmitBusy] = uC(false);
  const customers = useFetch(
    () => creating ? (ObaraBackend?.customers?.list?.() || Promise.resolve({ customers: [] })) : Promise.resolve({ customers: [] }),
    [creating],
  );
  const customerRows = (() => {
    const d = customers.data;
    return Array.isArray(d) ? d : (d?.customers || []);
  })();

  const cars = useFetch(() => carFetchPath("/api/service/car_reports"), []);
  const closures = useFetch(() => carFetchPath("/api/service/closure_reports"), []);

  const submitNewCar = async () => {
    setSubmitErr(null);
    if (!draft.customer_id && !draft.original_po_no.trim()) {
      setSubmitErr({ message: "Customer or original PO required for traceability." });
      return;
    }
    setSubmitBusy(true);
    try {
      await ObaraBackend?.service?.createCarReport?.({
        customer_id: draft.customer_id || null,
        original_po_no: draft.original_po_no.trim() || null,
        original_so_no: draft.original_so_no.trim() || null,
        part_no: draft.part_no.trim() || null,
        qty_rejected: draft.qty_rejected ? Number(draft.qty_rejected) : null,
        root_cause: draft.root_cause.trim() || null,
        status: draft.status,
      });
      window.notifySuccess?.("CAR created", draft.original_po_no || draft.part_no || "draft");
      setCreating(false);
      setDraft({
        customer_id: "", original_po_no: "", original_so_no: "", part_no: "",
        qty_rejected: "", root_cause: "", status: "OPEN",
      });
      cars.reload();
    } catch (err) {
      setSubmitErr(err);
      window.notifyError?.("Could not create CAR", err?.message || String(err));
    } finally {
      setSubmitBusy(false);
    }
  };

  const carRows = (() => {
    const d = cars.data;
    if (!d) return [];
    if (Array.isArray(d)) return d;
    return d.rows || d.car_reports || d.reports || [];
  })();

  const closureRows = (() => {
    const d = closures.data;
    if (!d) return [];
    if (Array.isArray(d)) return d;
    return d.rows || d.closure_reports || d.reports || [];
  })();

  // Build closure index by car id for quick lookup
  const closuresByCar = {};
  closureRows.forEach((cl) => {
    const k = cl.car_report_id || cl.car_id;
    if (k) closuresByCar[k] = cl;
  });

  const counts = Object.fromEntries(CAR_TABS.map((t) => [t.id, carRows.filter((c) => t.match((c.status || "").toUpperCase())).length]));
  const filtered = carRows.filter((c) => CAR_TABS.find((t) => t.id === active)?.match((c.status || "").toUpperCase()));

  if (cars.loading) {
    return (
      <div className="ws ws-no-rail">
        <WSTitle eyebrow="loading" title="CAR reports" />
        <div className="ws-content"><Card><div className="body">Loading CAR reports…</div></Card></div>
      </div>
    );
  }

  if (cars.error) {
    return (
      <div className="ws ws-no-rail">
        <WSTitle eyebrow="error" title="Could not load CAR reports" />
        <div className="ws-content">
          <Banner kind="bad" icon={Icon.alert} title="Backend unreachable" action={<Btn sm onClick={cars.reload}>Retry</Btn>}>
            <span className="mono-sm">{String(cars.error.message || cars.error)}</span>
          </Banner>
        </div>
      </div>
    );
  }

  return (
    <>
      <WSTitle
        eyebrow="Service · CAR Reports"
        title="Corrective Action Reports"
        meta={`${carRows.length} total · ${counts.open || 0} open · ${closureRows.length} closures`}
        right={<>
          <Btn icon kind="ghost" sm onClick={cars.reload} title="Refresh">{Icon.cycle}</Btn>
          <Btn sm kind="primary" onClick={() => setCreating((v) => !v)}>{Icon.plus} {creating ? "Cancel" : "New CAR"}</Btn>
        </>}
      />
      <WSTabs
        tabs={CAR_TABS.map((t) => ({ id: t.id, label: t.label, count: counts[t.id] }))}
        active={active}
        onChange={setActive}
      />

      <div className="ws-content">
        {closures.error && (
          <Banner kind="warn" icon={Icon.alert} title="Closure reports failed to load">
            <span className="mono-sm">{String(closures.error.message || closures.error)}</span>
          </Banner>
        )}

        {creating && (
          <Card title="New CAR" eyebrow="quick capture · expand later">
            {submitErr && (
              <Banner kind="bad" icon={Icon.alert} title="Could not create CAR">
                <span className="mono-sm">{String(submitErr?.message || submitErr)}</span>
              </Banner>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12, marginTop: 8 }}>
              <label className="mono-sm" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span>Customer</span>
                <select className="input" value={draft.customer_id}
                        onChange={(ev) => setDraft({ ...draft, customer_id: ev.target.value })}>
                  <option value="">{customers.loading ? "loading…" : "select a customer…"}</option>
                  {customerRows.map((c: any) => (
                    <option key={c.id} value={c.id}>{c.customer_name || c.id?.slice(0, 8)}</option>
                  ))}
                </select>
              </label>
              <label className="mono-sm" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span>Original PO</span>
                <input className="input mono" value={draft.original_po_no}
                       onChange={(ev) => setDraft({ ...draft, original_po_no: ev.target.value })} />
              </label>
              <label className="mono-sm" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span>Original SO</span>
                <input className="input mono" value={draft.original_so_no}
                       onChange={(ev) => setDraft({ ...draft, original_so_no: ev.target.value })} />
              </label>
              <label className="mono-sm" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span>Part number</span>
                <input className="input mono" value={draft.part_no}
                       onChange={(ev) => setDraft({ ...draft, part_no: ev.target.value })} />
              </label>
              <label className="mono-sm" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span>Qty rejected</span>
                <input className="input mono r" type="number" value={draft.qty_rejected}
                       onChange={(ev) => setDraft({ ...draft, qty_rejected: ev.target.value })} />
              </label>
              <label className="mono-sm" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span>Status</span>
                <select className="input" value={draft.status}
                        onChange={(ev) => setDraft({ ...draft, status: ev.target.value })}>
                  <option value="OPEN">OPEN</option>
                  <option value="UNDER_INVESTIGATION">UNDER_INVESTIGATION</option>
                  <option value="CLOSED">CLOSED</option>
                </select>
              </label>
              <label className="mono-sm" style={{ display: "flex", flexDirection: "column", gap: 4, gridColumn: "1 / -1" }}>
                <span>Root cause (initial)</span>
                <textarea className="input" rows={2} style={{ width: "100%", padding: 6 }}
                          value={draft.root_cause}
                          onChange={(ev) => setDraft({ ...draft, root_cause: ev.target.value })} />
              </label>
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
              <Btn sm kind="ghost" onClick={() => setCreating(false)} disabled={submitBusy}>Cancel</Btn>
              <Btn sm kind="primary" onClick={submitNewCar} disabled={submitBusy}>
                {submitBusy ? "Creating…" : "Create CAR"}
              </Btn>
            </div>
          </Card>
        )}

        <Card flush>
          <table className="tbl">
            <thead><tr>
              <th>CAR number</th>
              <th>Customer</th>
              <th>Equipment</th>
              <th>Raised</th>
              <th>Severity</th>
              <th>Status</th>
              <th>Owner</th>
              <th></th>
            </tr></thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={8} className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
                  No CAR reports in this tab.
                </td></tr>
              ) : filtered.map((c) => {
                const status = (c.status || "OPEN").toUpperCase();
                const sev = (c.severity || "MED").toUpperCase();
                const chip = CAR_STATUS_CHIP[status] || { label: status.toLowerCase(), k: "ghost" };
                const sevChip = CAR_SEVERITY_CHIP[sev] || { label: sev.toLowerCase(), k: "ghost" };
                const carNum = c.car_number || c.number || c.id?.slice(0, 8) || "—";
                const closure = closuresByCar[c.id];
                return (
                  <tr key={c.id || carNum}>
                    <td className="mono">
                      <span className="pri">{carNum}</span>
                      {closure && <span className="mono-sm" style={{ marginLeft: 6, color: "var(--ink-4)" }} title="Closure filed">·closed</span>}
                    </td>
                    <td>{c.customer_name || c.customer?.customer_name || c.customer_id?.slice(0, 8) || "—"}</td>
                    <td className="mono-sm">{c.equipment_label || c.equipment?.label || c.equipment_serial || c.equipment_id?.slice(0, 8) || "—"}</td>
                    <td className="mono-sm">{carFmtDate(c.raised_at || c.opened_at || c.created_at)}</td>
                    <td><Chip k={sevChip.k}>{sevChip.label}</Chip></td>
                    <td><Chip k={chip.k}>{chip.label}</Chip></td>
                    <td className="mono-sm">{c.owner_name || c.owner?.name || c.assigned_to_name || "—"}</td>
                    <td><Btn sm onClick={() => window.location.hash = `#/car?id=${c.id}`}>open {Icon.arrowR}</Btn></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      </div>
    </>
  );
};


export default WiredCAR;
