// The anvil-client methods the opportunity detail card calls, executed for
// real (test-setup.ts loads the client IIFE; fetch is the only stub). The
// screen tests stub AnvilBackend, so this is where the method-to-route wiring
// is proven.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const client = window.AnvilBackend;

let fetchMock;
beforeEach(() => {
  try { window.localStorage.clear(); } catch { /* no storage: setConfig below still runs */ }
  client.setConfig({ url: "https://api.test", tenantId: "t-1" });
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); });

const lastCall = () => {
  const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  return { url, method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null };
};

describe("sales client: opportunities", () => {
  it("updateOpportunity PATCHes the stage, the lost reason and the owner", async () => {
    await client.sales.updateOpportunity({ id: "o-1", stage: "CLOSE_LOST", lost_reason: "PRICE_HIGH" });
    expect(lastCall()).toEqual({
      url: "https://api.test/api/sales/opportunities",
      method: "PATCH",
      body: { id: "o-1", stage: "CLOSE_LOST", lost_reason: "PRICE_HIGH" },
    });
    await client.sales.updateOpportunity({ id: "o-1", owner_id: "u-2" });
    expect(lastCall().body).toEqual({ id: "o-1", owner_id: "u-2" });
  });

  it("predictOpportunity POSTs the id in the body, which is the only form the handler accepts", async () => {
    await client.sales.predictOpportunity("o-1");
    expect(lastCall()).toEqual({
      url: "https://api.test/api/sales/predict_opportunity",
      method: "POST",
      body: { id: "o-1" },
    });
  });

  it("a 409 from the stage guard reaches the caller with its status and body", async () => {
    const reply = { error: { code: "INVALID_STAGE_TRANSITION", message: "Cannot move opportunity from RFQ to STRATEGY_CHECK directly.", from: "RFQ", to: "STRATEGY_CHECK" } };
    fetchMock.mockResolvedValueOnce({ ok: false, status: 409, text: async () => JSON.stringify(reply) });
    const err = await client.sales.updateOpportunity({ id: "o-1", stage: "STRATEGY_CHECK" }).catch((e) => e);
    expect(err.status).toBe(409);
    expect(err.body).toEqual(reply);
  });
});
