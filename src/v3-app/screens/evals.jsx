import React, { useEffect, useMemo, useState } from "react";
import { ageLabel } from "../lib/helpers.js";
import { Banner, Btn, Card, Chip, KPI, KPIRow, WSTitle } from "../lib/primitives.jsx";
import { Icon } from "../lib/icons.jsx";
import { ObaraBackend } from "../lib/api.js";
import { RBAC } from "../lib/rbac.js";

// ============================================================
// ANVIL v3 — Eval Suites CRUD overlay
// Adds Cases editor (list / add / edit / delete) and a manual
// Run-cases form on top of the read-only dashboard in
// wired-evals-e.jsx. Wins via load-order.
//
// Backend (ObaraBackend.eval):
//   dashboard(suite?)
//   listCases(suite?)
//   upsertCase({ suite, case_id, description?, documents?, expected, enabled? })
//   deleteCase(id)
//   run(suite, cases)              -> /api/eval/run, body { suite, cases }
// Server-side run scores expected vs actual; caller supplies both.
// ============================================================

const evalReadParams = () => {
  const hash = window.location.hash || "";
  const q = hash.split("?")[1];
  return new URLSearchParams(q || "");
};

const evalCrudFetch = async (path, opts = {}) => {
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

const EVAL_CASE_BLANK = () => ({
  suite: "",
  case_id: "",
  description: "",
  enabled: true,
  documents_text: "[]",
  expected_text: "{\n  \"poNumber\": \"\",\n  \"grandTotal\": 0,\n  \"lineItems\": []\n}",
});

const evalCrudRowsOf = (resp, key) => {
  if (!resp) return [];
  if (Array.isArray(resp)) return resp;
  if (key && Array.isArray(resp[key])) return resp[key];
  if (Array.isArray(resp.rows)) return resp.rows;
  return [];
};

const tryParseJson = (s, fallback) => {
  try { return JSON.parse(s); } catch (_) { return fallback; }
};

const WiredEvalsCRUD = () => {
  const { useState: u, useEffect: e, useMemo: m } = React;
  const params = evalReadParams();
  const editId = params.get("id");
  const isNew = params.get("new") === "1";
  const isRun = params.get("run") === "1";
  const initialTab = params.get("tab") || (isNew || editId ? "cases" : "dashboard");

  const [tab, setTab] = u(initialTab);
  const [dash, setDash] = u({ data: null, loading: true, error: null });
  const [cases, setCases] = u({ rows: [], loading: true, error: null });
  const [suiteFilter, setSuiteFilter] = u("");
  const [editing, setEditing] = u(null);
  const [form, setForm] = u(null);
  const [busy, setBusy] = u(false);
  const [err, setErr] = u(null);
  const [okMsg, setOkMsg] = u(null);
  const [delBusy, setDelBusy] = u(null);

  // Run-cases panel state
  const [running, setRunning] = u(false);
  const [runForm, setRunForm] = u({ suite: "", actuals_text: "{\n  \"caseId\": {\n    \"poNumber\": \"...\"\n  }\n}" });
  const [runResult, setRunResult] = u(null);

  const canWrite = RBAC?.canDo?.("evals.write") ?? true;
  const canAdmin = RBAC?.canDo?.("evals.admin") ?? canWrite;

  const reloadDash = () => {
    setDash((s) => ({ ...s, loading: true }));
    Promise.resolve(ObaraBackend?.eval?.dashboard?.(suiteFilter || undefined)
                    || evalCrudFetch("/api/eval/dashboard" + (suiteFilter ? "?suite=" + encodeURIComponent(suiteFilter) : "")))
      .then((data) => setDash({ data, loading: false, error: null }))
      .catch((error) => setDash({ data: null, loading: false, error }));
  };

  const reloadCases = () => {
    setCases((s) => ({ ...s, loading: true }));
    Promise.resolve(ObaraBackend?.eval?.listCases?.(suiteFilter || undefined)
                    || evalCrudFetch("/api/eval/cases" + (suiteFilter ? "?suite=" + encodeURIComponent(suiteFilter) : "")))
      .then((r) => {
        const rows = Array.isArray(r) ? r : (r?.cases || r?.rows || []);
        setCases({ rows, loading: false, error: null });
      })
      .catch((error) => setCases({ rows: [], loading: false, error }));
  };

  e(() => { reloadDash(); reloadCases(); }, [suiteFilter]);

  e(() => {
    if (isNew) {
      setForm({ ...EVAL_CASE_BLANK(), suite: suiteFilter || "" });
      setEditing("__new__");
      setTab("cases");
      return;
    }
    if (editId) {
      const found = cases.rows.find((c) => c.id === editId);
      if (found) {
        setForm({
          ...EVAL_CASE_BLANK(),
          ...found,
          documents_text: JSON.stringify(found.documents || [], null, 2),
          expected_text: JSON.stringify(found.expected || {}, null, 2),
          enabled: found.enabled !== false,
        });
        setEditing(editId);
        setTab("cases");
      }
    }
    if (isRun) {
      setRunning(true);
      setTab("cases");
    }
  }, [isNew, editId, isRun, cases.rows.length]);

  const closeForm = () => {
    setEditing(null);
    setForm(null);
    setRunning(false);
    setRunResult(null);
    setErr(null);
    const hash = window.location.hash.split("?")[0];
    window.location.hash = hash;
  };

  const submit = async () => {
    if (!form) return;
    if (!form.suite || !form.case_id) {
      setErr(new Error("Suite and case_id are required"));
      return;
    }
    const documents = tryParseJson(form.documents_text, undefined);
    if (documents === undefined) {
      setErr(new Error("Documents must be valid JSON (e.g. [])"));
      return;
    }
    const expected = tryParseJson(form.expected_text, undefined);
    if (expected === undefined) {
      setErr(new Error("Expected must be valid JSON"));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const payload = {
        suite: form.suite.trim(),
        case_id: form.case_id.trim(),
        description: form.description || null,
        documents,
        expected,
        enabled: form.enabled !== false,
      };
      await (ObaraBackend?.eval?.upsertCase?.(payload)
             || evalCrudFetch("/api/eval/cases", { method: "POST", body: payload }));
      setOkMsg(editing === "__new__" ? "Case created" : "Case updated");
      closeForm();
      reloadCases();
    } catch (error) {
      setErr(error);
    } finally {
      setBusy(false);
    }
  };

  const removeCase = async (id) => {
    if (!confirm("Delete this eval case? This cannot be undone.")) return;
    setDelBusy(id);
    setErr(null);
    try {
      await (ObaraBackend?.eval?.deleteCase?.(id)
             || evalCrudFetch("/api/eval/cases?id=" + encodeURIComponent(id), { method: "DELETE" }));
      setOkMsg("Case deleted");
      reloadCases();
    } catch (error) {
      setErr(error);
    } finally {
      setDelBusy(null);
    }
  };

  const submitRun = async () => {
    if (!runForm.suite) {
      setErr(new Error("Pick a suite to run"));
      return;
    }
    const actualsByCase = tryParseJson(runForm.actuals_text, undefined);
    if (actualsByCase === undefined || typeof actualsByCase !== "object") {
      setErr(new Error("Actuals must be a JSON object keyed by case_id"));
      return;
    }
    const suiteCases = cases.rows.filter((c) => c.suite === runForm.suite && c.enabled !== false);
    if (suiteCases.length === 0) {
      setErr(new Error(`No enabled cases for suite "${runForm.suite}"`));
      return;
    }
    const runCases = suiteCases.map((c) => ({
      id: c.case_id,
      documents: c.documents || [],
      expected: c.expected || {},
      actual: actualsByCase[c.case_id] || null,
    }));
    setBusy(true);
    setErr(null);
    setRunResult(null);
    try {
      const result = await (ObaraBackend?.eval?.run?.(runForm.suite, runCases)
                            || evalCrudFetch("/api/eval/run", { method: "POST", body: { suite: runForm.suite, cases: runCases } }));
      setRunResult(result);
      reloadDash();
    } catch (error) {
      setErr(error);
    } finally {
      setBusy(false);
    }
  };

  const filteredCases = m(() => {
    const rows = cases.rows;
    if (!suiteFilter) return rows;
    return rows.filter((c) => c.suite === suiteFilter);
  }, [cases.rows, suiteFilter]);

  const allSuites = m(() => {
    const s = new Set();
    for (const c of cases.rows) if (c.suite) s.add(c.suite);
    return Array.from(s).sort();
  }, [cases.rows]);

  const data = dash.data || {};
  const runs = evalCrudRowsOf(data.runs || data.recent || data, "runs");
  const fields = evalCrudRowsOf(data.fields || data.heatmap, "fields");

  const last30 = runs.slice(0, 30);
  const passCount = last30.filter((r) => (r.status || "").toUpperCase() === "PASS" || r.passed === true).length;
  const passRate = last30.length ? (passCount / last30.length) : null;
  const accuracies = last30.map((r) => Number(r.accuracy ?? r.score ?? 0)).filter((n) => !Number.isNaN(n) && n > 0);
  const avgAccuracy = accuracies.length ? (accuracies.reduce((s, n) => s + n, 0) / accuracies.length) : null;
  const drift = data.drift != null ? Number(data.drift) : (data.drift_score != null ? Number(data.drift_score) : null);
  const ranked = fields
    .slice()
    .map((f) => {
      const fail = f.failure_rate != null ? Number(f.failure_rate) : (f.pass_rate != null ? 1 - Number(f.pass_rate) : null);
      return { ...f, _failure: fail };
    })
    .filter((f) => f._failure != null)
    .sort((a, b) => b._failure - a._failure)
    .slice(0, 20);

  return (
    <>
      <WSTitle
        eyebrow="Quality · Eval"
        title="Eval suites"
        meta={`${cases.rows.length} cases · ${runs.length} runs`}
        right={<>
          <Btn icon kind="ghost" sm onClick={() => { reloadDash(); reloadCases(); }} title="Refresh">{Icon.cycle}</Btn>
          {canWrite && (
            <>
              <Btn sm onClick={() => { setRunning(true); setRunResult(null); }} title="Run a suite against pasted actuals">
                {Icon.bolt} Run suite
              </Btn>
              <Btn sm kind="primary" onClick={() => { window.location.hash = "#/evals?new=1"; }}>
                {Icon.plus} New case
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
        {dash.error && (
          <Banner kind="warn" icon={Icon.alert} title="Dashboard load failed">
            <span className="mono-sm">{String(dash.error.message || dash.error)}</span>
          </Banner>
        )}

        <KPIRow cols={4}>
          <KPI lbl="Pass rate · last 30" v={passRate != null ? `${(passRate * 100).toFixed(1)}%` : "—"} d={`${passCount}/${last30.length} runs`} dKind={passRate != null && passRate < 0.9 ? "down" : "up"} />
          <KPI lbl="Recent runs" v={String(runs.length)} d="all suites" />
          <KPI lbl="Avg accuracy" v={avgAccuracy != null ? avgAccuracy.toFixed(3) : "—"} d="weighted" />
          <KPI lbl="Drift" v={drift != null ? drift.toFixed(2) : "—"} d="vs baseline" dKind={drift != null && drift > 0.05 ? "down" : ""} />
        </KPIRow>

        <div style={{ display: "flex", gap: 12, alignItems: "center", margin: "8px 0" }}>
          <div className="tabs">
            {[
              ["dashboard", "Dashboard"],
              ["cases",     `Cases (${cases.rows.length})`],
            ].map(([k, label]) => (
              <button key={k} className={`tab ${tab === k ? "on" : ""}`} onClick={() => setTab(k)}>
                {label}
              </button>
            ))}
          </div>
          <span style={{ flex: 1 }} />
          <label className="lbl mono-sm" style={{ display: "flex", gap: 6, alignItems: "center" }}>
            Suite
            <select value={suiteFilter} onChange={(ev) => setSuiteFilter(ev.target.value)}>
              <option value="">all</option>
              {allSuites.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
        </div>

        {tab === "dashboard" && (
          <>
            <Card title="Recent runs" eyebrow="last 50 across suites" flush>
              {runs.length === 0 ? (
                <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>No eval runs yet.</div>
              ) : (
                <table className="tbl">
                  <thead><tr>
                    <th>Suite</th>
                    <th>Started</th>
                    <th>Status</th>
                    <th className="r">Duration</th>
                    <th className="r">Pass</th>
                    <th className="r">Fail</th>
                  </tr></thead>
                  <tbody>
                    {runs.slice(0, 50).map((r) => {
                      const status = (r.status || "").toUpperCase();
                      const k = status === "PASS" || r.passed === true ? "good" : status === "FAIL" || r.passed === false ? "bad" : status === "RUNNING" ? "live" : "ghost";
                      return (
                        <tr key={r.id || r.run_id}>
                          <td className="mono"><span className="pri">{r.suite || r.suite_name || "—"}</span></td>
                          <td className="mono-sm">{r.started_at ? ageLabel(r.started_at) : (r.created_at ? ageLabel(r.created_at) : "—")}</td>
                          <td><Chip k={k}>{(r.status || (r.passed === true ? "pass" : r.passed === false ? "fail" : "—")).toLowerCase()}</Chip></td>
                          <td className="r mono">{r.duration_ms != null ? `${Number(r.duration_ms).toLocaleString("en-IN")} ms` : "—"}</td>
                          <td className="r mono">{r.pass_count != null ? r.pass_count : (r.passed != null ? r.passed : "—")}</td>
                          <td className="r mono">{r.fail_count != null ? r.fail_count : (r.failed != null ? r.failed : "—")}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </Card>

            <Card title="Field heatmap · top 20" eyebrow="ranked by failure rate">
              {ranked.length === 0 ? (
                <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>No field-level signal yet.</div>
              ) : (
                <table className="tbl">
                  <thead><tr>
                    <th>Field</th>
                    <th className="r">Failure rate</th>
                    <th className="r">Cases</th>
                    <th>Bar</th>
                  </tr></thead>
                  <tbody>
                    {ranked.map((f) => (
                      <tr key={f.field || f.name}>
                        <td className="mono"><span className="pri">{f.field || f.name || "—"}</span></td>
                        <td className="r mono" style={{ color: f._failure > 0.1 ? "var(--rust)" : f._failure > 0.05 ? "var(--amber-2)" : "var(--ink)" }}>
                          {(f._failure * 100).toFixed(1)}%
                        </td>
                        <td className="r mono">{f.cases != null ? f.cases : (f.case_count != null ? f.case_count : "—")}</td>
                        <td>
                          <div style={{ height: 8, background: "var(--paper-2)", border: "1px solid var(--hairline)" }}>
                            <div style={{ height: "100%", width: `${Math.min(100, f._failure * 100)}%`, background: f._failure > 0.1 ? "var(--rust)" : "var(--amber-2)" }} />
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </>
        )}

        {tab === "cases" && (
          <Card flush title={`Eval cases${suiteFilter ? ` · ${suiteFilter}` : ""}`} eyebrow="golden test catalogue">
            {cases.loading ? (
              <div className="body" style={{ padding: 22 }}>Loading cases…</div>
            ) : cases.error ? (
              <div className="body" style={{ padding: 22, color: "var(--rust)" }}>{String(cases.error.message || cases.error)}</div>
            ) : filteredCases.length === 0 ? (
              <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
                No cases yet. Click "New case" to add one.
              </div>
            ) : (
              <table className="tbl">
                <thead><tr>
                  <th>Suite</th>
                  <th>Case ID</th>
                  <th>Description</th>
                  <th className="r">Docs</th>
                  <th className="r">Expected fields</th>
                  <th>Enabled</th>
                  <th></th>
                </tr></thead>
                <tbody>
                  {filteredCases.map((c) => {
                    const docCount = Array.isArray(c.documents) ? c.documents.length : 0;
                    const expFieldCount = c.expected && typeof c.expected === "object" ? Object.keys(c.expected).length : 0;
                    return (
                      <tr key={c.id}>
                        <td className="mono"><span className="pri">{c.suite}</span></td>
                        <td className="mono-sm">{c.case_id}</td>
                        <td>{c.description || "—"}</td>
                        <td className="r mono">{docCount}</td>
                        <td className="r mono">{expFieldCount}</td>
                        <td><Chip k={c.enabled !== false ? "good" : "ghost"}>{c.enabled !== false ? "on" : "off"}</Chip></td>
                        <td style={{ whiteSpace: "nowrap" }}>
                          {canWrite && (
                            <Btn sm kind="ghost" onClick={() => { window.location.hash = `#/evals?id=${c.id}`; }}>
                              {Icon.edit} Edit
                            </Btn>
                          )}
                          {canAdmin && (
                            <Btn sm kind="ghost"
                                 disabled={delBusy === c.id}
                                 onClick={() => removeCase(c.id)}>
                              {delBusy === c.id ? "…" : Icon.trash}
                            </Btn>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </Card>
        )}
      </div>

      {editing && form && (
        <div className="modal-backdrop" onClick={closeForm}>
          <div className="modal" onClick={(ev) => ev.stopPropagation()} style={{ maxWidth: 760 }}>
            <div className="modal-h">
              <span className="ti">{editing === "__new__" ? "New eval case" : "Edit eval case"}</span>
              <Btn icon kind="ghost" sm onClick={closeForm}>{Icon.close}</Btn>
            </div>
            <div className="modal-body" style={{ display: "grid", gap: 10 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <label className="lbl">Suite
                  <input type="text" placeholder="po-extraction" value={form.suite}
                         onChange={(ev) => setForm({ ...form, suite: ev.target.value })} />
                </label>
                <label className="lbl">Case ID
                  <input type="text" placeholder="hyundai-2026-01" value={form.case_id}
                         onChange={(ev) => setForm({ ...form, case_id: ev.target.value })} />
                </label>
              </div>

              <label className="lbl">Description
                <input type="text" value={form.description || ""}
                       onChange={(ev) => setForm({ ...form, description: ev.target.value })} />
              </label>

              <label className="lbl mono-sm">Documents (JSON array)
                <textarea rows={3} className="mono"
                          value={form.documents_text}
                          onChange={(ev) => setForm({ ...form, documents_text: ev.target.value })} />
              </label>

              <label className="lbl mono-sm">Expected (JSON object)
                <textarea rows={10} className="mono"
                          value={form.expected_text}
                          onChange={(ev) => setForm({ ...form, expected_text: ev.target.value })} />
              </label>

              <label className="lbl" style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input type="checkbox" checked={form.enabled !== false}
                       onChange={(ev) => setForm({ ...form, enabled: ev.target.checked })} />
                Enabled
              </label>

              <div className="hint mono-sm" style={{ color: "var(--ink-3)" }}>
                Server scores expected vs actual on poNumber, poDate, customer, grandTotal,
                and lineItems[].partNo / qty / rate / hsn. Numeric fields use a 0.5%
                relative tolerance.
              </div>
            </div>
            <div className="modal-f">
              <Btn kind="ghost" onClick={closeForm}>Cancel</Btn>
              <Btn kind="primary" disabled={busy} onClick={submit}>
                {busy ? "Saving…" : (editing === "__new__" ? "Create case" : "Save changes")}
              </Btn>
            </div>
          </div>
        </div>
      )}

      {running && (
        <div className="modal-backdrop" onClick={closeForm}>
          <div className="modal" onClick={(ev) => ev.stopPropagation()} style={{ maxWidth: 720 }}>
            <div className="modal-h">
              <span className="ti">Run suite</span>
              <Btn icon kind="ghost" sm onClick={closeForm}>{Icon.close}</Btn>
            </div>
            <div className="modal-body" style={{ display: "grid", gap: 10 }}>
              <label className="lbl">Suite
                <select value={runForm.suite}
                        onChange={(ev) => setRunForm({ ...runForm, suite: ev.target.value })}>
                  <option value="">— pick suite —</option>
                  {allSuites.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>

              <label className="lbl mono-sm">
                Actuals by case_id (JSON object)
                <textarea rows={12} className="mono"
                          value={runForm.actuals_text}
                          onChange={(ev) => setRunForm({ ...runForm, actuals_text: ev.target.value })} />
              </label>

              <div className="hint mono-sm" style={{ color: "var(--ink-3)" }}>
                Paste extraction outputs keyed by case_id. The server scores each enabled
                case against its stored expected. Cases with no actual are skipped.
              </div>

              {runResult && (
                <div className="mono-sm" style={{
                  background: "var(--paper-2)",
                  border: "1px solid var(--hairline)",
                  padding: 10,
                  whiteSpace: "pre-wrap",
                  maxHeight: 240,
                  overflow: "auto",
                }}>
                  {JSON.stringify(runResult, null, 2)}
                </div>
              )}
            </div>
            <div className="modal-f">
              <Btn kind="ghost" onClick={closeForm}>Close</Btn>
              <Btn kind="primary" disabled={busy} onClick={submitRun}>
                {busy ? "Running…" : "Run + score"}
              </Btn>
            </div>
          </div>
        </div>
      )}
    </>
  );
};


export default WiredEvalsCRUD;
