// Uploads/storage/creation aggregation for the Item-Master Uploads view.

import { describe, it, expect } from "vitest";
import { computeUploadsSummary } from "../api/_lib/bom-uploads.js";

const ASSETS = [{ id: "a1" }, { id: "a2" }, { id: "a3" }];
const EVENTS = [
  { uploaded_by: "u1", line_count: 100, file_name: "gunA.xlsx", source_format: "excel", created_at: "2026-07-01T00:00:00Z", asset_id: "a1" },
  { uploaded_by: "u1", line_count: 50, file_name: "gunB.csv", source_format: "csv", created_at: "2026-07-10T00:00:00Z", asset_id: "a2" },
  { uploaded_by: "u2", line_count: 200, file_name: "gunC.xlsx", source_format: "excel", created_at: "2026-07-05T00:00:00Z", asset_id: "a3" },
];
const DOCS = [{ size_bytes: 1000 }, { size_bytes: 2000 }, { size_bytes: null }];

describe("computeUploadsSummary", () => {
  it("rolls up KPIs across assets / events / items / documents", () => {
    const r = computeUploadsSummary({ assets: ASSETS, events: EVENTS, docs: DOCS, itemsTotal: 500, itemsImported: 120 });
    expect(r.kpis).toEqual({
      assets_uploaded: 3,
      upload_events: 3,
      parts_ingested: 350,
      items_created: 500,
      items_imported: 120,
      documents: 3,
      storage_bytes: 3000, // null size ignored
    });
  });

  it("groups by uploader (uploads desc) with parts + latest activity", () => {
    const r = computeUploadsSummary({ assets: ASSETS, events: EVENTS, docs: DOCS, itemsTotal: 0, itemsImported: 0 });
    expect(r.by_uploader.map((u) => u.uploader_id)).toEqual(["u1", "u2"]); // u1 has 2 uploads
    const u1 = r.by_uploader.find((u) => u.uploader_id === "u1");
    expect(u1.uploads).toBe(2);
    expect(u1.parts).toBe(150);
    expect(u1.last_at).toBe("2026-07-10T00:00:00Z"); // most recent of u1's two
  });

  it("returns a recent feed with the event shape", () => {
    const r = computeUploadsSummary({ assets: ASSETS, events: EVENTS, docs: DOCS });
    expect(r.recent).toHaveLength(3);
    expect(r.recent[0]).toMatchObject({ uploaded_by: "u1", file_name: "gunA.xlsx", line_count: 100, source_format: "excel" });
  });

  it("empty input yields a well-formed zeroed summary", () => {
    const r = computeUploadsSummary({});
    expect(r.kpis.assets_uploaded).toBe(0);
    expect(r.kpis.parts_ingested).toBe(0);
    expect(r.kpis.storage_bytes).toBe(0);
    expect(r.by_uploader).toEqual([]);
    expect(r.recent).toEqual([]);
  });
});
