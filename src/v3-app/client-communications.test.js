// The real anvil-client communications namespace (not a stub): the filtered
// list the Follow-up timeline reads, the order-id list the ThreadDrawer has
// always used, and the POST that records a rep touch. Asserts the request the
// client actually puts on the wire.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// test-setup.ts ran the client IIFE before this file loaded, so this is the
// real client, captured before anything could swap in a stub.
const client = window.AnvilBackend;

let fetchSpy;
beforeEach(() => {
  client.setConfig({ url: "https://api.test", tenantId: "t-1" });
  fetchSpy = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ communications: [] }) }));
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
  client.setConfig(null);
});

describe("AnvilBackend.communications", () => {
  it("list(filters) sends object_type and object_id as query params", async () => {
    await client.communications.list({ object_type: "quote", object_id: "q-1" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.test/api/communications?object_type=quote&object_id=q-1");
    expect(init.method).toBe("GET");
  });

  it("list(filters) drops empty values instead of sending them", async () => {
    await client.communications.list({ customer_id: "c-1", object_id: "", order_id: null });
    expect(fetchSpy.mock.calls[0][0]).toBe("https://api.test/api/communications?customer_id=c-1");
  });

  it("list(orderId) keeps the ThreadDrawer's order-id call working", async () => {
    await client.communications.list("ord-1");
    expect(fetchSpy.mock.calls[0][0]).toBe("https://api.test/api/communications?order_id=ord-1");
  });

  it("log(payload) POSTs the touch to /api/communications/log", async () => {
    const payload = {
      object_type: "quote", object_id: "q-1", channel: "call", body: "Spoke to maintenance",
      metadata: { next_followup_at: "2026-10-07" },
    };
    await client.communications.log(payload);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.test/api/communications/log");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual(payload);
  });
});
