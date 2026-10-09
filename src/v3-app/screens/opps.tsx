import React, { useEffect, useState } from "react";
import { ageLabel, fmtINRShort, useFetch, useHashParam } from "../lib/helpers";
import { Banner, Btn, Card, Chip, KPI, KPIRow, KV, WSTitle } from "../lib/primitives";
import { OpportunityQuotesPanel } from "../components/OpportunityQuotesPanel";
import { OpportunityQuoteRevisions } from "../components/OpportunityQuoteRevisions";
import { TouchLog } from "../components/TouchLog";
import { Icon } from "../lib/icons";
import { AnvilBackend } from "../lib/api";

// The list view: the pipeline as one sortable table.
//
// The board answers "what is in each stage". It cannot answer "what is the
// biggest thing in this pipeline", "what has not moved in a month", or "which
// of these is least likely to close" — questions ABOUT the pipeline rather
// than about a stage, and every one of them needs comparing across all eleven
// columns at once.
//
// Sorting is client-side on purpose. The board already holds the whole set in
// memory (it has to, to bucket it), so a round trip per sort would be slower
// and would make the two views disagree about what "the pipeline" contains.
const OPP_COLUMNS = [
  { key: "name", label: "Opportunity", align: "left" },
  { key: "customer", label: "Customer", align: "left" },
  { key: "stage", label: "Stage", align: "left" },
  { key: "value", label: "Value", align: "right" },
  { key: "weighted", label: "Weighted", align: "right" },
  { key: "probability", label: "Close prob.", align: "right" },
  { key: "owner", label: "Owner", align: "left" },
  { key: "age", label: "Age", align: "right" },
];

// The row as GET /api/sales/opportunities sends it: opportunity_name,
// customer_id with customer_name, amount_inr, owner_id with owner_name, and
// close_date. The screen used to read title, value, owner and
// expected_close_date, which the API never sent, so those cells were blank.
const oppValue = (r) => Number(r.amount_inr) || 0;
// The customer lookup is tenant-scoped and best-effort, so a row can arrive
// without a name. Its id prefix is still a handle somebody can search for.
const oppCustomer = (r) => r.customer_name || (r.customer_id ? String(r.customer_id).slice(0, 8) : "");
const oppOwner = (r) => r.owner_name || (r.owner_id ? String(r.owner_id).slice(0, 8) : "unassigned");

const oppSortValue = (r, key) => {
  switch (key) {
    case "name": return String(r.opportunity_name || "").toLowerCase();
    case "customer": return oppCustomer(r).toLowerCase();
    // Sorted by the stage's WEIGHT, not its name: alphabetical stage order is
    // meaningless, and pipeline order is what somebody scanning this wants.
    case "stage": return OPP_STAGES.findIndex((s) => s.id === r.stage);
    case "value": return oppValue(r);
    case "weighted": {
      const w = OPP_STAGES.find((s) => s.id === r.stage)?.w ?? 0;
      return oppValue(r) * w;
    }
    // -1, not 0: an opportunity nobody has scored is not the same as one
    // scored at zero, and sorting them together hides exactly the rows that
    // need attention.
    case "probability": return Number.isFinite(Number(r.ai_probability)) ? Number(r.ai_probability) : -1;
    case "owner": return oppOwner(r).toLowerCase();
    case "age": {
      const t = r.created_at || r.updated_at;
      return t ? new Date(t).getTime() : 0;
    }
    default: return 0;
  }
};

