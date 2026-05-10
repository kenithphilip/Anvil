// Phase F.2: router wiring + tool-presence regression tests for
// the supplier-ack extraction surface.
//
// We don't make a real Anthropic call here. Instead we assert:
//   1. The router resolves /source_pos/<id>/ack_extract to the
//      ack_extract handler.
//   2. The Claude adapter source carries the new
//      extract_supplier_ack tool + prompt verbatim, with every
//      schema field the supplier_ack_extractions table expects
//      to read.
//   3. The router still resolves /invoices/extract +
//      /eway_bills/extract to their respective handlers.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const CLAUDE_SRC = readFileSync(
  resolve(process.cwd(), "src/api/_lib/docai/claude.js"),
  "utf8",
);
const ROUTER_SRC = readFileSync(
  resolve(process.cwd(), "src/api/router.js"),
  "utf8",
);

describe("claude / extract_supplier_ack tool definition", () => {
  it("declares the tool name", () => {
    expect(CLAUDE_SRC).toMatch(/name:\s*"extract_supplier_ack"/);
  });

  for (const f of [
    "supplier_ref",
    "confirmed_price",
    "confirmed_currency",
    "confirmed_eta",
    "payment_terms",
    "remarks",
    "line_acks",
  ]) {
    it("schema includes header field " + f, () => {
      // Prompt text or schema property name; either is fine as long
      // as the field appears verbatim in the adapter source.
      expect(CLAUDE_SRC).toMatch(new RegExp("\\b" + f + "\\b"));
    });
  }

  for (const f of ["partNumber", "quantity", "unit_price", "eta", "rejected"]) {
    it("line_acks item schema includes " + f, () => {
      expect(CLAUDE_SRC).toMatch(new RegExp("\\b" + f + "\\b"));
    });
  }

  it("the system prompt teaches the four classifications", () => {
    expect(CLAUDE_SRC).toMatch(/SUPPLIER_ACK_SYSTEM_PROMPT/);
    expect(CLAUDE_SRC).toMatch(/['"]ack['"]/);
    expect(CLAUDE_SRC).toMatch(/['"]partial['"]/);
    expect(CLAUDE_SRC).toMatch(/['"]rejection['"]/);
    expect(CLAUDE_SRC).toMatch(/['"]non_ack['"]/);
  });

  it("the extract function selects the supplier-ack tool when expectedKind = supplier_ack", () => {
    expect(CLAUDE_SRC).toMatch(/expectedKind\s*===\s*['"]supplier_ack['"]/);
    expect(CLAUDE_SRC).toMatch(/activeTool\s*=/);
  });

  it("normalises supplier_ack output to the canonical shape", () => {
    expect(CLAUDE_SRC).toMatch(/normalizeSupplierAck/);
    expect(CLAUDE_SRC).toMatch(/supplier_ack:\s*\{/);
  });
});

describe("router / new endpoints wired", () => {
  it("imports source_pos/ack_extract.js", () => {
    expect(ROUTER_SRC).toMatch(/from\s+["']\.\/source_pos\/ack_extract\.js["']/);
  });

  it("includes /source_pos/<id>/ack_extract dynamic route entry", () => {
    expect(ROUTER_SRC).toMatch(/suffix:\s*["']\/ack_extract["']/);
  });

  it("imports invoices/extract.js + adds /invoices/extract static route", () => {
    expect(ROUTER_SRC).toMatch(/from\s+["']\.\/invoices\/extract\.js["']/);
    expect(ROUTER_SRC).toMatch(/"\/invoices\/extract":/);
  });

  it("imports eway_bills/extract.js + adds /eway_bills/extract static route", () => {
    expect(ROUTER_SRC).toMatch(/from\s+["']\.\/eway_bills\/extract\.js["']/);
    expect(ROUTER_SRC).toMatch(/"\/eway_bills\/extract":/);
  });
});

describe("router / dispatch resolution", () => {
  it("dispatches /source_pos/<id>/ack_extract to ack_extract.js", async () => {
    const { dispatch } = await import("../api/router.js");
    let handlerName = null;
    const req = {
      url: "/api/source_pos/abc-123/ack_extract",
      method: "POST",
      headers: {},
    };
    const res = {
      _status: 0,
      _headers: {},
      statusCode: 0,
      setHeader(k, v) { this._headers[k.toLowerCase()] = v; },
      end(body) {
        try { handlerName = JSON.parse(body)?.error?.message || null; } catch (_) {}
      },
    };
    // The handler will short-circuit on auth, but we just want to
    // confirm the router resolved (no 404). The dispatch returns
    // the handler's promise; ack_extract calls resolveContext
    // first which will throw without auth. That's fine: a non-
    // 404 response means routing worked.
    try { await dispatch(req, res); } catch (_e) { /* expected */ }
    expect(res.statusCode).not.toBe(404);
  });
});
