import React, { useState } from "react";
import { PortalAPI } from "./api";

// Customer sign-in. Email + password → a session (token out of the URL).
export const LoginView: React.FC<{ onLogin: () => void }> = ({ onLogin }) => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null); setBusy(true);
    try { await PortalAPI.login(email.trim(), password); onLogin(); }
    catch (x: any) { setErr(x?.message || "Sign-in failed"); }
    finally { setBusy(false); }
  };

  return (
    <div className="pt-center">
      <form className="pt-card pt-login" onSubmit={submit}>
        <div className="pt-brand">Customer Portal</div>
        <div className="pt-sub">Sign in to view what your supplier has shared with you.</div>
        {err && <div className="pt-error" role="alert">{err}</div>}
        <label className="pt-field">
          <span>Email</span>
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label className="pt-field">
          <span>Password</span>
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        <button className="pt-btn pt-btn-primary" type="submit" disabled={busy || !email || !password}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <div className="pt-hint">Access is by invitation. Contact your supplier if you need an account.</div>
      </form>
    </div>
  );
};
