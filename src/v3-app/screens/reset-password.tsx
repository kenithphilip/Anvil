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
import { ObaraBackend } from "../lib/api";

const MIN_PASSWORD = 10;

const parseRecoveryToken = (): { access_token: string | null; type: string | null; error: string | null } => {
  // Supabase recovery links put params in the fragment after the
  // hash route, e.g. #/reset#access_token=...&type=recovery .
  // We accept either an embedded fragment or a "?access_token=..."
  // query. URLSearchParams handles both transparently when we
  // strip the leading char.
  if (typeof window === "undefined") return { access_token: null, type: null, error: null };
  const raw = window.location.hash || "";
  // Drop the route prefix (#/reset). Anything after the next # or ?
  // is the param payload.
  const tail = raw.replace(/^#\/?reset/, "").replace(/^[?#]/, "");
  if (!tail) {
    // Token might be in the search string for some hosts.
    const search = window.location.search.replace(/^\?/, "");
    if (!search) return { access_token: null, type: null, error: null };
    const params = new URLSearchParams(search);
    return {
      access_token: params.get("access_token"),
      type: params.get("type"),
      error: params.get("error_description") || params.get("error"),
    };
  }
  const params = new URLSearchParams(tail);
  return {
    access_token: params.get("access_token"),
    type: params.get("type"),
    error: params.get("error_description") || params.get("error"),
  };
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
    // route directly; bounce them to the landing sign-in tab.
    if (!parsed.access_token && !parsed.error) {
      const t = setTimeout(() => { window.location.hash = "#/landing"; }, 1500);
      return () => clearTimeout(t);
    }
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
      const cfg = (ObaraBackend?.getConfig?.() || {}) as { url?: string };
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
                <Banner kind="info">No recovery token found. Redirecting to sign-in…</Banner>
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
