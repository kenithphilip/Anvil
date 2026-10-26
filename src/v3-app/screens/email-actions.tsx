// Email actions: the critical-mail dashboard, the action detail, my queue,
// review, the manager view, mailboxes and rules.
// docs/EMAIL_ACCOUNTABILITY_SCOPE.md 6.10.
//
// #/email-actions?sub=dashboard|mine|review|manager|mailboxes|rules
// #/email-actions?id=<email action id>  opens the detail beside the list.
// Filters ride on the hash too: priority, state, mailbox, owner, customer,
// order. The server decides what each user may see (404 otherwise); the tabs
// only hide what a role cannot use.

import React, { useMemo, useState } from "react";
import { Banner, Btn, Card, Chip, KPI, KPIRow, KV, WSTabs, WSTitle, rowActivateProps } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { AnvilBackend } from "../lib/api";
import { RBAC } from "../lib/rbac";
import { ageLabel, readHashParam, useFetch, useHashParam } from "../lib/helpers";

type Action = Record<string, any>;

const STATE_LABEL: Record<string, string> = {
  detected: "Detected", awaiting_review: "Awaiting review", pending: "Pending", in_progress: "In progress",
  awaiting_verification: "Awaiting verification", performed: "Action performed", cancelled: "Cancelled",
};
const BUSINESS_LABEL: Record<string, string> = {
  not_assessed: "Not assessed", awaiting_internal: "Awaiting internal action", awaiting_external: "Awaiting external response",
  in_progress: "In progress", resolved: "Resolved", closed: "Closed",
};
const TYPE_LABEL: Record<string, string> = {
  reply: "Reply", forward: "Forward", provide_documents: "Provide documents",
  confirm_payment: "Confirm payment", obtain_approval: "Obtain approval", investigate: "Investigate",
};
const PRIO_TONE: Record<string, string> = { critical: "bad", high: "warn", normal: "info", informational: "ghost" };
const EVIDENCE_TONE: Record<string, string> = { verified: "good", confirmed: "good", ambiguous: "warn", claimed: "warn", rejected: "bad" };

const DAY = 86_400_000;
const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");

// Change one key of the hash query, keeping the rest.
const setHash = (patch: Record<string, string | null>) => {
  const q = new URLSearchParams((window.location.hash.split("?")[1]) || "");
  for (const [k, v] of Object.entries(patch)) { if (v == null || v === "") q.delete(k); else q.set(k, v); }
  const s = q.toString();
  window.location.hash = "#/email-actions" + (s ? "?" + s : "");
};

const failNotice = (what: string) => (err: any) => window.notifyError?.(what + " failed", err?.message || String(err));
const doneNotice = (what: string) => window.notifySuccess?.(what);

const StateChips: React.FC<{ a: Action }> = ({ a }) => (
  <span className="row gap-sm">
    <Chip k={a.status === "performed" ? "good" : a.status === "awaiting_verification" || a.status === "awaiting_review" ? "warn" : "info"}>{STATE_LABEL[a.status] || a.status}</Chip>
    {a.overdue && <Chip k="bad">Overdue</Chip>}
    {a.escalated && <Chip k="plum">Escalated L{a.escalation_level}</Chip>}
  </span>
);

