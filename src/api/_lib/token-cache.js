// Generic token cache for ERPs that issue session-style tokens
// (basic-auth or API-key on a token endpoint, then carry the token
// on subsequent calls for some TTL). Used by JDE EnterpriseOne (AIS),
// Plex Smart Manufacturing Platform, and JobBoss² (ECi REST).
//
// We cache tokens in-memory per (tenant_id, token_url, identity)
// and refresh ~30s before expiry. Cold starts re-mint tokens; that's
// a one-shot cost we accept rather than persisting tokens to DB and
// hauling encryption back in for each call.
//
// Unlike `_lib/oauth2.js` (which speaks the standard OAuth2 client_-
// credentials body shape), this module is generic over the request
// builder: callers supply a `mintFn` that performs whatever HTTP
// dance the vendor requires and returns `{ token, expiresInSec }`.

const cache = new Map();
const REFRESH_SLACK_MS = 30_000;
const DEFAULT_TTL_SEC = 1800; // 30 min, conservative

const cacheKey = (tenantId, tokenUrl, identity) =>
  String(tenantId) + "|" + String(tokenUrl) + "|" + String(identity);

// Get a cached token or mint a new one. `mintFn` must return a
// Promise of `{ token, expiresInSec }`. `expiresInSec` defaults to
// 1800 if mintFn returns falsy.
export const getOrMintToken = async ({
  tenantId, tokenUrl, identity, mintFn,
}) => {
  const key = cacheKey(tenantId, tokenUrl, identity);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now() + REFRESH_SLACK_MS) {
    return cached.token;
  }
  const minted = await mintFn();
  if (!minted?.token) {
    throw new Error("token-cache mintFn returned no token");
  }
  const ttlMs = (Number(minted.expiresInSec) || DEFAULT_TTL_SEC) * 1000;
  cache.set(key, { token: minted.token, expiresAt: Date.now() + ttlMs });
  return minted.token;
};

// Force-evict a cache entry. Call this when an API returns 401
// mid-call so the next attempt re-mints instead of replaying the
// stale token.
export const evictToken = (tenantId, tokenUrl, identity) => {
  cache.delete(cacheKey(tenantId, tokenUrl, identity));
};

// Test seam.
export const clearTokenCache = () => { cache.clear(); };
