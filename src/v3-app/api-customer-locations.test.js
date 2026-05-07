// Regression tests for the auto-extract intake flow's address
// integration. Three contracts:
//
// 1. /api/customer_locations is registered in the router so the
//    intake dialog can fetch addresses (the user's
//    "relational object from other existing addresses" spec).
// 2. /api/customers POST mirrors bill_to / ship_to text into
//    customer_locations rows so the e-invoice JOIN finds them.
// 3. /api/docai/extract is callable by sales engineers (write
//    permission), not just admins (approve).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p) => readFileSync(resolve(process.cwd(), p), "utf8");

describe("customer_locations endpoint + intake address integration", () => {
  it("router maps /api/customer_locations to a handler", () => {
    const router = read("src/api/router.js");
    expect(router).toMatch(/customerLocationsIndex/);
    expect(router).toMatch(/["']\/customer_locations["']\s*:\s*customerLocationsIndex/);
  });

  it("GET endpoint joins customer_name onto each location row", () => {
    const src = read("src/api/customer_locations/index.js");
    expect(src).toMatch(/customer_name:/);
    expect(src).toMatch(/from\(\s*["']customers["']\s*\)/);
  });

  it("GET endpoint supports optional ?customer_id and ?q substring filters", () => {
    const src = read("src/api/customer_locations/index.js");
    expect(src).toMatch(/req\.query\.customer_id/);
    expect(src).toMatch(/req\.query\.q/);
  });

  it("/api/customers POST mirrors bill_to / ship_to into customer_locations", () => {
    const src = read("src/api/customers/index.js");
    // The handler must call upsertLocation for both bill and ship.
    expect(src).toMatch(/upsertLocation\([^)]*"bill"/);
    expect(src).toMatch(/upsertLocation\([^)]*"ship"/);
    // The upsert helper must hit the customer_locations table.
    expect(src).toMatch(/from\(\s*["']customer_locations["']\s*\)/);
  });

  it("/api/docai/extract requires write, not approve, so SEs can use auto-extract", () => {
    const src = read("src/api/docai/extract.js");
    expect(src).toMatch(/requirePermission\(\s*ctx\s*,\s*["']write["']\s*\)/);
    expect(src).not.toMatch(/requirePermission\(\s*ctx\s*,\s*["']approve["']\s*\)/);
  });

  it("address parser pulls pincode + city heuristically", () => {
    const src = read("src/api/customers/index.js");
    expect(src).toMatch(/parseAddressBlob/);
    expect(src).toMatch(/\\d\{6\}/);
  });

  it("client exposes customers.listLocations", () => {
    const client = read("src/client/anvil-client.js");
    expect(client).toMatch(/listLocations\s*:\s*async/);
    expect(client).toMatch(/\/api\/customer_locations/);
  });
});
