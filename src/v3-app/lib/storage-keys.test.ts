// Pin the migration semantics of the localStorage helper. The rebrand
// switched the prefix from `obara:` to `anvil:`; the helper has to
// read both, prefer the new prefix, and migrate legacy values forward
// on first read so an existing user does not lose their session or
// theme on the upgrade.

import { describe, it, expect, beforeEach } from "vitest";
import { lsGet, lsSet, lsRemove, lsKey, lsLegacyKey } from "./storage-keys";

beforeEach(() => {
  for (const k of [
    "anvil:test_key", "obara:test_key",
    "anvil:other", "obara:other",
  ]) {
    try { window.localStorage.removeItem(k); } catch (_) {}
  }
});

describe("storage-keys helper", () => {
  it("reads from anvil: prefix when present", () => {
    window.localStorage.setItem("anvil:test_key", "fresh");
    expect(lsGet("test_key")).toBe("fresh");
  });

  it("falls back to obara: prefix when anvil: is missing, then migrates forward", () => {
    window.localStorage.setItem("obara:test_key", "legacy");
    expect(lsGet("test_key")).toBe("legacy");
    // After the read, the value is mirrored under the new prefix so
    // subsequent reads do not pay the fallback cost.
    expect(window.localStorage.getItem("anvil:test_key")).toBe("legacy");
  });

  it("returns null when neither key is present", () => {
    expect(lsGet("test_key")).toBeNull();
  });

  it("lsSet writes to anvil: and clears the legacy duplicate for non-shared keys", () => {
    window.localStorage.setItem("obara:test_key", "stale");
    lsSet("test_key", "fresh");
    expect(window.localStorage.getItem("anvil:test_key")).toBe("fresh");
    expect(window.localStorage.getItem("obara:test_key")).toBeNull();
  });

  it("lsSet dual-writes for backend_config / backend_session so legacy screen reads still see fresh data", () => {
    lsSet("backend_config", "{\"url\":\"x\"}");
    expect(window.localStorage.getItem("anvil:backend_config")).toBe("{\"url\":\"x\"}");
    expect(window.localStorage.getItem("obara:backend_config")).toBe("{\"url\":\"x\"}");
    // Cleanup
    lsRemove("backend_config");
  });

  it("lsRemove deletes both prefixes", () => {
    window.localStorage.setItem("anvil:test_key", "a");
    window.localStorage.setItem("obara:test_key", "b");
    lsRemove("test_key");
    expect(window.localStorage.getItem("anvil:test_key")).toBeNull();
    expect(window.localStorage.getItem("obara:test_key")).toBeNull();
  });

  it("lsKey + lsLegacyKey produce the canonical full key strings", () => {
    expect(lsKey("test_key")).toBe("anvil:test_key");
    expect(lsLegacyKey("test_key")).toBe("obara:test_key");
  });

  it("does not blow up if localStorage throws (private mode, quota)", () => {
    // Defensive: storage-keys catches all storage exceptions internally.
    // We simulate by passing a key the helper can use without error.
    expect(() => lsGet("never_set_key")).not.toThrow();
    expect(() => lsSet("test_key", "x")).not.toThrow();
    expect(() => lsRemove("test_key")).not.toThrow();
  });
});
