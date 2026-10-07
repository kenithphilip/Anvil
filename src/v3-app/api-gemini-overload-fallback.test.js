// An overloaded Gemini model must not eat the extraction run.
//
// 2026-10-06 and 2026-10-07, one 6-page PO, five runs. Google answered the
// model it routes to with 503 "This model is currently experiencing high
// demand". callGemini treated that like any 5xx: back off, retry the SAME
// model. On 10-07 two slow 503s spent 19.9s, the run budget stopped the third
// call, and the attempt error read "run budget exhausted before Gemini call",
// which hid the overload completely. Claude was then left 5.5s and timed out.
//
// These tests drive callGemini / callAnthropic with fetch stubbed and check
// what they now do: name the real status, switch to a second Gemini model on
// overload, give up after two overloaded calls with most of the budget left,
// and leave the 429 Retry-After behaviour as it was. Every value is invented.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const PRO = "gemini-3.1-pro-preview";
const FLASH = "gemini-3-flash-preview";

// Google's own overload body, as the 10-06 runs recorded it.
const overloadBody = {
  error: {
    code: 503,
    message: "This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.",
    status: "UNAVAILABLE",
  },
};

const response = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
  text: async () => JSON.stringify(body),
});
const okGemini = () => response(200, { candidates: [{ content: { parts: [{ text: "{\"lines\":[]}" }] }, finishReason: "STOP" }] });

const loadGemini = async (safeFetch) => {
  vi.doMock("../api/_lib/safe-fetch.js", () => ({ safeFetch }));
  return (await import("../api/_lib/gemini.js")).callGemini;
};
const modelOf = (call) => decodeURIComponent(String(call[0]).split("/models/")[1].split(":")[0]);
const ask = { tenantId: "t1", apiKey: "k", messages: [{ role: "user", content: "read this PO" }] };

beforeEach(() => { vi.resetModules(); });
afterEach(() => { vi.doUnmock("../api/_lib/safe-fetch.js"); vi.restoreAllMocks(); });

