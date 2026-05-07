// Regression tests for the second-round UX flow audit. Locks the
// data-loss fixes that the schema-drift agent surfaced, the
// einvoice action-name mismatch that broke "Send to GSTN" since it
// shipped, and the new escape hatches for stuck-state recovery.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p) => readFileSync(resolve(process.cwd(), p), "utf8");

describe("leads.tsx: company_name in payload (data-loss fix)", () => {
  it("sends company_name (the schema column) on createLead", () => {
    const src = read("src/v3-app/screens/leads.tsx");
    // Find the actual call site (not the comment header at the top
    // of the file). Scan for the call expression.
    const idx = src.indexOf("createLead?.(");
    expect(idx).toBeGreaterThan(0);
    const block = src.slice(Math.max(0, idx - 800), idx);
    expect(block).toMatch(/company_name\s*:\s*draft\.name/);
  });
  it("sends budget_estimate (the schema column) for the value", () => {
    const src = read("src/v3-app/screens/leads.tsx");
    const idx = src.indexOf("createLead?.(");
    expect(idx).toBeGreaterThan(0);
    const block = src.slice(Math.max(0, idx - 800), idx);
    expect(block).toMatch(/budget_estimate\s*:/);
  });
});

describe("comms.tsx: to_addr + templateCode in draft payload (data-loss fix)", () => {
  it("sends to_addr (the column the API reads) not just recipient", () => {
    const src = read("src/v3-app/screens/comms.tsx");
    const idx = src.indexOf("communications?.draft?");
    expect(idx).toBeGreaterThan(0);
    const block = src.slice(idx, idx + 600);
    expect(block).toMatch(/to_addr\s*:\s*composer\.recipient/);
  });
  it("sends templateCode (the column the API reads)", () => {
    const src = read("src/v3-app/screens/comms.tsx");
    const idx = src.indexOf("communications?.draft?");
    const block = src.slice(idx, idx + 600);
    expect(block).toMatch(/templateCode\s*:/);
  });
});

describe("projects.tsx: expected_delivery_date (the actual column)", () => {
  it("detail card reads expected_delivery_date first", () => {
    const src = read("src/v3-app/screens/projects.tsx");
    expect(src).toMatch(/selected\.expected_delivery_date/);
  });
  it("table row reads expected_delivery_date with fallback", () => {
    const src = read("src/v3-app/screens/projects.tsx");
    expect(src).toMatch(/r\.expected_delivery_date/);
  });
});

describe("einvoice: action-name alignment + stuck-state recovery", () => {
  it("frontend sends action 'send_to_gstn' (matches backend)", () => {
    const src = read("src/v3-app/screens/einvoice.tsx");
    expect(src).toMatch(/action:\s*["']send_to_gstn["']/);
    expect(src).not.toMatch(/action:\s*["']submit_to_gstn["']/);
  });
  it("backend handles revert_to_draft + mark_generated_manually", () => {
    const src = read("src/api/einvoice/index.js");
    expect(src).toMatch(/body\.action\s*===\s*["']revert_to_draft["']/);
    expect(src).toMatch(/body\.action\s*===\s*["']mark_generated_manually["']/);
  });
  it("frontend exposes revertToDraft + markGeneratedManually", () => {
    const src = read("src/v3-app/screens/einvoice.tsx");
    expect(src).toMatch(/const revertToDraft\s*=/);
    expect(src).toMatch(/const markGeneratedManually\s*=/);
    // Buttons exist for PENDING_GSTN / REJECTED rows.
    expect(src).toMatch(/PENDING_GSTN[\s\S]{0,200}revertToDraft/);
  });
});

describe("documents.tsx: empty-state has a working CTA", () => {
  it("renders an Upload button instead of a text instruction", () => {
    const src = read("src/v3-app/screens/documents.tsx");
    // Find the empty-state branch.
    const idx = src.indexOf("rows.length === 0");
    expect(idx).toBeGreaterThan(0);
    const block = src.slice(idx, idx + 600);
    expect(block).toMatch(/setTab\(\s*["']upload["']\s*\)/);
    expect(block).toMatch(/Upload a document/);
  });
});
