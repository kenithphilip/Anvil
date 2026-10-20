// Admin > Mode B lane readiness (plan C-8): the checks from the server, and the
// pilot nav preset, applied only on the admin's click through the Navigation
// write path.

import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { waitFor, fireEvent } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";
import { LaneReadinessCard } from "./LaneReadinessCard";
import { applyNavSettingsLocal, isNavEnabled, pilotNavPreset } from "../lib/nav-settings";

const READINESS = {
  lane: "mode_b",
  window_days: 7,
  summary: { ok: 1, warn: 1, missing: 1 },
  checks: [
    { group: "flags", id: "so_processing_mode", label: "SO processing mode", status: "ok", reason: "Mode B: the clerk keys the SO in the ERP and Anvil pushes nothing.", value: "B" },
    { group: "services", id: "clamav", label: "ClamAV", status: "missing", reason: "CLAMAV_URL is not set, so inbound auto-OCR never runs (OPS-2)." },
    { group: "usage", id: "approve_order", label: "Approve", status: "warn", reason: "Not used in the last 7 days.", value: 0 },
  ],
};

describe("LaneReadinessCard", () => {
  let save: any;
  beforeEach(() => {
    installRbac("admin");
    applyNavSettingsLocal({});
    save = vi.fn(async (patch: any) => ({ ok: true, nav_disabled: patch.nav_disabled }));
    installBackend({
      admin: {
        laneReadiness: vi.fn(async () => READINESS),
        navSettings: vi.fn(async () => ({ nav_disabled: { finance: ["leads"] } })),
        updateNavSettings: save,
      },
    });
  });
  afterEach(() => { vi.restoreAllMocks(); applyNavSettingsLocal({}); });

  it("shows each check with its status and reason", async () => {
    const r = renderScreen(LaneReadinessCard);
    await waitFor(() => expect(r.getByTestId("lane-check-clamav").textContent).toMatch(/missing.*CLAMAV_URL is not set/));
    expect(r.getByTestId("lane-check-so_processing_mode").textContent).toMatch(/ok/);
    expect(r.getByTestId("lane-check-approve_order").textContent).toMatch(/warn/);
    expect(r.getByText("1 ok · 1 warn · 1 missing")).toBeTruthy();
  });

  it("shows what the preset changes and saves nothing until the click", async () => {
    const r = renderScreen(LaneReadinessCard);
    await waitFor(() => expect(r.getByTestId("pilot-preset-sales_engineer").textContent).toMatch(/hides .*Quotes/));
    expect(r.getByTestId("pilot-preset-operator").textContent).toMatch(/hides /);
    expect(r.getByTestId("pilot-preset-sales_engineer").textContent).not.toMatch(/Sales Orders/);
    expect(save).not.toHaveBeenCalled();
    expect(isNavEnabled("quotes", "sales_engineer")).toBe(true);
  });

  it("applies the preset through the nav settings write, keeps other roles, and updates the live nav", async () => {
    const r = renderScreen(LaneReadinessCard);
    const btn = await waitFor(() => {
      const b = r.getByText("Apply pilot preset").closest("button") as HTMLButtonElement;
      expect(b.disabled).toBe(false);
      return b;
    });
    fireEvent.click(btn);
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const sent = save.mock.calls[0][0].nav_disabled;
    expect(sent).toEqual(pilotNavPreset({ finance: ["leads"] }).next);
    expect(sent.finance).toEqual(["leads"]);
    await waitFor(() => expect(r.getByTestId("pilot-preset-none")).toBeTruthy());
    expect(isNavEnabled("quotes", "sales_engineer")).toBe(false);
    expect(isNavEnabled("so", "sales_engineer")).toBe(true);
  });
});
