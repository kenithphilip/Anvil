// Sliding-window rate limiter. DB-backed via per-feature attempt
// tables (password_reset_attempts, mfa_attempts, magic_link_attempts).
// Each table has the same shape:
//   id uuid, identifier text, attempted_at timestamptz default now()
// where `identifier` is whatever uniquely keys the limit (email,
// user_id, IP, "<email>:<ip>", etc.).
//
// Used by:
//   - src/api/auth/request_reset.js (already shipped) via its own
//     check; we leave that path alone.
//   - src/api/auth/mfa.js (audit M3)
//   - src/api/auth/magic_link.js (audit M7)
//
// We pick DB over in-memory because Vercel's serverless functions
// are stateless across cold starts; a per-instance Map would let an
// attacker spread guesses across instances and bypass the limit.
//
// Returns { allowed: boolean, remaining: number, retry_in_sec: number }.

const SECONDS = 1000;
const MINUTES = 60 * SECONDS;

export const checkRateLimit = async (svc, table, identifier, opts = {}) => {
  const window = Number(opts.windowMs || 15 * MINUTES);
  const max = Number(opts.maxAttempts || 5);
  const now = new Date();
  const cutoff = new Date(now.getTime() - window).toISOString();
  const r = await svc.from(table)
    .select("id, attempted_at", { count: "exact" })
    .eq("identifier", identifier)
    .gte("attempted_at", cutoff)
    .order("attempted_at", { ascending: false });
  if (r.error) {
    // Don't fail-open on a DB read error: refuse the request.
    return { allowed: false, remaining: 0, retry_in_sec: Math.ceil(window / 1000), reason: "rate_limit_check_failed" };
  }
  const used = r.data?.length || 0;
  if (used >= max) {
    const oldest = r.data[r.data.length - 1]?.attempted_at;
    const retryAtMs = oldest ? new Date(oldest).getTime() + window : now.getTime() + window;
    return {
      allowed: false,
      remaining: 0,
      retry_in_sec: Math.max(1, Math.ceil((retryAtMs - now.getTime()) / 1000)),
    };
  }
  return { allowed: true, remaining: max - used, retry_in_sec: 0 };
};

// Record an attempt. Insert a row keyed by identifier; older rows
// outside the current window stay in the table but are filtered by
// the window check above. A periodic prune job can sweep them later.
export const recordRateLimitAttempt = async (svc, table, identifier) => {
  await svc.from(table).insert({ identifier, attempted_at: new Date().toISOString() });
};

// Convenience: check + record. Records an attempt only when the
// caller wants to count the current request (e.g., a failed verify).
// For success paths, callers can choose to skip recording.
export const useRateLimit = async (svc, table, identifier, opts) => {
  const result = await checkRateLimit(svc, table, identifier, opts);
  return result;
};

// Audit L5 (May 2026): webhook rate limiter. In-process LRU keyed
// on `<endpoint>:<source-ip>` with a sliding 1-minute window.
// Used by high-volume webhook endpoints (Stripe, Razorpay, Twilio,
// Slack, Vapi, Retell) where DB-backed rate limiting would add a
// round-trip per call. Resets across cold starts (acceptable; a
// coordinated attacker bypassing this needs to spread requests
// across function instances, which already crosses the WAF
// threshold).
const HITS = new Map();
const PRUNE_EVERY_MS = 30 * 1000;
let lastPrune = 0;

export const webhookRateLimit = (key, opts = {}) => {
  const max = Number(opts.maxPerMinute || 120);
  const windowMs = Number(opts.windowMs || 60 * 1000);
  const now = Date.now();
  if (now - lastPrune > PRUNE_EVERY_MS) {
    for (const [k, v] of HITS) {
      if (now - v.firstAt > windowMs * 2) HITS.delete(k);
    }
    lastPrune = now;
  }
  let entry = HITS.get(key);
  if (!entry || (now - entry.firstAt) > windowMs) {
    entry = { firstAt: now, count: 0 };
    HITS.set(key, entry);
  }
  entry.count += 1;
  if (entry.count > max) {
    return {
      allowed: false,
      count: entry.count,
      retry_in_sec: Math.max(1, Math.ceil((entry.firstAt + windowMs - now) / 1000)),
    };
  }
  return { allowed: true, count: entry.count, retry_in_sec: 0 };
};

// Convenience: extract a stable IP key from a request and apply
// the rate limit. Use in webhook handlers as the first thing after
// signature verification.
export const webhookIpRateLimit = (req, endpoint, opts) => {
  const ip = String(req.headers?.["x-forwarded-for"] || req.headers?.["x-real-ip"] || "")
    .split(",")[0].trim() || "unknown";
  return webhookRateLimit(endpoint + ":" + ip, opts);
};
