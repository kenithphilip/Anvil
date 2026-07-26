// service_report_template endpoint — the tenant-default upsert.
//
// service_report_templates uniqueness is TWO partial indexes (one per customer,
// one tenant-default), because a plain unique(tenant_id, customer_id) treats
// NULL as distinct and would let a tenant accumulate multiple default rows.
// supabase-js onConflict can't target a partial index and can't match a NULL
// conflict key either, so the endpoint does a manual find-then-update/insert.
// This asserts the source uses that path and matches NULL with `.is`.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENDPOINT = readFileSync(join(HERE, "..", "api", "comms", "service_report_template.js"), "utf8");
const MIGRATION = readFileSync(join(HERE, "..", "..", "supabase", "migrations", "191_service_report.sql"), "utf8");

describe("migration enforces one tenant-default", () => {
  it("uses partial unique indexes, not a null-blind table constraint", () => {
    expect(MIGRATION).not.toMatch(/unique \(tenant_id, customer_id\)\s*\n\s*\)/);
    expect(MIGRATION).toMatch(/service_report_templates_default_uk[\s\S]*where customer_id is null/);
    expect(MIGRATION).toMatch(/service_report_templates_customer_uk[\s\S]*where customer_id is not null/);
  });
});

describe("endpoint upserts without relying on onConflict", () => {
  it("no longer makes an upsert/onConflict CALL (cannot target a partial index)", () => {
    // The word may appear in a comment; the CALL must not.
    expect(ENDPOINT).not.toMatch(/\.upsert\(/);
    expect(ENDPOINT).not.toMatch(/onConflict:/);
  });

  it("finds the existing row matching NULL customer_id with .is", () => {
    expect(ENDPOINT).toMatch(/existQ\.is\("customer_id", null\)/);
  });

  it("updates when found, inserts when not", () => {
    expect(ENDPOINT).toMatch(/existing\?\.data\?\.id/);
    expect(ENDPOINT).toMatch(/\.update\(row\)/);
    expect(ENDPOINT).toMatch(/\.insert\(row\)/);
  });
});
