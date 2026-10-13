// The Source POs "Total value" KPI read value_inr, total_value_inr and
// value, which source_pos does not have (the column is total_inr), so it was
// always 0. It also summed every row while saying "all open SPOs".
//
// This test puts the REAL source_pos GET handler behind the screen's
// sourcePos.list (screen -> real client -> handler). One row is shaped the
// way POST /api/source_pos writes a screen-made SPO: total_foreign and
// currency, no total_inr.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";

const db = vi.hoisted(() => ({ tables: {} as Record<string, Array<Record<string, any>>> }));

vi.mock("../../api/_lib/supabase.js", () => {
  const from = (table: string) => {
    const filters: Array<(r: any) => boolean> = [];
    const q: any = {
      select: () => q,
      order: () => q,
      limit: () => q,
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; },
      in: (c: string, v: unknown[]) => { filters.push((r) => v.includes(r[c])); return q; },
      then: (resolve: (v: unknown) => void) =>
        resolve({ data: (db.tables[table] || []).filter((r) => filters.every((f) => f(r))).map((r) => ({ ...r })), error: null }),
    };
    return q;
  };
  return { serviceClient: () => ({ from }), userClient: () => ({ from }) };
});
vi.mock("../../api/_lib/auth.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveContext: vi.fn(async () => ({ user: { id: "u-pr" }, tenantId: "t-1", role: "procurement" })),
}));
vi.mock("../../api/_lib/audit.js", () => ({ recordAudit: vi.fn(async () => {}) }));

const spoHandler = (await import("../../api/source_pos/index.js")).default;

// test-setup.ts ran the client IIFE before this file loaded, so this is the
// real client, captured before installBackend swaps in a stub.
const realClient = (window as any).AnvilBackend;

const serverFetch = vi.fn(async (url: string, init: { method: string }) => {
  let status = 200;
  let sent = "";
  const res: any = {
    setHeader: () => {},
    status(c: number) { status = c; return res; },
    send(p: string) { sent = p; return res; },
    end() { return res; },
  };
  const u = new URL(url);
  await spoHandler({ method: init.method, headers: {}, query: Object.fromEntries(u.searchParams.entries()), url: u.pathname }, res);
  return { ok: status < 400, status, text: async () => sent };
});

const spo = (id: string, extra: Record<string, unknown>) => ({
  id, tenant_id: "t-1", order_id: "o-1", reference: "SPO-" + id, supplier: "Kestrel Tooling",
  status: "SENT_TO_SUPPLIER", created_at: "2026-10-01T00:00:00.000Z", ...extra,
});

beforeEach(() => {
  db.tables = {
    source_pos: [
      // total_inr set: it is the rupee value, even where the foreign
      // total at the row's rate would say otherwise (4,000 x 83 = 332,000).
      spo("a", { currency: "USD", total_foreign: 4000, exchange_rate: 83, total_inr: 340000 }),
      // As POST writes a screen-made INR SPO: no total_inr.
      spo("b", { currency: "INR", total_foreign: 200000, total_inr: null, status: "DRAFT" }),
      // Foreign, with its own rate: 1,000 USD at 83.
      spo("c", { currency: "USD", total_foreign: 1000, exchange_rate: 83, total_inr: null, status: "ETA_CONFIRMED" }),
      // Foreign, no rate: no rupee value, counted apart.
      spo("d", { currency: "EUR", total_foreign: 5000, total_inr: null }),
      // Not open: left out.
      spo("e", { currency: "INR", total_inr: 999999, status: "CLOSED" }),
      spo("f", { currency: "INR", total_inr: 888888, status: "RECEIVED" }),
      // Another tenant's: never returned.
      { ...spo("g", { currency: "INR", total_inr: 777777 }), tenant_id: "t-2" },
    ],
  };
  realClient.setConfig({ url: "https://api.test", tenantId: "t-1" });
  vi.stubGlobal("fetch", serverFetch);
  serverFetch.mockClear();
  installBackend({
    sourcePos: {
      list: (p: unknown) => realClient.sourcePos.list(p),
      scorecard: vi.fn(async () => ({ scorecards: [] })),
    },
  });
  installRbac("procurement");
  window.location.hash = "#/spo";
});

afterEach(() => {
  vi.unstubAllGlobals();
  realClient.setConfig(null);
});

describe("Source POs: Total value", () => {
  it("sums the open SPOs in rupees from total_inr, and counts the ones with no rupee value", async () => {
    const mod = await import("./source-pos");
    renderScreen(mod.default);
    await screen.findByText("SPO-a");

    const tile = screen.getByText("Total value").parentElement as HTMLElement;
    // 340,000 + 200,000 + 1,000 x 83 = 623,000.
    await waitFor(() => expect(tile.querySelector(".v")?.textContent).toBe("₹ 623k"));
    expect(tile.querySelector(".d")?.textContent).toBe("all open SPOs · 1 without an INR value");
  });
});
