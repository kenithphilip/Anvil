// Password-reset completion screen.
//
// Reached when the user clicks the recovery link that
// /api/auth/request_reset emailed them. Supabase's recovery flow
// puts the access_token in the URL fragment (#) so the browser
// never sends it to the server. We extract it client-side, then
// post it (with the user's chosen new password) to
// /api/auth/complete_reset.
//
// Pre-auth screen: rendered by App.tsx alongside <Landing>; the
// auth gate routes here when the URL hash matches /reset.

import React, { useEffect, useMemo, useState } from "react";
import { Banner, Btn, Card } from "../lib/primitives";
import { AnvilBackend } from "../lib/api";

const MIN_PASSWORD = 10;

// Recovery-token transport.
//
// Preferred: sessionStorage["anvil:recovery"] populated by the
// callback page (public/auth/callback.js). The recovery flow is:
//   1. User clicks the Supabase recovery email link.
//   2. Supabase verifies the token and 302's to /auth/callback.html
//      with #access_token=...&type=recovery in the URL fragment.
//   3. callback.js detects type=recovery, moves the token to
//      sessionStorage, clears the URL fragment, redirects to /#/reset.
//   4. This screen reads sessionStorage, clears it immediately, and
//      shows the new-password form.
//
// Fallback: URL parse. For old links generated before the callback
// route landed, or operator hand-crafted URLs, we still parse the
// fragment + search. The fallback also clears the URL fragment via
// history.replaceState as soon as the token is captured.
//
// Both paths put the token in component state for the lifetime of
// the form; it is sent to /api/auth/complete_reset and discarded.
const RECOVERY_KEY = "anvil:recovery";

type RecoveryState = { access_token: string | null; type: string | null; error: string | null };

