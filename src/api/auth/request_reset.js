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
import { safeFetch } from "../_lib/safe-fetch.js";
import { createClient } from "@supabase/supabase-js";

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
  // Bug fix May 2026 (recovery-stuck-on-home report): default to
  // /auth/callback.html rather than /#/reset. The callback page
  // hands the recovery token off via sessionStorage and routes to
  // /#/reset on a single-fragment URL. The previous /#/reset
  // fallback produced a double-fragment URL (#/reset#access_token=...)
  // that the SPA router treated as an unknown route.
  const fallback = APP_URL ? APP_URL.replace(/\/+$/, "") + "/auth/callback.html" : "";
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
    const resp = await safeFetch("https://api.sendgrid.com/v3/mail/send", {
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

    // Email delivery strategy.
    //
    // The original flow generated a recovery link via the service
    // role (`auth.admin.generateLink`) which mints the link but does
    // NOT send any email. We then attempted SendGrid as the only
    // delivery channel. On a deployment without SENDGRID_API_KEY +
    // SENDGRID_FROM_EMAIL, the function silently dropped the email
    // and returned 200, so the user clicked "forgot password",
    // never got an email, and had no way to know why.
    //
    // The robust path is to use Supabase's anon-client method
    // `auth.resetPasswordForEmail()` which uses the Supabase
    // project's configured SMTP (the default for new projects).
    // We try that first; if it fails (or the anon key is missing),
    // we fall back to the manual generateLink + SendGrid path.
    // If both providers are missing we surface a clear server-side
    // warning + audit row so the operator can spot the misconfig
    // (the user-visible response stays generic to avoid leaking
    // anything about the account existence).
    let delivered = false;
    let provider = "none";
    let lastError = null;

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

    if (SUPABASE_URL && SUPABASE_ANON_KEY) {
      try {
        const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
          auth: { autoRefreshToken: false, persistSession: false },
        });
        const opts = redirectTo ? { redirectTo } : undefined;
        const r = await anon.auth.resetPasswordForEmail(email, opts);
        if (!r.error) {
          delivered = true;
          provider = "supabase_smtp";
        } else {
          lastError = r.error.message;
        }
      } catch (err) {
        lastError = err.message || String(err);
      }
    }

    // Fallback: manual generate + SendGrid. We only walk this path
    // if Supabase SMTP didn't deliver, because we don't want to send
    // two emails for a single request.
    let actionLink = null;
    if (!delivered) {
      try {
        const link = await svc.auth.admin.generateLink({
          type: "recovery",
          email,
          options: redirectTo ? { redirectTo } : undefined,
        });
        if (link.error) throw new Error(link.error.message);
        actionLink = link.data?.properties?.action_link || null;
      } catch (err) {
        lastError = err.message || lastError;
      }
      if (actionLink && SENDGRID_KEY && SENDGRID_FROM) {
        const sendResult = await sendResetEmail({ to: email, name: user.user_metadata?.name, actionLink });
        if (sendResult.sent) {
          delivered = true;
          provider = "sendgrid";
        } else {
          lastError = sendResult.error || lastError;
        }
      }
    }

    await safeAwait(svc.from("user_security_audit").insert({
      user_id: user.id,
      user_email: email,
      event: "password_reset_requested",
      ip, user_agent: userAgent,
      detail: {
        provider,
        sent: delivered,
        error: lastError ? String(lastError).slice(0, 240) : null,
      },
    }), "password_reset_audit");

    // Audit H2 (May 2026): never return the live recovery token in
    // the API response. Even in dev, exposing the action_link to the
    // caller is account-takeover-as-a-service. Instead we log the
    // link to server stderr in non-production so the dev workflow
    // still has a copy-pasteable artifact.
    if (!delivered) {
      // eslint-disable-next-line no-console
      console.warn(
        "[auth/request_reset] no email delivered for " + email +
        " (provider=" + provider + ", error=" + (lastError || "no provider configured") + "). " +
        "Configure Supabase SMTP in the project dashboard, or set " +
        "SUPABASE_URL/SUPABASE_ANON_KEY (built-in SMTP) or " +
        "SENDGRID_API_KEY/SENDGRID_FROM_EMAIL (manual fallback).",
      );
      if (NODE_ENV !== "production" && actionLink) {
        // eslint-disable-next-line no-console
        console.warn("[auth/request_reset] dev action_link for " + email + " -> " + actionLink);
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
