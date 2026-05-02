import { describe, it, expect } from "vitest";
import { NAV, ROLES, crumbFor } from "./nav";

describe("NAV", () => {
  it("has the canonical 9 sidebar groups", () => {
    expect(NAV.map((g) => g.label)).toEqual([
      "Workflows", "Sales", "Procurement", "Service",
      "Finance", "Data", "Quality", "Comms & Security", "Admin",
    ]);
  });
  it("exposes 30 unique nav ids", () => {
    const ids = NAV.flatMap((g) => g.items.map((i) => i.id));
    expect(ids.length).toBe(30);
    expect(new Set(ids).size).toBe(30);
  });
  it("each item has id + label + icon", () => {
    for (const group of NAV) {
      for (const item of group.items) {
        expect(item.id).toBeTruthy();
        expect(item.label).toBeTruthy();
        expect(item.icon).toBeTruthy();
      }
    }
  });
});

describe("ROLES", () => {
  it("ships the canonical role display tuples", () => {
    expect(ROLES.map((r) => r.id)).toEqual([
      "engineer", "manager", "approver", "admin", "operator", "finance", "viewer",
    ]);
    for (const r of ROLES) expect(r.short.length).toBeLessThanOrEqual(3);
  });
});

describe("crumbFor", () => {
  it("returns Anvil + group + item label for known nav id", () => {
    expect(crumbFor("home")).toEqual(["Anvil", "Workflows", "My Day"]);
    expect(crumbFor("amc")).toEqual(["Anvil", "Service", "AMC Schedule"]);
    expect(crumbFor("admin")).toEqual(["Anvil", "Admin", "Admin Center"]);
  });
  it("falls back to ['Anvil'] for unknown id", () => {
    expect(crumbFor("nope")).toEqual(["Anvil"]);
  });
});
