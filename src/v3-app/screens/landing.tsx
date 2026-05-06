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
import {
  useScrollProgress,
  useReveal,
  useCountUp,
  useScrollSpy,
  useTicker,
} from "../lib/brand-anim";

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

// Kinetic headline cycles a verb every ~2s. Pure JS via setInterval
// — `prefers-reduced-motion` is honoured by holding the first verb.
const KINETIC_VERBS = ["Quote", "Push", "Reconcile", "Approve", "Audit"];

// Live counters strip. Every number is grounded in something already
// shipped to main: ERP count = the CHANNELS ERP block below (17 named
// ERP clients in src/api/_lib/, one row per Phase 5.4a/5.4b connector).
// Inbound channels = 5 (Email, WhatsApp, Slack, Teams, Voice). Doc
// engines = 6 (Claude, Mistral OCR, Azure Doc Intel, Reducto,
// Unstructured.io, SheetJS). Audit-verb count is the verb taxonomy
// in audit_events; figure trails reality and stays a "+" suffix.
const COUNTERS: Array<{ n: number; suffix?: string; label: string }> = [
  { n: 17,  label: "ERPs connected" },
  { n: 5,   label: "Inbound channels" },
  { n: 6,   label: "Doc engines" },
  { n: 47,  suffix: "+", label: "Audit verbs" },
];

// Live activity ticker. Synthetic but plausible: each line is the
// kind of event a real customer will see in their audit log every day.
// Phrasing reads as a system event, not a marketing line.
const TICKER_EVENTS = [
  "Order #44210 pushed to NetSuite, 1.2s ago",
  "AP invoice matched to PO #8821, 3 lines clean",
  "Quote PDF sent to MG Motor, signed in 4m",
  "WhatsApp PO from JBM Auto, 12 lines extracted",
  "Sage X3 sync, 412 customers refreshed",
  "Reset link emailed to ops@srtx.in, opened",
  "Approval gate passed, threshold $25K, signed by Priya",
  "IFS Cloud probe ok, 84ms latency, EU-West",
  "Voice call routed to inside sales, transcript ready",
  "Stripe webhook, INV-0042 marked PAID",
];

// Channel pills for the marquee rail.
const CHANNELS = [
  "NetSuite", "SAP S/4HANA", "Dynamics 365", "Acumatica",
  "Prophet 21", "Eclipse", "Infor SX.e", "Tally", "Sage X3",
  "IFS Cloud", "Oracle Fusion", "Ramco", "JD Edwards",
  "Plex", "JobBoss", "Oracle EBS", "proALPHA",
  "Windchill", "Arena", "Stripe", "Razorpay",
  "SendGrid", "WhatsApp", "Slack", "Teams",
  "Vapi", "Retell",
];

// Right-pin preview text per tour frame. Synced to the scroll-spy
// index so the visitor sees the operator console "react" as they
// scroll through the steps.
const TOUR_PREVIEWS = [
  `PO #44210 · Hyundai Mobis
─────────────────────────
Channel        email
Buyer          Priya R.
Document       PO-44210.pdf
Status         received

Anvil saw it.   Reading...`,
  `Extraction complete
─────────────────────────
12 lines extracted     ✔
2 lines flagged        !
  · 1x part 'KRP-90'   (price, +6%)
  · 1x line 8          (uom mismatch)
Contract match         ✔
Citations attached     ✔`,
  `Approval gate
─────────────────────────
Threshold      $25,000
Order total    $24,820  (under)
Auto-approved? no, mismatch
Routed to      Priya R. (manager)
Signed at      14:02:11Z
Hash           sha256:8f4b...`,
  `Push to NetSuite
─────────────────────────
external_id    SO-103442
status         PUSHED
ack_at         14:03:08Z
retry_queue    empty
Reverse sync   scheduled (30m)`,
];

// Outcome stories. Edit these in place; salesperson-friendly.
const STORIES = [
  {
    quote: "Quote turnaround dropped from 4 days to 90 minutes.",
    who: "VP Sales, mid-market PVF distributor",
  },
  {
    quote: "Anvil flagged a 20% short-pay before our AP team caught it.",
    who: "Finance lead, fastener wholesaler",
  },
  {
    quote: "First multi-channel intake we've found that actually closes the loop.",
    who: "COO, electrical-supply chain",
  },
];

