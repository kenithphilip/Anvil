// OAuth2 client_credentials helper used by SAP S/4HANA and
// Dynamics 365 connectors. Both use the same flow:
//   POST <token_url>
//     grant_type=client_credentials
//     client_id=<id>
//     client_secret=<secret>
//     scope=<scope>     (optional; Dynamics uses resource= instead)
//
// We cache tokens in-memory per (tenant_id, token_url, client_id) and
// refresh ~30s before expiry. Cold starts re-mint tokens; that's a
// one-shot cost we accept rather than persisting tokens to DB and
// hauling encryption back in for each call.

const cache = new Map();
const REFRESH_SLACK_MS = 30_000;

const cacheKey = (tenantId, tokenUrl, clientId) =>
  String(tenantId) + "|" + String(tokenUrl) + "|" + String(clientId);

export const oauth2ClientCredentials = async ({
  tenantId, tokenUrl, clientId, clientSecret, scope, resource, extra,
}) => {
  const key = cacheKey(tenantId, tokenUrl, clientId);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now() + REFRESH_SLACK_MS) {
    return cached.token;
  }
  const params = new URLSearchParams();
  params.set("grant_type", "client_credentials");
  params.set("client_id", clientId);
  params.set("client_secret", clientSecret);
  if (scope) params.set("scope", scope);
  if (resource) params.set("resource", resource);
  if (extra) {
    for (const [k, v] of Object.entries(extra)) params.set(k, v);
  }
  const resp = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: params.toString(),
  });
  const text = await resp.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch (_e) { parsed = { raw: text.slice(0, 400) }; }
  if (!resp.ok || !parsed?.access_token) {
    const err = new Error("oauth2 token request failed: " + resp.status + " " + (parsed?.error_description || parsed?.error || text.slice(0, 200)));
    err.status = resp.status;
    throw err;
  }
  const ttlMs = (Number(parsed.expires_in) || 3600) * 1000;
  const token = parsed.access_token;
  cache.set(key, { token, expiresAt: Date.now() + ttlMs });
  return token;
};

// Force-evict a cache entry. Useful when an API returns 401 mid-call
// and we want the next attempt to re-mint instead of replaying the
// stale token.
export const oauth2Evict = (tenantId, tokenUrl, clientId) => {
  cache.delete(cacheKey(tenantId, tokenUrl, clientId));
};

// Test seam: clear all entries.
export const oauth2ClearCache = () => { cache.clear(); };
