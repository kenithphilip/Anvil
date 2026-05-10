import { describe, it, expect } from "vitest";
import { NAV, ROLES, crumbFor } from "./nav";

describe("NAV", () => {
  it("has the canonical 9 sidebar groups", () => {
    expect(NAV.map((g) => g.label)).toEqual([
      "Workflows", "Sales", "Procurement", "Service",
      "Finance", "Data", "Quality", "Comms & Security", "Admin",
    ]);
  });
  it("exposes 38 unique nav ids", () => {
    // Count goes up to 38 with the inventory-planning module's
    // five Procurement entries (planning / plans / exceptions /
    // allocations / suppliers).
    const ids = NAV.flatMap((g) => g.items.map((i) => i.id));
    expect(ids.length).toBe(38);
    expect(new Set(ids).size).toBe(38);
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
    // ids match the canonical RBAC role identifiers used by both the
    // frontend matrix and the backend requirePermission sets. The old
    // short tuples ("engineer", "manager", "approver") let two roles
    // collapse onto the same "SAL" badge in the header pill.
    expect(ROLES.map((r) => r.id)).toEqual([
      "sales_engineer", "sales_manager", "procurement", "finance", "admin", "operator", "viewer",
    ]);
    for (const r of ROLES) expect(r.short.length).toBeLessThanOrEqual(3);
    // Short labels must be unique so the user can tell roles apart.
    const shorts = ROLES.map((r) => r.short);
    expect(new Set(shorts).size).toBe(shorts.length);
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
