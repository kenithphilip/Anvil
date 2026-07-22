import React, { useEffect, useRef, useState } from "react";
import { Banner, Btn, Card, Chip, WSTitle, fmtINR } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { AnvilBackend } from "../lib/api";
import { canApprove } from "../lib/rbac";

// ============================================================
// ANVIL v3 — Ask Anvil (GenAI copilot P0b + P2a)
// The front door to the copilot. Two ways to ask, one trust contract:
//   • pick a governed metric  -> AnvilBackend.metrics.query() -> an answer
//     card with the number + unit + provenance ("how computed") + as_of +
//     a breakdown chart. Deterministic, no LLM — the Metric Catalog (P0a).
//   • free-text question       -> AnvilBackend.erpChat.send() -> the agentic
//     tool-use assistant, which can also PROPOSE an action (create a lead,
//     send a reminder, acknowledge an exception). GenOps (P2a): proposed
//     actions surface here as INLINE confirm/cancel cards — propose→confirm→
//     execute, approver-gated + audited (AnvilBackend.copilot.*). Nothing
//     mutates until a human confirms.
// Every answer is tenant-scoped and shows how it was derived. Mounted by
// routes.ts as the top-level `ask` route.
// ============================================================

type MetricDef = { id: string; label: string; description?: string; unit: string; domain: string; params?: string[] };
type MetricAnswer = {
  metric_id: string; label: string; unit: string; domain: string; value: number | null;
  as_of?: string; window_days?: number; count?: number; denominator?: number;
  breakdown?: Array<Record<string, unknown>>; provenance?: string; source?: string;
};
type Citation = { source: string; tool?: string };
type Proposal = {
  id: string; action: string; preview?: Record<string, unknown>;
  confirm_token: string; created_by?: string; expires_at?: string; created_at?: string;
};
type Entry =
  | { kind: "q"; text: string }
  | { kind: "metric"; answer: MetricAnswer }
  | { kind: "text"; content: string; citations?: Citation[] }
  | { kind: "error"; message: string };

const WINDOWS = [30, 90, 365];

const ACTION_LABELS: Record<string, string> = {
  create_lead: "Create lead",
  draft_and_send_comms: "Send message",
  acknowledge_inventory_exception: "Acknowledge inventory exception",
  post_tally_voucher: "Post Tally voucher",
};
const labelForAction = (action: string): string =>
  ACTION_LABELS[action] || String(action || "action").replace(/_/g, " ");

const fmtValue = (unit: string, value: number | null): string => {
  if (value == null) return "—";
  if (unit === "currency") return fmtINR(value);
  if (unit === "percent") return value + "%";
  if (unit === "days") return value + (value === 1 ? " day" : " days");
  return Number(value).toLocaleString("en-IN");
};

// A breakdown row's numeric magnitude (AR buckets carry `outstanding`).
const magOf = (row: Record<string, unknown>): number => {
  const v = (row.outstanding ?? row.value ?? row.amount ?? row.count) as number;
  return Number.isFinite(Number(v)) ? Number(v) : 0;
};

