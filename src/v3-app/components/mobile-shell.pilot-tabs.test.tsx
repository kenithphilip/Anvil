// The phone tabs follow the pilot nav preset (plan C-8, C-D9). MobileShell
// gets the same filtered nav as the desktop sidebar (visibleNav, as app.tsx
// passes it), so a role sees only the preset's tabs, plus More.

import React from "react";
import { describe, it, expect, beforeEach } from "vitest";
import { fireEvent, render, within } from "@testing-library/react";
import { MobileShell } from "./MobileShell";
import { NAV } from "../lib/nav";
import { RBAC, type Role } from "../lib/rbac";
import { applyNavSettingsLocal, pilotNavPreset, visibleNav } from "../lib/nav-settings";

const tabsFor = (role: Role): string[] => {
  RBAC.setRole(role);
  const { getByRole, unmount } = render(<MobileShell route="home" nav={visibleNav(NAV)} />);
  const labels = within(getByRole("tablist")).getAllByRole("tab").map((t) => t.textContent);
  unmount();
  return labels;
};

beforeEach(() => applyNavSettingsLocal({}));

describe("phone tabs under the pilot preset", () => {
  it("before the preset, a sales manager has every primary tab", () => {
    expect(tabsFor("sales_manager")).toEqual(["My Day", "Inbox", "Approve", "SOs", "More"]);
  });

  it("the sales engineer keeps My Day, Inbox, Approve and SOs", () => {
    applyNavSettingsLocal(pilotNavPreset({}).next);
    expect(tabsFor("sales_engineer")).toEqual(["My Day", "Inbox", "Approve", "SOs", "More"]);
  });

  it("the clerk (operator) keeps My Day and SOs only", () => {
    expect(tabsFor("operator")).toEqual(["My Day", "Inbox", "SOs", "More"]);
    applyNavSettingsLocal(pilotNavPreset({}).next);
    expect(tabsFor("operator")).toEqual(["My Day", "SOs", "More"]);
  });

  it("the More drawer holds only the preset's items", () => {
    applyNavSettingsLocal(pilotNavPreset({}).next);
    RBAC.setRole("operator");
    const { getByRole, getByText } = render(<MobileShell route="home" nav={visibleNav(NAV)} />);
    fireEvent.click(getByText("More"));
    const items = within(getByRole("dialog")).getAllByRole("button").map((b) => b.textContent).filter((t) => t);
    expect(items).toEqual(["My Day", "Sales Orders"]);
  });
});
