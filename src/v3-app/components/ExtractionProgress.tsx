import React, { useEffect, useRef, useState } from "react";
import { Banner, Btn, Chip } from "../lib/primitives";
import { AnvilBackend } from "../lib/api";

// Live progress indicator for an in-flight extraction.
//
// Polls /api/orders/extraction_status every POLL_INTERVAL_MS to
// surface stage progress (profiling, chunking, per-chunk
// extraction, merging, done). The status endpoint reduces the
// processing_events stream the pipeline writes; this component
// renders the reduction.
//
// Three terminal states: completed, failed, idle (the latter
// when no extraction has run yet on this order). The component
// stops polling on any terminal state and surfaces onComplete /
// onFailed callbacks so the recon table can refresh itself.

const POLL_INTERVAL_MS = 2000;
const MAX_POLL_DURATION_MS = 10 * 60 * 1000; // 10 minutes ceiling

interface ProgressEvent {
  event_type: string;
  detail?: any;
  created_at: string;
}

interface ProgressSnapshot {
  order_id: string;
  status: "idle" | "running" | "completed" | "failed";
  current_stage: string;
  last_event_at: string | null;
  page_count: number | null;
  line_item_pages: number[] | null;
  chunks_total: number;
  chunks_done: number;
  chunks_failed: number;
  page_start: number | null;
  page_end: number | null;
  line_count: number | null;
  adapters_used: string[];
  profiler_ok: boolean | null;
  last_terminal_reason: string | null;
  events: ProgressEvent[];
}

interface Props {
  orderId: string | null;
  // Triggered the first transition to a terminal state.
  onComplete?: (snapshot: ProgressSnapshot) => void;
  onFailed?: (snapshot: ProgressSnapshot) => void;
  // The component normally polls automatically. Set false to
  // gate on an external trigger (e.g. only poll while the
  // operator is actively running an extraction).
  active?: boolean;
  // Show the per-event log under the bar. Default off; the
  // recon table turns it on for debugging.
  showEventLog?: boolean;
}

const fetchStatus = async (orderId: string): Promise<ProgressSnapshot | null> => {
  const cfg: any = (AnvilBackend as any)?.getConfig?.() || {};
  const session: any = (AnvilBackend as any)?.getSession?.() || null;
  if (!cfg.url) return null;
  const headers: any = { "Content-Type": "application/json" };
  if (session?.access_token) headers["Authorization"] = "Bearer " + session.access_token;
  if (cfg.tenantId) headers["x-anvil-tenant"] = cfg.tenantId;
  const url = cfg.url.replace(/\/+$/, "") + "/api/orders/extraction_status?order_id=" + encodeURIComponent(orderId);
  const resp = await fetch(url, { headers });
  if (!resp.ok) return null;
  return resp.json();
};

