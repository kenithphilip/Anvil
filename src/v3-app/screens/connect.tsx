import React, { useEffect, useState } from "react";
import { Banner, Btn, Card, KV, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { ObaraBackend } from "../lib/api";
import { RBAC } from "../lib/rbac";
import { Prefs } from "../lib/preferences";

// ============================================================
// ANVIL v3 — Backend connect (sign-in / config)
// Shipped as a dedicated route at #/connect AND as a modal that
// auto-opens when ObaraBackend.isReady() is false on first load.
// Migrates the legacy showBackendModal flow.
// ============================================================

const WiredBackendConnect = () => {
  const { useState: uS, useEffect: uE } = React;
  const cfg = (ObaraBackend && ObaraBackend.getConfig && ObaraBackend.getConfig()) || {};
  const session = (ObaraBackend && ObaraBackend.getSession && ObaraBackend.getSession()) || {};
  const [url, setUrl] = uS(cfg.url || "");
  const [tenantId, setTenantId] = uS(cfg.tenantId || "");
  const [tab, setTab] = uS("signup");
  const [email, setEmail] = uS("");
  const [password, setPassword] = uS("");
  const [signupName, setSignupName] = uS("");
  const [token, setToken] = uS(session.access_token || "");
  const [status, setStatus] = uS({ kind: "", text: "" });
  const [busy, setBusy] = uS(false);
  const [signedIn, setSignedIn] = uS(!!(ObaraBackend?.isReady?.() && session.access_token));

  uE(() => {
    const onChange = () => setSignedIn(!!(ObaraBackend?.isReady?.()));
    window.addEventListener("storage", onChange);
    return () => window.removeEventListener("storage", onChange);
  }, []);

  // Navigate the user back to where they were trying to go before the
  // /connect redirect kicked in. Falls back to /home for first-run.
  const goToIntendedOrHome = () => {
    let target = "#/home";
    try {
      const stored = localStorage.getItem("obara:v3_intended_route");
      if (stored && stored !== "#/connect" && stored !== "#/" && stored !== "#") {
        target = stored;
      }
      localStorage.removeItem("obara:v3_intended_route");
    } catch (_) {}
    window.location.hash = target;
  };

  const saveAndTest = async () => {
    try {
      ObaraBackend?.setConfig?.({ url: url.trim().replace(/\/+$/, ""), tenantId: tenantId.trim() || null });
      if (token.trim()) {
        ObaraBackend?.setSession?.({ access_token: token.trim() });
        setStatus({ kind: "live", text: "Verifying access token…" });
        const verified = await ObaraBackend.auth.verifyToken(token.trim());
        try { localStorage.setItem("obara:auth_profile", JSON.stringify(verified)); } catch (_) {}
        setStatus({ kind: "good", text: "Signed in as " + (verified.user?.email || verified.user?.id || "user") });
        setSignedIn(true);
        window.notifySuccess?.("Signed in", verified.user?.email || verified.user?.id || "Welcome.");
        // Brief pause so the user sees the success state, then route.
        setTimeout(goToIntendedOrHome, 600);
      } else {
        setStatus({ kind: "good", text: "Saved. Backend at " + url });
        window.notifySuccess?.("Backend saved", url.trim());
      }
    } catch (err) {
      setStatus({ kind: "bad", text: "Failed: " + (err?.message || String(err)) });
      window.notifyError?.("Sign-in failed", err?.message || String(err));
    }
  };

  const sendMagic = async () => {
    if (!email.trim()) { setStatus({ kind: "bad", text: "Email is required." }); return; }
    if (!url.trim()) { setStatus({ kind: "bad", text: "Backend URL is required first." }); return; }
    setStatus({ kind: "live", text: "Sending magic link…" });
    try {
      ObaraBackend?.setConfig?.({ url: url.trim().replace(/\/+$/, ""), tenantId: tenantId.trim() || null });
      const redirect = url.trim().replace(/\/+$/, "") + "/auth/callback.html";
      await ObaraBackend.auth.requestMagicLink(email.trim(), redirect);
      setStatus({ kind: "good", text: "Magic link sent to " + email.trim() + ". Check your inbox." });
    } catch (err) {
      setStatus({ kind: "bad", text: "Magic link failed: " + (err?.message || String(err)) });
    }
  };

  // Self-serve account creation. The endpoint creates the user with
  // email_confirm:true, auto-onboards the tenant_members row, and
  // returns a fresh session so we can sign the user in immediately.
  const signUp = async () => {
    const e = email.trim();
    const p = password;
    const n = signupName.trim();
    if (!e || !p || !n) { setStatus({ kind: "bad", text: "Email, password, and name are required." }); return; }
    if (p.length < 8) { setStatus({ kind: "bad", text: "Password must be at least 8 characters." }); return; }
    if (!url.trim()) { setStatus({ kind: "bad", text: "Backend URL is required first." }); return; }
    setBusy(true);
    setStatus({ kind: "live", text: "Creating your account…" });
    try {
      ObaraBackend?.setConfig?.({ url: url.trim().replace(/\/+$/, ""), tenantId: tenantId.trim() || null });
      const resp = await ObaraBackend.auth.signup({ email: e, password: p, display_name: n });
      const sess = resp?.session;
      if (!sess?.access_token) throw new Error("Signup did not return a session");
      ObaraBackend?.setSession?.({
        access_token: sess.access_token,
        refresh_token: sess.refresh_token,
        expires_at: sess.expires_at,
        user: resp.user,
      });
      try { localStorage.setItem("obara:auth_profile", JSON.stringify({ user: resp.user, memberships: [] })); } catch (_) {}
      setStatus({ kind: "good", text: "Welcome, " + n + "! Routing you in…" });
      setSignedIn(true);
      window.notifySuccess?.("Account created", "Welcome, " + n + ".");
      setPassword("");
      setTimeout(goToIntendedOrHome, 600);
    } catch (err) {
      setStatus({ kind: "bad", text: "Sign-up failed: " + (err?.message || String(err)) });
      window.notifyError?.("Sign-up failed", err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const passwordLogin = async () => {
    const e = email.trim();
    const p = password;
    if (!e || !p) { setStatus({ kind: "bad", text: "Email and password are required." }); return; }
    if (!url.trim()) { setStatus({ kind: "bad", text: "Backend URL is required first." }); return; }
    setBusy(true);
    setStatus({ kind: "live", text: "Signing in…" });
    try {
      ObaraBackend?.setConfig?.({ url: url.trim().replace(/\/+$/, ""), tenantId: tenantId.trim() || null });
      const resp = await ObaraBackend.auth.passwordLogin(e, p);
      const sess = resp?.session;
      if (!sess?.access_token) throw new Error("Sign-in did not return a session");
      ObaraBackend?.setSession?.({
        access_token: sess.access_token,
        refresh_token: sess.refresh_token,
        expires_at: sess.expires_at,
        user: resp.user,
      });
      try { localStorage.setItem("obara:auth_profile", JSON.stringify({ user: resp.user, memberships: [] })); } catch (_) {}
      setStatus({ kind: "good", text: "Signed in. Routing you in…" });
      setSignedIn(true);
      window.notifySuccess?.("Signed in", resp.user?.display_name || resp.user?.email || "Welcome.");
      setPassword("");
      setTimeout(goToIntendedOrHome, 600);
    } catch (err) {
      const msg = err?.message || String(err);
      setStatus({ kind: "bad", text: /credentials/i.test(msg) ? "Wrong email or password." : ("Sign-in failed: " + msg) });
    } finally {
      setBusy(false);
    }
  };

  const signOut = () => {
    try {
      ObaraBackend?.setSession?.(null);
      localStorage.removeItem("obara:auth_profile");
    } catch (_) {}
    setToken("");
    setSignedIn(false);
    setStatus({ kind: "good", text: "Signed out." });
  };

  const profile = (() => { try { return JSON.parse(localStorage.getItem("obara:auth_profile") || "null"); } catch { return null; } })();

  return (
    <>
      <WSTitle
        eyebrow="Admin · Sign in"
        title="Backend connection"
        meta={signedIn ? "Connected" : "Not connected"}
      />
      <div className="ws-content">
        {signedIn && profile?.user && (
          <Banner kind="good" icon={Icon.shieldCheck} title={"Signed in as " + (profile.user.email || profile.user.id)}
                  action={<Btn sm onClick={signOut}>Sign out</Btn>}>
            <span className="mono-sm">
              {profile.memberships ? `${profile.memberships.length} tenant membership${profile.memberships.length === 1 ? "" : "s"}` : ""}
            </span>
          </Banner>
        )}

        <Card title="Backend URL + Tenant" eyebrow="step 1">
          <div className="form-grid">
            <div>
              <label htmlFor="be-url" className="label">Backend URL</label>
              <input id="be-url" className="input mono" placeholder="https://obara-ops.vercel.app"
                     value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Backend URL" />
              <div className="fieldnote">Vercel deploy URL, no trailing slash. The same origin serves the API and the static app.</div>
            </div>
            <div>
              <label htmlFor="be-tenant" className="label">Tenant ID</label>
              <input id="be-tenant" className="input mono" placeholder="00000000-0000-0000-0000-000000000001"
                     value={tenantId} onChange={(e) => setTenantId(e.target.value)} aria-label="Tenant ID" />
              <div className="fieldnote">UUID of the tenant row in `tenants`. Defaults to the demo tenant if empty.</div>
            </div>
          </div>
        </Card>

        <Card title={signedIn ? "Sign in (already authenticated)" : "Sign in"}
              eyebrow={signedIn ? "step 2 · re-auth or stay signed in" : "step 2 · pick one"}>
          <div className="row" style={{ gap: 6, marginBottom: 12 }}>
            <Btn sm kind={tab === "signup" ? "primary" : "ghost"} onClick={() => setTab("signup")}>Create account</Btn>
            <Btn sm kind={tab === "login" ? "primary" : "ghost"} onClick={() => setTab("login")}>Sign in</Btn>
            <Btn sm kind={tab === "magic" ? "primary" : "ghost"} onClick={() => setTab("magic")}>Magic link</Btn>
            <Btn sm kind={tab === "dev" ? "primary" : "ghost"} onClick={() => setTab("dev")}>Dev token</Btn>
            {signedIn && (
              <span style={{ marginLeft: "auto" }}>
                <Btn sm kind="ghost" onClick={goToIntendedOrHome}>{Icon.arrowR} Continue to app</Btn>
              </span>
            )}
          </div>

          {tab === "signup" && (
            <div>
              <label htmlFor="su-name" className="label">Your name</label>
              <input id="su-name" type="text" className="input" placeholder="Kenith Philip"
                     value={signupName} onChange={(e) => setSignupName(e.target.value)} aria-label="Display name"
                     autoComplete="name" />
              <label htmlFor="su-email" className="label" style={{ marginTop: 10 }}>Email</label>
              <input id="su-email" type="email" className="input" placeholder="you@example.com"
                     value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Email"
                     autoComplete="email" />
              <label htmlFor="su-pwd" className="label" style={{ marginTop: 10 }}>Password</label>
              <input id="su-pwd" type="password" className="input" placeholder="at least 8 characters"
                     value={password} onChange={(e) => setPassword(e.target.value)} aria-label="Password"
                     autoComplete="new-password" minLength={8} />
              <div className="fieldnote" style={{ marginTop: 6 }}>
                Stored hashed by Supabase Auth. You can change it later from Admin Center, My Profile.
              </div>
              <div className="row" style={{ marginTop: 12, gap: 8 }}>
                <Btn kind="primary" onClick={signUp} disabled={busy}>{busy ? "creating…" : <>{Icon.plus} Create account</>}</Btn>
                <Btn kind="ghost" onClick={() => setTab("login")}>Already have one?</Btn>
              </div>
            </div>
          )}

          {tab === "login" && (
            <div>
              <label htmlFor="li-email" className="label">Email</label>
              <input id="li-email" type="email" className="input" placeholder="you@example.com"
                     value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Email"
                     autoComplete="email" />
              <label htmlFor="li-pwd" className="label" style={{ marginTop: 10 }}>Password</label>
              <input id="li-pwd" type="password" className="input"
                     value={password} onChange={(e) => setPassword(e.target.value)} aria-label="Password"
                     autoComplete="current-password" />
              <div className="row" style={{ marginTop: 12, gap: 8 }}>
                <Btn kind="primary" onClick={passwordLogin} disabled={busy}>{busy ? "signing in…" : <>{Icon.shieldCheck} Sign in</>}</Btn>
                <Btn kind="ghost" onClick={() => setTab("magic")}>Forgot password? Use magic link</Btn>
              </div>
            </div>
          )}

          {tab === "magic" && (
            <div>
              <label htmlFor="be-email" className="label">Email</label>
              <input id="be-email" type="email" className="input" placeholder="you@example.com"
                     value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Email" />
              <div className="row" style={{ marginTop: 12, gap: 8 }}>
                <Btn kind="primary" onClick={sendMagic}>{Icon.send} Send magic link</Btn>
                <Btn kind="ghost" onClick={saveAndTest}>Save URL only</Btn>
              </div>
              <div className="fieldnote" style={{ marginTop: 10 }}>
                We email you a one-time link. Click it to sign in. Requires SMTP configured in Supabase
                (or RESEND_API_KEY); use Create account if SMTP is unset.
              </div>
            </div>
          )}

          {tab === "dev" && (
            <div>
              <label htmlFor="be-token" className="label">Access token</label>
              <textarea id="be-token" className="input mono" rows={4}
                        placeholder="Paste a Supabase access token"
                        value={token} onChange={(e) => setToken(e.target.value)}
                        aria-label="Supabase access token"
                        style={{ fontSize: 11 }} />
              <Banner kind="warn" icon={Icon.alert} title="Dev only">
                <span className="mono-sm">Production users sign in via Create account or Sign in. This pane exists for headless test rigs.</span>
              </Banner>
              <div className="row" style={{ marginTop: 12, gap: 8 }}>
                <Btn kind="primary" onClick={saveAndTest}>Save and verify</Btn>
                {signedIn && <Btn kind="danger" onClick={signOut}>Sign out</Btn>}
              </div>
            </div>
          )}

          {status.text && (
            <div className="mono-sm" style={{
              marginTop: 12,
              color: status.kind === "bad" ? "var(--rust)" : status.kind === "good" ? "var(--sage)" : "var(--ink-3)",
            }}>
              {status.text}
            </div>
          )}
        </Card>

        <Card title="Live status" eyebrow="ping">
          <KV rows={[
            ["Backend URL", cfg.url || "(not set)"],
            ["Tenant ID", cfg.tenantId || "(not set)"],
            ["Session", signedIn ? "live" : "anonymous"],
            ["Theme", Prefs?.theme() || "—"],
            ["Role", (RBAC?.role() || "—").replace(/_/g, " ")],
          ]} />
        </Card>
      </div>
    </>
  );
};


export default WiredBackendConnect;