const MetricCard: React.FC<{ a: MetricAnswer }> = ({ a }) => {
  const bd = Array.isArray(a.breakdown) ? a.breakdown : [];
  const max = bd.reduce((m, r) => Math.max(m, magOf(r)), 0) || 1;
  return (
    <Card
      title={a.label}
      eyebrow={a.domain}
      right={<>
        {a.window_days ? <Chip k="ghost">last {a.window_days}d</Chip> : null}
        <Chip k="info">governed</Chip>
      </>}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 30, fontWeight: 650, color: "var(--ink)", fontVariantNumeric: "tabular-nums" }}>
          {fmtValue(a.unit, a.value)}
        </span>
        {a.denominator != null && a.count != null && (
          <span className="mono-sm" style={{ color: "var(--ink-3)" }}>{a.count} of {a.denominator}</span>
        )}
      </div>

      {bd.length > 0 && (
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
          {bd.map((row, i) => {
            const mag = magOf(row);
            const label = String(row.label ?? row.name ?? i);
            return (
              <div key={i} style={{ display: "grid", gridTemplateColumns: "88px 1fr auto", alignItems: "center", gap: 8 }}>
                <span className="mono-sm" style={{ color: "var(--ink-3)" }}>{label}</span>
                <div style={{ height: 10, background: "var(--paper-2)", borderRadius: 999, border: "1px solid var(--hairline-2)", overflow: "hidden" }}>
                  <div style={{ height: "100%", width: Math.max(2, Math.round((mag / max) * 100)) + "%", background: "var(--accent)" }} />
                </div>
                <span className="mono-sm" style={{ color: "var(--ink-2)", fontVariantNumeric: "tabular-nums" }}>{fmtValue(a.unit, mag)}</span>
              </div>
            );
          })}
        </div>
      )}

      {a.provenance && (
        <div className="mono-sm" style={{ marginTop: 12, color: "var(--ink-3)", lineHeight: 1.5 }}>
          <span style={{ color: "var(--ink-4)" }}>how computed:</span> {a.provenance}
          {a.as_of ? <> · <span style={{ color: "var(--ink-4)" }}>as of</span> {new Date(a.as_of).toLocaleString()}</> : null}
        </div>
      )}
    </Card>
  );
};

