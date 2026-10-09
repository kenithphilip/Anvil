// resolveInternalRecipients: an admin's To and CC lists turned into the email
// addresses of the tenant's own staff (docs/SO_TERMS_AND_HANDOFF_SCOPE.md,
// 8.1). An entry is an address, taken as written, or a role token that
// expands to the APPROVED members of THIS tenant with that role. Every entry
// that produces no address is reported with the reason.
//
// The resolver runs against an in-memory Supabase: tenant_members rows plus
// auth users served by getUserById. Every address is example.com.

import { describe, it, expect, beforeEach } from "vitest";
import {
  resolveInternalRecipients, parseRecipientEntry, isEmailAddress, RECIPIENT_ROLES,
} from "../api/_lib/internal-recipients.js";
import { ROLES } from "./lib/rbac";

const T1 = "tenant-1";
const T2 = "tenant-2";

let H;
const makeSvc = () => ({
  auth: {
    admin: {
      getUserById: async (id) => {
        H.authCalls.push(id);
        return { data: { user: H.users[id] || null }, error: null };
      },
    },
  },
  from(table) {
    H.fromCalls.push(table);
    const st = { filters: [] };
    const run = () => {
      if (H.failRead) return { data: null, error: H.failRead };
      const rows = (H.store[table] || []).filter((r) => st.filters.every((f) => f(r)));
      return { data: rows.map((r) => ({ ...r })), error: null };
    };
    const b = {
      select() { return b; },
      eq(c, v) { st.filters.push((r) => r[c] === v); return b; },
      in(c, vs) { st.filters.push((r) => vs.includes(r[c])); return b; },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    return b;
  },
});

beforeEach(() => {
  H = {
    authCalls: [],
    fromCalls: [],
    failRead: null,
    users: {
      "u-op1": { id: "u-op1", email: "Ravi.Ops@example.com", user_metadata: { name: "Ravi Ops" } },
      "u-op2": { id: "u-op2", email: "sana.ops@example.com", user_metadata: { full_name: "Sana Ops" } },
      "u-op-pending": { id: "u-op-pending", email: "new.ops@example.com", user_metadata: {} },
      "u-op-gone": { id: "u-op-gone", email: "former.ops@example.com", user_metadata: {} },
      "u-mgr": { id: "u-mgr", email: "meera.mgr@example.com", user_metadata: { name: "Meera Manager" } },
      "u-fin-nomail": { id: "u-fin-nomail", email: null, phone: "+00000", user_metadata: {} },
      "u-t2-op": { id: "u-t2-op", email: "other.tenant.ops@example.com", user_metadata: { name: "Other Tenant" } },
    },
    store: {
      tenant_members: [
        { tenant_id: T1, user_id: "u-op1", role: "operator", status: "approved" },
        { tenant_id: T1, user_id: "u-op2", role: "operator", status: "approved" },
        { tenant_id: T1, user_id: "u-op-pending", role: "operator", status: "pending" },
        { tenant_id: T1, user_id: "u-op-gone", role: "operator", status: "deactivated" },
        { tenant_id: T1, user_id: "u-mgr", role: "sales_manager", status: "approved" },
        { tenant_id: T1, user_id: "u-fin-nomail", role: "finance", status: "approved" },
        { tenant_id: T2, user_id: "u-t2-op", role: "operator", status: "approved" },
      ],
    },
  };
});

const emails = (rows) => rows.map((r) => r.email);

describe("plain addresses", () => {
  it("are taken as written, trimmed and lowercased, with the reason", async () => {
    const out = await resolveInternalRecipients(makeSvc(), T1, { to: ["  Orders@Example.com "], cc: ["accounts@example.com"] });
    expect(out.to).toEqual([{ email: "orders@example.com", name: null, user_id: null, reason: "listed address", reasons: [{ kind: "address", entry: "orders@example.com" }] }]);
    expect(emails(out.cc)).toEqual(["accounts@example.com"]);
    expect(out.dropped).toEqual([]);
    expect(out.reply_to).toBeNull();
  });

  it("need no member lookup when there is no role token", async () => {
    await resolveInternalRecipients(makeSvc(), T1, { to: ["orders@example.com"] });
    expect(H.fromCalls).toEqual([]);
    expect(H.authCalls).toEqual([]);
  });
});

describe("role tokens", () => {
  it("expand to the approved members with that role, with name, id and reason", async () => {
    const out = await resolveInternalRecipients(makeSvc(), T1, { to: ["role:operator"] });
    expect(out.to).toEqual([
      { email: "ravi.ops@example.com", name: "Ravi Ops", user_id: "u-op1", reason: "role:operator", reasons: [{ kind: "role", entry: "role:operator", role: "operator" }] },
      { email: "sana.ops@example.com", name: "Sana Ops", user_id: "u-op2", reason: "role:operator", reasons: [{ kind: "role", entry: "role:operator", role: "operator" }] },
    ]);
  });

  it("accept any case and surrounding space in the token", async () => {
    const out = await resolveInternalRecipients(makeSvc(), T1, { cc: [" Role:Sales_Manager "] });
    expect(emails(out.cc)).toEqual(["meera.mgr@example.com"]);
    expect(out.cc[0].reason).toBe("role:sales_manager");
  });

  it("look up auth users for approved members only", async () => {
    await resolveInternalRecipients(makeSvc(), T1, { to: ["role:operator"] });
    expect(H.authCalls.sort()).toEqual(["u-op1", "u-op2"]);
  });
});

describe("dedupe", () => {
  it("one row per address in a list, with every reason that produced it", async () => {
    const out = await resolveInternalRecipients(makeSvc(), T1, {
      to: ["ravi.ops@example.com", "role:operator", "RAVI.OPS@example.com"],
    });
    expect(emails(out.to)).toEqual(["ravi.ops@example.com", "sana.ops@example.com"]);
    expect(out.to[0].reasons.map((r) => r.entry)).toEqual(["ravi.ops@example.com", "role:operator", "ravi.ops@example.com"]);
    expect(out.to[0].reason).toBe("listed address; role:operator; listed address");
    // The member found by the role names the literal row too.
    expect(out.to[0]).toMatchObject({ user_id: "u-op1", name: "Ravi Ops" });
  });

  it("keeps an address that is in To out of CC, and says so", async () => {
    const out = await resolveInternalRecipients(makeSvc(), T1, {
      to: ["role:operator"],
      cc: ["sana.ops@example.com", "meera.mgr@example.com"],
    });
    expect(emails(out.to)).toEqual(["ravi.ops@example.com", "sana.ops@example.com"]);
    expect(emails(out.cc)).toEqual(["meera.mgr@example.com"]);
    expect(out.dropped.filter((d) => d.list === "cc")).toEqual([{ list: "cc", entry: "sana.ops@example.com", reason: "already_in_to", detail: "Already in To." }]);
  });
});

describe("invalid and unknown entries are dropped and reported", () => {
  it("reports a malformed address, two addresses in one entry, an unknown role and a blank", async () => {
    const out = await resolveInternalRecipients(makeSvc(), T1, {
      to: ["not-an-address", "a@example.com, b@example.com", "role:wizard", "  ", "ok@example.com"],
    });
    expect(emails(out.to)).toEqual(["ok@example.com"]);
    expect(out.dropped.map((d) => [d.list, d.entry, d.reason])).toEqual([
      ["to", "not-an-address", "invalid_address"],
      ["to", "a@example.com, b@example.com", "invalid_address"],
      ["to", "role:wizard", "unknown_role"],
      ["to", "", "empty"],
    ]);
    expect(out.dropped[2].detail).toBe("No such role.");
  });

  it("reports a role nobody in the tenant has", async () => {
    const out = await resolveInternalRecipients(makeSvc(), T1, { cc: ["role:procurement"] });
    expect(out.cc).toEqual([]);
    expect(out.dropped).toEqual([{ list: "cc", entry: "role:procurement", reason: "no_active_members", detail: "No approved member of this tenant has this role." }]);
  });
});

describe("inactive members", () => {
  it("never receive it, and each one is reported with its status", async () => {
    const out = await resolveInternalRecipients(makeSvc(), T1, { to: ["role:operator"] });
    expect(emails(out.to)).not.toContain("new.ops@example.com");
    expect(emails(out.to)).not.toContain("former.ops@example.com");
    const inactive = out.dropped.filter((d) => d.reason === "inactive_member");
    expect(inactive.map((d) => [d.user_id, d.status]).sort()).toEqual([["u-op-gone", "deactivated"], ["u-op-pending", "pending"]]);
  });

  it("a role whose only members are inactive is also reported as having nobody", async () => {
    H.store.tenant_members = H.store.tenant_members.filter((m) => m.status !== "approved" || m.role !== "operator");
    const out = await resolveInternalRecipients(makeSvc(), T1, { to: ["role:operator"] });
    expect(out.to).toEqual([]);
    expect(out.dropped.map((d) => d.reason).sort()).toEqual(["inactive_member", "inactive_member", "no_active_members"]);
  });

  it("an approved member with no email on the account is reported, not sent to", async () => {
    const out = await resolveInternalRecipients(makeSvc(), T1, { to: ["role:finance"] });
    expect(out.to).toEqual([]);
    expect(out.dropped).toEqual([{ list: "to", entry: "role:finance", reason: "no_email", detail: "This member has no email address on their account.", user_id: "u-fin-nomail" }]);
  });
});

describe("tenant isolation", () => {
  it("expands a role to this tenant's members only", async () => {
    const t1 = await resolveInternalRecipients(makeSvc(), T1, { to: ["role:operator"] });
    expect(emails(t1.to)).not.toContain("other.tenant.ops@example.com");
    expect(H.authCalls).not.toContain("u-t2-op");

    H.authCalls = [];
    const t2 = await resolveInternalRecipients(makeSvc(), T2, { to: ["role:operator"] });
    expect(emails(t2.to)).toEqual(["other.tenant.ops@example.com"]);
    expect(H.authCalls).toEqual(["u-t2-op"]);
  });

  it("fails closed without a tenant: it throws and reads nothing", async () => {
    for (const t of [null, undefined, ""]) {
      await expect(resolveInternalRecipients(makeSvc(), t, { to: ["role:operator"] })).rejects.toMatchObject({ code: "TENANT_REQUIRED", status: 400 });
    }
    expect(H.fromCalls).toEqual([]);
    expect(H.authCalls).toEqual([]);
  });

  it("a failed member read throws instead of reporting the team as empty", async () => {
    H.failRead = { code: "57014", message: "canceling statement due to statement timeout" };
    await expect(resolveInternalRecipients(makeSvc(), T1, { to: ["role:operator"] })).rejects.toThrow(/could not read tenant members: canceling statement/);
  });
});

describe("the sending engineer", () => {
  it("is added to CC and returned as reply-to", async () => {
    const out = await resolveInternalRecipients(makeSvc(), T1, {
      to: ["orders@example.com"],
      engineer: { email: "Eng.One@example.com", user_id: "u-eng", name: "Eng One" },
    });
    expect(out.cc).toEqual([{ email: "eng.one@example.com", name: "Eng One", user_id: "u-eng", reason: "sending engineer", reasons: [{ kind: "engineer", entry: "engineer" }] }]);
    expect(out.reply_to).toBe("eng.one@example.com");
    expect(out.dropped).toEqual([]);
  });

  it("already in To stays in To only, and is still the reply-to", async () => {
    const out = await resolveInternalRecipients(makeSvc(), T1, { to: ["role:operator"], engineer: { email: "ravi.ops@example.com" } });
    expect(emails(out.cc)).toEqual([]);
    expect(out.reply_to).toBe("ravi.ops@example.com");
    // Only the role's two inactive operators are reported; the engineer is not.
    expect(out.dropped.map((d) => d.reason)).toEqual(["inactive_member", "inactive_member"]);
  });
});

describe("parseRecipientEntry and isEmailAddress", () => {
  it("classify and normalise one entry", () => {
    expect(parseRecipientEntry("role:OPERATOR")).toEqual({ kind: "role", entry: "role:operator", role: "operator" });
    expect(parseRecipientEntry("Team@Example.com")).toEqual({ kind: "address", entry: "team@example.com", email: "team@example.com" });
    expect(parseRecipientEntry("role:")).toEqual({ kind: "invalid", entry: "role:", reason: "unknown_role" });
    expect(parseRecipientEntry(42)).toEqual({ kind: "invalid", entry: "", reason: "empty" });
  });

  it("accepts one plain address and refuses header-breaking characters", () => {
    expect(isEmailAddress("first.last+tag@sub.example.com")).toBe(true);
    for (const bad of ["a@example", "a b@example.com", "a@example.com\nBcc: x@example.com", "<a@example.com>", "a@example.com;b@example.com", "x".repeat(250) + "@example.com"]) {
      expect(isEmailAddress(bad)).toBe(false);
    }
  });
});

describe("role tokens name the same roles as the app", () => {
  it("RECIPIENT_ROLES matches rbac.ts ROLES", () => {
    expect([...RECIPIENT_ROLES].sort()).toEqual([...ROLES].sort());
  });
});
