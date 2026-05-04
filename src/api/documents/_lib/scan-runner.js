// Internal helper for /api/documents/scan and /api/documents/upload.
//
// Wraps the ClamAV REST proxy contract:
//   POST {CLAMAV_URL}/scan
//   { filename, sha256, content_b64 }
//   -> { infected: bool, virus?: string }
//
// Verdict shape: callers branch on `invoked`. When false, `reason` is
// one of "not_configured" | "http_<status>" | "<network error>". When
// true, `infected` is authoritative.
//
// We never mark a clean file as rejected because of a missing AV; the
// absence is a "warn", not a "rejected". That policy decision lives in
// scan.js (the route handler), not here.

import crypto from "node:crypto";

export const sha256 = (buf) =>
  crypto.createHash("sha256").update(buf).digest("hex");

export const SCAN_TIMEOUT_MS = 12_000;

export async function scanWithClamAV(buffer, filename, opts) {
  const url = (opts && opts.url) || process.env.CLAMAV_URL || "";
  const token = (opts && opts.token) || process.env.CLAMAV_TOKEN || "";
  const fetchFn = (opts && opts.fetch) || globalThis.fetch;
  if (!url) return { invoked: false, reason: "not_configured" };
  try {
    const headers = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = "Bearer " + token;
    const body = {
      filename,
      sha256: sha256(buffer),
      content_b64: buffer.toString("base64"),
    };
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), opts?.timeoutMs || SCAN_TIMEOUT_MS);
    const resp = await fetchFn(url.replace(/\/$/, "") + "/scan", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) return { invoked: false, reason: "http_" + resp.status };
    const data = await resp.json();
    return {
      invoked: true,
      infected: !!data.infected,
      virus: data.virus || null,
      raw: data,
    };
  } catch (err) {
    return { invoked: false, reason: err.message || "network_error" };
  }
}
