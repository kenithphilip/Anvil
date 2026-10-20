// The Mode B pilot nav preset (plan C-8, owner decision C-D9). The preset is a
// visibility map that goes through the same normalizer and the same client
// filter as Admin > Navigation, so these tests read what each role SEES after
// it, through visibleNav (the function app.tsx gives the sidebar and the
// phone tabs).

import { describe, it, expect, beforeEach } from "vitest";
import { applyNavSettingsLocal, isNavEnabled, pilotNavPreset, visibleNav } from "./nav-settings";
import { NAV } from "./nav";
import { RBAC, type Role } from "./rbac";
import { normalizeMap } from "../../api/admin/nav_settings.js";

const seenBy = (role: Role): string[] => {
  RBAC.setRole(role);
  return visibleNav(NAV).flatMap((g) => g.items.map((i) => i.id));
};

beforeEach(() => applyNavSettingsLocal({}));

describe("pilot nav preset", () => {
  it("leaves the sales engineer Home, Inbox (new POs), Sales Orders and Approvals", () => {
    applyNavSettingsLocal(pilotNavPreset({}).next);
    expect(seenBy("sales_engineer").sort()).toEqual(["approvals", "home", "intake", "so"]);
  });

  it("leaves the clerk's operator seat Home and Sales Orders", () => {
    applyNavSettingsLocal(pilotNavPreset({}).next);
    expect(seenBy("operator").sort()).toEqual(["home", "so"]);
  });

  it("gives admin every item back, and says which", () => {
    const allForAdmin = seenBy("admin");
    const { next, changes } = pilotNavPreset({ admin: ["audit", "tally"] });
    applyNavSettingsLocal(next);
    expect(seenBy("admin")).toEqual(allForAdmin);
    expect(changes.find((c) => c.role === "admin")).toEqual({ role: "admin", hide: [], show: ["tally", "audit"] });
  });

  it("keeps every other role's entry as it was", () => {
    const { next } = pilotNavPreset({ finance: ["leads"], sales_manager: ["spares"] });
    expect(next.finance).toEqual(["leads"]);
    expect(next.sales_manager).toEqual(["spares"]);
  });

  it("lists what it will hide before anything is applied, and applies nothing by itself", () => {
    const { changes } = pilotNavPreset({});
    const eng = changes.find((c) => c.role === "sales_engineer");
    expect(eng.hide).toContain("quotes");
    expect(eng.hide).not.toContain("so");
    expect(eng.hide).not.toContain("home");
    expect(isNavEnabled("quotes", "sales_engineer")).toBe(true);
  });

  it("re-enables an item the preset keeps that was hidden before", () => {
    const { next, changes } = pilotNavPreset({ sales_engineer: ["approvals", "quotes"] });
    expect(changes.find((c) => c.role === "sales_engineer").show).toEqual(["approvals"]);
    expect(next.sales_engineer).not.toContain("approvals");
  });

  it("has nothing left to change once applied", () => {
    const once = pilotNavPreset({ finance: ["leads"] }).next;
    const twice = pilotNavPreset(once);
    expect(twice.next).toEqual(once);
    expect(twice.changes.every((c) => !c.hide.length && !c.show.length)).toBe(true);
  });

  it("passes the server's nav_settings validation unchanged", () => {
    const { next } = pilotNavPreset({ finance: ["leads"] });
    expect(normalizeMap(next)).toEqual({ value: next });
  });
});
