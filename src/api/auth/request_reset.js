// POST /api/auth/request_reset
//
// Body: { email, redirect_to? }
//
// Generates a Supabase recovery link for `email`, sends it via
// SendGrid (best-effort; falls back to console.warn so the test
// rig still works), and audits the request.
//
// Security notes
// --------------
// 1. **No user enumeration.** The endpoint always returns 200 with
//    a generic "if an account exists, an email has been sent"
//    message. We only differ in the audit log.
// 2. **Rate-limit per email.** The password_reset_attempts table
//    holds a per-address count + sliding 1h window. Five requests
//    in an hour drops further requests on the floor. Bursts go
//    through but a stuffing run gets bounced.
// 3. **Token mint via Supabase.** The Supabase recovery link is
//    single-use, time-limited, and cryptographically signed by
//    the project's auth service. We never see the raw token; we
//    only forward the `action_link` to the user.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { serviceClient } from "../_lib/supabase.js";
import { safeAwait } from "../_lib/safe-thenable.js";

const RESET_RATE_LIMIT = Number(process.env.RESET_RATE_LIMIT || 5);
const RESET_RATE_WINDOW_MIN = 60;
const SENDGRID_KEY = process.env.SENDGRID_API_KEY;
const SENDGRID_FROM = process.env.SENDGRID_FROM_EMAIL;
const SENDGRID_FROM_NAME = process.env.SENDGRID_FROM_NAME || "Anvil";
const APP_URL = process.env.APP_URL || process.env.PUBLIC_APP_URL || "";
const NODE_ENV = process.env.NODE_ENV || "development";

const isValidEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "").trim());

// Open-redirect allowlist (audit H2). The redirect_to value is
// embedded in the recovery email by Supabase; an attacker who can
// trigger a reset on a victim's address could otherwise harvest the
// recovery token by pointing redirect_to at attacker.com. Only
// echo the caller's value back to Supabase when it shares the
// configured APP_URL origin. Otherwise fall back to APP_URL/#/reset.
const safeRedirectTo = (caller) => {
  const fallback = APP_URL ? APP_URL.replace(/\/+$/, "") + "/#/reset" : "";
  if (!caller) return fallback;
  if (!APP_URL) return fallback;
  try {
    const u = new URL(caller);
    const base = new URL(APP_URL);
    if (u.origin === base.origin) return caller;
  } catch (_) { /* malformed URL, fall through */ }
  return fallback;
};

const checkRateLimit = async (svc, email) => {
  const now = Date.now();
  const windowStart = new Date(now - RESET_RATE_WINDOW_MIN * 60_000).toISOString();
  const { data: row } = await svc.from("password_reset_attempts")
    .select("*").eq("email", email).maybeSingle();
  if (!row) {
    await svc.from("password_reset_attempts").insert({
      email,
      count: 1,
      window_started_at: new Date(now).toISOString(),
      last_request_at: new Date(now).toISOString(),
    });
    return { allowed: true, count: 1 };
  }
  // Reset counter if the window expired.
  if (row.window_started_at < windowStart) {
    await svc.from("password_reset_attempts")
      .update({
        count: 1,
        window_started_at: new Date(now).toISOString(),
        last_request_at: new Date(now).toISOString(),
      })
      .eq("email", email);
    return { allowed: true, count: 1 };
  }
  if ((row.count || 0) >= RESET_RATE_LIMIT) {
    return { allowed: false, count: row.count };
  }
  await svc.from("password_reset_attempts")
    .update({
      count: (row.count || 0) + 1,
      last_request_at: new Date(now).toISOString(),
    })
    .eq("email", email);
  return { allowed: true, count: (row.count || 0) + 1 };
};

