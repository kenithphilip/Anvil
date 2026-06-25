import { describe, it, expect, beforeEach } from "vitest";
import { isNavEnabled, applyNavSettingsLocal, getDisabledByRole, CORE_NAV_IDS } from "./nav-settings";

describe("nav-settings", () => {
  beforeEach(() => applyNavSettingsLocal({}));

  it("everything is enabled by default", () => {
    expect(isNavEnabled("leads", "finance")).toBe(true);
    expect(isNavEnabled("spares", "procurement")).toBe(true);
  });

  it("disables only the listed item for the listed role", () => {
    applyNavSettingsLocal({ finance: ["leads", "opps"] });
    expect(isNavEnabled("leads", "finance")).toBe(false);
    expect(isNavEnabled("opps", "finance")).toBe(false);
    expect(isNavEnabled("spares", "finance")).toBe(true);
    // a different role is unaffected
    expect(isNavEnabled("leads", "operator")).toBe(true);
  });

  it("core ids stay enabled even if a payload tries to disable them", () => {
    applyNavSettingsLocal({ admin: ["home", "admin"] });
    expect(isNavEnabled("home", "admin")).toBe(true);
    expect(isNavEnabled("admin", "admin")).toBe(true);
    // core ids were stripped, so the role ends up with no disabled set
    expect(getDisabledByRole().admin).toBeUndefined();
    expect(CORE_NAV_IDS.has("home")).toBe(true);
  });

  it("getDisabledByRole returns a copy that does not mutate state", () => {
    applyNavSettingsLocal({ viewer: ["cost"] });
    const snap = getDisabledByRole();
    snap.viewer.push("leads");
    expect(isNavEnabled("leads", "viewer")).toBe(true); // unchanged
  });
});
