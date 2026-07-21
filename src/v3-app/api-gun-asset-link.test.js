// CM PDM P0c: authoritative gun -> BOM asset link. The spare_matrix row's
// bom_asset_id FK is resolved from gun_no at save so spare resolution stops
// re-matching gun_no strings on every lookup.

import { describe, it, expect } from "vitest";
import { buildGunAssetMap } from "../api/_lib/gun-asset-link.js";

describe("buildGunAssetMap", () => {
  it("maps asset_code (uppercased) to the bom_asset id", () => {
    const m = buildGunAssetMap([{ id: "a1", asset_code: "GUN-01", revision: "" }]);
    expect(m.get("GUN-01")).toBe("a1");
    expect(m.get("gun-01".toUpperCase())).toBe("a1");   // case-insensitive key
  });

  it("prefers the base revision when a code has several revisions", () => {
    const m = buildGunAssetMap([
      { id: "rev-b", asset_code: "GUN-01", revision: "B" },
      { id: "base", asset_code: "GUN-01", revision: "" },
      { id: "rev-c", asset_code: "GUN-01", revision: "C" },
    ]);
    expect(m.get("GUN-01")).toBe("base");
  });

  it("keeps the first seen when no base revision exists", () => {
    const m = buildGunAssetMap([
      { id: "rev-b", asset_code: "GUN-02", revision: "B" },
      { id: "rev-c", asset_code: "GUN-02", revision: "C" },
    ]);
    expect(m.get("GUN-02")).toBe("rev-b");
  });

  it("ignores rows without an id or asset_code", () => {
    const m = buildGunAssetMap([{ asset_code: "X" }, { id: "y", asset_code: "" }, null]);
    expect(m.size).toBe(0);
  });

  it("handles empty / non-array input", () => {
    expect(buildGunAssetMap([]).size).toBe(0);
    expect(buildGunAssetMap(null).size).toBe(0);
  });
});
