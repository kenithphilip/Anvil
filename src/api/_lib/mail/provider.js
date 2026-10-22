// The provider-independent part of the mailbox sync.
// docs/EMAIL_ACCOUNTABILITY_SCOPE.md sections 5 and 6.1.
//
// An adapter (outlook.js, later gmail.js) turns provider responses into
// NormalisedMessage objects and maps provider errors to one MailError code.
// The sync runner (sync.js) then treats every provider the same way.
//
// MailError codes and what the runner does with them:
//   auth        token refused or revoked   -> reauth_required, alert
//   throttle    429 / 503 after retries    -> pause for Retry-After
//   checkpoint  the sync token is invalid  -> clear it, restart bounded
//   quota       a daily provider quota     -> pause to 00:00 UTC, alert
//   budget      our own daily budget       -> pause to 00:00 UTC, alert
//   transient   5xx or network after retry -> failure count
//   http        any other status           -> failure count
//   deadline    the run is out of time     -> stop cleanly, continue next tick

import { safeFetch } from "../safe-fetch.js";

export class MailError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

export const MAX_RETRIES = 2;
// A longer Retry-After ends the run; the mailbox waits for it on a later tick.
export const MAX_INLINE_WAIT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 8_000;

export const retryAfterMs = (resp, attempt) => {
  const raw = resp?.headers?.get?.("retry-after");
  if (raw != null && raw !== "") {
    const secs = Number(raw);
    if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
    const at = Date.parse(raw);
    if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  }
  return 1000 * 4 ** attempt; // 1 s, then 4 s
};

// One provider request, inside the run's request budget and deadline.
//   run      { requests, budget, deadline, sleep } shared by the whole run;
//            every attempt counts, retries too.
//   classify (status, bodyText) -> a MailError code, or null for "by status".
// Returns the ok Response. The error body is never put into a message or log:
// a provider body can echo tokens or mailbox data.
export const mailFetch = async (run, url, init, classify = () => null) => {
  for (let attempt = 0; ; attempt++) {
    if (run.requests >= run.budget) throw new MailError("budget", "daily request budget reached");
    if (Date.now() >= run.deadline) throw new MailError("deadline", "run deadline reached");
    run.requests += 1;
    let resp = null;
    try {
      resp = await safeFetch(url, { timeoutMs: REQUEST_TIMEOUT_MS, ...init });
    } catch {
      resp = null; // network error or timeout: retried like a 503
    }
    if (resp?.ok) return resp;

    const status = resp ? resp.status : 0;
    const body = resp ? await resp.text().catch(() => "") : "";
    const code = classify(status, body)
      || (status === 429 ? "throttle" : (status === 0 || status >= 500) ? "transient" : "http");
    if (code !== "throttle" && code !== "transient") {
      throw new MailError(code, "provider HTTP " + status, { status });
    }
    const wait = resp ? retryAfterMs(resp, attempt) : 1000 * 4 ** attempt;
    if (attempt >= MAX_RETRIES || wait > MAX_INLINE_WAIT_MS || Date.now() + wait > run.deadline) {
      throw new MailError(code, "provider HTTP " + status, { status, retryAfterMs: wait });
    }
    await run.sleep(wait);
  }
};

export const newRun = ({ budget, deadline, sleep }) => ({
  requests: 0,
  budget: Math.max(0, Number(budget) || 0),
  deadline,
  sleep: sleep || ((ms) => new Promise((r) => setTimeout(r, ms))),
});

// The address forms the engine compares: trimmed and lower case.
export const normAddr = (a) => String(a || "").trim().toLowerCase();

// A Message-ID list ("<a@x> <b@y>") as an array, in its "<...>" form.
export const parseIdList = (raw) => String(raw || "").match(/<[^<>\s]+>/g) || [];
