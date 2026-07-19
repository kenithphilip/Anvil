// Guards ERP_SOURCES in src/api/_lib/inventory/positions.js against the
// actual connector-mirror table schemas. The whole map was previously
// wrong (imagined column names), so every structured ERP source read
// columns that do not exist. This test fails if the reader and the
// migrations ever drift apart again.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ERP_SOURCES } from "../api/_lib/inventory/positions.js";

// Concatenate every migration so we can find each create-table block.
const migDir = join(process.cwd(), "supabase", "migrations");
const allSql = readdirSync(migDir)
  .filter((f) => f.endsWith(".sql"))
  .map((f) => readFileSync(join(migDir, f), "utf8"))
  .join("\n");

// Extract the column body of `create table [if not exists] <table> ( ... );`.
const tableBody = (table) => {
  const re = new RegExp("create table(?:\\s+if not exists)?\\s+" + table + "\\s*\\(([\\s\\S]*?)\\n\\);", "i");
  const m = allSql.match(re);
  return m ? m[1] : null;
};

// A column is "declared" when its name appears as an identifier in the
// body (word-boundary so quantity_on_hand != quantity_available).
const declares = (body, col) => new RegExp("\\b" + col + "\\b").test(body);

describe("ERP_SOURCES columns match the mirror-table migrations", () => {
  it("every source's table exists in a migration", () => {
    for (const s of ERP_SOURCES) {
      expect(tableBody(s.table), `no create-table for ${s.table}`).toBeTruthy();
    }
  });

  for (const s of ERP_SOURCES) {
    it(`${s.source}: part "${s.part}" and onHand "${s.onHand}" are real columns of ${s.table}`, () => {
      const body = tableBody(s.table);
      expect(body).toBeTruthy();
      expect(declares(body, s.part), `${s.table} has no column ${s.part}`).toBe(true);
      expect(declares(body, s.onHand), `${s.table} has no column ${s.onHand}`).toBe(true);
    });
  }
});
