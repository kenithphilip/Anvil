import React, { useEffect, useState } from "react";
import { ageLabel, fmtINRShort, useFetch, useHashParam } from "../lib/helpers";
import { Banner, Btn, Card, Chip, KPI, KPIRow, KV, Steps, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { AnvilBackend } from "../lib/api";
import { RBAC } from "../lib/rbac";

// ============================================================
// ANVIL v3 — wired Projects
// Wave B · Sales · Project lifecycle (15-phase enum)
// Reads via AnvilBackend.sales.listProjects (api/sales/projects GET)
// Moves a phase via AnvilBackend.sales.updateProject (PATCH), whose
// phase guard answers 409 INVALID_PHASE_TRANSITION for a move it
// refuses; the screen shows that message.
//
// Field names are the projects table's own (migration 006):
// current_phase, total_value_inr, customer_id (the GET embeds
// customer.customer_name), related_opportunity_id. There is no owner
// column, so the screen shows none.
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

// KPI buckets over the real enum, in phase order. Together they cover
// every open phase: pre-order runs to LB finalization, execution from
// kickoff through manufacturing, and delivery from shipping on.
const phaseIn = (phase: string, from: string, to: string): boolean => {
  const i = PROJECT_PHASES.indexOf(phase);
  return i >= 0 && i >= PROJECT_PHASES.indexOf(from) && i <= PROJECT_PHASES.indexOf(to);
};
const isOpenProject = (r: any): boolean =>
  r.current_phase !== "CLOSED" && r.status !== "COMPLETED" && r.status !== "CANCELLED";

const BLANK_DRAFT = {
  project_code: "", project_name: "", related_opportunity_id: "", customer_id: "", current_phase: "INITIAL_INFO", total_value_inr: "",
};

const WiredProjects = () => {
  // Inline create-project state (replaces dead-button bug per audit).
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ ...BLANK_DRAFT });
  const [submitErr, setSubmitErr] = useState(null);
  const [submitBusy, setSubmitBusy] = useState(false);
  const customers = useFetch(
    () => creating ? (AnvilBackend?.customers?.list?.() || Promise.resolve({ customers: [] })) : Promise.resolve({ customers: [] }),
    [creating],
  );
  const customerRows = (() => {
    const d = customers.data;
    return Array.isArray(d) ? d : (d?.customers || []);
  })();
  const opportunities = useFetch(
    () => creating ? (AnvilBackend?.sales?.listOpportunities?.() || Promise.resolve({ opportunities: [] })) : Promise.resolve({ opportunities: [] }),
    [creating],
  );
  const opportunityRows: any[] = (() => {
    const d: any = opportunities.data;
    return Array.isArray(d) ? d : (d?.opportunities || []);
  })();

  const list = useFetch(
    () => AnvilBackend?.sales?.listProjects?.() || Promise.resolve({ projects: [] }),
    []
  );

  // Unconditional hook call so the count stays stable across
  // loading / error / success renders. selected is resolved once
  // rows are computed below.
  const selectedId = useHashParam("id");

  // Phase move on the open project. The target starts at the next
  // phase; the server's guard decides, and its refusal is shown.
  const canWrite = RBAC?.canWrite?.("projects") === true;
  const [phaseTarget, setPhaseTarget] = useState("");
  const [phaseBusy, setPhaseBusy] = useState(false);
  const [phaseErr, setPhaseErr] = useState<string | null>(null);
  useEffect(() => { setPhaseTarget(""); setPhaseErr(null); }, [selectedId]);

  const movePhase = async (project: any, to: string) => {
    if (!project?.id || !to) return;
    setPhaseBusy(true);
    setPhaseErr(null);
    try {
      await AnvilBackend?.sales?.updateProject?.({ id: project.id, current_phase: to });
      window.notifySuccess?.("Phase moved", PROJECT_PHASE_LABEL(to));
      setPhaseTarget("");
      list.reload();
    } catch (err: any) {
      setPhaseErr(err?.message || String(err));
    } finally {
      setPhaseBusy(false);
    }
  };

  // Choosing the opportunity a project comes from fills the fields it
  // already knows (customer, name, value) where they are still empty.
  const pickOpportunity = (id: string) => {
    const opp = opportunityRows.find((o) => o.id === id);
    setDraft((d) => ({
      ...d,
      related_opportunity_id: id,
      customer_id: d.customer_id || opp?.customer_id || "",
      project_name: d.project_name || opp?.opportunity_name || "",
      total_value_inr: d.total_value_inr || (opp?.amount_inr != null ? String(opp.amount_inr) : ""),
    }));
  };

  const submitNewProject = async () => {
    setSubmitErr(null);
    if (!draft.project_code.trim()) { setSubmitErr({ message: "Project code is required." }); return; }
    if (!draft.project_name.trim()) { setSubmitErr({ message: "Project name is required." }); return; }
    setSubmitBusy(true);
    try {
      await AnvilBackend?.sales?.createProject?.({
        project_code: draft.project_code.trim(),
        project_name: draft.project_name.trim(),
        customer_id: draft.customer_id || null,
        related_opportunity_id: draft.related_opportunity_id || null,
        current_phase: draft.current_phase,
        total_value_inr: draft.total_value_inr ? Number(draft.total_value_inr) : null,
      });
      window.notifySuccess?.("Project created", draft.project_code);
      setCreating(false);
      setDraft({ ...BLANK_DRAFT });
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

  const open = rows.filter(isOpenProject);
  const activeCount = open.length;
  const preOrderCount = open.filter((r) => phaseIn(r.current_phase, "INITIAL_INFO", "LB_FINALIZATION")).length;
  const executionCount = open.filter((r) => phaseIn(r.current_phase, "KICKOFF", "MANUFACTURING")).length;
  const deliveryCount = open.filter((r) => phaseIn(r.current_phase, "SHIPPING", "PAYMENT_FOLLOWUP")).length;

  // Detail-card lookup. selectedId was read at the top of the
  // function (rules-of-hooks); resolve `selected` here once rows
  // are loaded.
  const selected = selectedId ? rows.find((r) => r.id === selectedId) || null : null;
  const selectedPhaseIdx = selected ? PROJECT_PHASES.indexOf(selected.current_phase) : -1;
  const moveTo = phaseTarget || (selectedPhaseIdx >= 0 ? PROJECT_PHASES[selectedPhaseIdx + 1] || "" : "");

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
          <KPI lbl="Pre-order" v={String(preOrderCount)} d="initial info → LB finalization" />
          <KPI lbl="In execution" v={String(executionCount)} d="kickoff → manufacturing" />
          <KPI lbl="Shipping and site" v={String(deliveryCount)} d="shipping → payment follow-up" dKind={deliveryCount ? "up" : ""} />
        </KPIRow>

        {selected && (
          <Card
            title={selected.project_name || selected.code || selected.project_code || "Project"}
            eyebrow={"project detail · " + (selected.id?.slice(0, 8) || "")}
            right={<Btn sm kind="ghost" onClick={() => { window.location.hash = "#/projects"; }}>{Icon.x} close</Btn>}
          >
            <KV rows={[
              ["Code",     selected.project_code || "—"],
              ["Customer", selected.customer?.customer_name || "—"],
              ["Opportunity", selected.related_opportunity_id
                ? <a href={"#/opps?id=" + selected.related_opportunity_id}>open opportunity</a>
                : "—"],
              ["Phase",    PROJECT_PHASE_LABEL(selected.current_phase)],
              ["Progress", selectedPhaseIdx >= 0
                ? Math.round((selectedPhaseIdx + 1) / PROJECT_PHASES.length * 100) + "% (" + (selectedPhaseIdx + 1) + " of " + PROJECT_PHASES.length + ")"
                : "—"],
              ["Value",    selected.total_value_inr
                ? fmtINRShort(Number(selected.total_value_inr))
                : "—"],
              // Schema-drift fix: the projects table has
              // `expected_delivery_date` (the canonical end-of-project
              // date); older code used `expected_close_date` /
              // `expected_close` which never existed in the schema.
              // Read the canonical column first; fall back to the
              // legacy aliases so a transitional API response with
              // either name still renders.
              ["Expected close",
                selected.expected_delivery_date
                || selected.expected_close_date
                || selected.expected_close
                || "—"],
              ["Last update",    selected.updated_at ? ageLabel(selected.updated_at) : "—"],
            ]} />
            {/* Audit P13.B.1.2: phase timeline. Reuses the Steps
                primitive with the project_phase enum, with the
                current row's index supplied so dots before it read
                as completed and dots after as upcoming. */}
            {selectedPhaseIdx >= 0 && (
              <div style={{ marginTop: 14 }}>
                <div className="mono-sm" style={{ color: "var(--ink-3)", marginBottom: 8 }}>Phase timeline</div>
                <Steps
                  items={PROJECT_PHASES.map((p) => PROJECT_PHASE_LABEL(p))}
                  current={selectedPhaseIdx}
                />
              </div>
            )}
            {/* Move the phase. CLOSED is terminal, so a closed project
                offers no move. Any phase can be picked; the server's
                guard refuses a jump back of more than one phase, and
                its message is shown here. */}
            {canWrite && selectedPhaseIdx >= 0 && selected.current_phase !== "CLOSED" && (
              <div style={{ marginTop: 14 }}>
                <div className="mono-sm" style={{ color: "var(--ink-3)", marginBottom: 8 }}>Move phase</div>
                {phaseErr && (
                  <div style={{ marginBottom: 8 }}>
                    <Banner kind="bad" icon={Icon.alert} title="Phase not moved">
                      <span className="mono-sm">{phaseErr}</span>
                    </Banner>
                  </div>
                )}
                <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <select
                    className="select"
                    aria-label="Move to phase"
                    value={moveTo}
                    disabled={phaseBusy}
                    onChange={(ev) => setPhaseTarget(ev.target.value)}
                    style={{ minWidth: 220 }}
                  >
                    {PROJECT_PHASES.filter((p) => p !== selected.current_phase).map((p) => (
                      <option key={p} value={p}>{PROJECT_PHASE_LABEL(p)}</option>
                    ))}
                  </select>
                  <Btn sm kind="primary" disabled={phaseBusy || !moveTo} onClick={() => movePhase(selected, moveTo)}>
                    {phaseBusy ? "Moving…" : "Move"}
                  </Btn>
                </div>
              </div>
            )}
          </Card>
        )}

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
                <span>Opportunity</span>
                <select className="input" value={draft.related_opportunity_id}
                        onChange={(ev) => pickOpportunity(ev.target.value)}>
                  <option value="">{opportunities.loading ? "loading…" : "none"}</option>
                  {opportunityRows.map((o: any) => (
                    <option key={o.id} value={o.id}>{o.opportunity_name || o.id?.slice(0, 8)}</option>
                  ))}
                </select>
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
              <label className="mono-sm" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
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
                <th>Progress</th>
                <th className="r">Value</th>
                <th>Expected close</th>
              </tr></thead>
              <tbody>
                {rows.slice(0, 200).map((r) => {
                  const pc = PROJECT_PHASE_CHIP(r.current_phase);
                  const v = Number(r.total_value_inr) || 0;
                  const expected = r.expected_delivery_date || r.expected_close_date || r.expected_close;
                  // Phase timeline: a 15-dot strip showing where in
                  // the lifecycle this project sits. Active dot is
                  // tinted accent; completed dots are ink; future
                  // dots are hairline. Replaces the design's
                  // standalone phase-timeline component without
                  // adding a new file.
                  const phase = r.current_phase;
                  const phaseIdx = PROJECT_PHASES.indexOf(phase);
                  const closed = phase === "CLOSED";
                  const pct = phaseIdx >= 0
                    ? Math.round((phaseIdx + 1) / PROJECT_PHASES.length * 100)
                    : 0;
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
                      <td className="mono"><span className="pri">{r.project_code || (r.id ? r.id.slice(0, 12) : "—")}</span></td>
                      <td>{r.customer?.customer_name || "—"}</td>
                      <td><Chip k={pc.k}>{pc.label}</Chip></td>
                      <td>
                        <div
                          aria-label={"phase " + (phaseIdx + 1) + " of " + PROJECT_PHASES.length}
                          style={{ display: "inline-flex", alignItems: "center", gap: 2 }}
                        >
                          {PROJECT_PHASES.map((_, i) => {
                            const state = i < phaseIdx ? "done"
                                        : i === phaseIdx ? "active"
                                        : "pending";
                            const bg = state === "done"   ? "var(--ink)"
                                     : state === "active" ? (closed ? "var(--ink-3)" : "var(--accent-2)")
                                     : "var(--hairline)";
                            return (
                              <span key={i} style={{
                                display: "inline-block",
                                width: 6, height: 6, borderRadius: 999,
                                background: bg,
                              }} />
                            );
                          })}
                          <span className="mono-sm" style={{ color: "var(--ink-3)", marginLeft: 6 }}>
                            {pct}%
                          </span>
                        </div>
                      </td>
                      <td className="r mono">{v ? fmtINRShort(v) : "—"}</td>
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
