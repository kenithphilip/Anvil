import React, { useEffect, useRef, useState } from "react";
import { Banner, Chip } from "../lib/primitives";
import { AnvilBackend } from "../lib/api";
import { ageLabel } from "../lib/helpers";
import { isJobInFlight } from "../../api/_lib/extraction-job-status.js";

// Live progress for a BACKGROUND extraction (an extraction_jobs row: a large
// or dense PO that the cron worker reads chunk by chunk).
//
// The SO workspace used to show progress only while a local action was busy.
// After intake handed a large PO to the background worker, the engineer saw
// a page-1 preview, no progress, and no refresh when the lines landed.
//
// This reads GET /api/orders/extraction_status once when the order opens. If
// the order's latest job is in flight, it keeps reading, shows the real stage
// and chunk count, and calls onLanded when the job completes, so the screen
// reloads the order with its lines. It stops on a finished job, and backs off
// while nothing moves (a queued job waits for the worker's next tick).
//
// The worker is drained by /api/cron/tick. If nothing pings that, a queued
// job waits, and this shows it waiting (with how long), and says when the
// worker last ran, so "waiting" can be told apart from "the worker is down".
// That time comes from cron_health through GET /api/health, the public probe
// that already lists every worker's last run; it exposes nothing new.

export const POLL = Object.freeze({
  firstMs: 2000,       // the first wait, and the wait after any movement
  maxMs: 15000,        // the longest wait while nothing moves
  factor: 1.5,         // how fast the wait grows while nothing moves
  ceilingMs: 30 * 60 * 1000, // stop watching after this long
});

// The wait before the next read: back to the first interval when the job
// moved since the last read, else longer by `factor`, up to `maxMs`.
export const nextDelay = (prevMs: number, moved: boolean, cfg: typeof POLL = POLL): number =>
  (moved ? cfg.firstMs : Math.min(cfg.maxMs, Math.round(prevMs * cfg.factor)));

// What counts as movement between two reads.
const progressKey = (s: any): string =>
  [s?.job?.status, s?.job?.next_chunk_index, s?.chunks_done, s?.chunks_failed, s?.last_event_at].join("|");

type Phase = "none" | "watching" | "landed" | "failed" | "stopped";

// How often the worker's last run is read again while a job is in flight.
export const WORKER_READ_MS = 60_000;

// The background worker's last run, from a /api/health body:
//   null                         the probe was not read, or cron_health was not
//                                (say nothing rather than guess)
//   { known: false }             cron_health has no row for the worker
//   { known: true, last_run_at, stale, worker }
// The extraction drain's own row is preferred; the tick that runs it is the
// fallback. `stale` is the server's verdict against the worker's cadence.
export type WorkerSeen = { known: boolean; worker?: string; last_run_at?: string; stale?: boolean };
export const workerSeen = (health: any): WorkerSeen | null => {
  const cron = health && typeof health === "object" && !Array.isArray(health) ? health.cron : null;
  if (!cron || cron.configured === false || !Array.isArray(cron.workers)) return null;
  const row = cron.workers.find((w: any) => w && w.worker === "extraction/jobs")
    || cron.workers.find((w: any) => w && w.worker === "cron/tick");
  if (!row || !row.last_run_at) return { known: false };
  return { known: true, worker: row.worker, last_run_at: row.last_run_at, stale: !!row.stale };
};

const workerLine = (w: WorkerSeen): string => {
  if (!w.known) return "There is no record of the background worker running, so this job waits until it does.";
  const ran = "The background worker last ran " + ageLabel(w.last_run_at) + " ago.";
  return w.stale ? ran + " That is later than it should be, so this job waits until the worker runs again." : ran;
};

