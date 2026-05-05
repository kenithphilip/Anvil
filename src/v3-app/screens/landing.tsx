// Landing + sign-in / sign-up surface.
//
// Rendered by App.tsx whenever the auth gate decides the visitor is
// not authenticated. Replaces the bare /connect screen as the first
// page a new user sees so they get product context (what Anvil
// does, who it's for, what's behind the login) before being asked
// for credentials.
//
// Three auth flows live here:
//   1. Sign in with email + password (existing returning user).
//   2. Sign up with email + password + display name (creates a
//      tenant membership; the backend assigns a default role
//      that an admin can promote later).
//   3. Magic link (passwordless, server emails a one-time URL).
//
// All three call into the existing /api/auth/* endpoints; the
// landing page is purely the UI gate. On success we persist the
// session via ObaraBackend.setSession and let the App's
// auth-gate effect route the user onward.

import React, { useEffect, useMemo, useState } from "react";
import { Banner, Btn, Card } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { ObaraBackend } from "../lib/api";
import { lsGet, lsSet, lsRemove } from "../lib/storage-keys";

type Mode = "signin" | "signup" | "magic";

const FEATURES = [
  {
    title: "Quote, push, reconcile",
    body: "PO in by email or upload, AI extracts the lines, the operator approves, and the order pushes to your ERP. Reconciles back when the dispatch is recorded.",
  },
  {
    title: "Connectors that don't lie",
    body: "NetSuite, SAP, Dynamics 365, Acumatica, Prophet 21, Eclipse, Infor SX.e, Tally, Sage X3 plus PLM (Windchill, Arena). Every push has retry + audit; every sync has a high-water cursor.",
  },
  {
    title: "Multi-channel intake",
    body: "Email, WhatsApp, Slack, Teams, voice. Customers reach you the way they want; Anvil normalises every conversation into the same intake row.",
  },
  {
    title: "Auditable, by design",
    body: "Every extraction has citations. Every approval has a payload hash. Every push has a retry log. SOC 2 ready.",
  },
];

const VALUE_PROPS = [
  "Capture: PO + email + WhatsApp + voice in one inbox.",
  "Validate: AI extracts and reconciles against your master data.",
  "Approve: thresholds, role gates, audit trail.",
  "Push: native ERP connectors with retry + reverse sync.",
];

const REQUESTABLE_ROLES = [
  { id: "sales_engineer",  label: "Sales engineer (default)" },
  { id: "sales_manager",   label: "Sales manager" },
  { id: "procurement",     label: "Procurement" },
  { id: "finance",         label: "Finance" },
  { id: "viewer",          label: "Read-only viewer" },
];

