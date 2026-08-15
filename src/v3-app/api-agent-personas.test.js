// Ask Anvil personas: the flag gate and the read-only guarantee.
//
// Two properties matter more than anything else here, and both are the kind
// that fail silently if nobody asserts them:
//
//   1. A persona is OFF unless the tenant turned it on. Shipping an assistant
//      that reads a client's orders because a default was true is not a bug you
//      get to fix afterwards.
//   2. The SO persona is read-only BY CONSTRUCTION — no write.* scope in its
//      list — so the write tools are never offered to the model at all. That is
//      stronger than rejecting a write later: the model cannot propose what it
//      cannot see.

import { describe, it, expect } from "vitest";
import {
  PERSONAS, enabledPersonas, resolvePersona, publicPersona, isReadOnly,
} from "../api/_lib/agent-personas.js";

const ON = { so_agent_enabled: true };
const OFF = { so_agent_enabled: false };

describe("the flag is the whole gate", () => {
  it("returns nothing when the tenant has not enabled it", () => {
    expect(enabledPersonas(OFF)).toEqual([]);
    expect(enabledPersonas({})).toEqual([]);
    expect(enabledPersonas(null)).toEqual([]);
  });

  it("returns the SO persona once enabled", () => {
    expect(enabledPersonas(ON).map((p) => p.id)).toEqual(["so"]);
  });

  // A truthy-but-not-true value must not enable a paid, data-reading feature.
  it.each([["1", "string one"], [1, "number one"], ["true", "string true"], [{}, "object"]])(
    "does not accept %p (%s) as enabled", (v) => {
      expect(enabledPersonas({ so_agent_enabled: v })).toEqual([]);
    },
  );
});

describe("resolvePersona", () => {
  it("resolves a known persona for an enabled tenant", () => {
    expect(resolvePersona("so", ON)?.id).toBe("so");
  });

  it("tolerates case and whitespace from a URL or hand-written request", () => {
    expect(resolvePersona("  SO ", ON)?.id).toBe("so");
  });

  // Rejecting rather than falling back is the point: a fallback would hand the
  // caller the FULL tool set, including writes, when they asked to be narrowed.
  it("returns null for an enabled-but-unknown persona", () => {
    expect(resolvePersona("spares", ON)).toBeNull();
    expect(resolvePersona("../../etc", ON)).toBeNull();
  });

  it("returns null when the tenant has the flag off", () => {
    expect(resolvePersona("so", OFF)).toBeNull();
    expect(resolvePersona("so", {})).toBeNull();
  });

  it.each([null, undefined, "", 42, {}])("returns null for the malformed id %p", (v) => {
    expect(resolvePersona(v, ON)).toBeNull();
  });
});

describe("the SO persona is read-only by construction", () => {
  const so = PERSONAS.so;

  it("declares no write scope at all", () => {
    expect(isReadOnly(so)).toBe(true);
    for (const s of so.scopes) expect(s.startsWith("read.")).toBe(true);
  });

  // Named explicitly so that adding one to the list is a deliberate act with a
  // failing test attached, not an accident during a refactor.
  it.each(["write.leads", "write.erp", "write.inventory"])("does not carry %s", (scope) => {
    expect(so.scopes).not.toContain(scope);
  });

  it("tells the model plainly that it cannot act", () => {
    expect(so.system).toMatch(/cannot change anything|no write tools/i);
  });

  it("is bound to the SO route only", () => {
    expect(so.routes).toEqual(["so"]);
  });

  it("is gated on the migration-210 column", () => {
    expect(so.flag).toBe("so_agent_enabled");
  });
});

describe("publicPersona", () => {
  // The prompt is the one thing a client must never receive: shipping it
  // invites someone to edit it and send it back.
  it("never leaks the system prompt to the browser", () => {
    const pub = publicPersona(PERSONAS.so);
    expect(pub.system).toBeUndefined();
    expect(JSON.stringify(pub)).not.toMatch(/You are the Anvil/);
  });

  it("carries what the UI actually needs", () => {
    const pub = publicPersona(PERSONAS.so);
    expect(pub).toMatchObject({ id: "so", label: expect.any(String), routes: ["so"] });
    expect(pub.placeholder).toBeTruthy();
  });
});
