// Smoke test for the Invoices screen. Mirrors the agents.test.tsx
// pattern: confirm the screen mounts and renders without throwing
// when the backend is fully stubbed.
//
// The "send" tests run the REAL anvil-client (test-setup.ts loads it)
// against a fake server behind fetch, so they prove the route the
// button reaches, not only the client method it calls. Invented fixtures.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";

// Captured before any beforeEach swaps in a stub.
const realClient = (window as any).AnvilBackend;

beforeEach(() => {
  installBackend();
  installRbac("admin");
  vi.stubGlobal("confirm", () => true);
  vi.stubGlobal("alert", () => undefined);
  vi.stubGlobal("prompt", () => null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Invoices", () => {
  it("renders without throwing", async () => {
    const mod = await import("./invoices");
    const Screen = mod.default;
    expect(typeof Screen).toBe("function");
    const { container } = renderScreen(Screen);
    expect(container).toBeTruthy();
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML.length).toBeGreaterThan(0);
  });
});

// ── Send ────────────────────────────────────────────────────────────────
// A fake server. GET /api/invoices lists one invoice. POST
// /api/invoices/send answers with `sendReply`; a reply with sent:true
// also flips the stored invoice to sent, as the real handler does.

type Reply = { status: number; body: any };
let invoiceRow: any;
let sendReply: Reply;
let calls: { url: string; method: string; body: any }[];

const fakeFetch = vi.fn(async (url: string, init: any) => {
  const method = init?.method || "GET";
  const body = init?.body ? JSON.parse(init.body) : null;
  calls.push({ url, method, body });
  const path = String(url).replace("https://api.test", "").split("?")[0];
  let reply: Reply = { status: 404, body: { error: { message: "Not found" } } };
  if (method === "GET" && path === "/api/invoices") {
    reply = { status: 200, body: { invoices: [{ ...invoiceRow }] } };
  } else if (method === "POST" && path === "/api/invoices/send") {
    reply = sendReply;
    if (reply.status === 200 && reply.body?.sent) invoiceRow.status = "sent";
  }
  return {
    ok: reply.status >= 200 && reply.status < 300,
    status: reply.status,
    text: async () => JSON.stringify(reply.body),
  };
});

const mountWithRealClient = async () => {
  (window as any).AnvilBackend = realClient;
  (window as any).ObaraBackend = realClient;
  try { window.localStorage.removeItem("anvil:v3_session"); } catch { /* storage may be blocked */ }
  realClient.setConfig({ url: "https://api.test", tenantId: "t-1" });
  vi.stubGlobal("fetch", fakeFetch);
  const mod = await import("./invoices");
  const utils = renderScreen(mod.default);
  await waitFor(() => expect(utils.getByText("INV-0001")).toBeTruthy());
  return utils;
};

const sendButton = (utils: any) =>
  utils.queryAllByRole("button").find((b: HTMLElement) => (b.textContent || "").trim() === "send");

const clickSend = (utils: any) => {
  const btn = sendButton(utils);
  expect(btn).toBeTruthy();
  fireEvent.click(btn);
};

describe("Invoices: send", () => {
  beforeEach(() => {
    calls = [];
    fakeFetch.mockClear();
    invoiceRow = {
      id: "inv-1", invoice_number: "INV-0001", status: "draft", currency: "INR",
      grand_total: 1180, issue_date: "2026-10-01", due_date: "2026-10-31",
    };
    sendReply = { status: 200, body: { ok: true, sent: true, status: "sent", error: null, communication_id: "comm-1" } };
  });

  it("posts the invoice id to /api/invoices/send once, and makes no second send call", async () => {
    const utils = await mountWithRealClient();
    clickSend(utils);
    await waitFor(() => expect(utils.container.textContent).toContain("Invoice INV-0001 sent"));
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toEqual([{ url: "https://api.test/api/invoices/send", method: "POST", body: { id: "inv-1" } }]);
    expect(calls.some((c) => c.url.includes("/api/communications/send"))).toBe(false);
  });

  it("a success shows the invoice as sent", async () => {
    const utils = await mountWithRealClient();
    clickSend(utils);
    await waitFor(() => expect(utils.container.textContent).toContain("Invoice INV-0001 sent"));
    // The list reloads: the status chip reads sent and the draft-only send button is gone.
    await waitFor(() => {
      const chips = Array.from(utils.container.querySelectorAll("tbody td")).map((td: any) => td.textContent);
      expect(chips).toContain("sent");
    });
    expect(sendButton(utils)).toBeUndefined();
  });

  it("a send that did not go out shows the server's reason, not success", async () => {
    sendReply = {
      status: 200,
      body: { ok: true, sent: false, status: "queued", error: "No mail provider is configured, so the email was not sent." },
    };
    const utils = await mountWithRealClient();
    clickSend(utils);
    await waitFor(() => expect(utils.container.textContent).toContain(
      "Invoice INV-0001 not sent: No mail provider is configured, so the email was not sent.",
    ));
    expect(utils.container.textContent).not.toContain("Invoice INV-0001 sent");
    // Still a draft, so it can be sent again.
    const chips = Array.from(utils.container.querySelectorAll("tbody td")).map((td: any) => td.textContent);
    expect(chips).toContain("draft");
  });

  it("a refused request shows the server's error message", async () => {
    sendReply = {
      status: 403,
      body: { error: { message: "Role sales_engineer is not permitted to perform 'invoices.write'", status: 403 } },
    };
    const utils = await mountWithRealClient();
    clickSend(utils);
    await waitFor(() => expect(utils.container.textContent).toContain(
      "Role sales_engineer is not permitted to perform 'invoices.write'",
    ));
  });
});
