// NetSuite TBA (Token-Based Authentication) HTTP helper.
//
// NetSuite supports two REST surfaces we use:
//   - SuiteQL via POST /services/rest/query/v1/suiteql for reads.
//   - Record API at GET/POST /services/rest/record/v1/<type> for writes.
//
// Auth is OAuth 1.0a with HMAC-SHA256, signed with consumer +
// token credentials. The crypto is small enough to inline here so
// we don't pull a heavy OAuth lib into the function.
//
// Each tenant has its own credentials stored on tenant_settings.
// The helper takes the row in and returns a fetch wrapper.

import crypto from "node:crypto";

const percentEncode = (s) =>
  encodeURIComponent(String(s ?? ""))
    .replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

const buildOAuthSignature = ({
  method, url, params, consumerSecret, tokenSecret, accountId,
}) => {
  const sortedParams = Object.keys(params)
    .sort()
    .map((k) => percentEncode(k) + "=" + percentEncode(params[k]))
    .join("&");
  const baseString = [
    method.toUpperCase(),
    percentEncode(url),
    percentEncode(sortedParams),
  ].join("&");
  const signingKey = percentEncode(consumerSecret) + "&" + percentEncode(tokenSecret);
  return crypto.createHmac("sha256", signingKey).update(baseString).digest("base64");
};

const buildOAuthHeader = ({
  method, url, accountId, consumerKey, consumerSecret, tokenId, tokenSecret,
}) => {
  const params = {
    oauth_consumer_key: consumerKey,
    oauth_token: tokenId,
    oauth_signature_method: "HMAC-SHA256",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_nonce: crypto.randomBytes(16).toString("hex"),
    oauth_version: "1.0",
  };
  const signature = buildOAuthSignature({
    method, url, params, consumerSecret, tokenSecret, accountId,
  });
  const all = { ...params, oauth_signature: signature, realm: accountId };
  // NetSuite expects realm to come first per their docs; we keep the
  // order stable for easier debugging.
  return "OAuth realm=\"" + percentEncode(all.realm) + "\","
    + Object.keys(all)
      .filter((k) => k !== "realm")
      .map((k) => percentEncode(k) + "=\"" + percentEncode(all[k]) + "\"")
      .join(",");
};

// Build the base URL from the account id. NetSuite account ids look
// like `1234567` or `1234567_SB1` (sandbox). The hostname swaps `_`
// for `-` and lowercases.
const baseUrl = (accountId) => {
  const host = String(accountId || "").replace(/_/g, "-").toLowerCase();
  return "https://" + host + ".suitetalk.api.netsuite.com";
};

export const netsuiteIsConfigured = (settings) => !!(
  settings?.netsuite_account_id &&
  settings?.netsuite_consumer_key &&
  settings?.netsuite_consumer_secret &&
  settings?.netsuite_token_id &&
  settings?.netsuite_token_secret
);

export const netsuiteFetch = async (settings, { method, path, body, query }) => {
  if (!netsuiteIsConfigured(settings)) {
    throw new Error("NetSuite credentials missing for this tenant");
  }
  const accountId = settings.netsuite_account_id;
  const url = baseUrl(accountId) + path + (query ? "?" + new URLSearchParams(query).toString() : "");
  const auth = buildOAuthHeader({
    method,
    url,
    accountId,
    consumerKey: settings.netsuite_consumer_key,
    consumerSecret: settings.netsuite_consumer_secret,
    tokenId: settings.netsuite_token_id,
    tokenSecret: settings.netsuite_token_secret,
  });
  const headers = { Authorization: auth, Accept: "application/json" };
  if (body) headers["Content-Type"] = "application/json";
  const resp = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch (_) { parsed = { raw: text }; }
  return { ok: resp.ok, status: resp.status, body: parsed };
};

// Convenience: run a SuiteQL query against the configured account.
// SuiteQL accepts a JSON body { q: "select ..." } and returns
// { items: [...], hasMore, count, totalResults }.
export const suiteql = async (settings, sql, opts) => {
  const limit = Math.max(1, Math.min(1000, opts?.limit || 100));
  const offset = Math.max(0, opts?.offset || 0);
  return netsuiteFetch(settings, {
    method: "POST",
    path: "/services/rest/query/v1/suiteql",
    body: { q: sql },
    query: { limit, offset },
  });
};