const readSessionStorage = (): RecoveryState | null => {
  try {
    const raw = sessionStorage.getItem(RECOVERY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return {
      access_token: parsed?.access_token || null,
      type: "recovery",
      error: null,
    };
  } catch (_) {
    return null;
  }
};

const clearSessionStorage = () => {
  try { sessionStorage.removeItem(RECOVERY_KEY); } catch (_) {}
};

const clearUrlFragment = () => {
  if (typeof window === "undefined") return;
  try {
    // Keep the route on /reset; drop the inner fragment with the
    // token. history.replaceState avoids the back-button history
    // entry.
    window.history.replaceState(null, "", window.location.pathname + "#/reset");
  } catch (_) {}
};

const parseRecoveryToken = (): RecoveryState => {
  if (typeof window === "undefined") return { access_token: null, type: null, error: null };
  // Tier 1: sessionStorage handoff from the callback page.
  const fromStorage = readSessionStorage();
  if (fromStorage?.access_token) {
    // Single-use: clear immediately so a refresh + abandoned form
    // does not leave the token sitting in storage.
    clearSessionStorage();
    return fromStorage;
  }
  // Tier 2: legacy URL fragment parse.
  const raw = window.location.hash || "";
  const tail = raw.replace(/^#\/?reset/, "").replace(/^[?#]/, "");
  let params: URLSearchParams;
  if (tail) {
    params = new URLSearchParams(tail);
  } else {
    const search = window.location.search.replace(/^\?/, "");
    if (!search) return { access_token: null, type: null, error: null };
    params = new URLSearchParams(search);
  }
  const state: RecoveryState = {
    access_token: params.get("access_token"),
    type: params.get("type"),
    error: params.get("error_description") || params.get("error"),
  };
  if (state.access_token) {
    // Hide the token from the address bar + browser history as soon
    // as we have it in memory.
    clearUrlFragment();
  }
  return state;
};

const ResetPassword: React.FC = () => {
  const parsed = useMemo(parseRecoveryToken, []);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(parsed.error || null);

  useEffect(() => {
    // If we got here without a token, the user probably opened the
    // route directly. Surface a clear "request a reset email" CTA
    // instead of bouncing them; the previous auto-bounce hid the
    // problem and made the failure mode look like the home screen
    // loading. The CTA is rendered below when access_token is null.
    return undefined;
  }, [parsed.access_token, parsed.error]);

  const onSubmit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setError(null);
    if (!parsed.access_token) {
      setError("Reset link is missing the recovery token. Request a new email from the sign-in page.");
      return;
    }
    if (password.length < MIN_PASSWORD) {
      setError(`Password must be at least ${MIN_PASSWORD} characters.`);
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      // We talk to /api/auth/complete_reset directly via the
      // configured backend client. apiFetch already attaches the
      // tenant header but does NOT inject the user's session for
      // this call (we want the recovery token, not a stale user
      // token); the endpoint reads the body's access_token.
      const cfg = (AnvilBackend?.getConfig?.() || {}) as { url?: string };
      if (!cfg.url) {
        setError("Backend not configured. Open the sign-in page first.");
        setBusy(false);
        return;
      }
      const resp = await fetch(cfg.url.replace(/\/+$/, "") + "/api/auth/complete_reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          access_token: parsed.access_token,
          new_password: password,
        }),
      });
      const body = await resp.json().catch(() => null);
      if (!resp.ok) {
        setError(body?.error?.message || "Could not reset password. The link may have expired; request a new one.");
        setBusy(false);
        return;
      }
      setDone(true);
      window.notifySuccess?.("Password updated", "Sign in with your new password.");
    } catch (err: any) {
      setError(err?.message || "Could not reset password.");
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="landing">
        <main id="main">
          <section className="landing-hero">
            <div style={{ gridColumn: "1 / -1", maxWidth: 460, margin: "40px auto" }}>
              <Card title="Password updated" eyebrow="security">
                <p style={{ fontSize: 14, color: "var(--ink-2)", lineHeight: 1.6 }}>
                  Your password has been changed. For security, any open Anvil sessions for this account
                  have been signed out. Use the new password to sign in below.
                </p>
                <Btn kind="primary" full onClick={() => { window.location.hash = "#/landing"; }}>
                  Go to sign-in
                </Btn>
              </Card>
            </div>
          </section>
        </main>
      </div>
    );
  }

  return (
    <div className="landing">
      <main id="main">
        <section className="landing-hero">
          <div style={{ gridColumn: "1 / -1", maxWidth: 460, margin: "40px auto", width: "100%" }}>
            <Card title="Set a new password" eyebrow="account recovery">
              {parsed.error && (
                <Banner kind="bad">{parsed.error}</Banner>
              )}
              {!parsed.access_token && !parsed.error && (
                <Banner kind="info">
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <span>This page expects a recovery token from a password-reset email. If you arrived here directly, request a new email from sign-in.</span>
                    <Btn kind="ghost" onClick={() => { window.location.hash = "#/signin"; }}>Go to sign-in</Btn>
                  </div>
                </Banner>
              )}
              <form onSubmit={onSubmit} className="landing-auth-form">
                <label className="landing-field">
                  <span>New password</span>
                  <input
                    className="input"
                    type="password"
                    autoFocus
                    minLength={MIN_PASSWORD}
                    placeholder={`min ${MIN_PASSWORD} chars`}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="new-password"
                    required
                  />
                </label>
                <label className="landing-field">
                  <span>Confirm new password</span>
                  <input
                    className="input"
                    type="password"
                    minLength={MIN_PASSWORD}
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    autoComplete="new-password"
                    required
                  />
                </label>
                <p className="landing-hint">
                  Pick something you don't use elsewhere. The link is single-use and expires in an hour, so a copy of
                  this email isn't enough to break in once you've reset.
                </p>
                {error && <Banner kind="bad">{error}</Banner>}
                <Btn type="submit" kind="primary" full disabled={busy || !parsed.access_token}>
                  {busy ? "Updating…" : "Update password"}
                </Btn>
                <div className="landing-auth-foot">
                  <button type="button" className="link-btn" onClick={() => { window.location.hash = "#/landing"; }}>
                    Back to sign-in
                  </button>
                </div>
              </form>
            </Card>
          </div>
        </section>
      </main>
    </div>
  );
};

export default ResetPassword;
