// Sign-in / sign-up / magic-link screen.
//
// Until 2026-05 the auth widget lived inline in the hero of
// `landing.tsx`. The Landing.html design package ships a full-bleed
// marketing landing with no inline auth, so we extracted the full
// auth flow into this dedicated route.
//
// Three flows live here:
//   1. Sign in with email + password (existing returning user).
//   2. Sign up with email + password + display name (creates a
//      tenant membership; backend assigns a default role that an
//      admin can promote later).
//   3. Magic link (passwordless, server emails a one-time URL).
//
// All three call into the existing /api/auth/* endpoints. On
// success we persist the session via ObaraBackend.setSession and
// the App's auth-gate effect routes the user onward.

import React, { useEffect, useState } from "react";
import { Banner, Btn, Card } from "../lib/primitives";
import { ObaraBackend } from "../lib/api";
import { lsGet, lsSet, lsRemove } from "../lib/storage-keys";

type Mode = "signin" | "signup" | "magic";

const REQUESTABLE_ROLES = [
  { id: "sales_engineer",  label: "Sales engineer (default)" },
  { id: "sales_manager",   label: "Sales manager" },
  { id: "procurement",     label: "Procurement" },
  { id: "finance",         label: "Finance" },
  { id: "viewer",          label: "Read-only viewer" },
];

