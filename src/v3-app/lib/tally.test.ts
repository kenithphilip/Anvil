import { describe, it, expect } from "vitest";
import { tallyOrderRows, tallyMasterRows, shortHash } from "./tally";

describe("tallyOrderRows", () => {
  it("returns [] for null/undefined", () => {
    expect(tallyOrderRows(null)).toEqual([]);
    expect(tallyOrderRows(undefined)).toEqual([]);
  });
  it("returns the array directly when given one", () => {
    expect(tallyOrderRows([{ id: 1 }])).toEqual([{ id: 1 }]);
  });
  it("unwraps { orders } and { rows } envelopes", () => {
    expect(tallyOrderRows({ orders: [{ id: 1 }] })).toEqual([{ id: 1 }]);
    expect(tallyOrderRows({ rows: [{ id: 2 }] })).toEqual([{ id: 2 }]);
  });
});

describe("tallyMasterRows", () => {
  it("unwraps { masters } envelope", () => {
    expect(tallyMasterRows({ masters: ["a"] })).toEqual(["a"]);
  });
});

describe("shortHash", () => {
  it("returns em-dash for empty input", () => {
    expect(shortHash(null)).toBe("—");
    expect(shortHash("")).toBe("—");
  });
  it("returns the value untouched if short", () => {
    expect(shortHash("abc")).toBe("abc");
  });
  it("truncates with ellipsis if longer than 10", () => {
    expect(shortHash("0123456789abcdef")).toBe("0123456789…");
  });
});
