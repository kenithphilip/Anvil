// POST /api/portal/auth/login   Body: { email, password }
//
// Email + password sign-in for CUSTOMER portal users. Proxies Supabase
// signInWithPassword server-side (anon key stays off the client) and returns a
// session { access_token, refresh_token } the browser sends back as a Bearer
// header — the token is NEVER placed in the URL (the core fix vs the legacy
// shared-link portal).
//
// PROVISIONED (not enforced in v1): the same session shape is issued by Supabase
// SSO, so this + resolveCustomerContext work unchanged once SSO is configured;
// portal_users.require_mfa is read for a future MFA challenge (see the gate stub
// below).

import { applyCors, handlePreflight, json, readBody, sendError } from "../../_lib/cors.js";
import { serviceClient } from "../../_lib/supabase.js";
import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const body = await readBody(req);
    const email = String(body?.email || "").trim().toLowerCase();
    const password = String(body?.password || "");
    if (!email || !password) return json(res, 400, { error: { message: "email and password required" } });

    const url = process.env.SUPABASE_URL;
    const anonKey = process.env.SUPABASE_ANON_KEY;
    if (!url || !anonKey) throw new Error("SUPABASE_URL or SUPABASE_ANON_KEY missing");
    const anon = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const session = await anon.auth.signInWithPassword({ email, password });
    if (session.error) {
      const status = /credentials/i.test(session.error.message) ? 401 : 500;
      return json(res, status, { error: { message: session.error.message } });
    }
    const user = session.data?.user;
    if (!user) return json(res, 500, { error: { message: "Sign-in returned no user" } });

    // The account MUST be a provisioned portal user (segregated from staff).
    const svc = serviceClient();
    const pu = await svc.from("portal_users")
      .select("id, customer_id, tenant_id, role, status, require_mfa")
      .eq("auth_user_id", user.id).maybeSingle();
    if (pu.error) throw new Error(pu.error.message);
    if (!pu.data) {
      try { await anon.auth.signOut(); } catch (_) { /* ignore */ }
      return json(res, 403, { error: { message: "This account is not a customer portal user." } });
    }
    if (pu.data.status === "suspended") {
      try { await anon.auth.signOut(); } catch (_) { /* ignore */ }
      return json(res, 403, { error: { message: "This portal account is suspended." } });
    }

    // FUTURE MFA GATE (provisioned, not enforced in v1): when portal MFA lands,
    // if pu.data.require_mfa and the second factor isn't satisfied, sign the
    // session out and return { mfa_required: true } here before issuing tokens.

    // First successful login activates an invited account + stamps last_login.
    await svc.from("portal_users").update({
      status: pu.data.status === "invited" ? "active" : pu.data.status,
      last_login_at: new Date().toISOString(),
    }).eq("id", pu.data.id);

    return json(res, 200, {
      user: { id: user.id, email: user.email, customer_id: pu.data.customer_id, role: pu.data.role },
      session: {
        access_token: session.data.session?.access_token || null,
        refresh_token: session.data.session?.refresh_token || null,
        expires_at: session.data.session?.expires_at || null,
      },
    });
  } catch (err) {
    sendError(res, err);
  }
}