const SignInScreen: React.FC = () => {
  const cfgRef = (ObaraBackend?.getConfig?.() || {}) as { url?: string; tenantId?: string | null };
  // Default the Backend URL to the page's own origin when nothing is
  // configured. The deployed Vercel host serves both the static
  // frontend and the /api/* endpoints, so this is correct ~99% of the
  // time. Local dev (vite on :5180 talking to a separate API) can
  // still override via the Advanced toggle.
  const defaultUrl = cfgRef.url || (typeof window !== "undefined" ? window.location.origin : "");
  const [mode, setMode] = useState<Mode>("signin");
  const [url, setUrl] = useState<string>(defaultUrl);
  const [tenantId, setTenantId] = useState<string>(cfgRef.tenantId || "");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [requestedRole, setRequestedRole] = useState<string>("sales_engineer");
  const [signupNotes, setSignupNotes] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: "good" | "bad" | "live" | "pending" | "info"; text: string } | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(!cfgRef.url);
  const [pendingFor, setPendingFor] = useState<string | null>(null);
  const [mfaFor, setMfaFor] = useState<string | null>(null);
  const [totpCode, setTotpCode] = useState("");

  const persistConfig = () => {
    try {
      ObaraBackend?.setConfig?.({
        url: (url || "").trim().replace(/\/+$/, ""),
        tenantId: (tenantId || "").trim() || null,
      });
    } catch (_) { /* swallow; setSession will surface a real error */ }
  };

  // Persist the auto-defaulted Backend URL on mount so the very first
  // submit (signup / signin / magic-link) doesn't fail with "Backend
  // URL is required". Without this, defaultUrl populated state but the
  // ObaraBackend client still reported no config.
  useEffect(() => {
    if (!cfgRef.url && url) persistConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const goAfterAuth = () => {
    let target = "#/home";
    try {
      const stored = lsGet("v3_intended_route");
      if (stored && stored !== "#/connect" && stored !== "#/landing" && stored !== "#/signin" && stored !== "#") {
        target = stored;
      }
      lsRemove("v3_intended_route");
    } catch (_) { /* ignore */ }
    window.location.hash = target;
  };

  const onSignIn = async () => {
    setStatus(null);
    if (!email || !password) {
      setStatus({ kind: "bad", text: "Email and password are required." });
      return;
    }
    if (!url) {
      setStatus({ kind: "bad", text: "Backend URL is required. Open Advanced to set it." });
      setShowAdvanced(true);
      return;
    }
    setBusy(true);
    persistConfig();
    try {
      const resp: any = await ObaraBackend?.auth?.passwordLogin?.(email.trim(), password);
      if (resp?.mfa_required) {
        setMfaFor(email);
        setStatus({ kind: "info", text: "Enter the 6-digit code from your authenticator." });
        return;
      }
      const accessToken = resp?.session?.access_token || resp?.access_token;
      if (!accessToken) throw new Error("No access token returned");
      ObaraBackend?.setSession?.({
        access_token: accessToken,
        refresh_token: resp?.session?.refresh_token || resp?.refresh_token,
        expires_at: resp?.session?.expires_at || resp?.expires_at,
      });
      try { lsSet("auth_profile", JSON.stringify({ user: resp.user })); } catch (_) {}
      setStatus({ kind: "good", text: "Signed in. Redirecting…" });
      window.notifySuccess?.("Welcome back", resp.user?.email || email);
      setTimeout(goAfterAuth, 400);
    } catch (err: any) {
      const errCode = err?.body?.error?.code || "";
      if (errCode === "MEMBERSHIP_PENDING") {
        setStatus({ kind: "pending", text: err.body.error.message || "Your account is pending admin approval." });
        setPendingFor(email);
      } else if (errCode === "MEMBERSHIP_DENIED") {
        setStatus({ kind: "bad", text: err.body.error.message || "Your access request was denied." });
      } else if (errCode === "MEMBERSHIP_DEACTIVATED") {
        setStatus({ kind: "bad", text: err.body.error.message || "Your account has been deactivated." });
      } else {
        setStatus({ kind: "bad", text: err?.message || "Sign-in failed" });
        window.notifyError?.("Sign-in failed", err?.message || String(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const onSignUp = async () => {
    setStatus(null);
    if (!email || !password) { setStatus({ kind: "bad", text: "Email and password are required." }); return; }
    if (password.length < 10) { setStatus({ kind: "bad", text: "Password must be at least 10 characters." }); return; }
    if (!displayName.trim()) { setStatus({ kind: "bad", text: "Please enter your full name so the admin reviewing your request can identify you." }); return; }
    if (!url) { setStatus({ kind: "bad", text: "Backend URL is required. Open Advanced to set it." }); setShowAdvanced(true); return; }
    setBusy(true);
    persistConfig();
    try {
      const resp: any = await ObaraBackend?.auth?.signup?.({
        email: email.trim(),
        password,
        display_name: displayName.trim() || null,
        requested_role: requestedRole || null,
        notes: signupNotes.trim() || null,
      });
      const accessToken = resp?.session?.access_token || resp?.access_token;
      if (resp?.status === "pending") {
        setPendingFor(email);
        setStatus({ kind: "pending", text: resp?.message || "Your access request has been submitted. An admin will review it; you'll be able to sign in once approved." });
        window.notifySuccess?.("Request submitted", "Pending admin approval");
        setPassword("");
        return;
      }
      if (accessToken) {
        ObaraBackend?.setSession?.({
          access_token: accessToken,
          refresh_token: resp?.session?.refresh_token || resp?.refresh_token,
          expires_at: resp?.session?.expires_at || resp?.expires_at,
        });
        try { lsSet("auth_profile", JSON.stringify({ user: resp.user })); } catch (_) {}
        setStatus({ kind: "good", text: "Account created. Redirecting…" });
        window.notifySuccess?.("Welcome to Anvil", resp.user?.email || email);
        setTimeout(goAfterAuth, 400);
        return;
      }
      setStatus({ kind: "good", text: resp?.message || "Account created. Check your email to confirm, then sign in." });
      setMode("signin");
    } catch (err: any) {
      setStatus({ kind: "bad", text: err?.message || "Sign-up failed" });
      window.notifyError?.("Sign-up failed", err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const onSignInWithPasskey = async () => {
    setStatus(null);
    if (!email.trim()) { setStatus({ kind: "bad", text: "Type your email so we know which account to sign in." }); return; }
    if (!url) { setStatus({ kind: "bad", text: "Backend URL is required. Open Advanced to set it." }); setShowAdvanced(true); return; }
    if (!window.PublicKeyCredential) { setStatus({ kind: "bad", text: "This browser doesn't support passkeys (WebAuthn)." }); return; }
    setBusy(true);
    persistConfig();
    try {
      const begin: any = await ObaraBackend?.auth?.passkeyAuthBegin?.(email.trim());
      const { startAuthentication } = await import("@simplewebauthn/browser");
      const assertion = await startAuthentication(begin.options);
      const resp: any = await ObaraBackend?.auth?.passkeyAuthFinish?.(email.trim(), begin.challenge_id, assertion);
      const accessToken = resp?.session?.access_token;
      if (!accessToken) throw new Error("No session returned after passkey verification");
      ObaraBackend?.setSession?.({
        access_token: accessToken,
        refresh_token: resp?.session?.refresh_token,
        expires_at: resp?.session?.expires_at,
      });
      try { lsSet("auth_profile", JSON.stringify({ user: resp.user })); } catch (_) {}
      setStatus({ kind: "good", text: "Signed in with passkey. Redirecting…" });
      window.notifySuccess?.("Welcome back", resp.user?.email || email);
      setTimeout(goAfterAuth, 400);
    } catch (err: any) {
      const errCode = err?.body?.error?.code;
      if (errCode === "MEMBERSHIP_PENDING") {
        setStatus({ kind: "pending", text: err.body.error.message });
        setPendingFor(email);
      } else if (errCode === "MEMBERSHIP_DENIED" || errCode === "MEMBERSHIP_DEACTIVATED") {
        setStatus({ kind: "bad", text: err.body.error.message });
      } else {
        setStatus({ kind: "bad", text: err?.message || "Passkey sign-in failed. Use password instead." });
      }
    } finally {
      setBusy(false);
    }
  };

  const onSubmitTotp = async () => {
    setStatus(null);
    const code = totpCode.replace(/\D/g, "");
    if (code.length !== 6) { setStatus({ kind: "bad", text: "Enter the 6-digit code from your authenticator." }); return; }
    if (!email || !password) { setStatus({ kind: "bad", text: "Session lost. Sign in again." }); setMfaFor(null); return; }
    setBusy(true);
    try {
      const resp: any = await ObaraBackend?.auth?.passwordLogin?.(email.trim(), password, code);
      const accessToken = resp?.session?.access_token || resp?.access_token;
      if (!accessToken) throw new Error("Sign-in failed after TOTP");
      ObaraBackend?.setSession?.({
        access_token: accessToken,
        refresh_token: resp?.session?.refresh_token,
        expires_at: resp?.session?.expires_at,
      });
      try { lsSet("auth_profile", JSON.stringify({ user: resp.user })); } catch (_) {}
      setStatus({ kind: "good", text: "Signed in. Redirecting…" });
      window.notifySuccess?.("Welcome back", resp.user?.email || email);
      setPassword("");
      setTotpCode("");
      setMfaFor(null);
      setTimeout(goAfterAuth, 400);
    } catch (err: any) {
      const code = err?.body?.error?.code;
      if (code === "INVALID_TOTP") {
        setStatus({ kind: "bad", text: err.body.error.message || "Two-factor code is incorrect." });
        setTotpCode("");
      } else if (code === "MEMBERSHIP_PENDING") {
        setMfaFor(null);
        setPendingFor(email);
        setStatus({ kind: "pending", text: err.body.error.message });
      } else {
        setStatus({ kind: "bad", text: err?.message || "Sign-in failed" });
      }
    } finally {
      setBusy(false);
    }
  };

  const onForgotPassword = async () => {
    setStatus(null);
    if (!email.trim()) { setStatus({ kind: "bad", text: "Type your email above and we'll send a reset link." }); return; }
    if (!url) { setStatus({ kind: "bad", text: "Backend URL is required. Open Advanced to set it." }); setShowAdvanced(true); return; }
    setBusy(true);
    persistConfig();
    try {
      const cfg = (ObaraBackend?.getConfig?.() || {}) as { url?: string };
      // Bug fix May 2026 (recovery-stuck-on-home report): point
      // Supabase at /auth/callback.html instead of /#/reset. The
      // callback page detects type=recovery, hands the token off
      // via sessionStorage, and redirects to /#/reset. Avoids the
      // double-fragment URL shape (#/reset#access_token=...) that
      // would otherwise leave the user on the home screen.
      const origin = (typeof window !== "undefined" && window.location.origin) || (cfg.url || "");
      const redirect = origin.replace(/\/+$/, "") + "/auth/callback.html";
      const resp = await fetch((cfg.url || "").replace(/\/+$/, "") + "/api/auth/request_reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), redirect_to: redirect }),
      });
      const body = await resp.json().catch(() => null);
      if (!resp.ok) {
        setStatus({ kind: "bad", text: body?.error?.message || "Could not send reset email." });
        return;
      }
      setStatus({ kind: "good", text: body?.message || "If an account exists for that address, a reset email has been sent." });
      if (body?.dev_action_link) {
        window.notifySuccess?.("Reset link generated", "Check your inbox or use the dev link in the response.");
      } else {
        window.notifySuccess?.("Email sent", "Check your inbox for the reset link.");
      }
    } catch (err: any) {
      setStatus({ kind: "bad", text: err?.message || "Could not request reset." });
    } finally {
      setBusy(false);
    }
  };

  const onMagicLink = async () => {
    setStatus(null);
    if (!email) { setStatus({ kind: "bad", text: "Email is required." }); return; }
    if (!url) { setStatus({ kind: "bad", text: "Backend URL is required. Open Advanced to set it." }); setShowAdvanced(true); return; }
    setBusy(true);
    persistConfig();
    try {
      const redirect = (url || "").trim().replace(/\/+$/, "") + "/auth/callback.html";
      await ObaraBackend?.auth?.requestMagicLink?.(email.trim(), redirect);
      setStatus({ kind: "good", text: "Magic link sent. Check your inbox." });
      window.notifySuccess?.("Magic link sent", email);
    } catch (err: any) {
      setStatus({ kind: "bad", text: err?.message || "Could not send magic link" });
      window.notifyError?.("Magic link failed", err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = (ev: React.FormEvent) => {
    ev.preventDefault();
    if (busy) return;
    if (mfaFor) { onSubmitTotp(); return; }
    if (mode === "signin") onSignIn();
    else if (mode === "signup") onSignUp();
    else onMagicLink();
  };

  return (
    <div className="signin-screen">
      <a className="skip-link" href="#auth-card">Skip to sign-in form</a>
      <header className="signin-head">
        <a href="#/landing" className="signin-brand" aria-label="Anvil — back to landing">
          <svg width="24" height="24" viewBox="0 0 32 32" role="img" aria-hidden="true">
            <path fill="currentColor" d="M 6 12 L 1 12 L 4 9 L 9 9 L 9 7 L 26 7 L 26 12 L 22 12 L 21 16 L 24 16 L 24 19 L 22 19 L 22 23 L 28 23 L 28 26 L 4 26 L 4 23 L 10 23 L 10 19 L 8 19 L 8 16 L 11 16 Z" />
            <g transform="translate(20.5 5.5)">
              <path fill="var(--accent)" stroke="currentColor" strokeWidth="0.6" strokeLinejoin="miter" d="M 0 -4 L 0.9 -0.9 L 4 0 L 0.9 0.9 L 0 4 L -0.9 0.9 L -4 0 L -0.9 -0.9 Z" />
            </g>
          </svg>
          <span>Anvil</span>
        </a>
        <a href="#/landing" className="signin-back">&larr; Back to landing</a>
      </header>
      <main className="signin-main" id="auth-card">
        <Card className="signin-card" title={mfaFor ? "Two-factor verification" : mode === "signin" ? "Sign in to Anvil" : mode === "signup" ? "Create your account" : "Magic link"}>
          {!mfaFor && (
            <div className="signin-tabs" role="tablist" aria-label="Sign-in mode">
              {(["signin", "signup", "magic"] as const).map((m) => (
                <button
                  key={m}
                  role="tab"
                  type="button"
                  aria-selected={mode === m}
                  className={"signin-tab" + (mode === m ? " active" : "")}
                  onClick={() => { setMode(m); setStatus(null); }}
                >
                  {m === "signin" ? "Sign in" : m === "signup" ? "Sign up" : "Magic link"}
                </button>
              ))}
            </div>
          )}

          <form onSubmit={onSubmit} className="signin-form">
            {mfaFor ? (
              <>
                <label className="signin-field">
                  <span>Two-factor code</span>
                  <input
                    className="input"
                    type="text"
                    inputMode="numeric"
                    autoFocus
                    maxLength={6}
                    pattern="\d{6}"
                    placeholder="123456"
                    value={totpCode}
                    onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    autoComplete="one-time-code"
                    style={{ letterSpacing: "0.4em", fontFamily: "var(--mono)", fontSize: 18, textAlign: "center" }}
                  />
                </label>
                <p className="signin-hint">
                  Open Authy / Google Authenticator / 1Password and copy the current 6-digit code for
                  <strong> {mfaFor}</strong>. Codes refresh every 30 seconds.
                </p>
              </>
            ) : (
              <>
                {mode === "signup" && (
                  <label className="signin-field">
                    <span>Display name</span>
                    <input
                      className="input"
                      type="text"
                      placeholder="Jane Distributor"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      autoComplete="name"
                    />
                  </label>
                )}
                <label className="signin-field">
                  <span>Email</span>
                  <input
                    className="input"
                    type="email"
                    required
                    placeholder="you@company.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="email"
                  />
                </label>
                {mode !== "magic" && (
                  <label className="signin-field">
                    <span>Password</span>
                    <input
                      className="input"
                      type="password"
                      required
                      minLength={mode === "signup" ? 10 : undefined}
                      placeholder={mode === "signup" ? "min 10 chars" : "••••••••"}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoComplete={mode === "signup" ? "new-password" : "current-password"}
                    />
                  </label>
                )}
                {mode === "signup" && (
                  <>
                    <label className="signin-field">
                      <span>Requested role</span>
                      <select className="input" value={requestedRole} onChange={(e) => setRequestedRole(e.target.value)}>
                        {REQUESTABLE_ROLES.map((r) => (
                          <option key={r.id} value={r.id}>{r.label}</option>
                        ))}
                      </select>
                    </label>
                    <label className="signin-field">
                      <span>Why you need access (optional)</span>
                      <textarea
                        className="input"
                        rows={2}
                        placeholder="e.g. New hire on the inside-sales team. Manager: Priya."
                        value={signupNotes}
                        onChange={(e) => setSignupNotes(e.target.value.slice(0, 500))}
                      />
                    </label>
                    <p className="signin-hint">
                      A tenant admin reviews every new request before granting access. You'll be able to sign in once
                      they approve. Admins may also adjust the role you requested.
                    </p>
                  </>
                )}
                <button
                  type="button"
                  className="signin-advanced-toggle"
                  onClick={() => setShowAdvanced((v) => !v)}
                  aria-expanded={showAdvanced}
                >
                  {showAdvanced ? "Hide advanced" : "Advanced (backend URL, tenant ID)"}
                </button>
                {showAdvanced && (
                  <>
                    <label className="signin-field">
                      <span>Backend URL</span>
                      <input className="input" type="url" placeholder="https://anvil.example.com" value={url} onChange={(e) => setUrl(e.target.value)} />
                    </label>
                    <label className="signin-field">
                      <span>Tenant ID (optional)</span>
                      <input className="input" type="text" placeholder="tenant uuid" value={tenantId} onChange={(e) => setTenantId(e.target.value)} />
                    </label>
                  </>
                )}
              </>
            )}

            {status && status.kind !== "pending" && (
              <Banner kind={status.kind === "good" ? "good" : status.kind === "bad" ? "bad" : "info"}>
                {status.text}
              </Banner>
            )}

            {status?.kind === "pending" && (
              <div className="signin-pending">
                <div className="signin-pending-icon" aria-hidden="true">⌛</div>
                <div className="signin-pending-title">Pending admin approval</div>
                <p>{status.text}</p>
                {pendingFor && (
                  <p className="signin-pending-meta">
                    Request linked to <strong>{pendingFor}</strong>. We'll send you an email once you're approved.
                    You can close this tab.
                  </p>
                )}
                <div className="row gap-sm" style={{ marginTop: 12, justifyContent: "center" }}>
                  <Btn sm kind="ghost" onClick={() => { setStatus(null); setPendingFor(null); setMode("signin"); }}>
                    Back to sign-in
                  </Btn>
                </div>
              </div>
            )}

            {status?.kind !== "pending" && (
              <Btn type="submit" kind="primary" full disabled={busy || (!!mfaFor && totpCode.length !== 6)}>
                {busy ? "Working…"
                  : mfaFor ? "Verify code"
                  : mode === "signin" ? "Sign in"
                  : mode === "signup" ? "Create account"
                  : "Send magic link"}
              </Btn>
            )}
            {!mfaFor && mode === "signin" && status?.kind !== "pending" && (
              <Btn type="button" kind="ghost" full disabled={busy} onClick={onSignInWithPasskey}
                   title="Use a passkey (TouchID, FaceID, Windows Hello, hardware key) instead of your password.">
                Sign in with passkey
              </Btn>
            )}
            {mfaFor && (
              <div className="signin-foot">
                <button type="button" className="link-btn" onClick={() => { setMfaFor(null); setTotpCode(""); setStatus(null); }}>
                  Cancel and sign in as a different user
                </button>
              </div>
            )}

            <div className="signin-foot">
              {mode === "signin" && <>
                New to Anvil? <button type="button" className="link-btn" onClick={() => setMode("signup")}>Create an account</button>
                <span style={{ margin: "0 8px", color: "var(--ink-5)" }}>·</span>
                <button type="button" className="link-btn" onClick={onForgotPassword} disabled={busy}>
                  Forgot password?
                </button>
              </>}
              {mode === "signup" && <>Already have an account? <button type="button" className="link-btn" onClick={() => setMode("signin")}>Sign in</button></>}
              {mode === "magic" && <>Or use <button type="button" className="link-btn" onClick={() => setMode("signin")}>password sign-in</button></>}
            </div>
          </form>
        </Card>
        <p className="signin-trust">
          SOC 2 in progress · ISO 27001 in progress · RLS on every table · AES-256-GCM at rest · HMAC-signed audit export · PII redaction always-on.
        </p>
      </main>
    </div>
  );
};

export default SignInScreen;