const Landing: React.FC = () => {
  const cfgRef = (ObaraBackend?.getConfig?.() || {}) as { url?: string; tenantId?: string | null };
  const [mode, setMode] = useState<Mode>("signin");
  const [url, setUrl] = useState<string>(cfgRef.url || "");
  const [tenantId, setTenantId] = useState<string>(cfgRef.tenantId || "");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [requestedRole, setRequestedRole] = useState<string>("sales_engineer");
  const [signupNotes, setSignupNotes] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: "good" | "bad" | "live" | "pending"; text: string } | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(!cfgRef.url);
  // Set after a successful pending signup so we can show a
  // dedicated "request received" view instead of staying on the
  // form. Cleared if the user goes back to a different mode.
  const [pendingFor, setPendingFor] = useState<string | null>(null);

  // Returning users typically have a cached backend URL. Persist
  // any change immediately so the auth call doesn't 404 on a
  // stale config.
  const persistConfig = () => {
    try {
      ObaraBackend?.setConfig?.({
        url: (url || "").trim().replace(/\/+$/, ""),
        tenantId: (tenantId || "").trim() || null,
      });
    } catch (_) { /* swallow; setSession will surface a real error */ }
  };

  // After a successful auth, hop to the route the user originally
  // wanted (saved by the App auth gate before redirecting), or
  // /home as a fallback.
  const goAfterAuth = () => {
    let target = "#/home";
    try {
      const stored = lsGet("v3_intended_route");
      if (stored && stored !== "#/connect" && stored !== "#/landing" && stored !== "#") {
        target = stored;
      }
      lsRemove("v3_intended_route");
    } catch (_) { /* ignore */ }
    // Force a hash change so App picks it up via the hashchange listener.
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
      const resp = await ObaraBackend?.auth?.passwordLogin?.(email.trim(), password);
      // The backend may return 200 with session OR a 2xx envelope
      // that the client wraps but we still need a token to proceed.
      // Use access_token from either resp.session or resp directly.
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
      // Approval-gated rejection: the server returns 403 with a
      // structured error.code starting with "MEMBERSHIP_". Render a
      // clear, sympathetic message so the user knows it isn't a
      // password problem and they don't keep retrying.
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
    if (!email || !password) {
      setStatus({ kind: "bad", text: "Email and password are required." });
      return;
    }
    if (password.length < 10) {
      setStatus({ kind: "bad", text: "Password must be at least 10 characters." });
      return;
    }
    if (!displayName.trim()) {
      setStatus({ kind: "bad", text: "Please enter your full name so the admin reviewing your request can identify you." });
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
      const resp: any = await ObaraBackend?.auth?.signup?.({
        email: email.trim(),
        password,
        display_name: displayName.trim() || null,
        requested_role: requestedRole || null,
        notes: signupNotes.trim() || null,
      });

      // Backend semantics:
      //   status:"pending" with NO session  -> approval gate is on, show pending screen.
      //   status:"approved" with session    -> first user / approval disabled, sign in immediately.
      //   legacy shape (access_token at top) -> treat as approved.
      const accessToken = resp?.session?.access_token || resp?.access_token;
      if (resp?.status === "pending") {
        setPendingFor(email);
        setStatus({
          kind: "pending",
          text: resp?.message || "Your access request has been submitted. An admin will review it; you'll be able to sign in once approved.",
        });
        window.notifySuccess?.("Request submitted", "Pending admin approval");
        // Clear the password from local state for safety; the user
        // will type it again at sign-in time once approved.
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
      // Email-confirmation path (Supabase flag turned on at the project).
      setStatus({
        kind: "good",
        text: resp?.message || "Account created. Check your email to confirm, then sign in.",
      });
      setMode("signin");
    } catch (err: any) {
      setStatus({ kind: "bad", text: err?.message || "Sign-up failed" });
      window.notifyError?.("Sign-up failed", err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const onMagicLink = async () => {
    setStatus(null);
    if (!email) {
      setStatus({ kind: "bad", text: "Email is required." });
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
    if (mode === "signin") onSignIn();
    else if (mode === "signup") onSignUp();
    else onMagicLink();
  };

  // Year for the footer. Computed at render so the page stays correct
  // across midnight without a hot reload.
  const year = new Date().getFullYear();

  return (
    <div className="landing">
      <header className="landing-head">
        <div className="landing-brand">
          <div className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M3 6h11l-2 4h6v3H8l-2 4H3l2-4H2V9h4l-3-3Z"/></svg>
          </div>
          <span>Anvil</span>
        </div>
        <nav className="landing-head-links" aria-label="primary">
          <a href="#features">Features</a>
          <a href="#how-it-works">How it works</a>
          <a href="#integrations">Integrations</a>
          <a href="#auth">Sign in</a>
        </nav>
      </header>

      <main id="main">
        <section className="landing-hero">
          <div className="landing-hero-copy">
            <div className="landing-eyebrow">Industrial sales-ops platform</div>
            <h1>Quote, push, reconcile, faster.</h1>
            <p className="landing-sub">
              Anvil is the multi-tenant sales-ops platform for industrial distributors. Capture POs from any channel,
              extract every line with auditable AI, validate against master data, push to your ERP, and reconcile when
              the goods ship. One stack. Every channel. Every connector.
            </p>
            <ul className="landing-bullets">
              {VALUE_PROPS.map((p) => (
                <li key={p}><span className="landing-bullet-dot" aria-hidden="true" />{p}</li>
              ))}
            </ul>
            <div className="landing-hero-cta">
              <a href="#auth" className="btn primary lg" style={{ textDecoration: "none" }}>Get started</a>
              <a href="#features" className="btn ghost lg" style={{ textDecoration: "none" }}>See features</a>
            </div>
          </div>

          <div id="auth" />
          <Card className="landing-auth" title={mode === "signin" ? "Sign in" : mode === "signup" ? "Create your account" : "Magic link"}>
            <div className="landing-auth-tabs" role="tablist">
              {(["signin", "signup", "magic"] as const).map((m) => (
                <button
                  key={m}
                  role="tab"
                  type="button"
                  aria-selected={mode === m}
                  className={"landing-auth-tab" + (mode === m ? " active" : "")}
                  onClick={() => { setMode(m); setStatus(null); }}
                >
                  {m === "signin" ? "Sign in" : m === "signup" ? "Sign up" : "Magic link"}
                </button>
              ))}
            </div>

            <form onSubmit={onSubmit} className="landing-auth-form">
              {mode === "signup" && (
                <label className="landing-field">
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
              <label className="landing-field">
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
                <label className="landing-field">
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
                  <label className="landing-field">
                    <span>Requested role</span>
                    <select
                      className="input"
                      value={requestedRole}
                      onChange={(e) => setRequestedRole(e.target.value)}
                    >
                      {REQUESTABLE_ROLES.map((r) => (
                        <option key={r.id} value={r.id}>{r.label}</option>
                      ))}
                    </select>
                  </label>
                  <label className="landing-field">
                    <span>Why you need access (optional)</span>
                    <textarea
                      className="input"
                      rows={2}
                      placeholder="e.g. New hire on the inside-sales team. Manager: Priya."
                      value={signupNotes}
                      onChange={(e) => setSignupNotes(e.target.value.slice(0, 500))}
                    />
                  </label>
                  <p className="landing-hint">
                    A tenant admin reviews every new request before granting access. You'll be able to sign in once
                    they approve. Admins may also adjust the role you requested.
                  </p>
                </>
              )}

              <button
                type="button"
                className="landing-advanced-toggle"
                onClick={() => setShowAdvanced((v) => !v)}
                aria-expanded={showAdvanced}
              >
                {showAdvanced ? "Hide" : "Advanced (backend URL, tenant ID)"}
              </button>
              {showAdvanced && (
                <>
                  <label className="landing-field">
                    <span>Backend URL</span>
                    <input
                      className="input"
                      type="url"
                      placeholder="https://anvil.example.com"
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                    />
                  </label>
                  <label className="landing-field">
                    <span>Tenant ID (optional)</span>
                    <input
                      className="input"
                      type="text"
                      placeholder="tenant uuid"
                      value={tenantId}
                      onChange={(e) => setTenantId(e.target.value)}
                    />
                  </label>
                </>
              )}

              {status && status.kind !== "pending" && (
                <Banner kind={status.kind === "good" ? "good" : status.kind === "bad" ? "bad" : "info"}>
                  {status.text}
                </Banner>
              )}

              {status?.kind === "pending" && (
                <div className="landing-pending">
                  <div className="landing-pending-icon" aria-hidden="true">⌛</div>
                  <div className="landing-pending-title">Pending admin approval</div>
                  <p>{status.text}</p>
                  {pendingFor && (
                    <p className="landing-pending-meta">
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
                <Btn type="submit" kind="primary" full disabled={busy}>
                  {busy ? "Working…" : mode === "signin" ? "Sign in" : mode === "signup" ? "Create account" : "Send magic link"}
                </Btn>
              )}

              <div className="landing-auth-foot">
                {mode === "signin" && <>New to Anvil? <button type="button" className="link-btn" onClick={() => setMode("signup")}>Create an account</button></>}
                {mode === "signup" && <>Already have an account? <button type="button" className="link-btn" onClick={() => setMode("signin")}>Sign in</button></>}
                {mode === "magic" && <>Or use <button type="button" className="link-btn" onClick={() => setMode("signin")}>password sign-in</button></>}
              </div>
            </form>
          </Card>
        </section>

        <section id="features" className="landing-section">
          <h2>What Anvil does</h2>
          <div className="landing-features">
            {FEATURES.map((f) => (
              <Card key={f.title} className="landing-feature">
                <div className="landing-feature-title">{f.title}</div>
                <p>{f.body}</p>
              </Card>
            ))}
          </div>
        </section>

        <section id="how-it-works" className="landing-section">
          <h2>How it works</h2>
          <ol className="landing-steps">
            <li>
              <span className="landing-step-n">1</span>
              <div>
                <strong>Capture.</strong> Connect your inbox, WhatsApp, voice number, or paste a PO.
                Anvil receives the message, extracts the buyer, the document, and the intent.
              </div>
            </li>
            <li>
              <span className="landing-step-n">2</span>
              <div>
                <strong>Validate.</strong> AI reads the PO line by line, matches against your item master,
                checks pricing against the contract, and flags mismatches with citations to the source page.
              </div>
            </li>
            <li>
              <span className="landing-step-n">3</span>
              <div>
                <strong>Approve.</strong> Thresholds + role gates make the right person sign off. The payload hash
                makes every approval auditable.
              </div>
            </li>
            <li>
              <span className="landing-step-n">4</span>
              <div>
                <strong>Push.</strong> Native ERP connectors push the order. If the ERP rejects, the retry queue
                re-tries with backoff. Reverse sync flips the local row to PAID when the ERP says so.
              </div>
            </li>
          </ol>
        </section>

        <section id="integrations" className="landing-section">
          <h2>Integrations</h2>
          <p className="landing-section-sub">
            Anvil ships with native connectors. No glue code, no flat-file drops, no manual reconciliation.
          </p>
          <div className="landing-integrations">
            <div className="landing-integration-group">
              <div className="landing-integration-h">ERPs</div>
              <ul>
                <li>NetSuite</li><li>SAP S/4HANA</li><li>Dynamics 365</li><li>Acumatica</li>
                <li>Prophet 21</li><li>Eclipse</li><li>Infor SX.e</li><li>Tally</li><li>Sage X3</li>
              </ul>
            </div>
            <div className="landing-integration-group">
              <div className="landing-integration-h">PLM</div>
              <ul><li>PTC Windchill</li><li>Arena</li></ul>
            </div>
            <div className="landing-integration-group">
              <div className="landing-integration-h">Comms</div>
              <ul>
                <li>Email (SendGrid + Microsoft Graph)</li>
                <li>WhatsApp (Twilio)</li>
                <li>Slack</li>
                <li>Microsoft Teams</li>
                <li>Voice (Vapi, Retell)</li>
              </ul>
            </div>
            <div className="landing-integration-group">
              <div className="landing-integration-h">Payments</div>
              <ul><li>Stripe Connect</li><li>Razorpay</li></ul>
            </div>
          </div>
        </section>
      </main>

      <footer className="landing-foot">
        <span>© {year} Anvil. All rights reserved.</span>
        <span className="landing-foot-meta">
          <a href="#auth">Sign in</a>
          <span aria-hidden="true">·</span>
          <a href="mailto:hello@anvil.local">Contact</a>
        </span>
      </footer>
    </div>
  );
};

export default Landing;
