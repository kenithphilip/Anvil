// ESM facade over src/client/anvil-client.js.
//
// The client is an IIFE that attaches `window.AnvilBackend` (and
// the legacy alias `window.ObaraBackend`) plus `window.storage`.
// Importing here runs the IIFE for its side effect.
//
// `ObaraBackend` is exposed as a Proxy that forwards every access to the
// CURRENT `window.AnvilBackend`. Tests can swap `window.AnvilBackend`
// for a stub between renders, and screens that imported `ObaraBackend`
// from this module pick up the swap on the next access. We export both
// names so a future search-and-replace can tidy the screens without a
// runtime change.

import "../../client/anvil-client.js";

// Treat the client as a flexible record of namespaces so callers can
// `AnvilBackend?.foo?.bar?.(...)`. Strict per-method types live in the
// client; documenting them here is a follow-up.
export type AnvilBackendShape = Record<string, any> & {
  isReady?: () => boolean;
  getConfig?: () => { url?: string; tenantId?: string };
  setSession?: (session: unknown) => void;
};
// Alias kept so the existing screens that import { ObaraBackendShape }
// keep typechecking. New code should reference AnvilBackendShape.
export type ObaraBackendShape = AnvilBackendShape;

declare global {
  interface Window {
    AnvilBackend?: AnvilBackendShape;
    ObaraBackend?: AnvilBackendShape;
    storage?: unknown;
    notify?: (...args: any[]) => unknown;
    notifySuccess?: (...args: any[]) => unknown;
    notifyWarn?: (...args: any[]) => unknown;
    notifyError?: (...args: any[]) => unknown;
    notifyLive?: (...args: any[]) => unknown;
    notifyDismiss?: (id: number) => void;
    __toastSubscribe?: (fn: (rows: unknown[]) => void) => () => void;
    __toastsCurrent?: () => unknown[];
    // Runtime-loaded CDN libraries. The screens that use them inject a
    // <script src="cdn"> tag on demand; once loaded, the global is set
    // by the library itself. Typing as `any` keeps the screens working
    // without pulling in the libraries' real type definitions.
    XLSX?: any;
    JSZip?: any;
    cytoscape?: any;
    dagre?: any;
  }
}

const cur = (): AnvilBackendShape | undefined =>
  (typeof window !== "undefined"
    ? (window.AnvilBackend || window.ObaraBackend)
    : undefined);

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

// New canonical name. The legacy export stays for the 102 call sites
// that already import { ObaraBackend } from "../lib/api".
export const AnvilBackend = new Proxy({}, handler) as AnvilBackendShape;
export const ObaraBackend = AnvilBackend;
export const storage = (typeof window !== "undefined" ? (window as any).storage : undefined);

export default AnvilBackend;
