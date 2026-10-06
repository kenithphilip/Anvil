// Shared helpers for the Admin Center and its extracted panels.
//
// Lifted verbatim out of screens/admin.tsx when its panels were split into
// components/AdminDataPanels + components/AdminLlmDocaiPanels, so both the main
// screen and the panels import these from one place (no circular import).

import { AnvilBackend } from "./api";

// Authenticated fetch against /api/admin/* using the AnvilBackend session +
// tenant config. Throws on non-2xx; returns null on 204, else parsed JSON.
export const adminCrudFetch = async (path: string, opts: { method?: string; body?: any; headers?: Record<string, string> } = {}) => {
  const cfg = (AnvilBackend?.getConfig?.() || {}) as { url?: string; tenantId?: string };
  const session = (AnvilBackend?.getSession?.() || null) as { access_token?: string } | null;
  const headers: Record<string, string> = { "Content-Type": "application/json", ...((opts.headers as Record<string, string>) || {}) };
  if (session?.access_token) headers.Authorization = "Bearer " + session.access_token;
  if (cfg.tenantId) headers["x-anvil-tenant"] = cfg.tenantId;
  const url = (cfg.url || "").replace(/\/+$/, "") + path;
  const resp = await fetch(url, {
    ...opts,
    headers,
    body: opts.body && typeof opts.body !== "string" ? JSON.stringify(opts.body) : opts.body,
  });
  if (!resp.ok) throw new Error("HTTP " + resp.status + ": " + (await resp.text()));
  if (resp.status === 204) return null;
  return resp.json();
};

// Minimal RFC-4180-ish CSV parser (handles quotes, escaped quotes, CRLF).
export const parseCSV = (text) => {
  const rows = [];
  let cur = [];
  let field = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQ = false;
      else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { cur.push(field); field = ""; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        cur.push(field); rows.push(cur); cur = []; field = "";
      }
      else field += c;
    }
  }
  if (field.length > 0 || cur.length > 0) { cur.push(field); rows.push(cur); }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ""));
};
