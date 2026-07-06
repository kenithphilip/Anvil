// Per-request CORS + body helpers.
//
// Hardened May 2026 (security audit P0). Previously the module
// defaulted to ALLOWED_ORIGINS="*" and would always echo the caller
// origin, so any cross-origin caller could reach the API. The new
// behaviour:
//
//   1. ALLOWED_ORIGINS must be set explicitly. Empty string means
//      "no cross-origin requests at all" (same-origin only).
//   2. The wildcard "*" is honoured only in non-production envs as
//      an explicit opt-in. We refuse to broadcast Access-Control-
//      Allow-Origin: * silently.
//   3. Origins are matched case-sensitively against the allowlist.
//      Only exact matches are echoed; no fall-through.

const NODE_ENV   = process.env.NODE_ENV || "development";
const RAW_ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
const ALLOW_WILDCARD = RAW_ORIGINS.includes("*") && NODE_ENV !== "production";
const ALLOWED = new Set(RAW_ORIGINS.filter((o) => o !== "*"));

// Hard cap on request bodies. Anvil endpoints handle small JSON
// payloads + the inbound email + document scan paths cap their own
// upload sizes. 1 MiB is enough for every JSON-shaped POST in the
// codebase. Anything larger gets a clean 413 instead of a Vercel
// runtime error.
const MAX_BODY_BYTES = 1 * 1024 * 1024;

export const applyCors = (req, res) => {
  const origin = String(req.headers.origin || "");
  let allow = "";
  if (origin && ALLOWED.has(origin)) allow = origin;
  else if (!origin && ALLOW_WILDCARD) allow = "*";
  // Otherwise: leave Access-Control-Allow-Origin unset. Browsers
  // will refuse the response per CORS rules; non-browser callers
  // (curl, server-to-server) are unaffected.
  if (allow) res.setHeader("Access-Control-Allow-Origin", allow);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-anvil-tenant, x-obara-tenant");
  res.setHeader("Access-Control-Max-Age", "86400");
};

export const handlePreflight = (req, res) => {
  if (req.method !== "OPTIONS") return false;
  applyCors(req, res);
  res.status(204).end();
  return true;
};

export const sendError = (res, err) => {
  const status = err && err.status ? err.status : 500;
  const message = err && err.message ? err.message : "Internal error";
  res.status(status).json({ error: { message, status } });
};

export const json = (res, status, body) => {
  res.setHeader("Content-Type", "application/json");
  res.status(status).send(JSON.stringify(body));
};

// readBody enforces a hard size cap (~1 MiB). When `req.body` is
// already parsed by an upstream middleware (Vercel pre-parses JSON
// for some content types) we trust the runtime's existing limit.
// Otherwise we accumulate chunks ourselves with a bounded buffer.
export const readBody = async (req) => {
  if (req.body && typeof req.body === "object") return req.body;
  return await new Promise((resolve, reject) => {
    let size = 0;
    let raw = "";
    let aborted = false;
    req.on("data", (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        const err = new Error("Request body exceeds " + MAX_BODY_BYTES + " bytes");
        err.status = 413;
        try { req.destroy(); } catch (_) { /* ignore */ }
        return reject(err);
      }
      raw += chunk;
    });
    req.on("end", () => {
      if (aborted) return;
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (_err) {
        const err = new Error("Invalid JSON body");
        err.status = 400;
        reject(err);
      }
    });
    req.on("error", reject);
  });
};