const OppList = ({ rows, sortKey, sortDir, onSort }) => {
  const sorted = [...rows].sort((a, b) => {
    const av = oppSortValue(a, sortKey);
    const bv = oppSortValue(b, sortKey);
    if (av === bv) return 0;
    // Both sides come from the same key, so they are always the same type —
    // but TypeScript cannot see that through the switch, and asserting it is
    // honest here in a way a cast to `any` would not be.
    const cmp = typeof av === "string" && typeof bv === "string"
      ? av.localeCompare(bv)
      : Number(av) - Number(bv);
    return sortDir === "desc" ? -cmp : cmp;
  });

  return (
    <Card>
      {/* Its own scroll container: eight columns on a narrow screen must not
          make the whole page scroll sideways. */}
      <div style={{ overflowX: "auto" }}>
        <table className="tbl" style={{ width: "100%" }}>
          <thead>
            <tr>
              {OPP_COLUMNS.map((c) => {
                const active = sortKey === c.key;
                return (
                  <th
                    key={c.key}
                    onClick={() => onSort(c.key)}
                    aria-sort={active ? (sortDir === "desc" ? "descending" : "ascending") : "none"}
                    style={{ textAlign: c.align === "right" ? "right" : "left", cursor: "pointer", whiteSpace: "nowrap" }}
                    title={`Sort by ${c.label.toLowerCase()}`}
                  >
                    {c.label}
                    {/* The arrow is not the only signal — aria-sort carries it
                        for a screen reader, and the header stays legible
                        without colour. */}
                    <span style={{ opacity: active ? 0.9 : 0.25, marginLeft: 4 }}>
                      {active ? (sortDir === "desc" ? "\u2193" : "\u2191") : "\u2195"}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const stage = OPP_STAGES.find((s) => s.id === r.stage);
              const sc = OPP_STAGE_CHIP(r.stage);
              const prob = OPP_PROB_CHIP(r.ai_probability);
              const v = oppValue(r);
              const created = r.created_at || r.updated_at;
              return (
                <tr
                  key={r.id}
                  tabIndex={0}
                  onClick={() => { window.location.hash = `#/opps?id=${r.id}`; }}
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter" || ev.key === " ") {
                      ev.preventDefault();
                      window.location.hash = `#/opps?id=${r.id}`;
                    }
                  }}
                  style={{ cursor: "pointer" }}
                >
                  <td>{r.opportunity_name || "-"}</td>
                  <td>{oppCustomer(r) || "-"}</td>
                  <td><Chip k={sc.k}>{sc.label}</Chip></td>
                  {/* tabular-nums so the figures line up down the column */}
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{v ? fmtINRShort(v) : "-"}</td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    {v && stage ? fmtINRShort(v * stage.w) : "-"}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <span title={r.ai_probability_reasoning || (r.ai_probability == null ? "Not scored yet" : "")}>
                      <Chip k={prob.k}>{prob.label}</Chip>
                    </span>
                  </td>
                  <td>{oppOwner(r)}</td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>{created ? ageLabel(created) : "-"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
};

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

// The KPI tiles, counted over the real stage ids. They used to count
// DISCOVERY, DEMO, QUOTE, NEGOTIATION and WON, which are not stages, so every
// tile but Total read 0. The weighted figure is the OPEN pipeline only: a won
// deal at weight 1.0 is revenue, not pipeline, and counting it would inflate
// the pipeline with every deal ever won.
const OPP_EARLY_STAGES = ["QUALIFICATION", "STRATEGY_CHECK", "NEEDS_ANALYSIS", "FOLLOW_UP"];
const OPP_QUOTING_STAGES = ["RFQ", "INTERNAL_PROPOSAL", "PROPOSAL_PRICE_QUOTE"];
const OPP_CLOSED_STAGES = ["CLOSE_WON", "CLOSE_LOST", "REGRETTED"];

const oppKpis = (rows) => {
  const weightOf = (stage) => OPP_STAGES.find((s) => s.id === stage)?.w ?? 0;
  const inStages = (ids) => rows.filter((r) => ids.includes(r.stage));
  const open = rows.filter((r) => OPP_STAGES.some((s) => s.id === r.stage) && !OPP_CLOSED_STAGES.includes(r.stage));
  const won = inStages(["CLOSE_WON"]);
  return {
    open: open.length,
    openValue: open.reduce((sum, r) => sum + oppValue(r), 0),
    weighted: open.reduce((sum, r) => sum + oppValue(r) * weightOf(r.stage), 0),
    early: inStages(OPP_EARLY_STAGES).length,
    quoting: inStages(OPP_QUOTING_STAGES).length,
    negotiation: inStages(["NEGOTIATION_REVIEW"]).length,
    won: won.length,
    wonValue: won.reduce((sum, r) => sum + oppValue(r), 0),
    lost: inStages(["CLOSE_LOST"]).length,
    regretted: inStages(["REGRETTED"]).length,
  };
};

const WiredOpportunities = () => {
  // Inline create-opp form, identical pattern to leads.tsx. Replaces
  // the dead-button bug where `New opp` set `#/opps?new=1` but neither
  // the resolver nor this screen ever read the param.
  const [creating, setCreating] = useState(false);
  // Audit P9.2: optional sort-by-AI-probability flag + per-row
  // re-predict spinner.
  const [sortByProb, setSortByProb] = useState(false);
  // Board or list.
  //
  // Eleven columns is a lot of horizontal scrolling to answer "what is the
  // biggest thing in this pipeline" or "what has not moved in a month" —
  // questions about the pipeline as a WHOLE, which a board is the wrong shape
  // for. The board answers "what is in each stage"; a list answers everything
  // that needs comparing across stages, and sorting.
  //
  // In the hash so a view survives a refresh and can be linked to, matching
  // the ?id= convention already on this screen.
  const [view, setView] = useState(() =>
    (typeof window !== "undefined" && window.location.hash.includes("view=list")) ? "list" : "board");
  const [sortKey, setSortKey] = useState("value");
  const [sortDir, setSortDir] = useState("desc");
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

  // Detail-card lookup. selectedId is read at the top of the
  // function (above the early-return guards) so the hook count
  // stays stable; we resolve `selected` here once rows are known.
  const selected = selectedId ? rows.find((r) => r.id === selectedId) || null : null;

  const kpi = oppKpis(rows);

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
        meta={`${kpi.open} open · weighted ${fmtINRShort(kpi.weighted)}`}
        right={<>
          <Btn
            sm
            kind={view === "list" ? "live" : "ghost"}
            onClick={() => {
              const next = view === "list" ? "board" : "list";
              setView(next);
              const base = window.location.hash.split("?")[0] || "#/opps";
              window.location.hash = next === "list" ? `${base}?view=list` : base;
            }}
            title={view === "list" ? "Switch to the stage board" : "Switch to a sortable list across all stages"}
          >
            {Icon.layers} {view === "list" ? "List" : "Board"}
          </Btn>
          {/* Probability sort is a BOARD affordance — it re-sorts within each
              column. In the list every column is sortable by its header, so
              offering both would be two controls fighting over one ordering. */}
          {view === "board" && (
            <Btn sm kind={sortByProb ? "live" : "ghost"} onClick={() => setSortByProb((v) => !v)} title="Sort by AI close probability (highest first)">
              {sortByProb ? "Sorting by probability" : "Sort by probability"}
            </Btn>
          )}
          <Btn icon kind="ghost" sm onClick={list.reload} title="Refresh">{Icon.cycle}</Btn>
          <Btn sm kind="primary" onClick={() => setCreating((v) => !v)}>
            {Icon.plus} {creating ? "Cancel" : "New opp"}
          </Btn>
        </>}
      />

      <div className="ws-content">
        <KPIRow cols={5}>
          <KPI lbl="Open" v={String(kpi.open)} d={`${fmtINRShort(kpi.openValue)} open value`} />
          <KPI lbl="Weighted ₹" v={fmtINRShort(kpi.weighted)} d="stage-weighted, open only" live={kpi.weighted > 0} />
          <KPI lbl="Early stage" v={String(kpi.early)} d="qualification to follow-up" />
          <KPI lbl="Quoting" v={String(kpi.quoting)} d={`${kpi.negotiation} in negotiation`} />
          <KPI lbl="Won" v={fmtINRShort(kpi.wonValue)}
               d={`${kpi.won} won · ${kpi.lost} lost` + (kpi.regretted ? ` · ${kpi.regretted} regretted` : "")}
               dKind={kpi.won ? "up" : ""} />
        </KPIRow>

        {selected && (
          <Card
            title={selected.opportunity_name || "Opportunity"}
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
              ["Name",       selected.opportunity_name || "-"],
              ["Customer",   oppCustomer(selected) || "-"],
              ["Stage",      selected.stage || "-"],
              ["Owner",      oppOwner(selected)],
              ["Value",      oppValue(selected) ? fmtINRShort(oppValue(selected)) : "not set"],
              // The column is a percent, 0 to 100 (default 50); the forecast
              // and the funnel divide it by 100. Multiplying it by 100 here
              // showed the default as 5000%.
              ["Probability (operator)", selected.probability != null ? Math.round(Number(selected.probability)) + "%" : "not set"],
              ["AI probability", (() => {
                if (selected.ai_probability == null) return <span style={{ color: "var(--ink-3)" }}>not predicted yet</span>;
                const c = OPP_PROB_CHIP(selected.ai_probability);
                return <Chip k={c.k}>{c.label}</Chip>;
              })()],
              ["AI reasoning", selected.ai_probability_reasoning || <span style={{ color: "var(--ink-3)" }}>-</span>],
              ["Expected close", selected.close_date || "not set"],
              ["Last update",   selected.updated_at ? ageLabel(selected.updated_at) : "-"],
            ]} />
            {/* opportunities has no notes column; product_summary is its
                free-text field. */}
            {selected.product_summary && (
              <>
                <div className="divider" />
                <pre style={{ font: "inherit", fontSize: 12.5, color: "var(--ink-2)", whiteSpace: "pre-wrap", margin: 0 }}>
                  {selected.product_summary}
                </pre>
              </>
            )}
            <div className="divider" />
            <div style={{ marginTop: 10 }}>
              <OpportunityQuotesPanel opportunityId={selected.id} customerId={selected.customer_id} />
            </div>
            <div style={{ marginTop: 10 }}>
              <OpportunityQuoteRevisions opportunityId={selected.id} customerId={selected.customer_id} opportunityAmount={selected.amount_inr} />
            </div>
            {/* Same follow-up log as the quote drawer's Follow-up tab. An
                opportunity has no contact column, so the contact prefill
                comes from its last touch. Keyed by id so switching
                opportunities starts a fresh form. */}
            <div style={{ marginTop: 10 }}>
              <TouchLog key={selected.id} objectType="opportunity" objectId={selected.id} customerId={selected.customer_id} />
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
        ) : view === "list" ? (
          <OppList
            rows={rows}
            sortKey={sortKey}
            sortDir={sortDir}
            onSort={(k) => {
              // Same column toggles direction; a new column starts descending,
              // because every column here is one where "biggest / newest /
              // furthest along" is the question being asked.
              if (k === sortKey) setSortDir((d) => (d === "desc" ? "asc" : "desc"));
              else { setSortKey(k); setSortDir("desc"); }
            }}
          />
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
                    <div className="mono-sm" style={{ color: "var(--ink-4)", padding: "8px 4px" }}>-</div>
                  ) : (
                    cards.map((kard) => {
                      const v = oppValue(kard);
                      const customer = oppCustomer(kard) || "-";
                      const owner = oppOwner(kard);
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
                          <div className="ti">{kard.opportunity_name || customer}</div>
                          <div className="meta">
                            {customer} · {v ? fmtINRShort(v) : "-"} · {owner}
                          </div>
                          <div className="ft">
                            <Chip k={sc.k}>{sc.label}</Chip>
                            <span title={kard.ai_probability_reasoning || (kard.ai_probability == null ? "Run /api/sales/predict_opportunity to populate" : "")} style={{ marginLeft: 6 }}>
                              <Chip k={prob.k}>{prob.label}</Chip>
                            </span>
                            <span className="mono-sm" style={{ marginLeft: "auto", color: "var(--ink-4)" }}>
                              {created ? ageLabel(created) : "-"}
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
