// Unit tests for the inbound-email helpers.
//
// Confirms:
//   - computeDupHash is deterministic, case-insensitive, normalises
//     RE:/FWD: prefixes, and is sensitive to from-domain + body.
//   - computeThreadKey prefers references[0], then In-Reply-To,
//     then Message-ID.
//   - computePriorityScore reflects tier + RFQ keywords + attachments.
//   - buildInboundEmailRow emits the canonical row shape.

import { describe, it, expect } from "vitest";
import {
  computeDupHash, computeThreadKey, computePriorityScore,
  buildInboundEmailRow,
} from "../api/_lib/inbound-email.js";

describe("inbound-email / dedup hash", () => {
  it("is deterministic for the same inputs", () => {
    const h1 = computeDupHash({ from_address: "buyer@acme.com", subject: "RFQ", body_text: "hello" });
    const h2 = computeDupHash({ from_address: "buyer@acme.com", subject: "RFQ", body_text: "hello" });
    expect(h1).toBe(h2);
  });
  it("strips RE:/FWD: prefixes from subject", () => {
    const a = computeDupHash({ from_address: "x@a.com", subject: "RFQ Pumps", body_text: "b" });
    const b = computeDupHash({ from_address: "x@a.com", subject: "RE: RFQ Pumps", body_text: "b" });
    const c = computeDupHash({ from_address: "x@a.com", subject: "FWD: RFQ Pumps", body_text: "b" });
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
  it("differs across from-domains", () => {
    const a = computeDupHash({ from_address: "x@acme.com", subject: "RFQ", body_text: "hi" });
    const b = computeDupHash({ from_address: "x@orbit.com", subject: "RFQ", body_text: "hi" });
    expect(a).not.toBe(b);
  });
  it("collapses whitespace + casing in body", () => {
    const a = computeDupHash({ from_address: "x@a.com", subject: "RFQ", body_text: "Hello\nWorld" });
    const b = computeDupHash({ from_address: "x@a.com", subject: "RFQ", body_text: "hello   world" });
    expect(a).toBe(b);
  });
});

describe("inbound-email / thread key", () => {
  it("prefers first References entry", () => {
    expect(computeThreadKey({
      message_id: "<m1@x>", in_reply_to: "<r1@x>",
      references_chain: ["<root@x>", "<m2@x>"],
    })).toBe("<root@x>");
  });
  it("falls back to In-Reply-To", () => {
    expect(computeThreadKey({
      message_id: "<m1@x>", in_reply_to: "<r1@x>",
    })).toBe("<r1@x>");
  });
  it("falls back to Message-ID", () => {
    expect(computeThreadKey({ message_id: "<m1@x>" })).toBe("<m1@x>");
  });
  it("synthesises a key when nothing is present", () => {
    expect(computeThreadKey({})).toBeTruthy();
  });
});

describe("inbound-email / priority", () => {
  it("strategic tier outscores standard", () => {
    expect(computePriorityScore({ tier: "strategic" }))
      .toBeGreaterThan(computePriorityScore({ tier: "standard" }));
  });
  it("RFQ keywords add weight", () => {
    const plain = computePriorityScore({ tier: "standard", subject: "Hello" });
    const rfq   = computePriorityScore({ tier: "standard", subject: "RFQ for pumps" });
    expect(rfq).toBeGreaterThan(plain);
  });
  it("attachments add weight", () => {
    const without = computePriorityScore({ tier: "standard", has_attachments: false });
    const withAtt = computePriorityScore({ tier: "standard", has_attachments: true });
    expect(withAtt).toBeGreaterThan(without);
  });
  it("watchlist tier scores low", () => {
    const wl = computePriorityScore({ tier: "watchlist" });
    const std = computePriorityScore({ tier: "standard" });
    expect(wl).toBeLessThan(std);
  });
});

describe("inbound-email / row builder", () => {
  it("emits the canonical row shape with dup hash + thread key", () => {
    const row = buildInboundEmailRow({
      tenantId: "t1",
      provider: "postmark",
      message_id: "<m@x>",
      from_address: "buyer@acme.com",
      subject: "RFQ #123",
      body_text: "We need 100 widgets",
      to_addresses: ["sales@anvil.app"],
    });
    expect(row.tenant_id).toBe("t1");
    expect(row.provider).toBe("postmark");
    expect(row.dup_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row._thread_key).toBe("<m@x>");
    expect(row.status).toBe("received");
    expect(Array.isArray(row.attachments)).toBe(true);
  });
});
