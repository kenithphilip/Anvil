// CAR screen: a smoke render, plus status tabs that match the statuses
// car_reports allows (OPEN, UNDER_REVIEW, CLOSED, REOPENED; migration 006),
// and no invented severity. Started as the generated smoke test for
// screens/car.tsx and extended by hand.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";

beforeEach(() => {
  installBackend();
  installRbac("admin");
  // jsdom's confirm/alert/prompt are no-ops by default; stub them so
  // accidental click handlers can't pop dialogs during a smoke render.
  vi.stubGlobal("confirm", () => true);
  vi.stubGlobal("alert", () => undefined);
  vi.stubGlobal("prompt", () => null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Car", () => {
  it("renders without throwing", async () => {
    const mod = await import("./car");
    const Screen = mod.default;
    expect(typeof Screen).toBe("function");
    const { container } = renderScreen(Screen);
    expect(container).toBeTruthy();
    // Wait one tick so any useEffect-triggered fetches resolve.
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML.length).toBeGreaterThan(0);
  });
});

// ── Status tabs ────────────────────────────────────────────────────────────
// Rows as GET /api/service/car_reports returns them: the stored row, which
// has no severity column. Invented fixtures.

const CARS = [
  { id: "car-open-0001", tenant_id: "t-1", status: "OPEN",         part_no: "TIP-100", created_at: "2026-09-01T00:00:00Z" },
  { id: "car-rvw-0002",  tenant_id: "t-1", status: "UNDER_REVIEW", part_no: "TIP-200", created_at: "2026-09-02T00:00:00Z" },
  { id: "car-reop-0003", tenant_id: "t-1", status: "REOPENED",     part_no: "TIP-300", created_at: "2026-09-03T00:00:00Z" },
  { id: "car-clsd-0004", tenant_id: "t-1", status: "CLOSED",       part_no: "TIP-400", created_at: "2026-09-04T00:00:00Z" },
];

const mount = async () => {
  vi.stubGlobal("confirm", () => true);
  installBackend({
    getConfig: () => ({ url: "https://api.example.test", tenantId: "t-1" }),
    getSession: () => null,
  });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
    ok: true,
    status: 200,
    json: async () => (String(url).includes("/api/service/car_reports")
      ? { car_reports: CARS }
      : { closure_reports: [] }),
  })));
  const mod = await import("./car");
  const utils = renderScreen(mod.default);
  await waitFor(() => expect(utils.getByRole("tab", { name: /^Open/ })).toBeTruthy());
  return utils;
};

// The CAR number cell falls back to the first 8 characters of the id.
const shownIds = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("tbody tr .pri")).map((el) => el.textContent);

describe("CAR: status tabs", () => {
  it("has one tab per allowed status", async () => {
    const { getAllByRole } = await mount();
    const labels = getAllByRole("tab").map((t) => (t.textContent || "").replace(/\d+$/, ""));
    expect(labels).toEqual(["Open", "Under review", "Reopened", "Closed"]);
  });

  it.each([
    ["Open",         "car-open"],
    ["Under review", "car-rvw-"],
    ["Reopened",     "car-reop"],
    ["Closed",       "car-clsd"],
  ])("the %s tab shows its CAR (%s)", async (tab, shortId) => {
    const { getByRole, container } = await mount();
    fireEvent.click(getByRole("tab", { name: new RegExp("^" + tab) }));
    await waitFor(() => expect(shownIds(container)).toEqual([shortId]));
  });

  it("puts every CAR in exactly one tab", async () => {
    const { getAllByRole, container } = await mount();
    const seen: string[] = [];
    for (const tab of getAllByRole("tab")) {
      fireEvent.click(tab);
      await waitFor(() => expect(tab.getAttribute("aria-selected")).toBe("true"));
      seen.push(...(shownIds(container) as string[]));
    }
    expect(seen.sort()).toEqual(["car-clsd", "car-open", "car-reop", "car-rvw-"]);
  });

  it("shows no severity, because car_reports has none", async () => {
    const { container } = await mount();
    const headers = Array.from(container.querySelectorAll("thead th")).map((th) => th.textContent);
    expect(headers).not.toContain("Severity");
    expect(container.querySelector("tbody")?.textContent || "").not.toMatch(/\bmed\b/);
  });

  it("offers only allowed statuses on a new CAR", async () => {
    const { getByText, container } = await mount();
    fireEvent.click(getByText(/New CAR/));
    const select = await waitFor(() => {
      const s = Array.from(container.querySelectorAll("select")).find((el) =>
        Array.from(el.options).some((o) => o.value === "OPEN"));
      expect(s).toBeTruthy();
      return s as HTMLSelectElement;
    });
    const values = Array.from(select.options).map((o) => o.value);
    for (const v of values) expect(["OPEN", "UNDER_REVIEW", "CLOSED", "REOPENED"]).toContain(v);
    expect(values).toContain("UNDER_REVIEW");
  });
});
