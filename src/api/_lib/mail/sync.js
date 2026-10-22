// Sync one mailbox: token, then each folder in the adapter's order, one page at
// a time, inside the request budget and the run deadline.
// docs/EMAIL_ACCOUNTABILITY_SCOPE.md sections 4 and 6.1.
//
// Rules:
//   - The checkpoint of a folder moves only after its page went through
//     onPage. A failure keeps the pages already done and nothing more.
//   - Inbox before Sent. When Inbox does not finish in this run, Sent waits,
//     so a reply is never read before the action it answers exists.
//   - Each outcome is one row update: health, counters, the next due time.
//   - A run that stops at the page cap or the deadline is not a failure. The
//     mailbox is due again at once, so a backlog drains tick by tick.
//   - An admin alert fires on a change of state, not on every run.

import { MailError, newRun } from "./provider.js";
import { accessTokenFor } from "./connections.js";
import { notifyAdmins } from "../notifications.js";

export const MAX_PAGES_PER_FOLDER = 3;
export const PAGE_SIZE = 50;
export const MAX_RECOVERY_HOURS = 168;
export const ALERT_AT_FAILURES = 3;
export const PAUSE_AT_FAILURES = 10;
const MIN_PAUSE_MS = 60_000;
const MAX_PAUSE_MS = 3_600_000;
const HOUR = 3_600_000;

const nextUtcMidnight = (now) => {
  const d = new Date(now);
  d.setUTCHours(24, 0, 0, 0);
  return d.toISOString();
};

// Where a round starts when a folder has no checkpoint: one hour before the
// last success, so an outage loses nothing, but never more than 7 days back.
// A first sync uses the mailbox's initial lookback.
export const syncSince = (conn, now) => {
  const floor = now.getTime() - MAX_RECOVERY_HOURS * HOUR;
  const start = conn.last_success_at
    ? Date.parse(conn.last_success_at) - HOUR
    : now.getTime() - (conn.initial_lookback_hours || 72) * HOUR;
  return new Date(Math.max(floor, start)).toISOString();
};

const inFirst = (a, b) => (a.direction === b.direction ? 0 : a.direction === "in" ? -1 : 1);

export const outcomePatch = (conn, { failure, failedFolder, checkpoint, stats, now, used }) => {
  const nowIso = now.toISOString();
  const interval = (conn.poll_interval_minutes || 5) * 60_000;
  const base = { checkpoint, last_sync_at: nowIso, sync_lease_until: null, last_sync_stats: stats, ...used };
  if (!failure) {
    return {
      ...base, last_success_at: nowIso, consecutive_failures: 0, last_error: null,
      paused_until: null, pause_reason: null,
      next_sync_at: stats.complete ? new Date(now.getTime() + interval).toISOString() : nowIso,
    };
  }
  const code = failure instanceof MailError ? failure.code : "engine";
  const err = { ...base, last_error: (code + ": " + String(failure.message || "")).slice(0, 200), last_error_at: nowIso };
  const pause = (until, reason, extra = {}) => ({ ...err, paused_until: until, pause_reason: reason, next_sync_at: until, ...extra });

  if (code === "checkpoint") {
    return {
      ...err, checkpoint: { ...checkpoint, [failedFolder]: null },
      checkpoint_resets: (conn.checkpoint_resets || 0) + 1, next_sync_at: nowIso,
    };
  }
  if (code === "throttle") {
    const wait = Math.min(MAX_PAUSE_MS, Math.max(MIN_PAUSE_MS, Number(failure.retryAfterMs) || 0));
    return pause(new Date(now.getTime() + wait).toISOString(), "throttled", { quota_errors: (conn.quota_errors || 0) + 1 });
  }
  if (code === "quota") return pause(nextUtcMidnight(now), "quota", { quota_errors: (conn.quota_errors || 0) + 1 });
  if (code === "budget") return pause(nextUtcMidnight(now), "budget");
  const failures = (conn.consecutive_failures || 0) + 1;
  if (code === "auth") return { ...err, status: "reauth_required", consecutive_failures: failures, next_sync_at: null };
  // Back off: 2, 4, 8, then 16 poll intervals.
  const backoff = interval * 2 ** Math.min(failures, 4);
  return {
    ...err, consecutive_failures: failures,
    next_sync_at: new Date(now.getTime() + backoff).toISOString(),
    ...(failures >= PAUSE_AT_FAILURES ? { status: "paused", pause_reason: "failures" } : {}),
  };
};

