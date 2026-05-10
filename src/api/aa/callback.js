// GET /api/aa/callback?handle=<...>&sandbox=1
//
// Setu Embed redirects back here after the user signs the consent.
// We pull the latest upstream state, persist it, and serve a tiny
// HTML response that posts a window message to the parent
// (the Anvil operator UI was the opener) so the slideover can
// close itself.
//
// Sandbox flow: the operator opens the consent slideover, clicks
// the mock-redirect URL we returned from /api/aa/consent. The URL
// hits this endpoint with `?sandbox=1`, which marks the consent
// active and renders the same close-window page so the UX is
// identical.

import { applyCors, handlePreflight, sendError } from "../_lib/cors.js";
import { serviceClient } from "../_lib/supabase.js";
import { tenantSettings } from "../_lib/stripe-client.js";
import { pollConsent } from "../_lib/aa/setu-client.js";

// Tiny self-closing page. The parent listens for the
// `aa-consent-complete` message via window.addEventListener.
const closingPage = (status) => `<!doctype html>
<html><head><title>Consent ${status}</title></head>
<body style="font-family:system-ui;padding:20px">
<h2>Account Aggregator: ${status}</h2>
<p>You may close this window.</p>
<script>
try {
  if (window.opener && !window.opener.closed) {
    window.opener.postMessage({ kind: 'aa-consent-complete', status: '${status}' }, '*');
  }
} catch (_) {}
setTimeout(function(){ try { window.close(); } catch (_) {} }, 800);
</script>
</body></html>`;

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    if (req.method !== "GET") {
      res.statusCode = 405;
      res.setHeader("Content-Type", "text/plain");
      res.end("Method not allowed");
      return;
    }
    const url = new URL(req.url, "http://_");
    const handle = url.searchParams.get("handle");
    if (!handle) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(closingPage("missing_handle"));
      return;
    }
    const svc = serviceClient();
    // The callback is unauthenticated (Setu redirects the user's
    // browser). We resolve tenant by consent_handle uniqueness.
    const existing = await svc.from("aa_consents").select("*")
      .eq("consent_handle", handle).maybeSingle();
    if (existing.error) throw new Error(existing.error.message);
    if (!existing.data) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(closingPage("not_found"));
      return;
    }
    const settings = await tenantSettings(svc, existing.data.tenant_id);
    const upstream = await pollConsent(settings || {}, handle);
    const isActive = (upstream.status || "").toLowerCase() === "active";
    const newStatus = isActive
      ? (upstream.is_sandbox ? "sandbox_active" : "active")
      : (upstream.status || "pending").toLowerCase();
    await svc.from("aa_consents").update({
      status: newStatus,
      consent_id: upstream.consent_id || existing.data.consent_id,
      granted_at: isActive
        ? (existing.data.granted_at || new Date().toISOString())
        : existing.data.granted_at,
      raw: { ...existing.data.raw, callback: upstream },
    }).eq("id", existing.data.id);
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(closingPage(newStatus));
  } catch (err) { sendError(res, err); }
}
