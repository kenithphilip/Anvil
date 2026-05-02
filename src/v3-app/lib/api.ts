// ESM facade over src/client/obara-client.js.
//
// The legacy client is an IIFE that attaches `window.ObaraBackend` and
// `window.storage`. Importing it here runs the IIFE for its side effect.
//
// `ObaraBackend` is exposed as a Proxy that forwards every access to the
// CURRENT `window.ObaraBackend`. Tests can swap `window.ObaraBackend` for
// a stub between renders, and screens that imported `ObaraBackend` from
// this module will pick up the swap on the next access.

import "../../client/obara-client.js";

// The legacy client is mostly untyped JS. Treat it as a flexible record
// of namespaces so callers can `ObaraBackend?.foo?.bar?.(...)`. Strict
// per-method types live in the legacy client; documenting them here is
// a follow-up for after the cutover.
export type ObaraBackendShape = Record<string, any> & {
  isReady?: () => boolean;
  getConfig?: () => { url?: string; tenantId?: string };
  setSession?: (session: unknown) => void;
};

declare global {
  interface Window {
    ObaraBackend?: ObaraBackendShape;
    storage?: unknown;
    notify?: (...args: any[]) => unknown;
    notifySuccess?: (...args: any[]) => unknown;
    notifyWarn?: (...args: any[]) => unknown;
    notifyError?: (...args: any[]) => unknown;
    notifyLive?: (...args: any[]) => unknown;
    notifyDismiss?: (id: number) => void;
    __toastSubscribe?: (fn: (rows: unknown[]) => void) => () => void;
    __toastsCurrent?: () => unknown[];
  }
}

const cur = (): ObaraBackendShape | undefined =>
  (typeof window !== "undefined" ? window.ObaraBackend : undefined);

const handler: ProxyHandler<object> = {
  get(_, prop) {
    const target = cur();
    if (target == null) return undefined;
    return (target as any)[prop];
  },
  set(_, prop, value) {
    const target = cur();
    if (target == null) return false;
    (target as any)[prop] = value;
    return true;
  },
  has(_, prop) {
    const target = cur();
    return target != null && prop in target;
  },
};

export const ObaraBackend = new Proxy({}, handler) as ObaraBackendShape;
export const storage = (typeof window !== "undefined" ? (window as any).storage : undefined);

export default ObaraBackend;
