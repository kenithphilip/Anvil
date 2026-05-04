// Autonomous-agent goals screen.
//
// Shows what the agent is working on, what it has done, and lets an
// authorised operator arm a new goal or pause/resume/cancel an existing
// one. The runner itself is server-side (api/agents/run.js, fired by
// the hourly Vercel cron); this screen is purely the operator surface.

import React, { useEffect, useMemo, useState } from "react";
import { ageLabel } from "../lib/helpers";
import { Banner, Btn, Card, Chip, KPI, KPIRow, WSTabs, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { ObaraBackend } from "../lib/api";

const GOAL_TYPES = [
  {
    id: "quote_accept_within_14d",
    label: "Drive a quote to acceptance",
    detail: "Nudges a draft or sent quote toward customer acceptance, escalates to the owner if it stalls.",
    objectType: "order",
  },
  {
    id: "ar_collect_by_due_plus_7",
    label: "Collect on an unpaid invoice",
    detail: "Sends a dunning sequence (gentle, firm, final) until paid or 7 days past the due date. Works on either an `invoice` (non-India) or `einvoice` (GSTN).",
    objectType: "invoice",
  },
  {
    id: "missing_doc_followup",
    label: "Follow up on missing documents",
    detail: "Asks the customer for required docs that intake is waiting on, escalates after the cooldown.",
    objectType: "order",
  },
];

const STATUS_TABS = [
  { id: "active",    label: "Active" },
  { id: "completed", label: "Completed" },
  { id: "cancelled", label: "Cancelled" },
  { id: "failed",    label: "Failed" },
  { id: "all",       label: "All" },
];

const statusChip = (s: string) => {
  if (s === "active")    return <Chip k="live">active</Chip>;
  if (s === "paused")    return <Chip k="warn">paused</Chip>;
  if (s === "completed") return <Chip k="live">completed</Chip>;
  if (s === "cancelled") return <Chip k="ghost">cancelled</Chip>;
  if (s === "failed")    return <Chip k="bad">failed</Chip>;
  return <Chip k="ghost">{s}</Chip>;
};

const goalTypeLabel = (id: string) => GOAL_TYPES.find((g) => g.id === id)?.label || id;

const WiredAgents = () => {
  const [tab, setTab] = useState("active");
  const [goals, setGoals] = useState<any[]>([]);
  const [steps, setSteps] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<{ kind: string; msg: string } | null>(null);
  const [armForm, setArmForm] = useState({ goal_type: GOAL_TYPES[0].id, object_id: "", due_in_days: "14" });
  const [expandedGoal, setExpandedGoal] = useState<string | null>(null);

  const reload = async (statusFilter?: string) => {
    setLoading(true);
    setError(null);
    try {
      const params: Record<string, string> = {};
      if (statusFilter && statusFilter !== "all") params.status = statusFilter;
      const resp: any = await ObaraBackend?.agents?.listGoals?.(params);
      setGoals(resp?.goals || []);
      setSteps(resp?.steps || []);
    } catch (err: any) {
      setError(err);
      setGoals([]);
      setSteps([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { reload(tab); }, [tab]);

  const stepsByGoal = useMemo(() => {
    const m: Record<string, any[]> = {};
    for (const s of steps) {
      if (!m[s.goal_id]) m[s.goal_id] = [];
      m[s.goal_id].push(s);
    }
    return m;
  }, [steps]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { active: 0, completed: 0, cancelled: 0, failed: 0, all: goals.length };
    for (const g of goals) {
      if (c[g.status] != null) c[g.status]++;
    }
    return c;
  }, [goals]);

  const armGoal = async (ev: React.FormEvent) => {
    ev.preventDefault();
    const gt = GOAL_TYPES.find((g) => g.id === armForm.goal_type);
    if (!gt) return;
    if (!armForm.object_id.trim()) {
      setFlash({ kind: "bad", msg: "Object id is required (an order id or invoice id)" });
      return;
    }
    setBusy(true);
    setFlash(null);
    try {
      const due = Number(armForm.due_in_days);
      const due_at = Number.isFinite(due) && due > 0
        ? new Date(Date.now() + due * 86400000).toISOString()
        : null;
      await ObaraBackend?.agents?.armGoal?.({
        goal_type: armForm.goal_type,
        object_type: gt.objectType,
        object_id: armForm.object_id.trim(),
        due_at,
      });
      setFlash({ kind: "good", msg: "Goal armed. The runner will pick it up at the next tick." });
      setArmForm({ goal_type: GOAL_TYPES[0].id, object_id: "", due_in_days: "14" });
      reload(tab);
    } catch (err: any) {
      setFlash({ kind: "bad", msg: err.message || String(err) });
    } finally {
      setBusy(false);
    }
  };

  const setStatus = async (id: string, status: string) => {
    setBusy(true);
    setFlash(null);
    try {
      await ObaraBackend?.agents?.updateGoal?.({ id, status });
      setFlash({ kind: "good", msg: "Goal " + status });
      reload(tab);
    } catch (err: any) {
      setFlash({ kind: "bad", msg: err.message || String(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <WSTitle
        eyebrow="Quality · Agents"
        title="Autonomous follow-up"
        meta={`${counts.active || 0} active · ${counts.completed || 0} completed · ${counts.failed || 0} failed`}
        right={<Btn icon kind="ghost" sm onClick={() => reload(tab)} title="Refresh">{Icon.cycle}</Btn>}
      />
      <WSTabs
        tabs={STATUS_TABS.map((t) => ({ id: t.id, label: t.label, count: counts[t.id] || 0 }))}
        active={tab}
        onChange={setTab}
      />

      <div className="ws-content">
        {flash && (
          <Banner kind={flash.kind} icon={flash.kind === "bad" ? Icon.alert : Icon.check}
                  title={flash.kind === "bad" ? "Could not arm goal" : "Done"}>
            <span className="mono-sm">{flash.msg}</span>
          </Banner>
        )}
        {error && (
          <Banner kind="bad" icon={Icon.alert} title="Failed to load goals" action={<Btn sm onClick={() => reload(tab)}>Retry</Btn>}>
            <span className="mono-sm">{String(error.message || error)}</span>
          </Banner>
        )}

        <KPIRow cols={4}>
          <KPI lbl="Active goals"  v={String(counts.active || 0)}    d="agent ticks each hour" live={(counts.active || 0) > 0} />
          <KPI lbl="Completed"     v={String(counts.completed || 0)} d="goal succeeded" />
          <KPI lbl="Failed"        v={String(counts.failed || 0)}    d="give-up triggered" dKind={(counts.failed || 0) > 0 ? "down" : ""} />
          <KPI lbl="Cancelled"     v={String(counts.cancelled || 0)} d="operator stopped" />
        </KPIRow>

        <Card title="Arm a new goal" eyebrow="goal type · target id · deadline">
          <form onSubmit={armGoal} style={{ display: "grid", gridTemplateColumns: "2fr 2fr 1fr auto", gap: 8, alignItems: "end" }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span className="mono-sm" style={{ color: "var(--ink-3)" }}>Goal type</span>
              <select className="input" value={armForm.goal_type}
                      onChange={(ev) => setArmForm({ ...armForm, goal_type: ev.target.value })}
                      style={{ height: 30 }}>
                {GOAL_TYPES.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
              </select>
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span className="mono-sm" style={{ color: "var(--ink-3)" }}>
                Target {GOAL_TYPES.find((g) => g.id === armForm.goal_type)?.objectType || "object"} id
              </span>
              <input className="input mono-sm" type="text" required value={armForm.object_id}
                     onChange={(ev) => setArmForm({ ...armForm, object_id: ev.target.value })}
                     placeholder="UUID" style={{ height: 30 }} />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span className="mono-sm" style={{ color: "var(--ink-3)" }}>Deadline (days)</span>
              <input className="input" type="number" min="1" value={armForm.due_in_days}
                     onChange={(ev) => setArmForm({ ...armForm, due_in_days: ev.target.value })}
                     style={{ height: 30 }} />
            </label>
            <Btn type="submit" kind="primary" sm disabled={busy}>{busy ? "arming…" : <>{Icon.plus} arm</>}</Btn>
          </form>
          <div className="mono-sm" style={{ color: "var(--ink-3)", marginTop: 8 }}>
            {GOAL_TYPES.find((g) => g.id === armForm.goal_type)?.detail}
          </div>
        </Card>

        <Card title="Goals" eyebrow={tab === "all" ? "every goal in the tenant" : tab + " goals"} flush>
          {loading ? (
            <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>Loading…</div>
          ) : goals.length === 0 ? (
            <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
              No {tab === "all" ? "" : tab} goals yet. Arm one above.
            </div>
          ) : (
            <table className="tbl">
              <thead><tr>
                <th>Goal</th>
                <th>Target</th>
                <th>Status</th>
                <th>Ticks</th>
                <th>Last action</th>
                <th>Next run</th>
                <th style={{ width: 200 }}></th>
              </tr></thead>
              <tbody>
                {goals.map((g) => {
                  const open = expandedGoal === g.id;
                  const goalSteps = stepsByGoal[g.id] || [];
                  return (
                    <React.Fragment key={g.id}>
                      <tr style={{ cursor: "pointer" }} onClick={() => setExpandedGoal(open ? null : g.id)}>
                        <td>{goalTypeLabel(g.goal_type)}</td>
                        <td className="mono-sm">{g.object_type}:{String(g.object_id).slice(0, 8)}</td>
                        <td>{statusChip(g.status)}</td>
                        <td className="mono-sm">{g.step_count}</td>
                        <td className="mono-sm">
                          {g.last_action_at ? <>{g.last_action || "—"} · {ageLabel(g.last_action_at)}</> : "—"}
                        </td>
                        <td className="mono-sm">{g.next_run_at ? ageLabel(g.next_run_at) : "—"}</td>
                        <td>
                          <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                            {g.status === "active" && (
                              <Btn sm kind="ghost" disabled={busy} onClick={(ev) => { ev.stopPropagation(); setStatus(g.id, "paused"); }}>pause</Btn>
                            )}
                            {g.status === "paused" && (
                              <Btn sm kind="ghost" disabled={busy} onClick={(ev) => { ev.stopPropagation(); setStatus(g.id, "active"); }}>resume</Btn>
                            )}
                            {(g.status === "active" || g.status === "paused") && (
                              <Btn sm kind="ghost" disabled={busy} onClick={(ev) => { ev.stopPropagation(); setStatus(g.id, "cancelled"); }}>cancel</Btn>
                            )}
                          </div>
                        </td>
                      </tr>
                      {open && (
                        <tr>
                          <td colSpan={7} style={{ background: "var(--paper-2)" }}>
                            <div style={{ padding: 12 }}>
                              <div className="mono-sm" style={{ color: "var(--ink-3)", marginBottom: 8 }}>
                                Goal id <code>{g.id}</code> · armed {ageLabel(g.created_at)} · deadline {g.due_at ? new Date(g.due_at).toLocaleDateString("en-IN") : "—"}
                                {g.last_error && <> · <span style={{ color: "var(--rust)" }}>last error: {g.last_error}</span></>}
                              </div>
                              {goalSteps.length === 0 ? (
                                <div className="body mono-sm" style={{ color: "var(--ink-3)" }}>No steps yet. Runner ticks hourly.</div>
                              ) : (
                                <table className="tbl mono-sm">
                                  <thead><tr><th>#</th><th>When</th><th>Action</th><th>Result</th><th>Thought</th></tr></thead>
                                  <tbody>
                                    {goalSteps.map((s) => (
                                      <tr key={s.id}>
                                        <td>{s.step_no}</td>
                                        <td>{ageLabel(s.created_at)}</td>
                                        <td>{s.action}</td>
                                        <td>{s.result}{s.result_detail ? " · " + s.result_detail : ""}</td>
                                        <td style={{ color: "var(--ink-3)" }}>{s.thought || "—"}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="How the runner works" eyebrow="hourly Vercel cron at /api/agents/run">
          <div className="body mono-sm" style={{ color: "var(--ink-2)" }}>
            <p style={{ margin: 0 }}>
              The runner walks every active goal whose <code>next_run_at</code> is in the past, dispatches it
              to its goal-type handler, and persists each step. Handlers decide between <code>noop</code>,
              <code> send_email</code>, <code>escalate</code>, <code>mark_complete</code>, and <code>give_up</code>.
              Send actions queue a row in <code>communications</code> with <code>status=queued</code>; existing
              comms plumbing fires it to the configured provider.
            </p>
            <p style={{ marginTop: 8 }}>
              Every non-noop step writes to <code>audit_events</code>, which the outcome meter on the Billing
              tab counts as <code>agent_action</code> outcomes. Failure to reach the goal by <code>due_at</code>
              flips it to <code>failed</code> and emits an <code>agent_escalation</code> processing event for
              the owner.
            </p>
          </div>
        </Card>
      </div>
    </>
  );
};

export default WiredAgents;
