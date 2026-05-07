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
// Optional `label` (string) routes failures to console.warn so the
// operator gets a breadcrumb when an audit insert silently fails.
// Without a label, behaviour matches the original silent swallow.
//
// Example:
//   await safeAwait(svc.from("user_security_audit").insert({...}));
//   await safeAwait(svc.from("audit_events").insert({...}), "audit_events");
export const safeAwait = async (thenable, label) => {
  try {
    if (thenable && typeof thenable.then === "function") {
      const result = await thenable;
      if (label && result && result.error) {
        // eslint-disable-next-line no-console
        console.warn("[" + label + "] supabase op returned error: " + (result.error.message || JSON.stringify(result.error)));
      }
      return result;
    }
    return thenable;
  } catch (err) {
    if (label) {
      // eslint-disable-next-line no-console
      console.warn("[" + label + "] supabase op threw: " + (err && err.message ? err.message : String(err)));
    }
    return undefined;
  }
};

// Fire-and-forget. Returns immediately; rejections from the
// underlying PromiseLike are swallowed in the background. Use when
// you do NOT want to block the response on the audit write.
//
// Same `label` semantics as safeAwait above.
//
// Example:
//   safeFire(svc.from("user_security_audit").insert({...}));
//   safeFire(svc.from("model_routing_log").insert({...}), "model_routing_log");
export const safeFire = (thenable, label) => {
  try {
    if (thenable && typeof thenable.then === "function") {
      thenable.then(
        (result) => {
          if (label && result && result.error) {
            // eslint-disable-next-line no-console
            console.warn("[" + label + "] supabase op returned error: " + (result.error.message || JSON.stringify(result.error)));
          }
        },
        (err) => {
          if (label) {
            // eslint-disable-next-line no-console
            console.warn("[" + label + "] supabase op threw: " + (err && err.message ? err.message : String(err)));
          }
        },
      );
    }
  } catch (_) {
    // Even the .then call could throw on a malformed builder; ignore.
  }
};