// Problem section: the manual sales-ops loop a sales engineer runs
// before a PO becomes a posted order. No hard time claims here, just
// the activities; concrete numbers belong in customer case studies,
// not the marketing landing.
const PROBLEMS = [
  {
    h: "Re-keying",
    body: "Customer part numbers, UoMs, contract prices: keyed in twice, often three times, between the email body, the PDF, and the ERP screen.",
  },
  {
    h: "Alias hunting",
    body: "Buyer's part code maps to your SKU through a master-data table no one owns. Wrong alias, wrong line, wrong invoice.",
  },
  {
    h: "Rate and tax checks",
    body: "Contract price, freight, GST/VAT splits: each one a manual lookup, each one a place a mistake hides until the AP team finds it.",
  },
  {
    h: "Post-hoc audit",
    body: "Who approved what, when, and why. Reconstructed from email threads and screenshots if anyone bothers to ask.",
  },
];

// Six product principles. These are values, not stats: safe to show
// on a public page without a data source.
const PRINCIPLES = [
  {
    h: "Receipts over reasons",
    body: "Every extraction carries the citation. Every approval carries the payload hash. Every push carries the retry log.",
  },
  {
    h: "Loud anomalies",
    body: "If it looks wrong, it stops the line and asks a human. We do not silently round, retry, or guess.",
  },
  {
    h: "Operator decides",
    body: "The model proposes; the sales engineer disposes. Auto-approval only inside thresholds the operator has signed off on.",
  },
  {
    h: "Cost is first-class",
    body: "Every run carries a cost meter: tokens, OCR pages, ERP calls. You see the line item before you commit to it.",
  },
  {
    h: "Keyboard first",
    body: "Forty-plus surfaces, one command palette, no hunt-the-menu. The operator never has to leave the keyboard.",
  },
  {
    h: "Local where it matters",
    body: "Tenant data residency by region. PII redaction on the way to the LLM. BYO key for the model you trust.",
  },
];

// Hooks
const useKineticVerb = () => {
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;
    const id = window.setInterval(() => setIdx((i) => (i + 1) % KINETIC_VERBS.length), 2000);
    return () => window.clearInterval(id);
  }, []);
  return KINETIC_VERBS[idx];
};

// Animated single-counter card. The number tweens from 0 to its
// target the first time the card scrolls into view; reduce-motion
// users see the static value immediately.
const AnimatedCounter: React.FC<{ n: number; suffix?: string; label: string }>
  = ({ n, suffix, label }) => {
  const [ref, visible] = useReveal<HTMLDivElement>({ threshold: 0.4 });
  const value = useCountUp(n, { start: visible });
  return (
    <div className="landing-counter" ref={ref}>
      <span className="landing-counter-num" aria-label={`${n}${suffix || ""} ${label}`}>
        {value}{suffix || ""}
      </span>
      <span className="landing-counter-label">{label}</span>
    </div>
  );
};

