import React, { useEffect, useState } from "react";
import { ageLabel, fmtINRShort, useFetch, useHashParam } from "../lib/helpers";
import { Banner, Btn, Card, Chip, KPI, KPIRow, KV, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { ObaraBackend } from "../lib/api";

// ============================================================
// ANVIL v3 — wired Leads
// Wave B · Sales pipeline · top of funnel
// Reads via ObaraBackend.sales.listLeads (api/sales/leads GET)
// Creates via ObaraBackend.sales.createLead (api/sales/leads POST)
// ============================================================

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

const leadRows = (resp) => {
  if (!resp) return [];
  if (Array.isArray(resp)) return resp;
  if (Array.isArray(resp.leads)) return resp.leads;
  if (Array.isArray(resp.rows)) return resp.rows;
  return [];
};

const WiredLeads = () => {
  const list = useFetch(
    () => ObaraBackend?.sales?.listLeads?.() || Promise.resolve({ leads: [] }),
    []
  );

  // Hash-id reader must be called UNCONDITIONALLY at the top of the
  // function so the hook count stays stable across loading / error /
  // success renders. The `selected` lookup that depends on `rows`
  // happens further down, after the rows are computed.
  const selectedId = useHashParam("id");

  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({
    name: "",
    source: "",
    status: "NEW",
    owner: "",
    estimated_value: "",
  });
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

  // Resolve the hash-id selection (declared above the early-return
  // guards) against the rows we just loaded. Same detail-card
  // pattern as customers.tsx and source-pos.tsx.
  const selected = selectedId ? rows.find((r) => r.id === selectedId) || null : null;
  const byStatus = (s) => rows.filter((r) => r.status === s).length;
  const newCount = byStatus("NEW");
  const qualifiedCount = byStatus("QUALIFIED");
  const convertedCount = byStatus("CONVERTED");

  const submitNew = async () => {
    if (!draft.name.trim()) {
      setSubmitError(new Error("Lead name is required"));
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      // Schema-drift fix: /api/sales/leads POST requires
      // `company_name` (the leads table's NOT NULL column). The
      // form labels its single text field "Name" which we treat as
      // the company name; the screen used to send it as `name` and
      // the endpoint rejected with "company_name required". Send
      // both the canonical column AND a `name` alias so any older
      // proxy that reads the legacy field still resolves it.
      // `estimated_value_inr` is the column; we keep `estimated_value`
      // too for the same reason.
      const payload = {
        company_name: draft.name.trim(),
        name: draft.name.trim(),
        source: draft.source.trim() || null,
        status: draft.status,
        allocated_to: draft.owner.trim() || null,
        owner: draft.owner.trim() || null,
        budget_estimate: draft.estimated_value ? Number(draft.estimated_value) : null,
        estimated_value: draft.estimated_value ? Number(draft.estimated_value) : null,
      };
      await ObaraBackend?.sales?.createLead?.(payload);
      setCreating(false);
      setDraft({ name: "", source: "", status: "NEW", owner: "", estimated_value: "" });
      list.reload();
    } catch (err) {
      setSubmitError(err);
    } finally {
      setSubmitting(false);
    }
  };

  const cancelNew = () => {
    setCreating(false);
    setDraft({ name: "", source: "", status: "NEW", owner: "", estimated_value: "" });
    setSubmitError(null);
  };

  return (
    <>
      <WSTitle
        eyebrow="Sales · Leads"
        title="Leads"
        meta={`${total} total · ${newCount} new · ${qualifiedCount} qualified`}
        right={<>
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
            title={selected.name || selected.company || "Lead"}
            eyebrow={"lead detail · " + (selected.id?.slice(0, 8) || "")}
            right={<Btn sm kind="ghost" onClick={() => { window.location.hash = "#/leads"; }}>{Icon.x} close</Btn>}
          >
            <KV rows={[
              ["Name",     selected.name || "—"],
              ["Company",  selected.company || "—"],
              ["Email",    selected.email || "—"],
              ["Phone",    selected.phone || "—"],
              ["Status",   selected.status || "—"],
              ["Source",   selected.source || "—"],
              ["Owner",    selected.owner || selected.assigned_to || "—"],
              ["Value",    (() => {
                // The schema column is `budget_estimate`; older
                // payload paths exposed `estimated_value` /
                // `estimated_value_inr`. Try each to be tolerant of
                // either backend version.
                const v = selected.budget_estimate ?? selected.estimated_value ?? selected.estimated_value_inr;
                return v != null ? fmtINRShort(Number(v)) : "—";
              })()],
              ["Created",  selected.created_at ? ageLabel(selected.created_at) : "—"],
            ]} />
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
                <span>Name *</span>
                <input
                  className="input"
                  value={draft.name}
                  onChange={(ev) => setDraft({ ...draft, name: ev.target.value })}
                  placeholder="Customer or company"
                />
              </label>
              <label className="mono-sm" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span>Source</span>
                <input
                  className="input"
                  value={draft.source}
                  onChange={(ev) => setDraft({ ...draft, source: ev.target.value })}
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
                  <option value="NEW">NEW</option>
                  <option value="CONTACTED">CONTACTED</option>
                  <option value="QUALIFIED">QUALIFIED</option>
                  <option value="CONVERTED">CONVERTED</option>
                  <option value="REJECTED">REJECTED</option>
                  <option value="REGRETTED">REGRETTED</option>
                </select>
              </label>
              <label className="mono-sm" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span>Owner</span>
                <input
                  className="input"
                  value={draft.owner}
                  onChange={(ev) => setDraft({ ...draft, owner: ev.target.value })}
                  placeholder="Sales rep name"
                />
              </label>
              <label className="mono-sm" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span>Estimated value (₹)</span>
                <input
                  className="input"
                  type="number"
                  min="0"
                  value={draft.estimated_value}
                  onChange={(ev) => setDraft({ ...draft, estimated_value: ev.target.value })}
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
                <th>Source</th>
                <th>Status</th>
                <th>Owner</th>
                <th>Last touch</th>
                <th className="r">Value</th>
              </tr></thead>
              <tbody>
                {rows.slice(0, 200).map((r) => {
                  const sc = LEAD_STATUS_CHIP(r.status);
                  const value = Number(r.estimated_value) || 0;
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
                      <td><span className="pri">{r.name || r.customer_name || (r.id ? r.id.slice(0, 8) : "—")}</span></td>
                      <td className="mono-sm">{r.source || "—"}</td>
                      <td><Chip k={sc.k}>{sc.label}</Chip></td>
                      <td className="mono-sm">{r.owner || "—"}</td>
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
