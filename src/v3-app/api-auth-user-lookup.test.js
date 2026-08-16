// Finding a Supabase auth user by email.
//
// Five call sites passed an `email` (or `filter`) key to listUsers.
// @supabase/auth-js 2.105.1 forwards ONLY page and per_page and drops
// everything else without error, so all five resolved "the first user in the
// project" and then treated that stranger as the person who had just typed
// their address:
//
//   signup.js        409 "account already exists" for EVERY new user once the
//                    project had one — self-serve onboarding was dead
//   passkey/*.js     the credential verified against the wrong account
//   request_reset.js the reset generated for, and audited against, the wrong one
//   magic_link.js    the sign-in attributed to the wrong tenant

import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { findUserByEmail, normaliseEmail } from "../api/_lib/auth-user-lookup.js";

// A stand-in that behaves like the real SDK: it PAGES, and it ignores any
// filter key it is handed. A mock that honoured `email` would have shown the
// old code passing.
const svcWith = (emails, { perPage = 1000 } = {}) => {
  const calls = [];
  return {
    calls,
    auth: { admin: { listUsers: async (params) => {
      calls.push(params);
      const page = Number(params?.page || 1);
      const size = Number(params?.perPage || perPage);
      const start = (page - 1) * size;
      return { data: { users: emails.slice(start, start + size).map((e, i) => ({ id: `u${start + i}`, email: e })) }, error: null };
    } } },
  };
};

describe("normaliseEmail", () => {
  it("is case- and whitespace-insensitive, as auth emails are", () => {
    expect(normaliseEmail("  Joel@Example.COM ")).toBe("joel@example.com");
  });
  it.each([null, undefined, ""])("returns empty for %p", (v) => expect(normaliseEmail(v)).toBe(""));
});

describe("findUserByEmail", () => {
  afterEach(() => { delete process.env.AUTH_LOOKUP_MAX_PAGES; });

  // The regression, stated directly.
  it("returns the MATCHING user, not the first user in the project", async () => {
    const svc = svcWith(["first@x.com", "second@x.com", "target@x.com"]);
    const { user } = await findUserByEmail(svc, "target@x.com");
    expect(user.email).toBe("target@x.com");
    expect(user.email).not.toBe("first@x.com");
  });

  it("finds a user on a later page", async () => {
    // The old call asked for perPage:1 and took [0], so anyone past the first
    // row was invisible — which is every user but one.
    const emails = Array.from({ length: 2500 }, (_, i) => `u${i}@x.com`);
    const svc = svcWith(emails);
    const { user, exhaustive } = await findUserByEmail(svc, "u2400@x.com");
    expect(user.email).toBe("u2400@x.com");
    expect(exhaustive).toBe(true);
  });

  it("matches case-insensitively", async () => {
    const svc = svcWith(["Joel@Example.com"]);
    expect((await findUserByEmail(svc, "joel@example.COM")).user.email).toBe("Joel@Example.com");
  });

  it("reports a genuine absence as exhaustive", async () => {
    // A short page is the last page, so 'not here' is a real answer.
    const { user, exhaustive } = await findUserByEmail(svcWith(["a@x.com", "b@x.com"]), "nobody@x.com");
    expect(user).toBeNull();
    expect(exhaustive).toBe(true);
  });

  it("stops at the last page instead of paging forever", async () => {
    const svc = svcWith(["a@x.com"]);
    await findUserByEmail(svc, "nobody@x.com");
    expect(svc.calls).toHaveLength(1);
  });

  // The honesty property. A caller must be able to tell "absent" from "unknown".
  it("reports exhaustive=false when the page budget runs out", async () => {
    process.env.AUTH_LOOKUP_MAX_PAGES = "2";
    const emails = Array.from({ length: 5000 }, (_, i) => `u${i}@x.com`);
    const { user, exhaustive } = await findUserByEmail(svcWith(emails), "u4999@x.com");
    expect(user).toBeNull();
    expect(exhaustive).toBe(false);   // NOT "no such account"
  });

  it("returns nothing for an empty address without calling the API", async () => {
    const svc = svcWith(["a@x.com"]);
    for (const v of [null, undefined, "", "   "]) {
      const r = await findUserByEmail(svc, v);
      expect(r.user).toBeNull();
      expect(r.exhaustive).toBe(true);
    }
    expect(svc.calls).toHaveLength(0);
  });

  it("propagates an API error rather than reporting 'no such user'", async () => {
    // Swallowing this is how a transient outage becomes a duplicate account.
    const svc = { auth: { admin: { listUsers: async () => ({ data: null, error: { message: "boom" } }) } } };
    await expect(findUserByEmail(svc, "a@x.com")).rejects.toThrow(/boom/);
  });

  it("never passes a filter key the SDK would silently drop", async () => {
    const svc = svcWith(["a@x.com"]);
    await findUserByEmail(svc, "a@x.com");
    for (const c of svc.calls) {
      expect(c).not.toHaveProperty("email");
      expect(c).not.toHaveProperty("filter");
      expect(Object.keys(c).sort()).toEqual(["page", "perPage"]);
    }
  });
});

// The security half of the passkey fix, pinned at the source level: the
// credential is verified against the resolved user, but the session used to be
// minted for the caller-supplied `email` string. Anyone holding the first
// project user's passkey could obtain a session as any other account, in any
// tenant, by editing one field. This must hold even if the lookup regresses.
describe("passkey sign-in mints a session for the verified owner", () => {
  // cwd under vitest is the repo root.
  const src = () => readFileSync("src/api/auth/passkey/auth_finish.js", "utf8");

  it("mints for user.email, never the request's email", () => {
    const s = src();
    expect(s).toContain("mintSessionForUser(svc, user.email)");
    expect(s).not.toMatch(/mintSessionForUser\(svc,\s*email\s*\)/);
  });

  it("audits the verified owner, not the submitted address", () => {
    expect(src()).toMatch(/user_email:\s*user\.email/);
  });

  it("resolves the user through the shared lookup and fails closed", () => {
    const s = src();
    expect(s).toContain("findUserByEmail");
    // exhaustive:false must not be treated as a match.
    expect(s).toMatch(/found\.exhaustive \? found\.user : null/);
  });
});
