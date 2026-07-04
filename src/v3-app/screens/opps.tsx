import React, { useEffect, useState } from "react";
import { ageLabel, fmtINRShort, useFetch, useHashParam } from "../lib/helpers";
import { Banner, Btn, Card, Chip, KPI, KPIRow, KV, WSTitle } from "../lib/primitives";
import { OpportunityQuotesPanel } from "../components/OpportunityQuotesPanel";
import { Icon } from "../lib/icons";
import { AnvilBackend } from "../lib/api";

// ============================================================
// ANVIL v3 — wired Opportunities
// Wave B · Sales pipeline · 11-stage kanban
// Reads via AnvilBackend.sales.listOpportunities (api/sales/opportunities GET)
// ============================================================

// Stage enum matches the opportunity_stage Postgres enum in
// supabase/migrations/006_corpus_alignment.sql. Weights drive the
// pipeline KPI so they reflect the canonical stage progression.
const OPP_STAGES = [
  { id: "QUALIFICATION",        t: "Qualification",         w: 0.05 },
  { id: "STRATEGY_CHECK",       t: "Strategy check",        w: 0.10 },
  { id: "NEEDS_ANALYSIS",       t: "Needs analysis",        w: 0.20 },
  { id: "FOLLOW_UP",            t: "Follow-up",             w: 0.30 },
  { id: "RFQ",                  t: "RFQ",                   w: 0.45 },
  { id: "INTERNAL_PROPOSAL",    t: "Internal proposal",     w: 0.55 },
  { id: "PROPOSAL_PRICE_QUOTE", t: "Proposal + price quote", w: 0.70 },
  { id: "NEGOTIATION_REVIEW",   t: "Negotiation review",    w: 0.85 },
  { id: "CLOSE_WON",            t: "Closed won",            w: 1.00 },
  { id: "CLOSE_LOST",           t: "Closed lost",           w: 0 },
  { id: "REGRETTED",            t: "Regretted",             w: 0 },
];

const OPP_STAGE_LABEL = (stage) => {
  const found = OPP_STAGES.find((s) => s.id === stage);
  return found ? found.t.toLowerCase() : (stage || "").toLowerCase().replace(/_/g, " ");
};

const OPP_STAGE_CHIP = (stage) => {
  if (stage === "CLOSE_WON") return { k: "good", label: OPP_STAGE_LABEL(stage) };
  if (stage === "CLOSE_LOST") return { k: "bad", label: OPP_STAGE_LABEL(stage) };
  if (stage === "REGRETTED") return { k: "warn", label: OPP_STAGE_LABEL(stage) };
  if (stage === "NEGOTIATION_REVIEW") return { k: "live", label: OPP_STAGE_LABEL(stage) };
  if (stage === "PROPOSAL_PRICE_QUOTE") return { k: "warn", label: OPP_STAGE_LABEL(stage) };
  return { k: "info", label: OPP_STAGE_LABEL(stage) };
};

// Audit P9.2: AI close-probability chip. Maps the 0-100 probability
// the Haiku predictor stores in opportunities.ai_probability into
// a discrete band: high (>=70), mid (40-69), low (<40). null
// renders as "p?" so an unscored opp is visually distinct.
const OPP_PROB_CHIP = (probability) => {
  if (probability == null || !Number.isFinite(Number(probability))) {
    return { k: "ghost", label: "p?" };
  }
  const n = Math.round(Number(probability));
  if (n >= 70) return { k: "good", label: "p" + n };
  if (n >= 40) return { k: "warn", label: "p" + n };
  return { k: "info", label: "p" + n };
};

const oppRows = (resp) => {
  if (!resp) return [];
  if (Array.isArray(resp)) return resp;
  if (Array.isArray(resp.opportunities)) return resp.opportunities;
  if (Array.isArray(resp.rows)) return resp.rows;
  return [];
};

