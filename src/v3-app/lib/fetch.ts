// Shared backend-fetch helper. Consolidates the per-screen
// `<thing>Fetch` helpers the converter copied across many files.
//
// Hardened May 2026 (security audit C5 part 2). Was reading the
// session + config from localStorage directly, which duplicated
// the SDK's storage logic and bypassed the sessionStorage-primary
// migration in anvil-client.js. Now delegates to
// AnvilBackend.getSession / getConfig so the SDK is the single
// source of truth.
//
// Returns the parsed JSON body. Throws on non-2xx responses with
// the response body included in the error message so screens can
// surface useful error text in their toast.
//
// Most screens should use AnvilBackend.<ns>.<method>(...) directly,
// which is itself a typed namespace. This helper is for the few
// places that hit endpoints not yet exposed on the client (or that
// need to compose a one-off URL).

import { AnvilBackend } from "./api";

interface BackendConfig {
  url?: string;
  tenantId?: string;
}

interface SessionEnvelope {
  access_token?: string;
}

const readConfig = (): BackendConfig =>
  (AnvilBackend?.getConfig?.() as BackendConfig) || {};

const readSession = (): SessionEnvelope | null =>
  (AnvilBackend?.getSession?.() as SessionEnvelope | null) || null;

export interface BackendFetchOpts extends Omit<RequestInit, "body" | "headers"> {
  body?: unknown;
  headers?: Record<string, string>;
}

export const backendFetch = async <T = unknown>(path: string, opts: BackendFetchOpts = {}): Promise<T> => {
  const cfg = readConfig();
  const session = readSession();
  if (!cfg.url) throw new Error("Backend URL not configured");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(opts.headers || {}),
  };
  if (session?.access_token) headers.Authorization = "Bearer " + session.access_token;
  if (cfg.tenantId) headers["x-obara-tenant"] = cfg.tenantId;

  const url = cfg.url.replace(/\/+$/, "") + path;
  const init: RequestInit = {
    method: opts.method || "GET",
    headers,
  };
  if (opts.body !== undefined) {
    init.body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
  }
  if (opts.signal) init.signal = opts.signal;

  const resp = await fetch(url, init);
  if (resp.status === 204) return undefined as unknown as T;
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status}: ${detail || resp.statusText}`);
  }
  return resp.json() as Promise<T>;
};