const ALERT_TEXT = {
  reauth: "Mailbox needs a new sign-in",
  budget: "Mailbox sync paused: daily request budget reached",
  quota: "Mailbox sync paused: provider quota reached",
  failing: "Mailbox sync is failing",
  paused: "Mailbox sync paused after repeated failures",
};

const alertReason = (conn, patch, failure) => {
  if (!failure) return null;
  if (patch.status === "reauth_required" && conn.status !== "reauth_required") return "reauth";
  if (patch.pause_reason === "budget" || patch.pause_reason === "quota") return patch.pause_reason;
  if (patch.status === "paused" && conn.status !== "paused") return "paused";
  if (patch.consecutive_failures === ALERT_AT_FAILURES) return "failing";
  return null;
};

export const syncConnection = async (svc, conn, { adapter, settings, now = new Date(), deadline, sleep, onPage }) => {
  const today = now.toISOString().slice(0, 10);
  const usedBefore = conn.requests_date === today ? (conn.requests_today || 0) : 0;
  const run = newRun({ budget: (conn.daily_request_budget ?? 0) - usedBefore, deadline, sleep });
  const used = () => ({ requests_today: usedBefore + run.requests, requests_date: today });
  const checkpoint = { ...(conn.checkpoint || {}) };
  const stats = { pages: 0, inbound: 0, outbound: 0, complete: true };
  const since = syncSince(conn, now);
  const save = async (patch) => {
    const { error } = await svc.from("mailbox_connections")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("tenant_id", conn.tenant_id)
      .eq("id", conn.id);
    if (error) throw new MailError("transient", "connection save failed");
  };

  let failure = null;
  let failedFolder = null;
  try {
    const token = await accessTokenFor(svc, conn, settings, adapter);
    for (const folder of adapter.folders) {
      failedFolder = folder;
      let done = false;
      for (let page = 0; !done && page < MAX_PAGES_PER_FOLDER; page++) {
        const res = await adapter.listPage(token, checkpoint[folder] || null, {
          folder, sinceIso: since, pageSize: adapter.pageSize || PAGE_SIZE, address: conn.address,
        }, run);
        const messages = [...res.messages].sort(inFirst);
        if (onPage) await onPage(messages, { folder, connection: conn });
        checkpoint[folder] = res.checkpoint;
        stats.pages += 1;
        for (const m of messages) stats[m.direction === "in" ? "inbound" : "outbound"] += 1;
        await save({ checkpoint, ...used() });
        done = res.done;
      }
      if (!done) { stats.complete = false; break; }
    }
  } catch (err) {
    if (err instanceof MailError && err.code === "deadline") stats.complete = false;
    else failure = err;
  }

  const patch = outcomePatch(conn, { failure, failedFolder, checkpoint, stats, now, used: used() });
  try { await save(patch); } catch (err) { failure = failure || err; }
  const reason = alertReason(conn, patch, failure);
  if (reason) {
    await notifyAdmins(svc, conn.tenant_id, {
      kind: "mailbox_sync",
      title: ALERT_TEXT[reason],
      body: conn.provider + " mailbox " + conn.address + ": " + (patch.last_error || ""),
      link_route: "admin",
      link_params: { tab: "communications" },
      object_type: "mailbox_connection",
      object_id: conn.id,
    }, { dedupKey: conn.id + ":" + reason + ":" + today });
  }
  return {
    id: conn.id, ok: !failure, code: failure ? (failure.code || "engine") : null,
    requests: run.requests, stats, alert: reason,
  };
};
