// Unit tests for the mobile push helpers in lib/push.ts.
// We test the bits that don't require a real ServiceWorker:
//   - pushIsSupported() returns false in jsdom (no PushManager / SW).
//   - subscribeToPush() degrades gracefully and reports unsupported.
//   - unsubscribeFromPush() returns false when no SW reg exists.

import { describe, it, expect } from "vitest";
import { pushIsSupported, subscribeToPush, unsubscribeFromPush } from "./push";

describe("lib/push", () => {
  it("pushIsSupported returns false in jsdom (no PushManager)", () => {
    expect(pushIsSupported()).toBe(false);
  });

  it("subscribeToPush returns unsupported when neither SW nor PushManager exist", async () => {
    const r = await subscribeToPush("BFAKEKEY");
    expect(r.ok).toBe(false);
    expect(r.permission).toBe("unsupported");
  });

  it("unsubscribeFromPush returns false when push isn't supported", async () => {
    const r = await unsubscribeFromPush();
    expect(r).toBe(false);
  });
});
