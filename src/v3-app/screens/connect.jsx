import React, { useEffect, useState } from "react";
import { Banner, Btn, Card, KV, WSTitle } from "../lib/primitives.jsx";
import { Icon } from "../lib/icons.jsx";
import { ObaraBackend } from "../lib/api.js";
import { RBAC } from "../lib/rbac.js";
import { Prefs } from "../lib/preferences.js";

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
  const [tab, setTab] = uS("magic");
  const [email, setEmail] = uS("");
  const [token, setToken] = uS(session.access_token || "");
  const [status, setStatus] = uS({ kind: "", text: "" });
  const [signedIn, setSignedIn] = uS(!!(ObaraBackend?.isReady?.()));

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
            <Btn sm kind={tab === "magic" ? "primary" : "ghost"} onClick={() => setTab("magic")}>Magic link</Btn>
            <Btn sm kind={tab === "dev" ? "primary" : "ghost"} onClick={() => setTab("dev")}>Dev token</Btn>
            {signedIn && (
              <span style={{ marginLeft: "auto" }}>
                <Btn sm kind="ghost" onClick={goToIntendedOrHome}>{Icon.arrowR} Continue to app</Btn>
              </span>
            )}
          </div>

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
                Click the link in the email. The callback page (auth/callback.html) stores the access
                token in localStorage. Refresh this page to pick up the session.
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
                <span className="mono-sm">Production users sign in via magic link. This pane exists for headless test rigs.</span>
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
