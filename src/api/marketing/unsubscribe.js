// /api/marketing/unsubscribe — PUBLIC (recipients click without a session).
//
//   GET  ?token=...   render a confirmation page. Does NOT unsubscribe on GET,
//                     so an email client's link-prefetch/scanner can't silently
//                     unsubscribe someone.
//   POST ?token / {token}   perform the unsubscribe (RFC 8058 one-click target
//                     of the List-Unsubscribe header, and the confirm button).
//
// The token is an HMAC(tenant_id, email) minted by _lib/marketing-send.js, so
// this endpoint trusts it instead of a session — the same pattern as the Graph
// OAuth callback. It adds a MARKETING suppression only (prospecting_suppressions);
// it never touches transactional routing. A payment reminder / PoD to the same
// person is unaffected — the transactional path never reads this table.

import { applyCors, handlePreflight, readBody, sendError } from "../_lib/cors.js";
import { serviceClient } from "../_lib/supabase.js";
import { verifyUnsubscribe, addSuppression } from "../_lib/marketing-send.js";

const page = (title, msg) =>
  "<!doctype html><html><head><meta charset=utf-8><meta name=viewport content=\"width=device-width,initial-scale=1\">"
  + "<title>" + title + "</title></head>"
  + "<body style=\"font-family:system-ui,-apple-system,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1.25rem;color:#1a1a1a\">"
  + msg + "</body></html>";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const token = req.query?.token || (req.method === "POST" ? (await readBody(req))?.token : null);
    const v = verifyUnsubscribe(token);

    if (req.method === "POST") {
      // One-click / confirm. Act only on a valid token; always answer 200 so a
      // probe can't distinguish valid from invalid.
      if (v) { await addSuppression(serviceClient(), v.tenantId, v.email, "unsubscribe"); }
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Unsubscribed");
      return;
    }

    // GET — confirmation page. No state change.
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (!v) {
      res.end(page("Link expired", "<h1>This unsubscribe link is invalid or expired</h1><p>Please use the link from a recent email.</p>"));
      return;
    }
    const safeToken = String(token).replace(/"/g, "&quot;");
    res.end(page("Unsubscribe",
      "<h1>Unsubscribe from marketing emails?</h1>"
      + "<p>You will stop receiving marketing emails from this sender. "
      + "Transactional messages (order, dispatch, and payment notifications) are unaffected.</p>"
      + "<form method=\"POST\" action=\"/api/marketing/unsubscribe\">"
      + "<input type=\"hidden\" name=\"token\" value=\"" + safeToken + "\">"
      + "<button type=\"submit\" style=\"font-size:1rem;padding:.6rem 1.2rem;border:0;border-radius:.4rem;background:#1a1a1a;color:#fff;cursor:pointer\">Unsubscribe</button>"
      + "</form>"));
  } catch (err) {
    return sendError(res, err);
  }
}
