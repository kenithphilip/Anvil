import { describe, it, expect } from "vitest";
import { normalizeMap } from "../api/admin/nav_settings.js";

describe("nav_settings normalizeMap", () => {
  it("accepts a well-formed per-role map and sorts/dedups ids", () => {
    const { value, error } = normalizeMap({ finance: ["opps", "leads", "leads"] });
    expect(error).toBeUndefined();
    expect(value).toEqual({ finance: ["leads", "opps"] });
  });

  it("defaults null/undefined to an empty map", () => {
    expect(normalizeMap(undefined)).toEqual({ value: {} });
    expect(normalizeMap(null)).toEqual({ value: {} });
  });

  it("rejects a non-object", () => {
    expect(normalizeMap(["leads"]).error).toMatch(/must be an object/);
    expect(normalizeMap("leads").error).toMatch(/must be an object/);
  });

  it("rejects an unknown role", () => {
    expect(normalizeMap({ wizard: ["leads"] }).error).toMatch(/unknown role/);
  });

  it("rejects a non-array role value", () => {
    expect(normalizeMap({ finance: "leads" }).error).toMatch(/must be an array/);
  });

  it("rejects a malformed nav id", () => {
    expect(normalizeMap({ finance: ["Bad ID!"] }).error).toMatch(/invalid nav id/);
  });

  it("never persists core ids as disabled", () => {
    const { value } = normalizeMap({ admin: ["home", "admin", "leads"] });
    expect(value).toEqual({ admin: ["leads"] });
  });

  it("drops roles whose disabled set is empty after cleaning", () => {
    const { value } = normalizeMap({ operator: ["home"], finance: [] });
    expect(value).toEqual({});
  });
});