const ActionTable: React.FC<{ rows: Action[]; empty: string; sub: string }> = ({ rows, empty, sub }) => (
  rows.length === 0 ? (
    <div className="body" style={{ padding: 18, color: "var(--ink-3)" }}>{empty}</div>
  ) : (
    <table className="tbl">
      <thead><tr>
        <th>Priority</th><th>Action</th><th>From</th><th>Customer / PO</th><th>Owner</th><th>Due</th><th>State</th>
      </tr></thead>
      <tbody>
        {rows.map((a) => (
          <tr key={a.id} {...rowActivateProps(() => setHash({ id: a.id, sub }), "Open " + (a.title || "action"))}>
            <td><Chip k={PRIO_TONE[a.priority_label] || "info"}>{a.priority_label}</Chip></td>
            <td style={{ maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.title}</td>
            <td className="mono-sm">{a.from_address || "—"}</td>
            <td>{a.customer_name || "—"}{a.po_number ? <span className="mono-sm"> · PO {a.po_number}</span> : null}</td>
            <td>{a.assignee_name || (a.assignee_user_id ? a.assignee_user_id.slice(0, 8) : <Chip k="warn">no owner</Chip>)}</td>
            <td className="mono-sm" style={a.overdue ? { color: "var(--bad)" } : undefined}>{when(a.due_at)}</td>
            <td><StateChips a={a} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  )
);

const useList = (params: Record<string, string>, deps: unknown[] = []) =>
  useFetch(() => AnvilBackend?.emailActions?.list?.(params) || Promise.resolve({ actions: [] }), deps);

const listOf = (r: any): Action[] => r?.data?.actions || [];

// The hash filters every list view reads.
const hashFilters = () => {
  const out: Record<string, string> = {};
  for (const k of ["priority", "state", "mailbox", "owner", "customer", "order"]) {
    const v = readHashParam(k);
    if (v) out[k] = v;
  }
  return out;
};

const ActionFilters: React.FC<{ mailboxes: Action[] }> = ({ mailboxes }) => {
  const f = hashFilters();
  return (
    <div className="row gap-sm" style={{ flexWrap: "wrap", margin: "8px 0" }}>
      <label className="mono-sm">Priority{" "}
        <select aria-label="Priority" value={f.priority || ""} onChange={(e) => setHash({ priority: e.target.value })}>
          <option value="">all</option><option value="critical">critical</option><option value="high">high</option><option value="normal">normal</option>
        </select>
      </label>
      <label className="mono-sm">State{" "}
        <select aria-label="State" value={f.state || ""} onChange={(e) => setHash({ state: e.target.value })}>
          <option value="">open</option><option value="overdue">overdue</option><option value="escalated">escalated</option>
          <option value="awaiting_verification">awaiting verification</option><option value="pending">pending</option>
          <option value="in_progress">in progress</option><option value="closed">closed</option>
        </select>
      </label>
      <label className="mono-sm">Mailbox{" "}
        <select aria-label="Mailbox" value={f.mailbox || ""} onChange={(e) => setHash({ mailbox: e.target.value })}>
          <option value="">all</option>
          {mailboxes.map((m) => <option key={m.id} value={m.id}>{m.address}</option>)}
        </select>
      </label>
      <label className="mono-sm">
        <input type="checkbox" checked={f.owner === "none"} onChange={(e) => setHash({ owner: e.target.checked ? "none" : null })} /> no owner
      </label>
      {f.customer && <Btn sm kind="ghost" onClick={() => setHash({ customer: null })}>customer filter {Icon.x}</Btn>}
      {f.order && <Btn sm kind="ghost" onClick={() => setHash({ order: null })}>order filter {Icon.x}</Btn>}
    </div>
  );
};

const Dashboard: React.FC<{ open: Action[]; closed: Action[] }> = ({ open, closed }) => {
  const now = Date.now();
  const recent = closed.filter((a) => a.status === "performed" && a.completed_at && now - Date.parse(a.completed_at) < 7 * DAY);
  const external = closed.filter((a) => a.business_status === "awaiting_external");
  const critical = open.filter((a) => a.priority_label === "critical");
  const overdue = open.filter((a) => a.overdue);
  const verify = open.filter((a) => a.status === "awaiting_verification");
  const escalated = open.filter((a) => a.escalated);
  return (
    <>
      <KPIRow>
        <KPI lbl="Critical open" v={String(critical.length)} d="outstanding" dKind={critical.length ? "down" : ""} />
        <KPI lbl="High priority" v={String(open.filter((a) => a.priority_label === "high").length)} d="open" />
        <KPI lbl="Overdue" v={String(overdue.length)} d="past due" dKind={overdue.length ? "down" : ""} />
        <KPI lbl="Awaiting verification" v={String(verify.length)} d="needs a person" />
        <KPI lbl="Awaiting external" v={String(external.length)} d="we answered" />
        <KPI lbl="Escalated" v={String(escalated.length)} d="open" />
        <KPI lbl="Performed, 7 days" v={String(recent.length)} d="verified or confirmed" dKind={recent.length ? "up" : ""} />
      </KPIRow>
      <Card flush title="Critical outstanding"><ActionTable rows={critical} sub="dashboard" empty="No critical action is open." /></Card>
      <Card flush title="Overdue"><ActionTable rows={overdue} sub="dashboard" empty="Nothing is overdue." /></Card>
      <Card flush title="Awaiting verification"><ActionTable rows={verify} sub="dashboard" empty="Nothing waits for a person to verify." /></Card>
      <Card flush title="Escalated"><ActionTable rows={escalated} sub="dashboard" empty="No open action is escalated." /></Card>
      <Card flush title="Awaiting external response"><ActionTable rows={external.slice(0, 20)} sub="dashboard" empty="No answered action waits for the customer." /></Card>
      <Card flush title="Recently performed"><ActionTable rows={recent.slice(0, 20)} sub="dashboard" empty="Nothing performed in the last 7 days." /></Card>
    </>
  );
};

const Manager: React.FC<{ open: Action[]; closed: Action[] }> = ({ open, closed }) => {
  const now = Date.now();
  const byOwner = useMemo(() => {
    const m = new Map<string, { name: string; open: number; overdue: number; escalated: number; done7: number }>();
    const row = (a: Action) => {
      const k = a.assignee_user_id || "none";
      if (!m.has(k)) m.set(k, { name: a.assignee_name || (a.assignee_user_id ? a.assignee_user_id.slice(0, 8) : "no owner"), open: 0, overdue: 0, escalated: 0, done7: 0 });
      return m.get(k)!;
    };
    for (const a of open) { const r = row(a); r.open += 1; if (a.overdue) r.overdue += 1; if (a.escalated) r.escalated += 1; }
    for (const a of closed) if (a.status === "performed" && a.completed_at && now - Date.parse(a.completed_at) < 7 * DAY) row(a).done7 += 1;
    return [...m.entries()].sort((x, y) => y[1].overdue - x[1].overdue || y[1].open - x[1].open);
  }, [open, closed, now]);
  const unassignedCritical = open.filter((a) => !a.assignee_user_id && a.priority_label === "critical");
  return (
    <>
      <Card flush title="Unassigned critical"><ActionTable rows={unassignedCritical} sub="manager" empty="Every critical action has an owner." /></Card>
      <Card flush title="Workload and completion by owner">
        {byOwner.length === 0 ? <div className="body" style={{ padding: 18 }}>No actions yet.</div> : (
          <table className="tbl">
            <thead><tr><th>Owner</th><th className="r">Open</th><th className="r">Overdue</th><th className="r">Escalated</th><th className="r">Performed, 7 days</th></tr></thead>
            <tbody>
              {byOwner.map(([k, r]) => (
                <tr key={k}>
                  <td>{r.name}</td><td className="r mono">{r.open}</td>
                  <td className="r mono" style={r.overdue ? { color: "var(--bad)" } : undefined}>{r.overdue}</td>
                  <td className="r mono">{r.escalated}</td><td className="r mono">{r.done7}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <Card flush title="Escalation history (open)"><ActionTable rows={open.filter((a) => a.escalated)} sub="manager" empty="No open action is escalated." /></Card>
    </>
  );
};

const Mailboxes: React.FC<{ resp: any; reload: () => void }> = ({ resp, reload }) => {
  const d = resp.data || {};
  const status = readHashParam("mailbox");
  const connect = (provider: string) => Promise.resolve(AnvilBackend?.emailActions?.connectMailbox?.(provider))
    .then((r: any) => { if (r?.authorize_url) window.location.href = r.authorize_url; })
    .catch(failNotice("Connect"));
  const resume = (id: string) => Promise.resolve(AnvilBackend?.emailActions?.updateMailbox?.({ id, resume: true }))
    .then(() => { doneNotice("Mailbox resumed"); reload(); }).catch(failNotice("Resume"));
  const disconnect = (id: string) => {
    if (!window.confirm("Disconnect this mailbox? Anvil deletes its tokens now.")) return;
    Promise.resolve(AnvilBackend?.emailActions?.disconnectMailbox?.(id)).then(() => { doneNotice("Mailbox disconnected"); reload(); }).catch(failNotice("Disconnect"));
  };
  return (
    <>
      {status && <Banner kind={status === "connected" ? "good" : "warn"} title={status === "connected" ? "Mailbox connected" : "Mailbox not connected"}>Result: {status.replace(/_/g, " ")}.</Banner>}
      {!d.enabled && <Banner kind="info" title="The module is off for this tenant">An admin turns it on. Until then no mailbox is read.</Banner>}
      {d.enabled && d.actions_mode !== "create" && <Banner kind="info" title="Observe mode">Mail is read and counted, but no action is made yet.</Banner>}
      <Card title="Connect a mailbox" right={<span className="row gap-sm">
        <Btn sm disabled={!d.providers?.outlook} onClick={() => connect("outlook")}>{Icon.plus} Outlook</Btn>
        <Btn sm disabled={!d.providers?.gmail} onClick={() => connect("gmail")}>{Icon.plus} Gmail</Btn>
      </span>}>
        <div className="body">Anvil asks for read-only access. It never sends, moves or deletes mail.</div>
      </Card>
      <Card flush title="Mailboxes">
        {(d.mailboxes || []).length === 0 ? <div className="body" style={{ padding: 18 }}>No mailbox is connected.</div> : (
          <table className="tbl">
            <thead><tr><th>Mailbox</th><th>Status</th><th>Last success</th><th className="r">Requests today</th><th className="r">Failures</th><th>Last error</th><th></th></tr></thead>
            <tbody>
              {d.mailboxes.map((m: Action) => (
                <tr key={m.id}>
                  <td>{m.address} <span className="mono-sm">{m.provider}</span></td>
                  <td><Chip k={m.status === "active" ? (m.pause_reason ? "warn" : "good") : "bad"}>{m.pause_reason ? "paused: " + m.pause_reason : m.status}</Chip></td>
                  <td className="mono-sm">{m.last_success_at ? ageLabel(m.last_success_at) + " ago" : "never"}</td>
                  <td className="r mono">{m.requests_today || 0} / {m.daily_request_budget}</td>
                  <td className="r mono">{m.consecutive_failures || 0}</td>
                  <td className="mono-sm" style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.last_error || "—"}</td>
                  <td className="row gap-sm">
                    {(m.status === "paused" || m.pause_reason) && m.status !== "reauth_required" && <Btn sm kind="ghost" onClick={() => resume(m.id)}>resume</Btn>}
                    {m.status === "reauth_required" && <Btn sm kind="ghost" onClick={() => connect(m.provider)}>sign in again</Btn>}
                    {m.status !== "disconnected" && <Btn sm kind="ghost" onClick={() => disconnect(m.id)}>disconnect</Btn>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
};

const Rules: React.FC = () => {
  const resp = useFetch(() => AnvilBackend?.emailActions?.rules?.() || Promise.resolve({ rules: [] }), []);
  const rules: Action[] = (resp.data as any)?.rules || [];
  const canTenant = !!(resp.data as any)?.can_edit_tenant_rules;
  const [form, setForm] = useState({ kind: "keyword", pattern: "", scope: "me", priority: "", action_type: "", due_hours: "" });
  const add = () => {
    const effect: Record<string, any> = {};
    if (form.priority) effect.priority = form.priority;
    if (form.action_type) effect.action_type = form.action_type;
    if (form.due_hours) effect.due_hours = Number(form.due_hours);
    Promise.resolve(AnvilBackend?.emailActions?.addRule?.({ kind: form.kind, pattern: form.pattern, scope: form.scope, effect }))
      .then(() => { doneNotice("Rule added"); setForm({ ...form, pattern: "" }); resp.reload(); }).catch(failNotice("Add rule"));
  };
  const toggle = (r: Action) => Promise.resolve(AnvilBackend?.emailActions?.updateRule?.({ id: r.id, active: !r.active }))
    .then(() => resp.reload()).catch(failNotice("Change rule"));
  const remove = (r: Action) => Promise.resolve(AnvilBackend?.emailActions?.deleteRule?.(r.id))
    .then(() => { doneNotice("Rule deleted"); resp.reload(); }).catch(failNotice("Delete rule"));
  return (
    <>
      <Card title="Add a rule">
        <div className="row gap-sm" style={{ flexWrap: "wrap" }}>
          <select aria-label="Rule kind" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
            <option value="keyword">keyword</option><option value="trusted_sender">trusted sender</option>
            <option value="exclusion">exclusion</option><option value="customer">customer</option><option value="deadline">deadline</option>
          </select>
          <input aria-label="Pattern" placeholder="phrase, address or @domain" value={form.pattern} onChange={(e) => setForm({ ...form, pattern: e.target.value })} />
          <select aria-label="Rule priority" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
            <option value="">no priority</option><option value="critical">critical</option><option value="high">high</option><option value="normal">normal</option>
          </select>
          <select aria-label="Rule action type" value={form.action_type} onChange={(e) => setForm({ ...form, action_type: e.target.value })}>
            <option value="">no action type</option>
            {Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <input aria-label="Due hours" placeholder="due hours" style={{ width: 90 }} value={form.due_hours} onChange={(e) => setForm({ ...form, due_hours: e.target.value })} />
          <select aria-label="Rule scope" value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value })}>
            <option value="me">my mailboxes</option>{canTenant && <option value="tenant">whole tenant</option>}
          </select>
          <Btn sm disabled={!form.pattern.trim()} onClick={add}>{Icon.plus} add</Btn>
        </div>
      </Card>
      <Card flush title="Rules">
        {rules.length === 0 ? <div className="body" style={{ padding: 18 }}>No rules. The default phrases apply.</div> : (
          <table className="tbl">
            <thead><tr><th>Kind</th><th>Pattern</th><th>Effect</th><th>Scope</th><th>Active</th><th></th></tr></thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id}>
                  <td>{r.kind.replace(/_/g, " ")}</td><td className="mono-sm">{r.pattern}</td>
                  <td className="mono-sm">{Object.entries(r.effect || {}).map(([k, v]) => k + ": " + v).join(", ") || "—"}</td>
                  <td>{r.scope_user_id ? "mine" : "tenant"}</td>
                  <td><Chip k={r.active ? "good" : "ghost"}>{r.active ? "on" : "off"}</Chip></td>
                  <td className="row gap-sm">
                    {(r.scope_user_id || canTenant) && <Btn sm kind="ghost" onClick={() => toggle(r)}>{r.active ? "turn off" : "turn on"}</Btn>}
                    {(r.scope_user_id || canTenant) && <Btn sm kind="ghost" onClick={() => remove(r)}>delete</Btn>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
};

const Detail: React.FC<{ id: string; onChanged: () => void }> = ({ id, onChanged }) => {
  const resp = useFetch(() => AnvilBackend?.emailActions?.get?.(id), [id]);
  const members = useFetch(() => AnvilBackend?.admin?.listMembers?.() || Promise.resolve({ members: [] }), []);
  const d: any = resp.data || {};
  const a: Action | null = d.action || null;
  if (resp.loading) return <Card><div className="body">Loading the action…</div></Card>;
  if (resp.error || !a) return <Banner kind="warn" title="Action not found">It does not exist, or you cannot see it.</Banner>;

  const canVerify = RBAC.canDo("email.verify");
  const call = (what: string, p: Promise<any> | undefined) => Promise.resolve(p)
    .then(() => { doneNotice(what); resp.reload(); onChanged(); }).catch(failNotice(what));
  const patch = (what: string, body: Record<string, any>) => call(what, AnvilBackend?.emailActions?.update?.(a.id, { version: a.version, ...body }));
  const withReason = (what: string, body: Record<string, any>) => {
    const reason = window.prompt(what + ": the reason (at least 3 characters)");
    if (reason) patch(what, { ...body, reason });
  };
  const facts = (a.reasons || []).filter((r: any) => r.kind === "fact");
  const inferred = (a.reasons || []).filter((r: any) => r.kind === "inferred");
  const team = ((members.data as any)?.members || []).filter((m: any) => m.status === "approved");
  const open = !["performed", "cancelled"].includes(a.status);

  return (
    <Card title={a.title} eyebrow={TYPE_LABEL[a.action_type] + " · " + a.priority_label}
          right={<Btn sm kind="ghost" onClick={() => setHash({ id: null })}>{Icon.x} close</Btn>}>
      <div className="row gap-sm" style={{ marginBottom: 8 }}>
        <StateChips a={a} />
        <Chip k="ghost">{BUSINESS_LABEL[a.business_status] || a.business_status}</Chip>
        {a.web_link && <a className="link" href={a.web_link} target="_blank" rel="noreferrer">{Icon.link} open the mail</a>}
      </div>
      <KV rows={[
        ["From", a.from_name ? a.from_name + " <" + a.from_address + ">" : a.from_address || "—"],
        ["To / Cc", [...(a.to_addresses || []), ...(a.cc_addresses || [])].join(", ") || "—"],
        ["Subject", a.subject || "—"],
        ["Received", when(a.received_at) + (a.mailbox ? " · " + a.mailbox : "")],
        ["Customer", a.account_id ? <a className="link" href={"#/customers?id=" + a.account_id}>{a.customer_name || a.account_id.slice(0, 8)}</a> : "not linked"],
        ["Sales order", a.order_id ? <a className="link" href={"#/so?id=" + a.order_id}>{a.po_number ? "PO " + a.po_number : a.order_id.slice(0, 8)}</a> : "not linked"],
        ["Owner", (a.assignee_name || a.assignee_user_id || "no owner") + (a.backup_name || a.backup_user_id ? " · backup " + (a.backup_name || a.backup_user_id.slice(0, 8)) : "")],
        ["Due", when(a.due_at) + " (" + (a.due_source === "customer_commit" ? "stated in the mail" : a.due_source === "manual" ? "set by a person" : "policy") + ", " + a.due_timezone + ")"],
        ["What completes it", a.requirement.replace(/_/g, " ")],
        ["If missed", a.consequence || "—"],
      ]} />
      {a.preview && <div className="body" style={{ margin: "8px 0", color: "var(--ink-3)" }}>“{a.preview}”</div>}

      <div className="h3" style={{ marginTop: 12 }}>Why</div>
      <div className="row" style={{ gap: 24, alignItems: "flex-start" }}>
        <div><div className="mono-sm">Facts</div><ul>{facts.map((r: any, i: number) => <li key={i}>{r.text}</li>)}</ul></div>
        <div><div className="mono-sm">Inferences</div><ul>{inferred.map((r: any, i: number) => <li key={i}>{r.text}</li>)}</ul></div>
      </div>

      <div className="h3" style={{ marginTop: 12 }}>Controls</div>
      <div className="row gap-sm" style={{ flexWrap: "wrap" }}>
        {a.status === "awaiting_review" && <Btn sm onClick={() => patch("Confirmed", { status: "pending" })}>confirm the action</Btn>}
        {a.status === "pending" && <Btn sm onClick={() => patch("Started", { status: "in_progress" })}>start</Btn>}
        {a.status === "in_progress" && <Btn sm kind="ghost" onClick={() => patch("Back to pending", { status: "pending" })}>back to pending</Btn>}
        {open && <Btn sm kind="ghost" onClick={() => {
          const note = window.prompt("What was done, and how? (for example: confirmed by phone)");
          if (note) call("Evidence recorded", AnvilBackend?.emailActions?.recordEvidence?.(a.id, { note }));
        }}>record evidence</Btn>}
        {open && <Btn sm kind="ghost" onClick={() => withReason("Cancel", { status: "cancelled" })}>cancel</Btn>}
        {!open && <Btn sm kind="ghost" onClick={() => withReason("Reopen", { status: "pending" })}>reopen</Btn>}
        <select aria-label="Business outcome" value={a.business_status} onChange={(e) => patch("Business outcome set", { business_status: e.target.value })}>
          {Object.entries(BUSINESS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select aria-label="Priority correction" value={a.priority_label} onChange={(e) => withReason("Priority corrected", { priority: e.target.value })}>
          {["critical", "high", "normal", "informational"].map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <select aria-label="Action type correction" value={a.action_type} onChange={(e) => withReason("Action type corrected", { action_type: e.target.value })}>
          {Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        {a.action_type === "forward" && <Btn sm kind="ghost" onClick={() => {
          const v = window.prompt("Forward to (addresses, separated by commas)", (a.forward_to || []).join(", "));
          if (v != null) patch("Forward target set", { forward_to: v.split(",").map((x) => x.trim()).filter(Boolean) });
        }}>forward target</Btn>}
        {/* The owner may hand off; anyone else needs email.reassign. The server decides. */}
        {open && team.length > 0 && (
          <select aria-label="Reassign" value="" onChange={(e) => e.target.value && patch("Reassigned", { assignee_user_id: e.target.value })}>
            <option value="">reassign to…</option>
            {team.map((m: any) => <option key={m.user_id} value={m.user_id}>{m.display_name || m.email}</option>)}
          </select>
        )}
      </div>

      <div className="h3" style={{ marginTop: 12 }}>Evidence</div>
      {(d.evidence || []).length === 0 ? <div className="mono-sm">No evidence yet. A reply or forward from a connected mailbox shows here.</div> : (
        <table className="tbl">
          <thead><tr><th>When</th><th>Kind</th><th>Method</th><th>Result</th><th>Detail</th><th></th></tr></thead>
          <tbody>
            {d.evidence.map((e: any) => (
              <tr key={e.id}>
                <td className="mono-sm">{when(e.sent_at || e.created_at)}</td>
                <td>{e.kind}</td>
                <td className="mono-sm">{e.method.replace(/_/g, " ")}{e.confidence ? " · " + e.confidence : ""}</td>
                <td><Chip k={EVIDENCE_TONE[e.status] || "info"}>{e.status}</Chip></td>
                <td className="mono-sm">{e.note || (e.recipients || []).join(", ")}{e.decision_reason ? " · decided: " + e.decision_reason : ""}</td>
                <td className="row gap-sm">
                  {canVerify && ["claimed", "ambiguous"].includes(e.status) && <>
                    <Btn sm kind="ghost" onClick={() => {
                      const reason = window.prompt("Confirm: the reason");
                      if (reason) call("Evidence confirmed", AnvilBackend?.emailActions?.decideEvidence?.(a.id, { evidence_id: e.id, decision: "confirm", reason }));
                    }}>confirm</Btn>
                    <Btn sm kind="ghost" onClick={() => {
                      const reason = window.prompt("Reject: the reason");
                      if (reason) call("Evidence rejected", AnvilBackend?.emailActions?.decideEvidence?.(a.id, { evidence_id: e.id, decision: "reject", reason }));
                    }}>reject</Btn>
                  </>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="h3" style={{ marginTop: 12 }}>History</div>
      <ul className="mono-sm">
        {(d.history || []).map((h: any, i: number) => (
          <li key={i}>{when(h.created_at)} · {String(h.action).replace(/^email_action_/, "").replace(/_/g, " ")}{h.reason ? " · " + h.reason : ""}</li>
        ))}
      </ul>
    </Card>
  );
};

const EmailActionsScreen: React.FC = () => {
  const sub = useHashParam("sub") || "dashboard";
  const id = useHashParam("id");
  const hash = useHashParam("priority") + "|" + useHashParam("state") + "|" + useHashParam("mailbox") + "|" + useHashParam("owner") + "|" + useHashParam("customer") + "|" + useHashParam("order");
  const [bump, setBump] = useState(0);
  const filters = hashFilters();
  const manager = RBAC.canDo("email.view_all");

  const open = useList(sub === "mine" ? { ...filters, scope: "mine" } : sub === "review" ? { ...filters, state: "awaiting_review" } : filters, [sub, hash, bump]);
  const closed = useList({ state: "closed" }, [sub, bump]);
  const mailboxes = useFetch(() => AnvilBackend?.emailActions?.mailboxes?.() || Promise.resolve({ mailboxes: [] }), [bump]);
  const mailboxList: Action[] = (mailboxes.data as any)?.mailboxes || [];

  const tabs = [
    { id: "dashboard", label: "Dashboard" },
    { id: "mine", label: "My queue" },
    { id: "review", label: "Review" },
    ...(manager ? [{ id: "manager", label: "Manager" }] : []),
    { id: "mailboxes", label: "Mailboxes" },
    { id: "rules", label: "Rules" },
  ];
  const listView = ["dashboard", "mine", "review", "manager"].includes(sub);
  const rows = listOf(open);

  return (
    <>
      <WSTitle eyebrow="Comms" title="Email actions" meta={listView ? rows.length + " open in view" : undefined} />
      <div className="ws-content">
        <WSTabs tabs={tabs} active={sub} onChange={(t) => setHash({ sub: t, id: null })} />
        {id && <Detail id={id} onChanged={() => setBump((n) => n + 1)} />}
        {listView && <ActionFilters mailboxes={mailboxList} />}
        {listView && open.error && <Banner kind="warn" title="Could not load the actions">{String((open.error as any)?.message || open.error)}</Banner>}
        {listView && open.loading && <Card><div className="body">Loading actions…</div></Card>}
        {!open.loading && sub === "dashboard" && <Dashboard open={rows} closed={listOf(closed)} />}
        {!open.loading && sub === "mine" && <Card flush title="My queue"><ActionTable rows={rows} sub="mine" empty="Nothing is waiting for you." /></Card>}
        {!open.loading && sub === "review" && <Card flush title="Awaiting review"><ActionTable rows={rows} sub="review" empty="Nothing waits for a review." /></Card>}
        {!open.loading && sub === "manager" && manager && <Manager open={rows} closed={listOf(closed)} />}
        {sub === "mailboxes" && <Mailboxes resp={mailboxes} reload={() => setBump((n) => n + 1)} />}
        {sub === "rules" && <Rules />}
      </div>
    </>
  );
};

export default EmailActionsScreen;