export const ExtractionProgress: React.FC<Props> = ({ orderId, onComplete, onFailed, active = true, showEventLog = false }) => {
  const [snap, setSnap] = useState<ProgressSnapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const lastTerminalRef = useRef<string | null>(null);
  const startedAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (!orderId || !active) return;
    let cancelled = false;
    startedAtRef.current = Date.now();
    const poll = async () => {
      if (cancelled) return;
      if (startedAtRef.current && Date.now() - startedAtRef.current > MAX_POLL_DURATION_MS) {
        // Failsafe: stop polling so we never spin forever on a
        // job that silently broke. Operator can refresh the
        // page to resume.
        return;
      }
      try {
        const s = await fetchStatus(orderId);
        if (cancelled) return;
        if (!s) { setErr("status endpoint unreachable"); return; }
        setSnap(s);
        setErr(null);
        const terminalKey = s.status === "completed" || s.status === "failed"
          ? s.status + ":" + (s.last_event_at || "")
          : null;
        if (terminalKey && terminalKey !== lastTerminalRef.current) {
          lastTerminalRef.current = terminalKey;
          if (s.status === "completed") onComplete?.(s);
          if (s.status === "failed") onFailed?.(s);
          return; // stop polling on terminal
        }
        window.setTimeout(poll, POLL_INTERVAL_MS);
      } catch (e: any) {
        if (cancelled) return;
        setErr(e?.message || String(e));
        window.setTimeout(poll, POLL_INTERVAL_MS * 2); // back off on error
      }
    };
    poll();
    return () => { cancelled = true; };
  }, [orderId, active, onComplete, onFailed]);

  if (!orderId) return null;
  if (!snap && !err) {
    return (
      <div className="mono-sm" style={{ padding: "8px 12px", color: "var(--ink-3)" }}>
        connecting to extraction status...
      </div>
    );
  }
  if (err) {
    return (
      <Banner kind="warn" title="Progress unavailable">
        <span className="mono-sm">{err}</span>
      </Banner>
    );
  }
  if (!snap) return null;

  // Derive bar fill: profiler is 10% of the bar; chunk progress
  // fills the remaining 90% proportionally to chunks_done /
  // chunks_total. When chunks_total is 0 (small single-shot PDF
  // or non-PDF), the bar shows 50% while running and 100% on
  // completion.
  const profilerContrib = snap.profiler_ok != null ? 10 : 0;
  const chunkContrib = snap.chunks_total > 0
    ? Math.round((snap.chunks_done / snap.chunks_total) * 90)
    : (snap.status === "running" ? 40 : 0);
  const pctRaw = profilerContrib + chunkContrib;
  const pct = snap.status === "completed" ? 100
    : snap.status === "failed" ? Math.max(10, pctRaw)
      : snap.status === "idle" ? 0
        : Math.min(95, pctRaw || 10);

  const toneByStatus: Record<string, "good" | "info" | "bad" | "ghost"> = {
    completed: "good",
    running:   "info",
    failed:    "bad",
    idle:      "ghost",
  };
  const tone = toneByStatus[snap.status] || "info";
  const barColor = snap.status === "completed" ? "var(--accent, var(--good, #2D8C3C))"
    : snap.status === "failed" ? "var(--rust, #C03B2B)"
      : "var(--accent, var(--brand, #C8FF2B))";

  return (
    <div style={{
      padding: "10px 14px",
      background: "var(--paper-2)",
      border: "1px solid var(--hairline-2)",
      borderRadius: 4,
      display: "flex", flexDirection: "column", gap: 8,
    }}>
      <div className="row" style={{ alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <Chip k={tone}>{snap.status}</Chip>
        <span className="mono-sm" style={{ flex: 1, color: "var(--ink)" }}>
          {snap.current_stage}
        </span>
        {snap.chunks_total > 0 && (
          <span className="mono-sm" style={{ color: "var(--ink-3)" }}>
            {snap.chunks_done}/{snap.chunks_total} chunks
            {snap.chunks_failed > 0 ? ` · ${snap.chunks_failed} failed` : ""}
          </span>
        )}
        {snap.page_count != null && (
          <span className="mono-sm" style={{ color: "var(--ink-3)" }}>{snap.page_count} pages</span>
        )}
      </div>
      <div style={{ height: 6, background: "var(--paper-3, #E8E9EB)", borderRadius: 3, overflow: "hidden" }}>
        <div style={{
          width: pct + "%",
          height: "100%",
          background: barColor,
          transition: "width 0.4s ease",
        }} />
      </div>
      {snap.line_item_pages && snap.line_item_pages.length > 0 && snap.status !== "completed" && (
        <div className="mono-sm" style={{ color: "var(--ink-3)", fontSize: 11 }}>
          line-item pages: {snap.line_item_pages.slice(0, 12).join(", ")}
          {snap.line_item_pages.length > 12 ? ", ..." : ""}
        </div>
      )}
      {snap.adapters_used.length > 0 && (
        <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
          {snap.adapters_used.map((a) => <Chip key={a} k="info">{a}</Chip>)}
        </div>
      )}
      {snap.status === "failed" && snap.last_terminal_reason && (
        <Banner kind="bad" title="Extraction failed">
          <span className="mono-sm">{snap.last_terminal_reason}</span>
        </Banner>
      )}
      {showEventLog && snap.events.length > 0 && (
        <details>
          <summary className="mono-sm" style={{ color: "var(--ink-3)", cursor: "pointer", fontSize: 11 }}>
            event log · {snap.events.length} recent
          </summary>
          <table className="tbl" style={{ marginTop: 6 }}>
            <thead>
              <tr><th>Stage</th><th>When</th></tr>
            </thead>
            <tbody>
              {snap.events.map((e, i) => (
                <tr key={i}>
                  <td className="mono-sm" style={{ fontSize: 11 }}>{e.event_type.replace(/^docai_/, "")}</td>
                  <td className="mono-sm" style={{ fontSize: 11, color: "var(--ink-3)" }}>
                    {new Date(e.created_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
};
