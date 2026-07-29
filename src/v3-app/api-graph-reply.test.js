// The Graph reply-loop join (docs/CUSTOMER_COMMS_DESIGN.md §5 follow-up).
//
// A reply attributes back to the outbound communication that prompted it, via
// thread_id=conversationId (primary) or provider_message_id=In-Reply-To
// (fallback); the outbound flips to status='replied' + metadata.replied_at,
// which is exactly what the reply-rate / time-to-first-response metrics read.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { attributeReply } from "../api/_lib/graph-reply.js";
import { getMetric } from "../api/_lib/metrics/catalog.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const readApi = (p) => readFileSync(join(HERE, "..", "api", p), "utf8");

// Mock svc: `comm` matches a communications select when the queried column/value
// equals comm._matchColumn/_matchValue; update()s are captured.
const makeSvc = (comm, sink) => ({
  from(table) {
    const st = { table, op: "select", filters: {}, patch: null };
    const b = {
      select() { st.op = "select"; return b; },
      update(p) { st.op = "update"; st.patch = p; return b; },
      eq(k, v) { st.filters[k] = v; return b; },
      order() { return b; },
      limit() { return b; },
      maybeSingle() {
        if (st.table === "communications" && comm && st.filters[comm._matchColumn] === comm._matchValue) {
          return Promise.resolve({ data: comm });
        }
        return Promise.resolve({ data: null });
      },
      then(resolve) {
        if (st.op === "update") sink.push({ table: st.table, id: st.filters.id, patch: st.patch });
        return Promise.resolve({ error: null }).then(resolve);
      },
    };
    return b;
  },
});

describe("attributeReply — the join", () => {
  const baseComm = () => ({
    id: "o1", customer_id: "c1", order_id: "ord1", status: "sent",
    sent_at: "2026-07-01T00:00:00Z", metadata: { po_number: "PO-1" },
  });

  it("matches by conversationId, marks the outbound replied, merges replied_at, back-links inbound", async () => {
    const sink = [];
    const comm = { ...baseComm(), _matchColumn: "thread_id", _matchValue: "CONV-1" };
    const r = await attributeReply(makeSvc(comm, sink), "t1", {
      conversationId: "CONV-1", inReplyTo: "<msg-1>", receivedAt: "2026-07-03T00:00:00Z", inboundEmailId: "in1",
    });
    expect(r).toMatchObject({ matched: true, via: "conversation_id", communication_id: "o1", customer_id: "c1", order_id: "ord1" });

    const commUp = sink.find((u) => u.table === "communications");
    expect(commUp.patch.status).toBe("replied");
    expect(commUp.patch.metadata.replied_at).toBe("2026-07-03T00:00:00Z");
    expect(commUp.patch.metadata.po_number).toBe("PO-1");   // merged, not clobbered

    const inbUp = sink.find((u) => u.table === "inbound_emails");
    expect(inbUp.patch).toMatchObject({ customer_id: "c1", linked_order_id: "ord1", status: "linked" });
  });

  it("matches by In-Reply-To (provider_message_id) — the precise signal, tried first", async () => {
    const sink = [];
    const comm = { ...baseComm(), _matchColumn: "provider_message_id", _matchValue: "<msg-1>" };
    const r = await attributeReply(makeSvc(comm, sink), "t1", {
      conversationId: "CONV-9", inReplyTo: "<msg-1>", receivedAt: "2026-07-03T00:00:00Z", inboundEmailId: "in1",
    });
    // Even though a conversationId is present, the exact In-Reply-To match wins.
    expect(r).toMatchObject({ matched: true, via: "in_reply_to" });
  });

  it("no match -> matched:false, no writes", async () => {
    const sink = [];
    const r = await attributeReply(makeSvc(null, sink), "t1", { conversationId: "X", inReplyTo: "<y>" });
    expect(r).toEqual({ matched: false });
    expect(sink).toHaveLength(0);
  });

  it("is idempotent — an already-replied row is not re-flipped (first reply wins the clock)", async () => {
    const sink = [];
    const comm = { ...baseComm(), status: "replied", _matchColumn: "thread_id", _matchValue: "CONV-1" };
    const r = await attributeReply(makeSvc(comm, sink), "t1", {
      conversationId: "CONV-1", receivedAt: "2026-07-09T00:00:00Z", inboundEmailId: "in2",
    });
    expect(r.matched).toBe(true);
    expect(sink.find((u) => u.table === "communications")).toBeUndefined();  // no status/replied_at overwrite
  });
});

