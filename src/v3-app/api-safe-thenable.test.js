// Regression test for the Supabase "catch is not a function" bug.
//
// The Supabase JS v2 query builder is PromiseLike (has .then) but
// not a real Promise (no .catch). Calling .catch on
// svc.from(...).insert(...) throws synchronously. The forgot-password
// flow used that pattern in 8 places across the auth handlers and
// threw on every call. The fix wraps each call in safeAwait from
// src/api/_lib/safe-thenable.js so the request never breaks on a
// failed audit insert.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { safeAwait, safeFire } from "../api/_lib/safe-thenable.js";

// Minimal PromiseLike mirroring the Supabase query builder shape.
const supabaseLike = (resolved, rejected) => ({
  then(onOk, onErr) {
    if (rejected) return Promise.reject(rejected).then(onOk, onErr);
    return Promise.resolve(resolved).then(onOk, onErr);
  },
  // No .catch on purpose. This is the bug condition.
});

describe("safe-thenable", () => {
  it("the supabase-like builder really does lack a catch method", () => {
    const builder = supabaseLike({ ok: true });
    expect(typeof builder.then).toBe("function");
    expect(builder.catch).toBeUndefined();
  });

  it("safeAwait resolves on a thenable that succeeds", async () => {
    const out = await safeAwait(supabaseLike({ id: 1 }));
    expect(out).toEqual({ id: 1 });
  });

  it("safeAwait swallows rejections without throwing", async () => {
    const out = await safeAwait(supabaseLike(null, new Error("boom")));
    expect(out).toBeUndefined();
  });

  it("safeAwait tolerates non-thenable inputs", async () => {
    expect(await safeAwait(null)).toBeNull();
    expect(await safeAwait(undefined)).toBeUndefined();
    expect(await safeAwait(42)).toBe(42);
  });

  it("safeFire returns synchronously and swallows rejections", async () => {
    let caught = false;
    const onUnhandled = () => { caught = true; };
    process.on("unhandledRejection", onUnhandled);
    safeFire(supabaseLike(null, new Error("nope")));
    await new Promise((r) => setTimeout(r, 10));
    process.off("unhandledRejection", onUnhandled);
    expect(caught).toBe(false);
  });

  it("the broken pattern is gone from every auth handler", () => {
    const root = join(process.cwd(), "src/api/auth");
    const offenders = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) { walk(p); continue; }
        if (!p.endsWith(".js")) continue;
        const src = readFileSync(p, "utf8");
        // Pattern: a builder chain ending in insert/update/delete/upsert/rpc
        // immediately followed by .catch (without a .then in between).
        const re = /\.(insert|update|delete|upsert|rpc)\([^]*?\)\s*\.catch\(/g;
        let m;
        while ((m = re.exec(src)) !== null) {
          offenders.push(p + ": " + m[1] + "(...).catch");
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
