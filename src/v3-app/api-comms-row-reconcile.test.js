// `communications` schema/writer reconciliation.
//
// The table was defined once and never altered, but twelve writers grew six
// mutually-incompatible schemas around it. Only three conformed. The rest
// inserted columns that do not exist and statuses the CHECK rejected — which
// meant POST /api/quotes/send and /api/invoices/send THREW on every call
// (customer-facing quote + invoice email was broken end to end), GET
// /api/communications 400'd on every call, and the writers that swallowed
// their errors dropped messages silently.
//
// commsRow() is the single normaliser every writer now passes through, so
// adding a column means changing one file rather than twelve.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { commsRow, invalidCommsKeys, COMMS_COLUMNS } from "../api/_lib/comms-row.js";

const API = join(dirname(fileURLToPath(import.meta.url)), "..", "api");
const REPO = join(API, "..", "..");

describe("commsRow / alias mapping", () => {
  it("maps the three recipient spellings onto to_addr", () => {
    expect(commsRow({ to_address: "a@x.com" }).to_addr).toBe("a@x.com");
    expect(commsRow({ recipient: "b@x.com" }).to_addr).toBe("b@x.com");
    expect(commsRow({ to_addr: "c@x.com" }).to_addr).toBe("c@x.com");
  });

  it("maps the three template spellings onto template_code", () => {
    expect(commsRow({ template: "t" }).template_code).toBe("t");
    expect(commsRow({ template_kind: "t" }).template_code).toBe("t");
  });

  it("maps `kind` onto document_type — it was always a document type", () => {
    expect(commsRow({ kind: "quote_email" }).document_type).toBe("quote_email");
  });

  it("normalises the statuses the CHECK rejected", () => {
    expect(commsRow({ status: "pending_send" }).status).toBe("queued");
    // `manual` meant "no provider, a human must send" — that is queued, not sent.
    expect(commsRow({ status: "manual" }).status).toBe("queued");
    expect(commsRow({ status: "sent" }).status).toBe("sent");
    expect(commsRow({}).status).toBe("draft");
  });

  it("defaults the NOT NULL direction that writers omitted", () => {
    // quotes/send.js and invoices/send.js both omitted it -> insert threw.
    expect(commsRow({ to_addr: "a@x.com" }).direction).toBe("outbound");
  });

  it("preserves unknown keys in metadata instead of throwing them at PostgREST", () => {
    const row = commsRow({ origin: "prospecting", origin_ref: { id: 1 }, to_name: "Stores" });
    expect(invalidCommsKeys(row)).toEqual([]);
    expect(row.metadata.origin).toBe("prospecting");
    expect(row.metadata.origin_ref).toEqual({ id: 1 });
    expect(row.metadata.to_name).toBe("Stores");
  });

  it("merges an explicit metadata object with rescued keys", () => {
    const row = commsRow({ metadata: { a: 1 }, external_ref: { b: 2 } });
    expect(row.metadata).toEqual({ a: 1, external_ref: { b: 2 } });
  });

  it("keeps body_html out of the columns but not out of the record", () => {
    const row = commsRow({ body_html: "<p>x</p>", body_text: "x" });
    expect(row.body).toBe("x");
    expect(invalidCommsKeys(row)).toEqual([]);
    expect(row.metadata.body_html).toBe("<p>x</p>");
  });

  it("normalises cc/bcc to arrays for routing", () => {
    expect(commsRow({ cc_addrs: "a@x.com" }).cc_addrs).toEqual(["a@x.com"]);
    expect(commsRow({}).cc_addrs).toEqual([]);
  });

  it("never emits a key that is not a real column", () => {
    const row = commsRow({
      tenant_id: "t1", object_type: "quote", object_id: "q1", kind: "quote_email",
      to_address: "a@x.com", sent_by: "u1", status: "queued", meta: { x: 1 },
      recipient: "ignored", ref_type: "supplier_rfq", ref_id: "r1",
    });
    expect(invalidCommsKeys(row)).toEqual([]);
  });
});

describe("every writer goes through commsRow", () => {
  const walk = (d) => readdirSync(d).flatMap((e) => {
    const p = join(d, e);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".js") ? [p] : [];
  });

  it("no raw object literal is inserted into communications", () => {
    // A raw insert is exactly how the drift started.
    const offenders = [];
    for (const f of walk(API)) {
      const src = readFileSync(f, "utf8");
      const re = /from\("communications"\)\s*\n?\s*\.insert\(\s*(?!commsRow|recipients\.map\(\(to\) => commsRow)/g;
      if (re.test(src)) offenders.push(relative(REPO, f));
    }
    expect(offenders).toEqual([]);
  });

  it("the scan actually finds the inserts it claims to check", () => {
    let n = 0;
    for (const f of walk(API)) {
      n += (readFileSync(f, "utf8").match(/from\("communications"\)\s*\n?\s*\.insert\(/g) || []).length;
    }
    expect(n).toBeGreaterThanOrEqual(8);
  });
});

describe("a send with no provider is not recorded as sent", () => {
  const SRC = readFileSync(join(API, "_lib", "comms-send.js"), "utf8");

  it("falls back to queued, not sent", () => {
    // Was: !configured ? "sent" — nothing transmitted, yet marked sent and
    // sent_at stamped. Analytics on status='sent' would measure fiction.
    expect(SRC).toMatch(/!configured \? "queued"/);
    expect(SRC).not.toMatch(/!configured \? "sent"/);
  });

  it("only stamps sent_at when it actually went", () => {
    expect(SRC).toMatch(/sent_at: newStatus === "sent" \? new Date\(\)\.toISOString\(\) : null/);
  });
});

describe("the list endpoint selects only real columns", () => {
  it("does not 400 on a phantom column", () => {
    const src = readFileSync(join(API, "communications", "list.js"), "utf8");
    const sel = src.match(/\.select\("([^"]+)"\)/);
    expect(sel).toBeTruthy();
    for (const col of sel[1].split(",").map((c) => c.trim())) {
      expect(COMMS_COLUMNS.has(col) || col === "id").toBe(true);
    }
  });
});
