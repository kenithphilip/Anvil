// Helpers for fire-and-forget Supabase queries.
//
// The Supabase JS v2 query builder (`svc.from(...).insert(...)`,
// `.update(...)`, `.delete(...)`, `.rpc(...)`) is *PromiseLike*, not a
// real Promise. It implements `.then()` so `await` works, but it does
// NOT implement `.catch()`. So `svc.from(...).insert(...).catch(() => {})`
// throws synchronously: "svc.from(...).insert(...).catch is not a function".
//
// Every audit-style insert that wants "best-effort, never break the
// request" semantics has to route through one of these helpers.

// Awaits a PromiseLike and swallows errors. Use when you do want to
// wait for the operation (e.g. ordering matters) but a failure is
// non-fatal.
//
// Example:
//   await safeAwait(svc.from("user_security_audit").insert({...}));
export const safeAwait = async (thenable) => {
  try {
    if (thenable && typeof thenable.then === "function") {
      return await thenable;
    }
    return thenable;
  } catch (_) {
    // Swallow. The caller asked for best-effort.
    return undefined;
  }
};

// Fire-and-forget. Returns immediately; rejections from the
// underlying PromiseLike are swallowed in the background. Use when
// you do NOT want to block the response on the audit write.
//
// Example:
//   safeFire(svc.from("user_security_audit").insert({...}));
export const safeFire = (thenable) => {
  try {
    if (thenable && typeof thenable.then === "function") {
      // Two-argument .then handles rejection without needing .catch,
      // which the Supabase builder doesn't expose.
      thenable.then(() => undefined, () => undefined);
    }
  } catch (_) {
    // Even the .then call could throw on a malformed builder; ignore.
  }
};
