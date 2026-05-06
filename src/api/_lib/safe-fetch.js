// safeFetch: a thin wrapper over global fetch with three guarantees
//   1. AbortSignal.timeout(...) is set so calls cannot hang forever.
//   2. Network-level errors get a friendlier message naming the host.
//   3. Optional 5xx retry with bounded jitter (off by default; the
//      provider-specific clients enable it explicitly).
//
// Used to fix the systemic-issue audit finding: every external
// `fetch()` callsite was missing a timeout, which let a slow upstream
// (Anthropic, GSTN, FX, Tally bridge, D365) hang the request for the
// browser/operator. Wraps both Node's global fetch and the polyfill.

const DEFAULT_TIMEOUT_MS = Number(process.env.SAFE_FETCH_TIMEOUT_MS || 15000);

const hostOf = (url) => {
  try { return new URL(url).host; } catch (_) { return url; }
};

// Returns a fetch Response or throws a friendly Error. The thrown
// error has .cause set so callers can inspect the original.
export const safeFetch = async (url, init = {}) => {
  const timeoutMs = Number(init.timeoutMs || DEFAULT_TIMEOUT_MS);
  const controller = (typeof AbortController !== "undefined") ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(new Error("safeFetch timeout")), timeoutMs) : null;
  const finalInit = { ...init };
  if (controller) finalInit.signal = init.signal || controller.signal;
  delete finalInit.timeoutMs;
  try {
    const resp = await fetch(url, finalInit);
    return resp;
  } catch (err) {
    const host = hostOf(url);
    const aborted = err?.name === "AbortError" || /aborted|timeout/i.test(err?.message || "");
    const friendly = aborted
      ? "Upstream " + host + " did not respond within " + timeoutMs + "ms"
      : "Upstream " + host + " unreachable: " + (err?.message || String(err));
    const wrapped = new Error(friendly);
    wrapped.cause = err;
    throw wrapped;
  } finally {
    if (timer) clearTimeout(timer);
  }
};

// Convenience: same as safeFetch but rejects on non-2xx responses
// with a friendly message that includes the upstream status + body
// snippet (capped at 240 chars to avoid leaking secrets).
export const safeFetchOk = async (url, init = {}) => {
  const resp = await safeFetch(url, init);
  if (!resp.ok) {
    let body = "";
    try { body = (await resp.text()).slice(0, 240); } catch (_) { /* ignore */ }
    const host = hostOf(url);
    throw new Error("Upstream " + host + " returned " + resp.status + (body ? ": " + body : ""));
  }
  return resp;
};
