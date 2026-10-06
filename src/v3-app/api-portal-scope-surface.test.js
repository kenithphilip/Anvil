// A portal session should be able to reach exactly what the portal can show.
//
// SESSION_SCOPES granted summary/quotes/orders/invoices/spares to every
// logged-in portal user. The portal makes exactly two view() calls — "spares"
// and "spare_matrix". So four kinds were authenticated, reachable surface with
// no client: a session could read its customer's order and invoice rows
// through an API the app it was issued for has no way to render.
//
// That is not a breach and it was not exploited. It is a grant nobody chose:
// scopes drifted out of step with the product, quietly, in the direction that
// grants more.
//
// This file ties them back together. It derives the needed scopes from the
// CLIENT — the actual view() calls — and compares them with what the server
// hands out, so it fails in BOTH directions:
//
//   • grant a scope no screen uses  -> over-granting, caught here
//   • add a screen without its scope -> the tab 403s, caught here
//
// Deriving rather than hardcoding is the point. A second hand-written list
// would be the same drift one layer up.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SESSION_SCOPES } from "../api/_lib/portal-auth.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(HERE, "..", "..", rel), "utf8");

// view.js: requiredScope = kind, except summary -> "quotes", spare_matrix -> "spares".
const scopeForKind = (kind) =>
  kind === "summary" ? "quotes" : kind === "spare_matrix" ? "spares" : kind;

// Every kind the portal client actually asks for, read off the client.
const kindsTheClientCalls = () => {
  const sources = ["src/v3-app/portal/PortalHome.tsx", "src/v3-app/portal/PortalApp.tsx", "src/v3-app/portal/LoginView.tsx"]
    .map((f) => read(f)).join("\n");
  return [...sources.matchAll(/\bview\(\s*"([a-z_]+)"/g)].map((m) => m[1]);
};

describe("the portal client and the session grant agree", () => {
  const kinds = kindsTheClientCalls();

  it("the client calls at least one kind (the derivation is not vacuous)", () => {
    // If view() is ever renamed, the regex above silently finds nothing and
    // every assertion below passes against an empty set.
    expect(kinds.length).toBeGreaterThan(0);
    expect(kinds).toContain("spares");
  });

  it("grants every scope the client needs", () => {
    for (const kind of kinds) {
      expect(
        SESSION_SCOPES,
        `the portal calls view("${kind}") but a session is not granted "${scopeForKind(kind)}" — that tab 403s`,
      ).toContain(scopeForKind(kind));
    }
  });

  it("grants nothing the client cannot show", () => {
    const needed = new Set(kinds.map(scopeForKind));
    for (const granted of SESSION_SCOPES) {
      expect(
        [...needed],
        `a session is granted "${granted}" but no portal screen calls a kind requiring it — either build the screen or drop the scope`,
      ).toContain(granted);
    }
  });

  it("does not list a value that is not a scope at all", () => {
    // "summary" was in the list for a long time. It is a KIND; its scope is
    // "quotes", so listing it granted nothing while reading as though it did.
    const view = read("src/api/portal/view.js");
    const kindsInView = [...view.matchAll(/kind === "([a-z_]+)"/g)].map((m) => m[1]);
    const realScopes = new Set(kindsInView.map(scopeForKind));
    for (const granted of SESSION_SCOPES) {
      expect(realScopes.has(granted), `"${granted}" is not a scope any kind requires`).toBe(true);
    }
  });
});

describe("the kinds themselves stay, and stay gated", () => {
  const view = read("src/api/portal/view.js");

  it("every kind still checks a scope before answering", () => {
    // The unused kinds are NOT deleted: legacy shared tokens carry explicitly
    // granted scopes (the portal_tokens default includes quotes/orders/
    // invoices) and may be in real use on links already sent to customers.
    // Narrowing what a SESSION gets is reversible; deleting an endpoint a
    // customer's bookmark depends on is not.
    expect(view).toMatch(/if \(!t\.scopes\.includes\(requiredScope\)\)/);
    expect(view).toMatch(/return json\(res, 403/);
  });

  it("logs the refusal, so unused surface can be measured rather than guessed", () => {
    // portal_access_log.path records the kind on both the 403 and the 200,
    // which is how you find out whether a legacy token still calls these.
    expect(view).toMatch(/logAccess\(svc, t, req, 403, kind\)/);
  });
});
