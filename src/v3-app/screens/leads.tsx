import React, { useEffect, useState } from "react";
import { ageLabel, fmtINRShort, useFetch, useHashParam } from "../lib/helpers";
import { Banner, Btn, Card, Chip, KPI, KPIRow, KV, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { AnvilBackend } from "../lib/api";
import { RBAC } from "../lib/rbac";
import { approvedMembers, memberLabel } from "../components/AccountOwnerPanel";

// ============================================================
// ANVIL v3 — wired Leads
// Wave B · Sales pipeline · top of funnel
// Reads via AnvilBackend.sales.listLeads (api/sales/leads GET)
// Creates via AnvilBackend.sales.createLead (api/sales/leads POST)
//
// Field names are the leads table's own (migration 006), which is what
// the API returns and accepts: company_name, lead_source, allocated_to
// (a member id; the GET adds allocated_to_name), budget_estimate and
// account_id (the customer the lead converts onto).
// ============================================================

const BLANK_DRAFT = {
  company_name: "",
  lead_source: "",
  status: "NEW",
  allocated_to: "",
  account_id: "",
  budget_estimate: "",
};

// A lead is CONVERTED only by the convert action, so the create form
// does not offer it.
const CREATE_STATUSES = ["NEW", "CONTACTED", "QUALIFIED", "REJECTED", "REGRETTED"];

const ownerName = (lead: any): string =>
  lead?.allocated_to_name || (lead?.allocated_to ? String(lead.allocated_to).slice(0, 8) : "");

const LEAD_STATUS_CHIP = (s) => {
  const map = {
    NEW:        { k: "live",  label: "new" },
    CONTACTED:  { k: "info",  label: "contacted" },
    QUALIFIED:  { k: "warn",  label: "qualified" },
    CONVERTED:  { k: "good",  label: "converted" },
    REJECTED:   { k: "bad",   label: "rejected" },
    REGRETTED:  { k: "ghost", label: "regretted" },
  };
  return map[s] || { k: "ghost", label: (s || "—").toLowerCase() };
};

// Audit P9.1: lead-score chip. Maps the numeric ai_score (0-100)
// to a visual band. Bands match the API's calibration tiers:
// hot (>=75), warm (45-74), cool (<45). null score is rendered as
// a faded "score?" so an unscored lead is visually distinct from
// a cool one.
const LEAD_SCORE_CHIP = (score) => {
  if (score == null || !Number.isFinite(Number(score))) {
    return { k: "ghost", label: "score?" };
  }
  const n = Math.round(Number(score));
  if (n >= 75) return { k: "good", label: "hot " + n };
  if (n >= 45) return { k: "warn", label: "warm " + n };
  return { k: "info", label: "cool " + n };
};

const leadRows = (resp) => {
  if (!resp) return [];
  if (Array.isArray(resp)) return resp;
  if (Array.isArray(resp.leads)) return resp.leads;
  if (Array.isArray(resp.rows)) return resp.rows;
  return [];
};

const WiredLeads = () => {
  const list = useFetch(
    () => AnvilBackend?.sales?.listLeads?.() || Promise.resolve({ leads: [] }),
    []
  );

  // Hash-id reader must be called UNCONDITIONALLY at the top of the
  // function so the hook count stays stable across loading / error /
  // success renders. The `selected` lookup that depends on `rows`
  // happens further down, after the rows are computed.
  const selectedId = useHashParam("id");

  const [creating, setCreating] = useState(false);
  const [sortByScore, setSortByScore] = useState(false);
  const [scoringId, setScoringId] = useState<string | null>(null);
  const [convertingId, setConvertingId] = useState<string | null>(null);
  const [linkAccount, setLinkAccount] = useState("");
  const [linking, setLinking] = useState(false);
  const canWrite = RBAC?.canWrite?.("leads") === true;
  // A customer picked for one lead must not carry over to the next.
  useEffect(() => { setLinkAccount(""); }, [selectedId]);

  // Customer accounts, for the create form and for linking an open lead
  // that has none. Loaded only while one of those is on screen.
  const customers = useFetch(
    () => (creating || selectedId)
      ? (AnvilBackend?.customers?.list?.() || Promise.resolve({ customers: [] }))
      : Promise.resolve({ customers: [] }),
    [creating, !!selectedId],
  );
  const customerRows: any[] = Array.isArray(customers.data) ? customers.data : ((customers.data as any)?.customers || []);
  // Approved members, for the owner picker on the create form. The server
  // refuses anyone else.
  const members = useFetch(
    () => creating
      ? (AnvilBackend?.admin?.listMembers?.() || Promise.resolve({ members: [] }))
      : Promise.resolve({ members: [] }),
    [creating],
  );
  const memberOptions = approvedMembers(members.data);

  // Promote a lead to an opportunity via the existing
  // PATCH /api/sales/leads {convert_to_opportunity}. The server opens
  // the opportunity on the lead's own account (opportunities.customer_id
  // is NOT NULL), so a lead with no account is guided to link one first
  // rather than fail opaquely. On success we jump straight to the new
  // opportunity.
  const convertLead = async (lead: any) => {
    if (!lead?.id) return;
    if (!lead.account_id) {
      window.notifyError?.("Link a customer first",
        "This lead has no linked customer account. Link one before converting to an opportunity.");
      return;
    }
    setConvertingId(lead.id);
    try {
      const r: any = await AnvilBackend?.sales?.updateLead?.({
        id: lead.id,
        convert_to_opportunity: true,
      });
      const oppId = r?.lead?.converted_opportunity_id;
      window.notifySuccess?.("Lead converted", "An opportunity was created.");
      if (oppId) window.location.hash = `#/opps?id=${oppId}`;
      else list.reload();
    } catch (err: any) {
      window.notifyError?.("Convert failed", err?.message || String(err));
    } finally {
      setConvertingId(null);
    }
  };
  // Link a customer account to a lead that has none (PATCH account_id;
  // the server refuses an account outside this tenant).
  const linkLeadAccount = async (lead: any) => {
    if (!lead?.id || !linkAccount) return;
    setLinking(true);
    try {
      await AnvilBackend?.sales?.updateLead?.({ id: lead.id, account_id: linkAccount });
      window.notifySuccess?.("Customer linked", "The lead can now be converted.");
      setLinkAccount("");
      list.reload();
    } catch (err: any) {
      window.notifyError?.("Could not link the customer", err?.message || String(err));
    } finally {
      setLinking(false);
    }
  };
  const [draft, setDraft] = useState({ ...BLANK_DRAFT });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);

  if (list.loading) {
    return (
      <div className="ws ws-no-rail">
        <WSTitle eyebrow="Sales · Leads" title="Leads" meta="loading…" />
        <div className="ws-content"><Card><div className="body">Loading leads…</div></Card></div>
      </div>
    );
  }

  if (list.error) {
    return (
      <div className="ws ws-no-rail">
        <WSTitle eyebrow="Sales · Leads" title="Leads" meta="error" />
        <div className="ws-content">
          <Banner kind="bad" icon={Icon.alert} title="Could not load leads"
                  action={<Btn sm onClick={list.reload}>Retry</Btn>}>
            <span className="mono-sm">{String(list.error.message || list.error)}</span>
          </Banner>
        </div>
      </div>
    );
  }

  const rows = leadRows(list.data);
  const total = rows.length;
  // Audit P9.1: optional sort-by-score. The default order is the
  // server's (created_at desc); flipping the chip pulls the highest
  // ai_score to the top with null scores at the bottom.
  const sortedRows = sortByScore
    ? [...rows].sort((a, b) => {
        const av = Number.isFinite(Number(a.ai_score)) ? Number(a.ai_score) : -1;
        const bv = Number.isFinite(Number(b.ai_score)) ? Number(b.ai_score) : -1;
        return bv - av;
      })
    : rows;

  // Resolve the hash-id selection (declared above the early-return
  // guards) against the rows we just loaded. Same detail-card
  // pattern as customers.tsx and source-pos.tsx.
  const selected = selectedId ? rows.find((r) => r.id === selectedId) || null : null;
  const byStatus = (s) => rows.filter((r) => r.status === s).length;
  const newCount = byStatus("NEW");
  const qualifiedCount = byStatus("QUALIFIED");
  const convertedCount = byStatus("CONVERTED");

  const submitNew = async () => {
    if (!draft.company_name.trim()) {
      setSubmitError(new Error("Company is required"));
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      // The leads table's own column names, which POST /api/sales/leads
      // reads. allocated_to is a member id and account_id a customer id;
      // the server checks both against this tenant.
      const payload = {
        company_name: draft.company_name.trim(),
        lead_source: draft.lead_source.trim() || null,
        status: draft.status,
        allocated_to: draft.allocated_to || null,
        account_id: draft.account_id || null,
        budget_estimate: draft.budget_estimate ? Number(draft.budget_estimate) : null,
      };
      await AnvilBackend?.sales?.createLead?.(payload);
      setCreating(false);
      setDraft({ ...BLANK_DRAFT });
      list.reload();
    } catch (err) {
      setSubmitError(err);
    } finally {
      setSubmitting(false);
    }
  };

  const cancelNew = () => {
    setCreating(false);
    setDraft({ ...BLANK_DRAFT });
    setSubmitError(null);
  };

  const customerName = (id: string | null | undefined): string => {
    if (!id) return "";
    const c = customerRows.find((x: any) => x.id === id);
    return (c && (c.customer_name || c.customer_key)) || String(id).slice(0, 8);
  };

  return (
    <>
      <WSTitle
        eyebrow="Sales · Leads"
        title="Leads"
        meta={`${total} total · ${newCount} new · ${qualifiedCount} qualified`}
        right={<>
          <Btn sm kind={sortByScore ? "live" : "ghost"} onClick={() => setSortByScore((v) => !v)} title="Sort leads by AI score (highest first)">
            {sortByScore ? "Sorting by score" : "Sort by score"}
          </Btn>
          <Btn icon kind="ghost" sm onClick={list.reload} title="Refresh">{Icon.cycle}</Btn>
          <Btn sm kind="primary" onClick={() => setCreating((v) => !v)}>
            {Icon.plus} {creating ? "Cancel" : "New lead"}
          </Btn>
        </>}
      />

      <div className="ws-content">
        <KPIRow cols={4}>
          <KPI lbl="Total leads" v={String(total)} d="all-time in scope" />
          <KPI lbl="New" v={String(newCount)} d="awaiting first touch" live={newCount > 0} />
          <KPI lbl="Qualified" v={String(qualifiedCount)} d="ready to promote" />
          <KPI lbl="Converted" v={String(convertedCount)} d="became opportunities" dKind={convertedCount ? "up" : ""} />
        </KPIRow>

        {selected && (
          <Card
            title={selected.company_name || "Lead"}
            eyebrow={"lead detail · " + (selected.id?.slice(0, 8) || "")}
            right={<>
              <Btn sm kind={selected.ai_score == null ? "live" : "ghost"} disabled={scoringId === selected.id}
                   onClick={async () => {
                     setScoringId(selected.id);
                     try { await AnvilBackend?.sales?.scoreLead?.(selected.id); list.reload(); }
                     finally { setScoringId(null); }
                   }}
                   title="Score this lead with the Haiku scorer">
                {scoringId === selected.id ? "Scoring..." : (selected.ai_score == null ? "Score lead" : "Re-score")}
              </Btn>
              {selected.status === "CONVERTED" && selected.converted_opportunity_id ? (
                <Btn sm kind="ghost"
                     onClick={() => { window.location.hash = `#/opps?id=${selected.converted_opportunity_id}`; }}
                     title="Open the opportunity this lead became">
                  {Icon.arrowR} View opportunity
                </Btn>
              ) : (selected.status !== "CONVERTED" && selected.status !== "REJECTED" && selected.status !== "REGRETTED") && (
                <Btn sm kind="primary" disabled={convertingId === selected.id}
                     onClick={() => convertLead(selected)}
                     title="Promote this lead to an opportunity">
                  {convertingId === selected.id ? "Converting..." : "Convert to opportunity"}
                </Btn>
              )}
              <Btn sm kind="ghost" onClick={() => { window.location.hash = "#/leads"; }}>{Icon.x} close</Btn>
            </>}
          >
            <KV rows={[
              ["Company",  selected.company_name || "—"],
              ["Contact",  selected.contact_name || "—"],
              ["Email",    selected.contact_email || "—"],
              ["Phone",    selected.contact_phone || "—"],
              ["Status",   selected.status || "—"],
              ["Source",   selected.lead_source || "—"],
              ["Owner",    ownerName(selected) || "—"],
              ["Customer", selected.account_id ? customerName(selected.account_id) : <span style={{ color: "var(--ink-3)" }}>not linked</span>],
              ["Value",    selected.budget_estimate != null ? fmtINRShort(Number(selected.budget_estimate)) : "—"],
              ["AI score", (() => {
                if (selected.ai_score == null) return <span style={{ color: "var(--ink-3)" }}>not scored yet</span>;
                const sc = LEAD_SCORE_CHIP(selected.ai_score);
                return <Chip k={sc.k}>{sc.label}</Chip>;
              })()],
              ["Reasoning", selected.ai_score_reasoning || <span style={{ color: "var(--ink-3)" }}>—</span>],
              ["Created",  selected.created_at ? ageLabel(selected.created_at) : "—"],
            ]} />
            {/* A lead converts onto its customer account. One with no
                account can be linked here, so it can be converted. */}
            {!selected.account_id && canWrite && selected.status !== "CONVERTED" && (
              <>
                <div className="divider" />
                <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <select
                    className="select"
                    aria-label="Customer account"
                    value={linkAccount}
                    disabled={linking}
                    onChange={(ev) => setLinkAccount(ev.target.value)}
                    style={{ minWidth: 220 }}
                  >
                    <option value="">{customers.loading ? "loading…" : "Pick a customer…"}</option>
                    {customerRows.map((c: any) => (
                      <option key={c.id} value={c.id}>{c.customer_name || c.customer_key || c.id?.slice(0, 8)}</option>
                    ))}
                  </select>
                  <Btn sm kind="primary" disabled={!linkAccount || linking} onClick={() => linkLeadAccount(selected)}>
                    {linking ? "Linking…" : "Link customer"}
                  </Btn>
                </div>
              </>
            )}
            {selected.notes && (
              <>
                <div className="divider" />
                <div className="mono-sm" style={{ color: "var(--ink-3)", marginBottom: 4 }}>Notes</div>
                <pre style={{ font: "inherit", fontSize: 12.5, color: "var(--ink-2)", whiteSpace: "pre-wrap", margin: 0 }}>
                  {selected.notes}
                </pre>
              </>
            )}
          </Card>
        )}

        {creating && (
          <Card title="New lead" eyebrow="quick capture">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12 }}>
              <label className="mono-sm" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span>Company *</span>
                <input
                  className="input"
                  value={draft.company_name}
                  onChange={(ev) => setDraft({ ...draft, company_name: ev.target.value })}
                  placeholder="Customer or company"
                />
              </label>
              <label className="mono-sm" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span>Source</span>
                <input
                  className="input"
                  value={draft.lead_source}
                  onChange={(ev) => setDraft({ ...draft, lead_source: ev.target.value })}
                  placeholder="Inbound · referral · trade show…"
                />
              </label>
              <label className="mono-sm" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span>Status</span>
                <select
                  className="input"
                  value={draft.status}
                  onChange={(ev) => setDraft({ ...draft, status: ev.target.value })}
                >
                  {CREATE_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
              <label className="mono-sm" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span>Owner</span>
                <select
                  className="input"
                  value={draft.allocated_to}
                  onChange={(ev) => setDraft({ ...draft, allocated_to: ev.target.value })}
                >
                  <option value="">{members.loading ? "loading…" : "Unassigned"}</option>
                  {memberOptions.map((m) => <option key={m.user_id} value={m.user_id}>{memberLabel(m)}</option>)}
                </select>
              </label>
              <label className="mono-sm" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span>Customer account</span>
                <select
                  className="input"
                  value={draft.account_id}
                  onChange={(ev) => setDraft({ ...draft, account_id: ev.target.value })}
                >
                  <option value="">{customers.loading ? "loading…" : "Not linked yet"}</option>
                  {customerRows.map((c: any) => (
                    <option key={c.id} value={c.id}>{c.customer_name || c.customer_key || c.id?.slice(0, 8)}</option>
                  ))}
                </select>
              </label>
              <label className="mono-sm" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span>Estimated value (₹)</span>
                <input
                  className="input"
                  type="number"
                  min="0"
                  value={draft.budget_estimate}
                  onChange={(ev) => setDraft({ ...draft, budget_estimate: ev.target.value })}
                  placeholder="0"
                />
              </label>
            </div>
            {submitError && (
              <div style={{ marginTop: 12 }}>
                <Banner kind="bad" icon={Icon.alert} title="Could not save lead">
                  <span className="mono-sm">{String(submitError.message || submitError)}</span>
                </Banner>
              </div>
            )}
            <div className="divider" />
            <div className="row" style={{ alignItems: "center" }}>
              <span style={{ flex: 1 }} />
              <Btn sm kind="ghost" onClick={cancelNew} disabled={submitting}>cancel</Btn>
              <Btn sm kind="primary" onClick={submitNew} disabled={submitting}>
                {submitting ? "saving…" : "save lead"}
              </Btn>
            </div>
          </Card>
        )}

        <Card flush>
          {rows.length === 0 ? (
            <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
              No leads yet.{" "}
              <button type="button" onClick={() => setCreating(true)} className="link-btn" style={{ color: "var(--ink)", cursor: "pointer", textDecoration: "underline" }}>Create one</button>
            </div>
          ) : (
            <table className="tbl">
              <thead><tr>
                <th>Lead</th>
                <th>Score</th>
                <th>Source</th>
                <th>Status</th>
                <th>Owner</th>
                <th>Last touch</th>
                <th className="r">Value</th>
              </tr></thead>
              <tbody>
                {sortedRows.slice(0, 200).map((r) => {
                  const sc = LEAD_STATUS_CHIP(r.status);
                  const score = LEAD_SCORE_CHIP(r.ai_score);
                  const value = Number(r.budget_estimate) || 0;
                  const last = r.last_touch_at || r.updated_at || r.created_at;
                  return (
                    <tr
                      key={r.id}
                      tabIndex={0}
                      onClick={() => window.location.hash = `#/leads?id=${r.id}`}
                      onKeyDown={(ev) => {
                        if (ev.key === "Enter" || ev.key === " ") {
                          ev.preventDefault();
                          window.location.hash = `#/leads?id=${r.id}`;
                        }
                      }}
                      style={{ cursor: "pointer" }}
                    >
                      <td><span className="pri">{r.company_name || (r.id ? r.id.slice(0, 8) : "—")}</span></td>
                      <td title={r.ai_score_reasoning || (r.ai_score == null ? "Run /api/sales/score_lead to populate" : "")}>
                        <Chip k={score.k}>{score.label}</Chip>
                      </td>
                      <td className="mono-sm">{r.lead_source || "—"}</td>
                      <td><Chip k={sc.k}>{sc.label}</Chip></td>
                      <td className="mono-sm">{ownerName(r) || "—"}</td>
                      <td className="mono-sm">{last ? ageLabel(last) : "—"}</td>
                      <td className="r mono">{value ? fmtINRShort(value) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {rows.length > 200 && (
            <div className="mono-sm" style={{ padding: 12, textAlign: "center", color: "var(--ink-3)", borderTop: "1px solid var(--hairline-2)" }}>
              Showing 200 of {rows.length} leads.
            </div>
          )}
        </Card>
      </div>
    </>
  );
};


export default WiredLeads;