const AskAnvil = () => {
  const [metrics, setMetrics] = useState<MetricDef[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [input, setInput] = useState("");
  const [windowDays, setWindowDays] = useState(90);
  const [busy, setBusy] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [actingOn, setActingOn] = useState<string | null>(null); // confirm_token being confirmed/cancelled
  const feedRef = useRef<HTMLDivElement | null>(null);
  const isApprover = canApprove("approvals"); // approver roles (sales_manager/finance/admin)

  const refreshProposals = async () => {
    try {
      const resp: any = await AnvilBackend?.copilot?.proposals?.();
      if (resp && Array.isArray(resp.proposals)) setProposals(resp.proposals);
    } catch (_) { /* proposals optional */ }
  };

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const resp: any = await AnvilBackend?.metrics?.list?.();
        if (live && resp && Array.isArray(resp.metrics)) setMetrics(resp.metrics);
      } catch (_) { /* catalog optional; free-text still works */ }
      if (live) await refreshProposals();
    })();
    return () => { live = false; };
  }, []);

  useEffect(() => { feedRef.current?.scrollTo?.({ top: feedRef.current.scrollHeight, behavior: "smooth" }); }, [entries]);

  const append = (e: Entry) => setEntries((arr) => [...arr, e]);

  const askMetric = async (m: MetricDef) => {
    if (busy) return;
    append({ kind: "q", text: m.label });
    setBusy(true);
    try {
      const answer: any = await AnvilBackend?.metrics?.query?.(m.id, { window_days: windowDays });
      if (!answer || answer.error) append({ kind: "error", message: (answer && answer.error && (answer.error.message || answer.error)) || "Could not compute that metric" });
      else append({ kind: "metric", answer });
    } catch (err: any) {
      append({ kind: "error", message: String(err?.message || err) });
    } finally { setBusy(false); }
  };

  const askFreeText = async () => {
    const content = input.trim();
    if (!content || busy) return;
    append({ kind: "q", text: content });
    setInput("");
    setBusy(true);
    try {
      const resp: any = await AnvilBackend?.erpChat?.send?.({ content, session_id: sessionId || undefined });
      if (!resp || resp.ok === false) {
        append({ kind: "error", message: (resp && resp.error && resp.error.message) || "The assistant is unavailable right now. Try a governed metric above." });
      } else {
        if (resp.session_id) setSessionId(resp.session_id);
        append({ kind: "text", content: resp.content || "(no answer)", citations: Array.isArray(resp.citations) ? resp.citations : [] });
        // the assistant may have PROPOSED an action this turn — surface it inline.
        await refreshProposals();
      }
    } catch (err: any) {
      append({ kind: "error", message: String(err?.message || err) });
    } finally { setBusy(false); }
  };

  const confirmProposal = async (p: Proposal) => {
    if (actingOn) return;
    setActingOn(p.confirm_token);
    try {
      const resp: any = await AnvilBackend?.copilot?.confirm?.(p.confirm_token);
      if (!resp || resp.ok === false) {
        append({ kind: "error", message: (resp && ((resp.error && resp.error.message) || resp.error)) || "Could not execute that action" });
      } else {
        append({ kind: "text", content: "✓ Done — " + labelForAction(p.action) + " executed.", citations: [] });
      }
    } catch (err: any) {
      append({ kind: "error", message: String(err?.message || err) });
    } finally {
      setActingOn(null);
      setProposals((arr) => arr.filter((x) => x.confirm_token !== p.confirm_token));
    }
  };

  const cancelProposal = async (p: Proposal) => {
    if (actingOn) return;
    setActingOn(p.confirm_token);
    try { await AnvilBackend?.copilot?.cancel?.(p.confirm_token); } catch (_) { /* best-effort */ }
    setActingOn(null);
    setProposals((arr) => arr.filter((x) => x.confirm_token !== p.confirm_token));
  };

  const inputStyle: React.CSSProperties = {
    flex: 1, padding: "10px 12px", border: "1px solid var(--hairline)", borderRadius: 8,
    background: "var(--paper)", color: "var(--ink)", fontSize: 14,
  };

  return (
    <>
      <WSTitle
        eyebrow="Copilot · Governed answers"
        title="Ask Anvil"
        meta="every number shows how it was computed · scoped to your tenant"
        right={<Btn sm kind="ghost" onClick={() => (window.location.hash = "#/sales-ops")}>{Icon.graph} Cockpit</Btn>}
      />

      <div className="ws-content">
        {/* ── Suggested governed metrics ─────────────────────── */}
        <Card
          title="Ask a governed metric"
          eyebrow="one click · no guessing"
          right={
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span className="mono-sm" style={{ color: "var(--ink-4)" }}>window</span>
              {WINDOWS.map((w) => (
                <Btn key={w} sm kind={windowDays === w ? "primary" : "ghost"} onClick={() => setWindowDays(w)}>{w}d</Btn>
              ))}
            </span>
          }
        >
          {!metrics.length ? (
            <div className="mono-sm" style={{ color: "var(--ink-4)" }}>Loading the metric catalog…</div>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {metrics.map((m) => (
                <button
                  key={m.id}
                  onClick={() => askMetric(m)}
                  disabled={busy}
                  title={m.description || m.label}
                  style={{
                    padding: "6px 12px", borderRadius: 999, cursor: busy ? "default" : "pointer",
                    border: "1px solid var(--hairline)", background: "var(--paper-2)", color: "var(--ink-2)",
                    fontSize: 13, opacity: busy ? 0.6 : 1,
                  }}
                >
                  {m.label}
                </button>
              ))}
            </div>
          )}
        </Card>

        {/* ── Pending actions (GenOps: propose → confirm → execute) ── */}
        {proposals.length > 0 && (
          <Card
            title="Pending actions"
            eyebrow="review before it runs"
            right={<Chip k="warn">{proposals.length} awaiting confirm</Chip>}
          >
            {!isApprover && (
              <div className="mono-sm" style={{ color: "var(--ink-3)", marginBottom: 8 }}>
                Confirming an action needs an approver role — a manager, finance, or admin can run these.
              </div>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {proposals.map((p) => (
                <div key={p.confirm_token} style={{ padding: 12, borderRadius: 10, border: "1px solid var(--hairline)", background: "var(--paper-2)" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                    <span className="pri" style={{ fontWeight: 600 }}>{labelForAction(p.action)}</span>
                    <div style={{ display: "flex", gap: 6 }}>
                      <Btn sm kind="primary" disabled={!isApprover || actingOn === p.confirm_token} onClick={() => confirmProposal(p)}>
                        {actingOn === p.confirm_token ? "Running…" : <>{Icon.check} Confirm</>}
                      </Btn>
                      <Btn sm kind="ghost" disabled={actingOn === p.confirm_token} onClick={() => cancelProposal(p)}>{Icon.x} Cancel</Btn>
                    </div>
                  </div>
                  {p.preview && (
                    <div className="mono-sm" style={{ marginTop: 8, color: "var(--ink-2)", display: "flex", flexWrap: "wrap", gap: 10 }}>
                      {Object.entries(p.preview)
                        .filter(([k]) => k !== "action")
                        .map(([k, v]) => (
                          <span key={k}><span style={{ color: "var(--ink-4)" }}>{k.replace(/_/g, " ")}:</span> {String(v ?? "—")}</span>
                        ))}
                    </div>
                  )}
                  <div className="mono-sm" style={{ marginTop: 6, color: "var(--ink-4)" }}>
                    Nothing changes until you confirm{p.expires_at ? " · expires " + new Date(p.expires_at).toLocaleTimeString() : ""}.
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}

        {/* ── Conversation ───────────────────────────────────── */}
        <Card title="Answers" eyebrow="conversation" flush>
          <div ref={feedRef} style={{ maxHeight: 460, overflow: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
            {!entries.length ? (
              <Banner kind="info" icon={Icon.brain} title="Ask anything about your business">
                <span className="mono-sm">
                  Tap a governed metric above for an instant, auditable answer — or type a question below and the assistant
                  will reason over your orders, quotes, invoices and inventory.
                </span>
              </Banner>
            ) : entries.map((e, i) => {
              if (e.kind === "q") {
                return (
                  <div key={i} style={{ alignSelf: "flex-end", maxWidth: "80%", padding: "8px 12px", borderRadius: 12, background: "var(--accent)", color: "#fff", fontSize: 14 }}>
                    {e.text}
                  </div>
                );
              }
              if (e.kind === "metric") return <div key={i} style={{ alignSelf: "stretch" }}><MetricCard a={e.answer} /></div>;
              if (e.kind === "error") {
                return <div key={i} style={{ alignSelf: "stretch" }}><Banner kind="bad" icon={Icon.alert} title="Couldn't answer that"><span className="mono-sm">{e.message}</span></Banner></div>;
              }
              // text
              return (
                <div key={i} style={{ alignSelf: "stretch", padding: 12, borderRadius: 12, background: "var(--paper-2)", border: "1px solid var(--hairline-2)" }}>
                  <div style={{ whiteSpace: "pre-wrap", fontSize: 14, color: "var(--ink)" }}>{e.content}</div>
                  {e.citations && e.citations.length > 0 && (
                    <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {e.citations.map((c, j) => <Chip key={j} k="ghost">{c.source}</Chip>)}
                    </div>
                  )}
                </div>
              );
            })}
            {busy && <div className="mono-sm" style={{ color: "var(--ink-3)" }}>Thinking…</div>}
          </div>

          {/* ── Input ─────────────────────────────────────────── */}
          <div style={{ display: "flex", gap: 8, padding: 12, borderTop: "1px solid var(--hairline-2)" }}>
            <input
              style={inputStyle}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); askFreeText(); } }}
              placeholder="Ask about orders, AR, quotes, inventory…"
              aria-label="Ask Anvil a question"
              disabled={busy}
            />
            <Btn kind="primary" disabled={busy || !input.trim()} onClick={askFreeText}>{Icon.brain} Ask</Btn>
          </div>
        </Card>

        <div className="mono-sm" style={{ color: "var(--ink-4)", padding: "0 2px" }}>
          Governed answers resolve to Anvil's Metric Catalog — the number, how it was computed, and its as-of time.
          The assistant never invents figures; if a question can't be computed, it says so.
        </div>
      </div>
    </>
  );
};

export default AskAnvil;
