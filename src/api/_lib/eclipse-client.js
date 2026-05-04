// Epicor Eclipse Web Services client.
//
// Eclipse exposes a SOAP-style XML API at /eterm/<endpoint>. Some
// hosts also offer a thin JSON wrapper. We support both: we send
// the request as JSON when the host advertises the JSON wrapper
// (detected at connect time), else fall back to a minimal SOAP
// envelope.
//
// Auth: HTTP Basic with username:password. Sessions are stateless;
// no token caching needed.

import { decryptField, encryptField, isSecretsConfigured, newIv } from "./secrets.js";

export const eclipseDecryptCreds = (s) => {
  if (!s) return s;
  const out = { ...s };
  const tryDec = (encCol, plainCol) => {
    if (s[encCol] && s.eclipse_creds_iv) {
      try { return decryptField(s[encCol], s.eclipse_creds_iv); }
      catch (_e) { return s[plainCol] || null; }
    }
    return s[plainCol] || null;
  };
  out.eclipse_username = tryDec("eclipse_username_enc", "eclipse_username");
  out.eclipse_password = tryDec("eclipse_password_enc", null);
  return out;
};

export const eclipseEncryptCreds = ({ username, password }) => {
  if (!isSecretsConfigured()) {
    return { eclipse_username: username, eclipse_username_enc: null, eclipse_password_enc: null, eclipse_creds_iv: null };
  }
  const iv = newIv();
  return {
    eclipse_username: null,
    eclipse_username_enc: encryptField(username, iv),
    eclipse_password_enc: encryptField(password, iv),
    eclipse_creds_iv: iv,
  };
};

export const eclipseIsConfigured = (s) => !!(
  s?.eclipse_base_url && s?.eclipse_username && s?.eclipse_password
);

const basicAuth = (s) =>
  "Basic " + Buffer.from(s.eclipse_username + ":" + s.eclipse_password).toString("base64");

const escapeXml = (s) => String(s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&apos;");

const buildSoapEnvelope = (path, payload) => {
  const op = path.split("/").pop();
  const fields = Object.entries(payload || {})
    .map(([k, v]) => `<${k}>${escapeXml(String(v ?? ""))}</${k}>`).join("");
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
 <soap:Body><${op}>${fields}</${op}></soap:Body>
</soap:Envelope>`;
};

const parseSoapResponse = (xml) => {
  if (!xml) return null;
  const out = {};
  const re = /<(?:[a-z0-9]+:)?([A-Za-z0-9_]+)>([^<]*)<\/(?:[a-z0-9]+:)?\1>/g;
  let m;
  while ((m = re.exec(xml))) out[m[1]] = m[2];
  return { soap: out, raw: xml.slice(0, 400) };
};

// Try JSON first (modern Eclipse Cloud hosts); on 415 / 404 fall back to SOAP.
export const eclipseFetch = async (s, { method, path, body, query } = {}) => {
  if (!eclipseIsConfigured(s)) throw new Error("Eclipse not configured for this tenant");
  const url = s.eclipse_base_url.replace(/\/+$/, "") + path
    + (query ? "?" + new URLSearchParams(query).toString() : "");
  const t0 = Date.now();
  const jsonResp = await fetch(url, {
    method,
    headers: {
      Authorization: basicAuth(s),
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (jsonResp.ok || (jsonResp.status !== 415 && jsonResp.status !== 404)) {
    const text = await jsonResp.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch (_e) { parsed = { raw: text.slice(0, 400) }; }
    return { ok: jsonResp.ok, status: jsonResp.status, body: parsed, latency_ms: Date.now() - t0, transport: "json" };
  }
  const soapBody = body ? buildSoapEnvelope(path, body) : null;
  const soapResp = await fetch(url, {
    method,
    headers: {
      Authorization: basicAuth(s),
      "Content-Type": "text/xml; charset=utf-8",
      SOAPAction: '"' + path + '"',
    },
    body: soapBody,
  });
  const stext = await soapResp.text();
  return {
    ok: soapResp.ok,
    status: soapResp.status,
    body: parseSoapResponse(stext),
    latency_ms: Date.now() - t0,
    transport: "soap",
  };
};

export const eclipseList = async (s, path, { since, top = 200, maxRows = 5000 } = {}) => {
  const out = [];
  let skip = 0;
  while (out.length < maxRows) {
    const query = { $top: String(top), $skip: String(skip) };
    if (since) query.modifiedAfter = new Date(since).toISOString();
    const resp = await eclipseFetch(s, { method: "GET", path, query });
    if (!resp.ok) {
      throw new Error("Eclipse list " + resp.status + " " + path + " " + JSON.stringify(resp.body).slice(0, 400));
    }
    const items = resp.body?.value || resp.body?.records || resp.body?.items || [];
    out.push(...items);
    if (items.length < top) break;
    skip += top;
  }
  return out;
};
