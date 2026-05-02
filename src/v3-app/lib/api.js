// ESM facade over src/client/obara-client.js.
//
// The legacy client is an IIFE that attaches `window.ObaraBackend` and
// `window.storage`. Importing it here runs the IIFE for its side effect.
//
// Important: `ObaraBackend` is exposed as a Proxy that forwards every
// access to the CURRENT `window.ObaraBackend`. That means:
//
//   1. Tests can swap `window.ObaraBackend` for a stub between renders
//      and the screens that imported `ObaraBackend` from this module
//      will pick up the swap on the next access.
//   2. The legacy client can re-attach itself if the page reloads its
//      session without breaking module-level captures.
//
// If `window.ObaraBackend` is undefined when accessed, the proxy returns
// `undefined` for any property so screens that use `ObaraBackend?.x?.y?.()`
// fall through cleanly without throwing.

import "../../client/obara-client.js";

const cur = () => (typeof window !== "undefined" ? window.ObaraBackend : undefined);

const ProxyHandler = {
  get(_, prop) {
    const target = cur();
    if (target == null) return undefined;
    return target[prop];
  },
  set(_, prop, value) {
    const target = cur();
    if (target == null) return false;
    target[prop] = value;
    return true;
  },
  has(_, prop) {
    const target = cur();
    return target != null && prop in target;
  },
};

export const ObaraBackend = new Proxy({}, ProxyHandler);
export const storage = (typeof window !== "undefined" ? window.storage : undefined);

export default ObaraBackend;