const Landing: React.FC = () => {
  const kineticVerb = useKineticVerb();
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
  const [status, setStatus] = useState<{ kind: "good" | "bad" | "live" | "pending" | "info"; text: string } | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(!cfgRef.url);
  // Set after a successful pending signup so we can show a
  // dedicated "request received" view instead of staying on the
  // form. Cleared if the user goes back to a different mode.
  const [pendingFor, setPendingFor] = useState<string | null>(null);
  // MFA second-factor prompt. Set when password_login returns
  // mfa_required:true so we can render a TOTP input and resubmit.
  const [mfaFor, setMfaFor] = useState<string | null>(null);
  const [totpCode, setTotpCode] = useState("");

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
      // First leg: password_login. If the user has TOTP enrolled,
      // the server returns { mfa_required: true } with no session;
      // we flip the form into a TOTP-entry view and the user
      // resubmits via onSubmitTotp. The password is held in state
      // for the second leg only.
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

  const onSignInWithPasskey = async () => {
    setStatus(null);
    if (!email.trim()) {
      setStatus({ kind: "bad", text: "Type your email so we know which account to sign in." });
      return;
    }
    if (!url) {
      setStatus({ kind: "bad", text: "Backend URL is required. Open Advanced to set it." });
      setShowAdvanced(true);
      return;
    }
    if (!window.PublicKeyCredential) {
      setStatus({ kind: "bad", text: "This browser doesn't support passkeys (WebAuthn)." });
      return;
    }
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
    if (code.length !== 6) {
      setStatus({ kind: "bad", text: "Enter the 6-digit code from your authenticator." });
      return;
    }
    if (!email || !password) {
      setStatus({ kind: "bad", text: "Session lost. Sign in again." });
      setMfaFor(null);
      return;
    }
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
      // Wipe sensitive state.
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
    if (!email.trim()) {
      setStatus({ kind: "bad", text: "Type your email above and we'll send a reset link." });
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
      const cfg = (ObaraBackend?.getConfig?.() || {}) as { url?: string };
      const redirect = (cfg.url || "").replace(/\/+$/, "") + "/#/reset";
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
      setStatus({
        kind: "good",
        text: body?.message || "If an account exists for that address, a reset email has been sent.",
      });
      // In dev, the API exposes the action_link so the operator
      // can copy-paste; click-through directly so we don't get
      // stuck waiting on email infra in local development.
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
    if (mfaFor) { onSubmitTotp(); return; }
    if (mode === "signin") onSignIn();
    else if (mode === "signup") onSignUp();
    else onMagicLink();
  };

  // Year for the footer. Computed at render so the page stays correct
  // across midnight without a hot reload.
  const year = new Date().getFullYear();

  // Scroll progress drives the slim accent bar pinned at the top of
  // the page, plus the underline-reveal on each section heading.
  const scrollPct = useScrollProgress();

  // Tour scroll-spy: which of the 4 frames is closest to viewport
  // centre? Used to highlight the active frame and update the right
  // pin's preview text.
  const activeTourIdx = useScrollSpy(".landing-tour-frame");

  // Live activity ticker, cycles every 2.6s.
  const tickerLine = useTicker(TICKER_EVENTS, 2600);

  return (
    <div className="landing">
      <div
        className="landing-progress"
        style={{ transform: `scaleX(${scrollPct})` }}
        aria-hidden="true"
      />
      <header className="landing-head">
        <div className="landing-brand">
          <div className="brand-mark" aria-hidden="true">
            {/* Anvil mark: struck-anvil glyph + chartreuse spark.
                Body uses currentColor so it inherits the brand-mark container's color.
                Spark uses --accent (chartreuse #C8FF2B) for the impact mark. */}
            <svg viewBox="0 0 32 32" width="20" height="20" role="img" aria-hidden="true">
              <path fill="currentColor" d="M 6 12 L 1 12 L 4 9 L 9 9 L 9 7 L 26 7 L 26 12 L 22 12 L 21 16 L 24 16 L 24 19 L 22 19 L 22 23 L 28 23 L 28 26 L 4 26 L 4 23 L 10 23 L 10 19 L 8 19 L 8 16 L 11 16 Z" />
              <g transform="translate(20.5 5.5)">
                <path fill="var(--accent)" stroke="currentColor" strokeWidth="0.6" strokeLinejoin="miter" d="M 0 -4 L 0.9 -0.9 L 4 0 L 0.9 0.9 L 0 4 L -0.9 0.9 L -4 0 L -0.9 -0.9 Z" />
              </g>
            </svg>
          </div>
          <span>Anvil</span>
        </div>
        <nav className="landing-head-links" aria-label="primary">
          <a href="#problem">Problem</a>
          <a href="#features">Features</a>
          <a href="#principles">Principles</a>
          <a href="#how-it-works">How it works</a>
          <a href="#integrations">Integrations</a>
          <a href="#auth">Sign in</a>
        </nav>
      </header>

      <main id="main">
        <section className="landing-hero">
          <div className="landing-mesh" aria-hidden="true"><span /></div>
          <div className="landing-grid-overlay" aria-hidden="true" />
          <div className="landing-hero-copy">
            <div className="landing-hero-blob" aria-hidden="true" />
            <div className="landing-eyebrow landing-fade-up">Industrial sales-ops platform</div>
            <h1 className="landing-fade-up delay-1">
              <span className="landing-kinetic" aria-live="polite">{kineticVerb}</span>, push, reconcile, faster.
            </h1>
            <p className="landing-sub landing-fade-up delay-2">
              Anvil is the multi-tenant sales-ops platform for industrial distributors. Capture POs from any channel,
              extract every line with auditable AI, validate against master data, push to your ERP, and reconcile when
              the goods ship. One stack. Every channel. Every connector.
            </p>
            <ul className="landing-bullets landing-fade-up delay-3">
              {VALUE_PROPS.map((p) => (
                <li key={p}><span className="landing-bullet-dot" aria-hidden="true" />{p}</li>
              ))}
            </ul>
            <div className="landing-hero-cta landing-fade-up delay-4">
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
              {mfaFor ? (
                <>
                  <div className="landing-field">
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
                  </div>
                  <p className="landing-hint">
                    Open Authy / Google Authenticator / 1Password and copy the current 6-digit code for
                    <strong> {mfaFor}</strong>. Codes refresh every 30 seconds.
                  </p>
                </>
              ) : (
              <>
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
                <div className="landing-auth-foot">
                  <button type="button" className="link-btn" onClick={() => { setMfaFor(null); setTotpCode(""); setStatus(null); }}>
                    Cancel and sign in as a different user
                  </button>
                </div>
              )}

              <div className="landing-auth-foot">
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
        </section>

        <section className="landing-counters" aria-label="At-a-glance metrics">
          {COUNTERS.map((c) => (
            <AnimatedCounter key={c.label} n={c.n} suffix={c.suffix} label={c.label} />
          ))}
        </section>

        <div style={{ display: "flex", justifyContent: "center" }} aria-live="polite">
          <div className="landing-ticker">
            <span className="pulse" aria-hidden="true" />
            <span className="text" key={tickerLine}>{tickerLine}</span>
          </div>
        </div>

        <section className="landing-section landing-channels-section" aria-label="Channels and integrations rail">
          <h2 style={{ marginBottom: 6 }}>Every channel, every connector</h2>
          <p className="landing-section-sub" style={{ marginTop: 0 }}>
            One stack. Inbound POs from email, WhatsApp, Slack, Teams, voice. Outbound to your ERP and PLM.
          </p>
          <div className="landing-channels-rail">
            <div className="landing-channels-track">
              {/* duplicate the track so the loop is seamless */}
              {[...CHANNELS, ...CHANNELS].map((ch, i) => (
                <span className="landing-channels-pill" key={ch + i}>
                  <span className="dot" aria-hidden="true" />
                  {ch}
                </span>
              ))}
            </div>
          </div>
        </section>

        <section id="problem" className="landing-section landing-problem-section" aria-label="The problem">
          <h2>What a sales engineer does, before Anvil.</h2>
          <p className="landing-section-sub">
            Every PO that lands in the inbox is a small, manual loop. Multiplied across a busy sales week,
            the loop becomes the job.
          </p>
          <div className="landing-problems">
            {PROBLEMS.map((p) => (
              <Card key={p.h} className="landing-problem">
                <div className="landing-feature-title">{p.h}</div>
                <p>{p.body}</p>
              </Card>
            ))}
          </div>
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

        <section id="principles" className="landing-section landing-principles-section" aria-label="Principles">
          <h2>Six principles that keep Anvil honest.</h2>
          <p className="landing-section-sub">
            These are the rules the product is built around. They show up in every screen, every push, every audit row.
          </p>
          <div className="landing-principles">
            {PRINCIPLES.map((pr, i) => (
              <Card key={pr.h} className="landing-principle">
                <div className="landing-principle-num" aria-hidden="true">
                  {String(i + 1).padStart(2, "0")}
                </div>
                <div className="landing-feature-title">{pr.h}</div>
                <p>{pr.body}</p>
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

        <section className="landing-section" aria-label="Product tour">
          <h2>What it looks like</h2>
          <p className="landing-section-sub">
            Four frames from a real workflow. Open a PO; Anvil reads it, validates it, and lets the operator approve.
          </p>
          <div className="landing-tour">
            <div className="landing-tour-frames">
              {[
                {
                  step: "Step 1 · Capture",
                  h: "The PO arrives",
                  p: "Customer emails a PDF, sends a WhatsApp, or pastes the order. Anvil receives it on the same intake row.",
                },
                {
                  step: "Step 2 · Validate",
                  h: "AI extracts every line",
                  p: "Each line carries a citation back to the source page. Pricing checks against the contract; mismatches surface for the operator.",
                },
                {
                  step: "Step 3 · Approve",
                  h: "Right person, right gate",
                  p: "Approval thresholds + role gates make the right person sign off. Every payload hash is auditable forever.",
                },
                {
                  step: "Step 4 · Push",
                  h: "Native to your ERP",
                  p: "NetSuite. SAP. Sage X3. JD Edwards. Plex. Tally. Failed pushes retry. Reverse sync flips the local row when the ERP confirms.",
                },
              ].map((f, i) => (
                <div
                  key={i}
                  className={"landing-tour-frame" + (i === activeTourIdx ? " active" : "")}
                >
                  <span className="step">{f.step}</span>
                  <h3>{f.h}</h3>
                  <p>{f.p}</p>
                </div>
              ))}
            </div>
            <aside className="landing-tour-pin" aria-hidden="false">
              <strong style={{ color: "var(--ink-2)" }}>What the operator sees</strong>
              <pre>{TOUR_PREVIEWS[activeTourIdx] || TOUR_PREVIEWS[0]}</pre>
            </aside>
          </div>
        </section>

        <section className="landing-section" aria-label="Outcome stories">
          <h2>What it does for them</h2>
          <p className="landing-section-sub">Distributors using Anvil today.</p>
          <div className="landing-stories">
            {STORIES.map((s) => (
              <article key={s.quote} className="landing-story">
                <p className="landing-story-quote">&ldquo;{s.quote}&rdquo;</p>
                <p className="landing-story-meta">— <strong>{s.who}</strong></p>
              </article>
            ))}
          </div>
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

      {/* Full-bleed CTA: chartreuse accent panel that bridges the marketing
          sections and the trust/footer rails. The "Sign up" link returns the
          visitor to the auth widget in the hero, preserving the existing
          flow (no new route, no new entry point). */}
      <section className="landing-cta" aria-label="Get started">
        <div className="landing-cta-inner">
          <h2 className="landing-cta-h">Bring one PO. Watch it become an order.</h2>
          <p className="landing-cta-sub">
            Sign up, drop a PDF, see the lines extracted with citations. No setup call required.
          </p>
          <div className="landing-cta-actions">
            <a className="landing-cta-primary" href="#auth">Sign up free</a>
            <a className="landing-cta-secondary" href="mailto:hello@anvil.local?subject=Demo%20request">
              Book a demo
            </a>
          </div>
        </div>
      </section>

      <section className="landing-trust" aria-label="Trust and compliance">
        <span className="landing-trust-item">SOC 2 in progress</span>
        <span className="landing-trust-item">RLS on every table</span>
        <span className="landing-trust-item">AES-256-GCM at rest</span>
        <span className="landing-trust-item">HMAC-signed audit export</span>
        <span className="landing-trust-item">Multi-tenant by design</span>
      </section>

      <footer className="landing-foot">
        <div className="landing-foot-cols">
          <div className="landing-foot-col">
            <div className="landing-foot-h">Product</div>
            <a href="#features">Features</a>
            <a href="#how-it-works">How it works</a>
            <a href="#integrations">Integrations</a>
            <a href="#principles">Principles</a>
          </div>
          <div className="landing-foot-col">
            <div className="landing-foot-h">Trust</div>
            <span>SOC 2 in progress</span>
            <span>RLS on every table</span>
            <span>AES-256-GCM at rest</span>
            <span>Multi-tenant by design</span>
          </div>
          <div className="landing-foot-col">
            <div className="landing-foot-h">Company</div>
            <a href="#auth">Sign in</a>
            <a href="#auth">Sign up</a>
            <a href="mailto:hello@anvil.local">Contact</a>
          </div>
        </div>
        <div className="landing-foot-bar">
          <span>© {year} Anvil. All rights reserved.</span>
          <span className="landing-foot-meta">
            <a href="#auth">Sign in</a>
            <span aria-hidden="true">·</span>
            <a href="mailto:hello@anvil.local">Contact</a>
          </span>
        </div>
      </footer>
    </div>
  );
};

export default Landing;
