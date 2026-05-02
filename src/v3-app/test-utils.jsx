// Shared test scaffolding for Vitest.
//
// Every screen test imports `mountScreen(ScreenComponent)` which:
// - stubs `window.ObaraBackend` with a method dispatcher that returns
//   benign defaults (empty arrays / objects) so screens render their
//   loaded-empty state instead of crashing on a missing backend.
// - stubs `window.localStorage` access via vitest's jsdom default.
// - mounts the screen inside a React.StrictMode + Suspense fallback.
//
// Tests can override specific backend methods by passing a `backend`
// option, e.g. `mountScreen(Orders, { backend: { orders: { list: ...} } })`.

import React, { Suspense } from "react";
import { render } from "@testing-library/react";

// Recursive empty-default proxy. Any property access returns either
// another proxy (for namespaces like `orders`) or a function that
// returns Promise.resolve([]). Screens that call `ObaraBackend?.orders?.list?.()`
// get `[]` and render their empty state.
const makeEmptyProxy = (overrides = {}) => new Proxy({}, {
  get: (target, prop) => {
    if (Object.prototype.hasOwnProperty.call(overrides, prop)) {
      return overrides[prop];
    }
    if (prop === Symbol.toPrimitive) return () => "[ObaraBackendStub]";
    if (prop === "then") return undefined;
    if (typeof prop === "string") {
      // Treat it as a namespace/method dispatcher.
      const methodOrNs = (...args) => {
        // If called as a method, return a benign default.
        if (args.length === 0 || typeof args[0] !== "object" || args[0] === null) {
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      };
      // Allow further dotted access too.
      return new Proxy(methodOrNs, {
        get: (_t, sub) => {
          if (sub === "then") return undefined;
          if (sub === Symbol.toPrimitive) return () => "[stub]";
          // Recursively return a stub for namespaces like `.orders.list`.
          return makeEmptyProxy()[sub];
        },
      });
    }
    return undefined;
  },
});

export const stubBackend = (overrides = {}) => {
  // Plain object so properties are writable + configurable. The proxy in
  // lib/api.js wraps this and forwards lookups; method binding there
  // would conflict with non-configurable descriptors.
  const stub = {
    isReady: () => false,
    getConfig: () => ({}),
    setSession: () => {},
    ...overrides,
  };
  // Wrap unknown access in a recursive empty proxy so screens that
  // call ObaraBackend.foo.bar.baz don't crash on undefined.
  return new Proxy(stub, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === Symbol.toPrimitive || prop === "then") return undefined;
      // Return a callable namespace placeholder for any unknown method.
      const ns = (..._args) => Promise.resolve([]);
      return new Proxy(ns, {
        get(_t, sub) {
          if (sub === Symbol.toPrimitive || sub === "then") return undefined;
          return makeEmptyProxy()[sub];
        },
      });
    },
  });
};

export const installBackend = (overrides) => {
  // eslint-disable-next-line no-undef
  globalThis.window = globalThis.window || {};
  // eslint-disable-next-line no-undef
  window.ObaraBackend = stubBackend(overrides);
  return window.ObaraBackend;
};

export const installRbac = (role = "admin") => {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem("obara:v3_role", role); }
  catch (_) {}
};

export const Wrap = ({ children }) => (
  <React.StrictMode>
    <Suspense fallback={<div data-testid="suspense-fallback">…</div>}>
      {children}
    </Suspense>
  </React.StrictMode>
);

export const renderScreen = (Component, props = {}) => render(<Wrap><Component {...props} /></Wrap>);