const WiredOpportunities = () => {
  // Inline create-opp form, identical pattern to leads.tsx. Replaces
  // the dead-button bug where `New opp` set `#/opps?new=1` but neither
  // the resolver nor this screen ever read the param.
  const [creating, setCreating] = useState(false);
  // Audit P9.2: optional sort-by-AI-probability flag + per-row
  // re-predict spinner.
  const [sortByProb, setSortByProb] = useState(false);
  const [predictingId, setPredictingId] = useState<string | null>(null);
  const [draft, setDraft] = useState({
    opportunity_name: "", customer_id: "", stage: "QUALIFICATION", amount_inr: "",
  });
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

  const list = useFetch(
    () => AnvilBackend?.sales?.listOpportunities?.() || Promise.resolve({ opportunities: [] }),
    []
  );

  // Unconditional hook call so the count stays stable across
  // loading / error / success renders. The selected-row lookup
  // happens after `rows` is computed below.
  const selectedId = useHashParam("id");

  const submitNewOpp = async () => {
    setSubmitErr(null);
    if (!draft.opportunity_name.trim()) { setSubmitErr({ message: "Opportunity name is required." }); return; }
    if (!draft.customer_id)             { setSubmitErr({ message: "Customer is required." }); return; }
    setSubmitBusy(true);
    try {
      await AnvilBackend?.sales?.createOpportunity?.({
        opportunity_name: draft.opportunity_name.trim(),
        customer_id: draft.customer_id,
        stage: draft.stage,
        amount_inr: draft.amount_inr ? Number(draft.amount_inr) : null,
      });
      window.notifySuccess?.("Opportunity created", draft.opportunity_name);
      setCreating(false);
      setDraft({ opportunity_name: "", customer_id: "", stage: "QUALIFICATION", amount_inr: "" });
      list.reload();
    } catch (err) {
      setSubmitErr(err);
      window.notifyError?.("Could not create opportunity", err?.message || String(err));
    } finally {
      setSubmitBusy(false);
    }
  };

  if (list.loading) {
    return (
      <div className="ws ws-no-rail">
        <WSTitle eyebrow="Sales · Opportunities" title="Opportunities" meta="loading…" />
        <div className="ws-content"><Card><div className="body">Loading opportunities…</div></Card></div>
      </div>
    );
  }

  if (list.error) {
    return (
      <div className="ws ws-no-rail">
        <WSTitle eyebrow="Sales · Opportunities" title="Opportunities" meta="error" />
        <div className="ws-content">
          <Banner kind="bad" icon={Icon.alert} title="Could not load opportunities"
                  action={<Btn sm onClick={list.reload}>Retry</Btn>}>
            <span className="mono-sm">{String(list.error.message || list.error)}</span>
          </Banner>
        </div>
      </div>
    );
  }

  const rows = oppRows(list.data);
  const total = rows.length;
  const stageMap = OPP_STAGES.reduce((acc, s) => { acc[s.id] = s.w; return acc; }, {});

  // Detail-card lookup. selectedId is read at the top of the
  // function (above the early-return guards) so the hook count
  // stays stable; we resolve `selected` here once rows are known.
  const selected = selectedId ? rows.find((r) => r.id === selectedId) || null : null;

  const weighted = rows.reduce((sum, r) => {
    const v = Number(r.value) || 0;
    const w = stageMap[r.stage] != null ? stageMap[r.stage] : 0;
    return sum + v * w;
  }, 0);

  const countByStage = (stage) => rows.filter((r) => r.stage === stage).length;
  const discoveryCount = countByStage("DISCOVERY");
  const demoCount = countByStage("DEMO");
  const quoteCount = countByStage("QUOTE");
  const negotCount = countByStage("NEGOTIATION");

  const wonMtd = rows.filter((r) => {
    if (r.stage !== "WON") return false;
    const t = r.closed_at || r.updated_at;
    if (!t) return false;
    const d = new Date(t);
    const now = new Date();
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  });
  const wonValueMtd = wonMtd.reduce((sum, r) => sum + (Number(r.value) || 0), 0);

  // Group rows by stage for the kanban
  const byStage = {};
  for (const stage of OPP_STAGES) byStage[stage.id] = [];
  for (const r of rows) {
    if (byStage[r.stage]) byStage[r.stage].push(r);
    else if (byStage[(r.stage || "").toUpperCase()]) byStage[(r.stage || "").toUpperCase()].push(r);
  }

  return (
    <>
      <WSTitle
        eyebrow="Sales · Opportunities"
        title="Opportunities · 11-stage pipeline"
        meta={`${total} active · weighted ${fmtINRShort(weighted)}`}
        right={<>
          <Btn sm kind={sortByProb ? "live" : "ghost"} onClick={() => setSortByProb((v) => !v)} title="Sort by AI close probability (highest first)">
            {sortByProb ? "Sorting by probability" : "Sort by probability"}
          </Btn>
          <Btn icon kind="ghost" sm onClick={list.reload} title="Refresh">{Icon.cycle}</Btn>
          <Btn sm kind="primary" onClick={() => setCreating((v) => !v)}>
            {Icon.plus} {creating ? "Cancel" : "New opp"}
          </Btn>
        </>}
      />

      <div className="ws-content">
        <KPIRow cols={5}>
          <KPI lbl="Total" v={String(total)} d="all stages" />
          <KPI lbl="Weighted ₹" v={fmtINRShort(weighted)} d="probability-adjusted" live={weighted > 0} />
          <KPI lbl="Discovery" v={String(discoveryCount)} d={`${demoCount} demo · ${quoteCount} quote`} />
          <KPI lbl="Negotiation" v={String(negotCount)} d="late stage" />
          <KPI lbl="Won · MTD" v={fmtINRShort(wonValueMtd)} d={`${wonMtd.length} closed`} dKind={wonMtd.length ? "up" : ""} />
        </KPIRow>

        {selected && (
          <Card
            title={selected.name || selected.opportunity_name || "Opportunity"}
            eyebrow={"opportunity detail · " + (selected.id?.slice(0, 8) || "")}
            right={<>
              <Btn sm kind={selected.ai_probability == null ? "live" : "ghost"} disabled={predictingId === selected.id}
                   onClick={async () => {
                     setPredictingId(selected.id);
                     try { await AnvilBackend?.sales?.predictOpportunity?.(selected.id); list.reload(); }
                     finally { setPredictingId(null); }
                   }}
                   title="Run the AI close-probability predictor for this opportunity">
                {predictingId === selected.id ? "Predicting..." : (selected.ai_probability == null ? "Predict probability" : "Re-predict")}
              </Btn>
              <Btn sm kind="ghost" onClick={() => { window.location.hash = "#/opps"; }}>{Icon.x} close</Btn>
            </>}
          >
            <KV rows={[
              ["Name",       selected.name || selected.opportunity_name || "—"],
              ["Customer",   selected.customer_name || selected.customer || "—"],
              ["Stage",      selected.stage || "—"],
              ["Owner",      selected.owner || selected.assigned_to || "—"],
              ["Value",      selected.value ? fmtINRShort(Number(selected.value)) : "—"],
              ["Probability (operator)", selected.probability != null ? Math.round(Number(selected.probability) * 100) + "%" : "—"],
              ["AI probability", (() => {
                if (selected.ai_probability == null) return <span style={{ color: "var(--ink-3)" }}>not predicted yet</span>;
                const c = OPP_PROB_CHIP(selected.ai_probability);
                return <Chip k={c.k}>{c.label}</Chip>;
              })()],
              ["AI reasoning", selected.ai_probability_reasoning || <span style={{ color: "var(--ink-3)" }}>—</span>],
              ["Expected close", selected.expected_close_date || selected.expected_close || "—"],
              ["Last update",   selected.updated_at ? ageLabel(selected.updated_at) : "—"],
            ]} />
            {selected.notes && (
              <>
                <div className="divider" />
                <pre style={{ font: "inherit", fontSize: 12.5, color: "var(--ink-2)", whiteSpace: "pre-wrap", margin: 0 }}>
                  {selected.notes}
                </pre>
              </>
            )}
            <div className="divider" />
            <div style={{ marginTop: 10 }}>
              <OpportunityQuotesPanel opportunityId={selected.id} />
            </div>
          </Card>
        )}

        {creating && (
          <Card title="New opportunity" eyebrow="quick capture">
            {submitErr && (
              <Banner kind="bad" icon={Icon.alert} title="Could not create opportunity">
                <span className="mono-sm">{String(submitErr?.message || submitErr)}</span>
              </Banner>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12, marginTop: 8 }}>
              <label className="mono-sm" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span>Opportunity name *</span>
                <input className="input" value={draft.opportunity_name}
                       onChange={(ev) => setDraft({ ...draft, opportunity_name: ev.target.value })} />
              </label>
              <label className="mono-sm" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span>Customer *</span>
                <select className="input" value={draft.customer_id}
                        onChange={(ev) => setDraft({ ...draft, customer_id: ev.target.value })}>
                  <option value="">{customers.loading ? "loading…" : "select a customer…"}</option>
                  {customerRows.map((c: any) => (
                    <option key={c.id} value={c.id}>{c.customer_name || c.id?.slice(0, 8)}</option>
                  ))}
                </select>
              </label>
              <label className="mono-sm" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span>Stage</span>
                <select className="input" value={draft.stage}
                        onChange={(ev) => setDraft({ ...draft, stage: ev.target.value })}>
                  {OPP_STAGES.map((s) => <option key={s.id} value={s.id}>{s.t}</option>)}
                </select>
              </label>
              <label className="mono-sm" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span>Amount (INR)</span>
                <input className="input mono r" type="number" value={draft.amount_inr}
                       onChange={(ev) => setDraft({ ...draft, amount_inr: ev.target.value })} />
              </label>
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
              <Btn sm kind="ghost" onClick={() => setCreating(false)} disabled={submitBusy}>Cancel</Btn>
              <Btn sm kind="primary" onClick={submitNewOpp} disabled={submitBusy}>
                {submitBusy ? "Creating…" : "Create opportunity"}
              </Btn>
            </div>
          </Card>
        )}

        {rows.length === 0 ? (
          <Card>
            <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
              No opportunities yet. Promote a lead to start the pipeline.
            </div>
          </Card>
        ) : (
          <div className="kanban" role="list" aria-label="Opportunity pipeline">
            {OPP_STAGES.map((s) => {
              let cards = byStage[s.id] || [];
              if (sortByProb) {
                // Audit P9.2: re-sort each column by ai_probability desc.
                cards = [...cards].sort((a, b) => {
                  const av = Number.isFinite(Number(a.ai_probability)) ? Number(a.ai_probability) : -1;
                  const bv = Number.isFinite(Number(b.ai_probability)) ? Number(b.ai_probability) : -1;
                  return bv - av;
                });
              }
              const sc = OPP_STAGE_CHIP(s.id);
              return (
                <div className="col" key={s.id} role="listitem">
                  <div className="col-h">
                    <span className="t">{s.t}</span>
                    <span className="c">{cards.length}</span>
                    {s.w > 0 && (
                      <span className="c" style={{ color: "var(--ink-3)" }}>
                        · {Math.round(s.w * 100)}%
                      </span>
                    )}
                  </div>
                  {cards.length === 0 ? (
                    <div className="mono-sm" style={{ color: "var(--ink-4)", padding: "8px 4px" }}>—</div>
                  ) : (
                    cards.map((kard) => {
                      const v = Number(kard.value) || 0;
                      const customer = kard.customer_name || kard.customer || "—";
                      const owner = kard.owner || "—";
                      const created = kard.created_at || kard.updated_at;
                      const prob = OPP_PROB_CHIP(kard.ai_probability);
                      return (
                        <div
                          className="kard"
                          key={kard.id}
                          tabIndex={0}
                          onClick={() => window.location.hash = `#/opps?id=${kard.id}`}
                          onKeyDown={(ev) => {
                            if (ev.key === "Enter" || ev.key === " ") {
                              ev.preventDefault();
                              window.location.hash = `#/opps?id=${kard.id}`;
                            }
                          }}
                          style={{ cursor: "pointer" }}
                        >
                          <div className="ti">{kard.title || customer}</div>
                          <div className="meta">
                            {customer} · {v ? fmtINRShort(v) : "—"} · {owner}
                          </div>
                          <div className="ft">
                            <Chip k={sc.k}>{sc.label}</Chip>
                            <span title={kard.ai_probability_reasoning || (kard.ai_probability == null ? "Run /api/sales/predict_opportunity to populate" : "")} style={{ marginLeft: 6 }}>
                              <Chip k={prob.k}>{prob.label}</Chip>
                            </span>
                            <span className="mono-sm" style={{ marginLeft: "auto", color: "var(--ink-4)" }}>
                              {created ? ageLabel(created) : "—"}
                            </span>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
};


export default WiredOpportunities;