describe("reply metrics read the attributed data", () => {
  const NOW = Date.parse("2026-07-21T00:00:00Z");
  const reduceOf = (id, rows) => getMetric(id).reduce(rows, { nowMs: NOW, windowDays: 90 });
  const rows = [
    { document_type: "dispatch_register", status: "sent", sent_at: "2026-07-01T00:00:00Z" },
    { document_type: "payment_reminder", status: "replied", sent_at: "2026-07-01T00:00:00Z", metadata: { replied_at: "2026-07-03T00:00:00Z" } }, // 2d
    { document_type: "quote_email", status: "replied", sent_at: "2026-07-01T00:00:00Z", metadata: { replied_at: "2026-07-02T00:00:00Z" } },       // 1d
    { document_type: "service_report", status: "queued" },                                                                                          // not sent
    { document_type: "supplier_rfq", status: "replied", sent_at: "2026-07-01T00:00:00Z", metadata: { replied_at: "2026-07-05T00:00:00Z" } },       // not customer-facing
  ];

  it("comms_reply_rate = replied / (sent+replied), customer-facing only", () => {
    const r = reduceOf("comms_reply_rate", rows);
    expect(r.value).toBe(66.7);   // 2 replied of 3 (supplier_rfq + queued excluded)
    expect(r).toMatchObject({ count: 2, denominator: 3 });
  });

  it("time_to_first_response_median = median(replied_at - sent_at) in days", () => {
    const r = reduceOf("time_to_first_response_median", rows);
    expect(r.value).toBe(1.5);    // median(2d, 1d)
    expect(r.count).toBe(2);
  });
});

describe("wiring", () => {
  it("the webhook fetches the message and attributes the reply", () => {
    const src = readApi("inbound/email/webhook.js");
    expect(src).toMatch(/fetchGraphMessage\(/);
    expect(src).toMatch(/attributeReply\(/);
  });
  it("the webhook FAILS CLOSED: it only fetches when clientState is verified", () => {
    const src = readApi("inbound/email/webhook.js");
    expect(src).toMatch(/clientStateOk\(settings\.graph_client_state, n\.clientState\)/);
    expect(src).toMatch(/timingSafeEqual/);
    // The privileged fetch is gated on `trusted`.
    expect(src).toMatch(/if \(trusted &&/);
  });
  it("dedups on the stable Graph id on both paths (no duplicate rows)", () => {
    const src = readApi("inbound/email/webhook.js");
    expect(src).toMatch(/message_id: graphMessageId/);
  });
  it("migration 195 adds the graph_client_state secret column", () => {
    const sql = readFileSync(join(HERE, "..", "..", "supabase", "migrations", "195_graph_inbound_client_state.sql"), "utf8");
    expect(sql).toMatch(/add column if not exists graph_client_state text/);
  });
  it("a replied row is terminal — comms-send won't resend it", () => {
    const src = readApi("_lib/comms-send.js");
    expect(src).toMatch(/status === "sent" \|\| row\.data\.status === "replied"/);
  });
  it("fetchGraphMessage keeps internetMessageId in <...> form (matches provider_message_id)", () => {
    const src = readApi("_lib/graph-client.js");
    // internetMessageId is passed through, NOT bracket-stripped.
    expect(src).toMatch(/internetMessageId: m\.internetMessageId \|\| null/);
    expect(src).toMatch(/inReplyTo: headerValue\(m\.internetMessageHeaders, "in-reply-to"\)/);
  });
});
