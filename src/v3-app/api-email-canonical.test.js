// Unit tests for src/api/_lib/email-canonical.js (Wave CM 1.3).

import { describe, it, expect } from "vitest";
import { canonicaliseEmail, emailHash, findContactByEmail } from "../api/_lib/email-canonical.js";

describe("canonicaliseEmail", () => {
  it("returns null on null / empty", () => {
    expect(canonicaliseEmail(null)).toBeNull();
    expect(canonicaliseEmail("  ")).toBeNull();
  });

  it("lowercases + trims", () => {
    expect(canonicaliseEmail(" ABC@Example.COM ")).toBe("abc@example.com");
  });

  it("strips +tag on every provider", () => {
    expect(canonicaliseEmail("buyer+po-09@acme.com")).toBe("buyer@acme.com");
    expect(canonicaliseEmail("ops+invoices@example.org")).toBe("ops@example.org");
  });

  it("folds dots in Gmail local-part", () => {
    expect(canonicaliseEmail("first.last@gmail.com")).toBe("firstlast@gmail.com");
    expect(canonicaliseEmail("a.b.c@googlemail.com")).toBe("abc@googlemail.com");
  });

  it("does NOT fold dots on non-gmail domains", () => {
    expect(canonicaliseEmail("first.last@acme.com")).toBe("first.last@acme.com");
  });

  it("returns null when local part is empty after +tag strip", () => {
    expect(canonicaliseEmail("+tag@acme.com")).toBeNull();
  });

  it("preserves emails without an @ as-is (lowercased)", () => {
    expect(canonicaliseEmail("not_an_email")).toBe("not_an_email");
  });
});

describe("emailHash", () => {
  it("returns null on uncanonicalisable input", async () => {
    expect(await emailHash(null)).toBeNull();
    expect(await emailHash("")).toBeNull();
  });

  it("returns deterministic 64-char hex", async () => {
    const a = await emailHash("buyer@acme.com");
    const b = await emailHash("buyer@acme.com");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("collides on canonical-equal variants", async () => {
    const a = await emailHash("buyer@acme.com");
    const b = await emailHash(" BUYER+po1@acme.com ");
    expect(a).toBe(b);
  });

  it("does NOT collide across distinct contacts", async () => {
    const a = await emailHash("buyer@acme.com");
    const b = await emailHash("buyer@example.com");
    expect(a).not.toBe(b);
  });
});

describe("findContactByEmail", () => {
  it("returns null on missing args", async () => {
    expect(await findContactByEmail(null, "t", "x@y.com")).toBeNull();
    expect(await findContactByEmail({}, null, "x@y.com")).toBeNull();
    expect(await findContactByEmail({}, "t", "")).toBeNull();
  });

  it("queries by hash and returns the contact row", async () => {
    let capturedHash = null;
    const svc = {
      from: () => ({
        select: () => ({
          eq: (col1, val1) => ({
            eq: (col2, val2) => {
              if (col2 === "canonical_email_hash") capturedHash = val2;
              return {
                eq: () => ({
                  maybeSingle: () => Promise.resolve({
                    data: { id: "ct1", customer_id: "c1", name: "Buyer", is_active: true },
                    error: null,
                  }),
                }),
              };
            },
          }),
        }),
      }),
    };
    const out = await findContactByEmail(svc, "t1", "Buyer+po1@Acme.com");
    expect(out.id).toBe("ct1");
    expect(out.customer_id).toBe("c1");
    expect(capturedHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
