// Behavior tests for the RBAC matrix port. Each test sets a role then
// reads the gate function to confirm the matrix matches what the legacy
// code enforces. Tests double as documentation for the role->capability
// mapping.

import { describe, it, expect, beforeEach } from "vitest";
import { ROLES, MATRIX, ACTIONS, RBAC, getRole, setRole, canRead, canWrite, canApprove, isAdmin, canDo, filterNav } from "./rbac";

beforeEach(() => {
  // Clear both prefixes so the storage-keys read-fallback layer
  // doesn't carry a value over into the test.
  try {
    window.localStorage.removeItem("anvil:v3_role");
    window.localStorage.removeItem("obara:v3_role");
  } catch (_) {}
});

describe("ROLES + MATRIX shape", () => {
  it("ROLES is the canonical role list (7 base + 2 design)", () => {
    expect(ROLES.length).toBe(9);
    for (const r of ["sales_engineer", "sales_manager", "procurement", "finance", "admin", "operator", "viewer", "design_engineer", "design_manager"]) {
      expect(ROLES).toContain(r);
    }
  });

  it("MATRIX has a row for every visible nav id", () => {
    const navIds = [
      "home", "intake", "so", "internal", "approvals",
      "leads", "opps", "projects", "shipments",
      "spo", "spares",
      "svc-visits", "amc", "car",
      "tally", "einvoice", "cost",
      "customers", "items", "graph", "forecasts",
      "evals", "studio", "anomaly", "duplicates",
      "comms", "email", "security",
      "audit", "admin",
    ];
    for (const id of navIds) {
      expect(MATRIX[id], `missing matrix row for ${id}`).toBeTruthy();
    }
  });
});

describe("getRole / setRole", () => {
  it("defaults to sales_engineer when no localStorage entry", () => {
    expect(getRole()).toBe("sales_engineer");
  });
  it("setRole persists + emits a custom event", () => {
    let captured = null;
    const handler = (e) => { captured = e.detail.role; };
    window.addEventListener("rbac:change", handler);
    setRole("admin");
    expect(getRole()).toBe("admin");
    expect(captured).toBe("admin");
    window.removeEventListener("rbac:change", handler);
  });
  it("setRole rejects unknown roles", () => {
    expect(() => setRole("nobody" as any)).toThrow();
  });
});

describe("canRead / canWrite / canApprove for sales_manager", () => {
  beforeEach(() => setRole("sales_manager"));
  it("can read + write SOs and approve approvals", () => {
    expect(canRead("so")).toBe(true);
    expect(canWrite("so")).toBe(true);
    expect(canApprove("approvals")).toBe(true);
  });
  it("can now WRITE the spare matrix (flipped from read-only for gun-data uploads)", () => {
    expect(canWrite("spares")).toBe(true);
  });
  it("cannot see admin or security", () => {
    expect(canRead("admin")).toBe(false);
    expect(canRead("security")).toBe(false);
  });
  it("isAdmin is false", () => {
    expect(isAdmin()).toBe(false);
  });
});

describe("design roles inherit a base sales role + gun-data overrides", () => {
  it("design_engineer inherits sales_engineer's cells but gets rw on spares/items", () => {
    setRole("design_engineer");
    // Override: full write on the spare-matrix + item/drawing data.
    expect(canWrite("spares")).toBe(true);
    expect(canWrite("items")).toBe(true);      // sales_engineer is read-only on items; design overrides to rw
    // Inherited from sales_engineer: can read+write opportunities, cannot see admin.
    expect(canWrite("opps")).toBe(true);
    expect(canRead("admin")).toBe(false);
    expect(isAdmin()).toBe(false);
  });
  it("design_manager inherits sales_manager and can write the spare matrix", () => {
    setRole("design_manager");
    expect(canWrite("spares")).toBe(true);
    expect(canWrite("items")).toBe(true);
    expect(canRead("admin")).toBe(false);
  });
});

describe("admin role gates", () => {
  beforeEach(() => setRole("admin"));
  it("isAdmin true", () => {
    expect(isAdmin()).toBe(true);
  });
  it("canRead every nav route", () => {
    for (const id of Object.keys(MATRIX)) {
      expect(canRead(id), `admin should read ${id}`).toBe(true);
    }
  });
  it("canDo every action", () => {
    for (const action of Object.keys(ACTIONS)) {
      expect(canDo(action), `admin should do ${action}`).toBe(true);
    }
  });
});

describe("canDo action gates", () => {
  it("operator can amc.generate_visits, sales_engineer cannot", () => {
    setRole("operator");
    expect(canDo("amc.generate_visits")).toBe(true);
    setRole("sales_engineer");
    expect(canDo("amc.generate_visits")).toBe(false);
  });
  it("finance can tally.push, procurement cannot", () => {
    setRole("finance");
    expect(canDo("tally.push")).toBe(true);
    setRole("procurement");
    expect(canDo("tally.push")).toBe(false);
  });
  it("unknown actions default to allow (server enforces)", () => {
    setRole("viewer");
    expect(canDo("totally.unknown.action")).toBe(true);
  });
});

describe("filterNav", () => {
  beforeEach(() => setRole("sales_engineer"));
  it("removes inaccessible items + drops empty groups", () => {
    const NAV = [
      { label: "Sales", items: [{ id: "leads" }, { id: "opps" }, { id: "admin" }] },
      { label: "Admin", items: [{ id: "admin" }, { id: "security" }] },
    ];
    const filtered = filterNav(NAV);
    expect(filtered.length).toBe(1);
    expect(filtered[0].label).toBe("Sales");
    expect(filtered[0].items.map((i) => i.id)).toEqual(["leads", "opps"]);
  });
});

describe("RBAC aggregate", () => {
  it("exposes ROLES + helpers via the RBAC object for legacy callers", () => {
    expect(Array.isArray(RBAC.ROLES)).toBe(true);
    expect(typeof RBAC.canRead).toBe("function");
    expect(typeof RBAC.canDo).toBe("function");
    expect(typeof RBAC.filterNav).toBe("function");
  });
});