export const BackgroundExtractionWatch: React.FC<{
  orderId: string;
  /** Change it to look again, e.g. after this screen queued a job. */
  checkKey?: number;
  /** The job completed: the lines are on the order. Called once. */
  onLanded: (snapshot: any) => void;
}> = ({ orderId, checkKey = 0, onLanded }) => {
  const [snap, setSnap] = useState<any>(null);
  const [phase, setPhase] = useState<Phase>("none");
  const [readErr, setReadErr] = useState<string | null>(null);
  const [worker, setWorker] = useState<WorkerSeen | null>(null);
  const landedRef = useRef(onLanded);
  landedRef.current = onLanded;

  useEffect(() => {
    if (!orderId) return undefined;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let delay: number = POLL.firstMs;
    let lastKey: string | null = null;
    let seenInFlight = false;
    const startedAt = Date.now();
    setSnap(null);
    setPhase("none");
    setReadErr(null);
    setWorker(null);

    const again = () => { timer = setTimeout(poll, delay); };
    const poll = async () => {
      if (!live) return;
      let s: any;
      try {
        s = await (AnvilBackend as any)?.orders?.extractionStatus?.(orderId);
      } catch (e: any) {
        if (!live) return;
        // Before a job was seen, a failed read means "nothing to watch".
        if (!seenInFlight) return;
        setReadErr(e?.message || String(e));
        delay = nextDelay(delay, false);
        again();
        return;
      }
      if (!live) return;
      const job = s && typeof s === "object" && !Array.isArray(s) ? s.job : null;
      if (isJobInFlight(job)) {
        seenInFlight = true;
        setReadErr(null);
        setSnap(s);
        if (Date.now() - startedAt > POLL.ceilingMs) { setPhase("stopped"); return; }
        setPhase("watching");
        const key = progressKey(s);
        delay = lastKey === null ? POLL.firstMs : nextDelay(delay, key !== lastKey);
        lastKey = key;
        again();
        return;
      }
      // Not in flight. Only a job this watch saw running has just ended; a
      // job that had already finished when the order opened is history.
      if (!seenInFlight) return;
      setSnap(s);
      if (job && job.status === "completed") {
        setPhase("landed");
        landedRef.current?.(s);
      } else {
        setPhase("failed");
      }
    };
    poll();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [orderId, checkKey]);

  // While a job is in flight, read when the worker last ran: now, then once
  // a minute. A failed read clears it rather than showing an old time.
  useEffect(() => {
    if (phase !== "watching") return undefined;
    let live = true;
    const read = async () => {
      try {
        const h = await (AnvilBackend as any)?.health?.();
        if (live) setWorker(workerSeen(h));
      } catch {
        if (live) setWorker(null);
      }
    };
    read();
    const t = setInterval(read, WORKER_READ_MS);
    return () => { live = false; clearInterval(t); };
  }, [phase]);

  if (phase === "none" || !snap) return null;
  const job = snap.job || {};

  if (phase === "failed") {
    return (
      <div style={{ margin: "8px 16px 0" }} data-testid="bg-extraction">
        <Banner kind="bad" title={job.status === "cancelled" ? "Background extraction was cancelled" : "Background extraction did not finish"}>
          <span className="mono-sm">
            {job.last_error ? job.last_error + ". " : ""}The lines from page 1 are kept. Run extraction to try again.
          </span>
        </Banner>
      </div>
    );
  }

  if (phase === "landed") {
    return (
      <div className="mono-sm" data-testid="bg-extraction" style={{ margin: "8px 16px 0", color: "var(--ink-3)" }}>
        Background extraction finished. The order has reloaded with its lines.
      </div>
    );
  }

  const queued = job.status === "queued";
  const total = Number(snap.chunks_total) || 0;
  const done = Number(snap.chunks_done) || 0;
  const failed = Number(snap.chunks_failed) || 0;
  const pages = Number(snap.page_count) || Number(job.total_pages) || 0;
  // A real fraction only: chunks done of chunks planned. Before the
  // document is split there is no honest percentage, so no bar.
  const pct = total > 0 ? Math.round((done / total) * 100) : null;

  return (
    <div
      data-testid="bg-extraction"
      role="status"
      aria-live="polite"
      style={{
        margin: "8px 16px 0", padding: "10px 14px", background: "var(--paper-2)",
        border: "1px solid var(--hairline-2)", borderRadius: 4, display: "flex", flexDirection: "column", gap: 8,
      }}
    >
      <div className="row" style={{ alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <Chip k="info">{queued ? "queued" : "extracting"}</Chip>
        <span className="mono-sm" data-testid="bg-extraction-stage" style={{ flex: 1, color: "var(--ink)" }}>
          {queued
            ? "Large PO queued" + (job.created_at ? " " + ageLabel(job.created_at) + " ago" : "") + ". Waiting for the background worker to start."
            : "Reading the full PO in the background: " + (snap.current_stage || job.status) + "."}
        </span>
        {total > 0 && (
          <span className="mono-sm" data-testid="bg-extraction-chunks" style={{ color: "var(--ink-3)" }}>
            {done} of {total} chunks{failed ? " · " + failed + " failed" : ""}
          </span>
        )}
        {pages > 0 && <span className="mono-sm" style={{ color: "var(--ink-3)" }}>{pages} pages</span>}
      </div>
      {pct != null && (
        <div style={{ height: 6, background: "var(--paper-3, #E8E9EB)", borderRadius: 3, overflow: "hidden" }}>
          <div data-testid="bg-extraction-bar" style={{ width: pct + "%", height: "100%", background: "var(--accent, var(--brand, #C8FF2B))", transition: "width 0.4s ease" }} />
        </div>
      )}
      {worker && (
        <span className="mono-sm" data-testid="bg-extraction-worker"
          style={{ color: worker.known && !worker.stale ? "var(--ink-3)" : "var(--rust, var(--ink))" }}>
          {workerLine(worker)}
        </span>
      )}
      <span className="mono-sm" style={{ color: "var(--ink-3)" }}>
        {phase === "stopped"
          ? "Still running after 30 minutes. Reload the page to check again."
          : readErr
            ? "Status not read (" + readErr + "). Trying again."
            : "The lines load here when it finishes."}
      </span>
    </div>
  );
};