const sendResetEmail = async ({ to, name, actionLink }) => {
  if (!SENDGRID_KEY || !SENDGRID_FROM) return { provider: "manual", sent: false };
  const greeting = name ? `Hi ${name},\n\n` : "Hi,\n\n";
  const body = greeting +
    "We got a request to reset your Anvil password.\n\n" +
    "Click here to set a new one. The link is single-use and expires in 1 hour:\n\n" +
    actionLink + "\n\n" +
    "If you didn't request this, ignore the email. Your password stays unchanged.\n\n" +
    "Anvil security team";
  try {
    const resp = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { Authorization: "Bearer " + SENDGRID_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: SENDGRID_FROM, name: SENDGRID_FROM_NAME },
        subject: "Reset your Anvil password",
        content: [
          { type: "text/plain", value: body },
          { type: "text/html", value: body.replace(/\n/g, "<br/>") },
        ],
      }),
    });
    return { provider: "sendgrid", sent: resp.ok, status: resp.status };
  } catch (err) {
    return { provider: "sendgrid", sent: false, error: err.message };
  }
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const body = await readBody(req);
    const email = String(body?.email || "").trim().toLowerCase();
    if (!isValidEmail(email)) {
      // Don't leak validation; respond as if accepted.
      return json(res, 200, { ok: true, message: "If an account exists for that address, a reset email has been sent." });
    }
    const redirectTo = safeRedirectTo(String(body?.redirect_to || "").trim());

    const svc = serviceClient();
    const ip = (req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || "").toString().split(",")[0].trim();
    const userAgent = String(req.headers["user-agent"] || "");

    const rate = await checkRateLimit(svc, email);
    if (!rate.allowed) {
      // Audit the throttle hit but answer 200 to avoid revealing
      // anything to a stuffing attacker.
      await safeAwait(svc.from("user_security_audit").insert({
        user_email: email,
        event: "password_reset_requested",
        ip, user_agent: userAgent,
        detail: { throttled: true, count: rate.count },
      }));
      return json(res, 200, {
        ok: true,
        throttled: true,
        message: "If an account exists for that address, a reset email has been sent.",
      });
    }

    // Look up the user (service role); if missing we still return
    // 200 so an attacker can't enumerate accounts via timing.
    // Audit H11 (May 2026): use Supabase's filtered listUsers
    // instead of pulling every user across the project. The filter
    // pins the lookup to a single email; no cross-tenant data is
    // loaded into memory.
    let user = null;
    try {
      const { data } = await svc.auth.admin.listUsers({ page: 1, perPage: 1, email });
      user = (data?.users || [])[0] || null;
    } catch (_) { user = null; }

    if (!user) {
      // Audit the failed lookup but DO NOT reveal it to the caller.
      await safeAwait(svc.from("user_security_audit").insert({
        user_email: email,
        event: "password_reset_requested",
        ip, user_agent: userAgent,
        detail: { unknown_account: true },
      }));
      return json(res, 200, { ok: true, message: "If an account exists for that address, a reset email has been sent." });
    }

    // Generate the single-use recovery link via Supabase.
    let actionLink = null;
    try {
      const link = await svc.auth.admin.generateLink({
        type: "recovery",
        email,
        options: redirectTo ? { redirectTo } : undefined,
      });
      if (link.error) throw new Error(link.error.message);
      actionLink = link.data?.properties?.action_link || null;
    } catch (err) {
      // Don't surface; audit and respond generically.
      await safeAwait(svc.from("user_security_audit").insert({
        user_id: user.id,
        user_email: email,
        event: "password_reset_requested",
        ip, user_agent: userAgent,
        detail: { error: err.message?.slice(0, 240) },
      }));
      return json(res, 200, { ok: true, message: "If an account exists for that address, a reset email has been sent." });
    }

    const sendResult = actionLink
      ? await sendResetEmail({ to: email, name: user.user_metadata?.name, actionLink })
      : { provider: "manual", sent: false };

    await safeAwait(svc.from("user_security_audit").insert({
      user_id: user.id,
      user_email: email,
      event: "password_reset_requested",
      ip, user_agent: userAgent,
      detail: { provider: sendResult.provider, sent: sendResult.sent },
    }));

    // Audit H2 (May 2026): never return the live recovery token in
    // the API response. Even in dev, exposing the action_link to the
    // caller is account-takeover-as-a-service: any caller, any CDN
    // log, any monitoring tool that captures bodies gets a working
    // sign-in primitive. Instead we log the link to the server stderr
    // so the dev workflow still has a copy-pasteable artifact.
    if (!SENDGRID_KEY || !SENDGRID_FROM) {
      if (NODE_ENV !== "production" && actionLink) {
        // eslint-disable-next-line no-console
        console.warn("[auth/request_reset] dev mode: action_link for", email, "->", actionLink);
      }
    }
    return json(res, 200, {
      ok: true,
      message: "If an account exists for that address, a reset email has been sent.",
    });
  } catch (err) {
    return sendError(res, err);
  }
}
