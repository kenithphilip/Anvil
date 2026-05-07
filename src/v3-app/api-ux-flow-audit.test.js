// Regression tests for the UX-flow audit. Locks every fix shipped in
// the audit so they can't regress silently.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const read = (p) => readFileSync(resolve(process.cwd(), p), "utf8");

describe("audit gate: dangling client calls", () => {
  it("scanner exits 0 against the current tree", () => {
    const out = spawnSync("node", ["scripts/audit/dangling-client-calls.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    if (out.status !== 0) {
      // Surface the report so a regression points the author at the
      // exact site that broke.
      // eslint-disable-next-line no-console
      console.log(out.stdout);
    }
    expect(out.status).toBe(0);
  });
});

describe("documents library: list endpoint exists", () => {
  it("router maps GET /api/documents to a handler", () => {
    const router = read("src/api/router.js");
    expect(router).toMatch(/documentsIndex/);
    expect(router).toMatch(/["']\/documents["']\s*:\s*documentsIndex/);
  });
  it("client exposes documents.list()", () => {
    const client = read("src/client/anvil-client.js");
    expect(client).toMatch(/list:\s*async[\s\S]{0,200}\/api\/documents/);
  });
});

describe("communications timeline: list endpoint exists", () => {
  it("router maps GET /api/communications to a handler", () => {
    const router = read("src/api/router.js");
    expect(router).toMatch(/commsList/);
    expect(router).toMatch(/["']\/communications["']\s*:\s*commsList/);
  });
  it("client exposes communications.list()", () => {
    const client = read("src/client/anvil-client.js");
    const block = client.match(/const communications\s*=\s*\{[\s\S]*?\};/);
    expect(block).not.toBeNull();
    expect(block[0]).toMatch(/list:\s*async/);
  });
});

describe("comms screen handles ?new=<template>", () => {
  it("reads the param and pre-selects the template", () => {
    const src = read("src/v3-app/screens/comms.tsx");
    expect(src).toMatch(/newTemplateFromHash/);
    expect(src).toMatch(/TEMPLATE_ALIASES/);
    // CmdK ships `?new=nudge` as a legacy alias.
    expect(src).toMatch(/nudge:\s*["']missing-doc["']/);
  });
});

describe("audit log rows have a working open button", () => {
  it("maps every documented object_type to a hash route", () => {
    const src = read("src/v3-app/screens/audit.tsx");
    expect(src).toMatch(/AUDIT_ROUTE_FOR_OBJECT/);
    // Spot-check the most common object types so a typo on the
    // canonical names doesn't silently disable drill-through.
    for (const t of ["order", "source_po", "customer", "document", "shipment", "einvoice"]) {
      expect(src).toMatch(new RegExp(t + ":\\s*\\(id\\)\\s*=>"));
    }
  });
});

describe("notifications bell validates link_route", () => {
  it("imports ROUTE_IDS and warns on unknown routes", () => {
    const src = read("src/v3-app/components/Shell.tsx");
    expect(src).toMatch(/ROUTE_IDS/);
    expect(src).toMatch(/no longer exists/);
  });
});

describe("leads / opps / projects render an inline detail card", () => {
  for (const screen of ["leads", "opps", "projects"]) {
    it(screen + ".tsx reads ?id= and renders selected detail", () => {
      const src = read("src/v3-app/screens/" + screen + ".tsx");
      expect(src).toMatch(/useHashParam\(\s*["']id["']\s*\)/);
      // The detail card shows a close button that strips ?id= from the hash.
      expect(src).toMatch(new RegExp("window\\.location\\.hash\\s*=\\s*[\"']#/" + screen + "[\"']"));
    });
  }
});

describe("readHashParam / useHashParam helpers", () => {
  it("are exported from lib/helpers.ts", () => {
    const src = read("src/v3-app/lib/helpers.ts");
    expect(src).toMatch(/export const readHashParam/);
    expect(src).toMatch(/export const useHashParam/);
  });
});