describe("callGemini on a 503 overload", () => {
  it("switches to the fallback model at once and returns its answer", async () => {
    const safeFetch = vi.fn(async (url) => (String(url).includes(PRO) ? response(503, overloadBody) : okGemini()));
    const callGemini = await loadGemini(safeFetch);
    const t0 = Date.now();
    const out = await callGemini({
      ...ask, model: PRO, fallback_model: FLASH, deadlineAt: Date.now() + 30_000, reserveMs: 0,
    });
    expect(out.ok).toBe(true);
    expect(out.model).toBe(FLASH);
    expect(out.fallback_from).toBe(PRO);
    expect(safeFetch.mock.calls.map(modelOf)).toEqual([PRO, FLASH]);
    expect(out.model_attempts.map((a) => [a.model, a.status])).toEqual([[PRO, 503], [FLASH, 200]]);
    // No back-off before the switch: the fallback model has its own capacity.
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it("stops after two overloaded calls, names the 503, and leaves most of the budget", async () => {
    const safeFetch = vi.fn(async () => response(503, overloadBody));
    const callGemini = await loadGemini(safeFetch);
    const budget = 30_000;
    const deadlineAt = Date.now() + budget;
    const out = await callGemini({ ...ask, model: PRO, fallback_model: FLASH, deadlineAt, reserveMs: 0 });

    expect(out.ok).toBe(false);
    expect(safeFetch).toHaveBeenCalledTimes(2);
    expect(out.status).toBe(503);
    expect(out.error).toMatch(/^503 model overloaded \(high demand\) on gemini-3\.1-pro-preview: This model is currently experiencing high demand/);
    expect(out.error).toContain("then 503 model overloaded (high demand) on gemini-3-flash-preview");
    expect(out.error).not.toMatch(/budget exhausted/);
    expect(out.failure_class).toBe("overload");
    expect(out.transient).toBe(true);
    expect(deadlineAt - Date.now()).toBeGreaterThan(budget * 0.9);
  });

  it("with no fallback model, makes one short retry of the same model and then stops", async () => {
    const safeFetch = vi.fn(async () => response(503, overloadBody));
    const callGemini = await loadGemini(safeFetch);
    const budget = 30_000;
    const deadlineAt = Date.now() + budget;
    const t0 = Date.now();
    const out = await callGemini({ ...ask, model: PRO, deadlineAt, reserveMs: 0 });

    expect(safeFetch.mock.calls.map(modelOf)).toEqual([PRO, PRO]);
    expect(out.ok).toBe(false);
    expect(out.status).toBe(503);
    expect(out.error).toMatch(/^503 model overloaded \(high demand\) on gemini-3\.1-pro-preview/);
    expect(out.failure_class).toBe("overload");
    // One short back-off (600ms), not the old 600 + 1200 against the same model.
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(deadlineAt - Date.now()).toBeGreaterThan(budget * 0.9);
  });
});

describe("callGemini names the status that ended the loop", () => {
  it("reports a 500 when the budget then stops the retry, instead of 'budget exhausted'", async () => {
    const safeFetch = vi.fn(async () => response(500, { error: { code: 500, message: "Internal error encountered.", status: "INTERNAL" } }));
    const callGemini = await loadGemini(safeFetch);
    // 2.5s of budget: room for one attempt and one 600ms back-off, then the
    // next attempt would have under the 2s minimum and is not started.
    const out = await callGemini({ ...ask, model: FLASH, deadlineAt: Date.now() + 2500, reserveMs: 0 });

    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(out.ok).toBe(false);
    expect(out.status).toBe(500);
    expect(out.error).toBe("500 upstream error on gemini-3-flash-preview: Internal error encountered.; run budget exhausted before a retry");
    expect(out.failure_class).toBe("server_error");
    expect(out.transient).toBe(true);
  });
});

describe("callGemini keeps the 429 Retry-After behaviour", () => {
  it("waits the Retry-After and retries the SAME model, even with a fallback configured", async () => {
    let n = 0;
    const safeFetch = vi.fn(async () => {
      n += 1;
      return n === 1
        ? response(429, { error: { code: 429, message: "Resource has been exhausted (e.g. check quota).", status: "RESOURCE_EXHAUSTED" } }, { "retry-after": "1" })
        : okGemini();
    });
    const callGemini = await loadGemini(safeFetch);
    const t0 = Date.now();
    const out = await callGemini({
      ...ask, model: PRO, fallback_model: FLASH, deadlineAt: Date.now() + 30_000, reserveMs: 0,
    });
    expect(out.ok).toBe(true);
    expect(out.model).toBe(PRO);
    expect(safeFetch.mock.calls.map(modelOf)).toEqual([PRO, PRO]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(950);
  });

  it("does the same for a caller with no deadline and no fallback", async () => {
    let n = 0;
    const safeFetch = vi.fn(async () => {
      n += 1;
      return n === 1 ? response(429, { error: { message: "quota" } }, { "retry-after": "1" }) : okGemini();
    });
    const callGemini = await loadGemini(safeFetch);
    const t0 = Date.now();
    const out = await callGemini({ ...ask, model: FLASH });
    expect(out.ok).toBe(true);
    expect(safeFetch).toHaveBeenCalledTimes(2);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(950);
  });
});

describe("callGemini honours the reserve the dispatcher already took", () => {
  it("reserveMs 0 gives the attempt the whole slice", async () => {
    const safeFetch = vi.fn(async () => okGemini());
    const callGemini = await loadGemini(safeFetch);
    await callGemini({ ...ask, model: FLASH, deadlineAt: Date.now() + 20_000, reserveMs: 0 });
    // Without reserveMs the default 8s tail would cut this to 12s.
    expect(safeFetch.mock.calls[0][1].timeoutMs).toBeGreaterThan(19_000);
  });
});

// ---- Claude ---------------------------------------------------------------

const thenable = (value) => {
  const api = new Proxy({}, {
    get: (_t, prop) => {
      if (prop === "then") return (resolve) => resolve(value);
      return () => api;
    },
  });
  return api;
};
const svc = { from: () => thenable({ data: [], error: null }) };

const loadAnthropic = async (safeFetch) => {
  vi.doMock("../api/_lib/safe-fetch.js", () => ({ safeFetch }));
  return (await import("../api/_lib/anthropic.js")).callAnthropic;
};

describe("callAnthropic names the status that ended the loop", () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  beforeEach(() => { process.env.ANTHROPIC_API_KEY = "test-key"; });
  afterEach(() => { if (saved == null) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved; });

  it("reports a 529 overload when the budget then stops the retry", async () => {
    const safeFetch = vi.fn(async () => response(529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }));
    const callAnthropic = await loadAnthropic(safeFetch);
    const out = await callAnthropic({
      tenantId: "t1", svc, messages: [{ role: "user", content: "read this PO" }],
      model: "claude-sonnet-4-6", deadlineAt: Date.now() + 2500, reserveMs: 0,
    });
    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(out.ok).toBe(false);
    expect(out.upstream_status).toBe(529);
    expect(out.error).toBe("529 model overloaded on claude-sonnet-4-6: Overloaded; run budget exhausted before a retry");
    expect(out.failure_class).toBe("overload");
    expect(out.transient).toBe(true);
  });

  it("classifies a timeout as transient", async () => {
    const safeFetch = vi.fn(async () => { throw new Error("Upstream api.anthropic.com did not respond within 15000ms"); });
    const callAnthropic = await loadAnthropic(safeFetch);
    const out = await callAnthropic({
      tenantId: "t1", svc, messages: [{ role: "user", content: "read this PO" }],
      model: "claude-sonnet-4-6", deadlineAt: Date.now() + 2500, reserveMs: 0,
    });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/^Network error: Upstream api\.anthropic\.com did not respond within 15000ms/);
    expect(out.failure_class).toBe("timeout");
    expect(out.transient).toBe(true);
  });

  it("reserveMs 0 gives the attempt the whole slice, up to the configured ceiling", async () => {
    const safeFetch = vi.fn(async () => response(200, { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }));
    const callAnthropic = await loadAnthropic(safeFetch);
    await callAnthropic({
      tenantId: "t1", svc, messages: [{ role: "user", content: "read this PO" }],
      model: "claude-sonnet-4-6", deadlineAt: Date.now() + 13_500, reserveMs: 0,
    });
    // The 2026-10-07 slice. With the old 8s reserve on top it was 5,525ms.
    expect(safeFetch.mock.calls[0][1].timeoutMs).toBeGreaterThan(13_000);
  });
});

// ---- which fallback model ---------------------------------------------------

describe("selectGeminiFallbackModel", () => {
  const load = async () => (await import("../api/_lib/docai/model_selector.js")).selectGeminiFallbackModel;
  const tiers = async () => (await import("../api/_lib/gemini.js")).MODEL_BY_TIER;

  it("defaults to the deployment's generation-tier model when the primary is the reasoning tier", async () => {
    const pick = await load();
    const T = await tiers();
    expect(pick({ primary: T.reasoning, env: "" })).toBe(T.generation);
  });

  it("uses the tenant setting first", async () => {
    const pick = await load();
    expect(pick({ primary: PRO, setting: "gemini-2.5-flash", env: "" })).toBe("gemini-2.5-flash");
  });

  it("'none' turns it off", async () => {
    const pick = await load();
    expect(pick({ primary: PRO, setting: "none", env: "" })).toBeNull();
    expect(pick({ primary: PRO, setting: "", env: "off" })).toBeNull();
  });

  it("gives a tenant that pinned its model no default fallback", async () => {
    const pick = await load();
    expect(pick({ primary: "gemini-3.1-pro-preview", pinned: true, env: "" })).toBeNull();
  });
});
