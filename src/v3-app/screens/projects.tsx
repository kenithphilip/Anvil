import React, { useEffect, useState } from "react";
import { fmtINRShort, useFetch } from "../lib/helpers";
import { Banner, Btn, Card, Chip, KPI, KPIRow, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { ObaraBackend } from "../lib/api";

// ============================================================
// ANVIL v3 — wired Projects
// Wave B · Sales · Project lifecycle (15-phase enum)
// Reads via ObaraBackend.sales.listProjects (api/sales/projects GET)
// ============================================================

// Phase enum matches the project_phase Postgres enum in
// supabase/migrations/006_corpus_alignment.sql. Display labels are
// rendered in lowercase and de-snaked for the operator's eye.
const PROJECT_PHASES = [
  "INITIAL_INFO",
  "STRATEGY",
  "PROMOTIONAL",
  "RFQ_PREP",
  "BUDGETARY_QUOTATION",
  "PRICE_NEGOTIATION",
  "LB_FINALIZATION",
  "KICKOFF",
  "DESIGN",
  "APPROVAL_PROCESSING",
  "MANUFACTURING",
  "SHIPPING",
  "INSTALLATION_COMMISSIONING",
  "PAYMENT_FOLLOWUP",
  "CLOSED",
];

// Map from the canonical enum to an operator-friendly display.
const PROJECT_PHASE_LABEL_MAP = {
  INITIAL_INFO:               "initial info",
  STRATEGY:                   "strategy",
  PROMOTIONAL:                "promotional",
  RFQ_PREP:                   "RFQ prep",
  BUDGETARY_QUOTATION:        "budgetary quotation",
  PRICE_NEGOTIATION:          "price negotiation",
  LB_FINALIZATION:            "LB finalization",
  KICKOFF:                    "kickoff",
  DESIGN:                     "design",
  APPROVAL_PROCESSING:        "approval processing",
  MANUFACTURING:              "manufacturing",
  SHIPPING:                   "shipping",
  INSTALLATION_COMMISSIONING: "installation + commissioning",
  PAYMENT_FOLLOWUP:           "payment follow-up",
  CLOSED:                     "closed",
};

const PROJECT_PHASE_LABEL = (ph) => PROJECT_PHASE_LABEL_MAP[ph] || (ph || "—").replace(/_/g, " ").toLowerCase();

const PROJECT_PHASE_CHIP = (ph) => {
  if (ph === "CLOSED") return { k: "good", label: PROJECT_PHASE_LABEL(ph) };
  if (ph === "PAYMENT_FOLLOWUP") return { k: "good", label: PROJECT_PHASE_LABEL(ph) };
  if (ph === "INSTALLATION_COMMISSIONING" || ph === "SHIPPING") {
    return { k: "live", label: PROJECT_PHASE_LABEL(ph) };
  }
  if (ph === "MANUFACTURING" || ph === "APPROVAL_PROCESSING") {
    return { k: "warn", label: PROJECT_PHASE_LABEL(ph) };
  }
  return { k: "info", label: PROJECT_PHASE_LABEL(ph) };
};

const projectRows = (resp) => {
  if (!resp) return [];
  if (Array.isArray(resp)) return resp;
  if (Array.isArray(resp.projects)) return resp.projects;
  if (Array.isArray(resp.rows)) return resp.rows;
  return [];
};

const WiredProjects = () => {
  // Inline create-project state (replaces dead-button bug per audit).
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({
    project_code: "", project_name: "", customer_id: "", current_phase: "INITIAL_INFO", total_value_inr: "",
  });
  const [submitErr, setSubmitErr] = useState(null);
  const [submitBusy, setSubmitBusy] = useState(false);
  const customers = useFetch(
    () => creating ? (ObaraBackend?.customers?.list?.() || Promise.resolve({ customers: [] })) : Promise.resolve({ customers: [] }),
    [creating],
  );
  const customerRows = (() => {
    const d = customers.data;
    return Array.isArray(d) ? d : (d?.customers || []);
  })();

  const list = useFetch(
    () => ObaraBackend?.sales?.listProjects?.() || Promise.resolve({ projects: [] }),
    []
  );

  const submitNewProject = async () => {
    setSubmitErr(null);
    if (!draft.project_code.trim()) { setSubmitErr({ message: "Project code is required." }); return; }
    if (!draft.project_name.trim()) { setSubmitErr({ message: "Project name is required." }); return; }
    setSubmitBusy(true);
    try {
      await ObaraBackend?.sales?.createProject?.({
        project_code: draft.project_code.trim(),
        project_name: draft.project_name.trim(),
        customer_id: draft.customer_id || null,
        current_phase: draft.current_phase,
        total_value_inr: draft.total_value_inr ? Number(draft.total_value_inr) : null,
      });
      window.notifySuccess?.("Project created", draft.project_code);
      setCreating(false);
      setDraft({ project_code: "", project_name: "", customer_id: "", current_phase: "INITIAL_INFO", total_value_inr: "" });
      list.reload();
    } catch (err) {
      setSubmitErr(err);
      window.notifyError?.("Could not create project", err?.message || String(err));
    } finally {
      setSubmitBusy(false);
    }
  };

  if (list.loading) {
    return (
      <div className="ws ws-no-rail">
        <WSTitle eyebrow="Sales · Projects" title="Project tracker" meta="loading…" />
        <div className="ws-content"><Card><div className="body">Loading projects…</div></Card></div>
      </div>
    );
  }

  if (list.error) {
    return (
      <div className="ws ws-no-rail">
        <WSTitle eyebrow="Sales · Projects" title="Project tracker" meta="error" />
        <div className="ws-content">
          <Banner kind="bad" icon={Icon.alert} title="Could not load projects"
                  action={<Btn sm onClick={list.reload}>Retry</Btn>}>
            <span className="mono-sm">{String(list.error.message || list.error)}</span>
          </Banner>
        </div>
      </div>
    );
  }

  const rows = projectRows(list.data);
  const total = rows.length;

  const isClosed = (p) => p === "CLOSED";
  const inDesign = (p) => ["INITIAL_INFO", "REQUIREMENT_GATHERING", "DESIGN", "QUOTE"].includes(p);
  const inMfg = (p) => ["PO_RECEIVED", "PRODUCTION_PLANNING", "MATERIALS_IN", "MANUFACTURING", "FAT"].includes(p);
  const delivered = (p) => ["DISPATCHED", "ON_SITE_INSTALL", "SAT", "COMMISSIONED"].includes(p);

  const activeCount = rows.filter((r) => !isClosed(r.phase)).length;
  const designCount = rows.filter((r) => inDesign(r.phase)).length;
  const mfgCount = rows.filter((r) => inMfg(r.phase)).length;
  const deliveredCount = rows.filter((r) => delivered(r.phase)).length;

  return (
    <>
      <WSTitle
        eyebrow="Sales · Projects"
        title="Project tracker"
        meta={`${total} total · ${activeCount} active · ${PROJECT_PHASES.length}-phase lifecycle`}
        right={<>
          <Btn icon kind="ghost" sm onClick={list.reload} title="Refresh">{Icon.cycle}</Btn>
          <Btn sm kind="primary" onClick={() => setCreating((v) => !v)}>
            {Icon.plus} {creating ? "Cancel" : "New project"}
          </Btn>
        </>}
      />

      <div className="ws-content">
        <KPIRow cols={4}>
          <KPI lbl="Active" v={String(activeCount)} d="not yet closed" live={activeCount > 0} />
          <KPI lbl="In design" v={String(designCount)} d="info → quote" />
          <KPI lbl="In manufacturing" v={String(mfgCount)} d="PO → FAT" />
          <KPI lbl="Delivered" v={String(deliveredCount)} d="dispatched → commissioned" dKind={deliveredCount ? "up" : ""} />
        </KPIRow>

        {creating && (
          <Card title="New project" eyebrow="quick capture">
            {submitErr && (
              <Banner kind="bad" icon={Icon.alert} title="Could not create project">
                <span className="mono-sm">{String(submitErr?.message || submitErr)}</span>
              </Banner>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12, marginTop: 8 }}>
              <label className="mono-sm" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span>Project code *</span>
                <input className="input mono" value={draft.project_code}
                       onChange={(ev) => setDraft({ ...draft, project_code: ev.target.value })} placeholder="PRJ-2026-0001" />
              </label>
              <label className="mono-sm" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span>Project name *</span>
                <input className="input" value={draft.project_name}
                       onChange={(ev) => setDraft({ ...draft, project_name: ev.target.value })} />
              </label>
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
                <span>Phase</span>
                <select className="input" value={draft.current_phase}
                        onChange={(ev) => setDraft({ ...draft, current_phase: ev.target.value })}>
                  {PROJECT_PHASES.map((p) => <option key={p} value={p}>{PROJECT_PHASE_LABEL_MAP[p] || p}</option>)}
                </select>
              </label>
              <label className="mono-sm" style={{ display: "flex", flexDirection: "column", gap: 4, gridColumn: "1 / -1" }}>
                <span>Total value (INR)</span>
                <input className="input mono r" type="number" value={draft.total_value_inr}
                       onChange={(ev) => setDraft({ ...draft, total_value_inr: ev.target.value })} />
              </label>
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
              <Btn sm kind="ghost" onClick={() => setCreating(false)} disabled={submitBusy}>Cancel</Btn>
              <Btn sm kind="primary" onClick={submitNewProject} disabled={submitBusy}>
                {submitBusy ? "Creating…" : "Create project"}
              </Btn>
            </div>
          </Card>
        )}

        <Card flush>
          {rows.length === 0 ? (
            <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
              No projects yet. Convert a PROJECT_HSS or PROJECT_FOR opportunity to start tracking.
            </div>
          ) : (
            <table className="tbl">
              <thead><tr>
                <th>Project</th>
                <th>Customer</th>
                <th>Phase</th>
                <th className="r">Value</th>
                <th>Owner</th>
                <th>Expected close</th>
              </tr></thead>
              <tbody>
                {rows.slice(0, 200).map((r) => {
                  const pc = PROJECT_PHASE_CHIP(r.phase);
                  const v = Number(r.value) || 0;
                  const expected = r.expected_close_date || r.expected_close;
                  return (
                    <tr
                      key={r.id}
                      tabIndex={0}
                      onClick={() => window.location.hash = `#/projects?id=${r.id}`}
                      onKeyDown={(ev) => {
                        if (ev.key === "Enter" || ev.key === " ") {
                          ev.preventDefault();
                          window.location.hash = `#/projects?id=${r.id}`;
                        }
                      }}
                      style={{ cursor: "pointer" }}
                    >
                      <td className="mono"><span className="pri">{r.project_code || r.code || (r.id ? r.id.slice(0, 12) : "—")}</span></td>
                      <td>{r.customer_name || r.customer || "—"}</td>
                      <td><Chip k={pc.k}>{pc.label}</Chip></td>
                      <td className="r mono">{v ? fmtINRShort(v) : "—"}</td>
                      <td className="mono-sm">{r.owner || "—"}</td>
                      <td className="mono-sm">{expected || "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {rows.length > 200 && (
            <div className="mono-sm" style={{ padding: 12, textAlign: "center", color: "var(--ink-3)", borderTop: "1px solid var(--hairline-2)" }}>
              Showing 200 of {rows.length} projects.
            </div>
          )}
        </Card>
      </div>
    </>
  );
};


export default WiredProjects;
