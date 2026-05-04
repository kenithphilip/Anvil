// POST /api/auth/signup
//
// Body: { email, password, display_name }
//
// Creates a Supabase auth user with the provided credentials, sets
// user_metadata.name = display_name, marks the email as confirmed
// (no email round trip), auto-onboards them to the default tenant
// via ensureMembership, and returns a fresh session that the browser
// can use immediately. No magic link, no confirmation email. Useful
// for self-serve onboarding when the operator has not set up SMTP.
//
// Self-serve signup is a privileged operation: anyone on the public
// internet can hit it. We rely on the Supabase project being
// reachable only from the frontend origin (CORS). If you need stricter
// gating, set SIGNUP_ALLOWED=false and use /api/admin/members invites
// instead.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { serviceClient } from "../_lib/supabase.js";
import { ensureMembership } from "../_lib/tenancy.js";
import { recordAudit } from "../_lib/audit.js";
import { createClient } from "@supabase/supabase-js";

const SIGNUP_ALLOWED = String(process.env.SIGNUP_ALLOWED || "true").toLowerCase() === "true";

const isValidEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "").trim());

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    if (!SIGNUP_ALLOWED) {
      return json(res, 403, { error: { message: "Self-serve signup is disabled. Ask an admin to invite you from Admin Center." } });
    }
    const body = await readBody(req);
    const email = String(body?.email || "").trim().toLowerCase();
    const password = String(body?.password || "");
    const display_name = String(body?.display_name || "").trim();
    if (!isValidEmail(email)) return json(res, 400, { error: { message: "Valid email required" } });
    if (password.length < 8) return json(res, 400, { error: { message: "Password must be at least 8 characters" } });
    if (!display_name) return json(res, 400, { error: { message: "Display name required" } });

    const svc = serviceClient();

    // Reject duplicate emails up front. Supabase admin.createUser would
    // also reject, but its error message is opaque ("User already
    // registered"); we want a clear surface for the UI.
    const existing = await svc.auth.admin.listUsers({ page: 1, perPage: 200 });
    if (existing.error) throw new Error("listUsers: " + existing.error.message);
    const dup = (existing.data?.users || []).find((u) => u.email?.toLowerCase() === email);
    if (dup) {
      return json(res, 409, { error: { message: "An account with that email already exists. Sign in instead." } });
    }

    const created = await svc.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { name: display_name },
    });
    if (created.error) throw new Error("createUser: " + created.error.message);
    const user = created.data?.user;
    if (!user) throw new Error("createUser returned no user");

    await ensureMembership(svc, user);

    // Sign in with the password we just set so the response carries a
    // valid session. We use a fresh anon client to avoid any
    // service-role context leaking into the session.
    const anonUrl = process.env.SUPABASE_URL;
    const anonKey = process.env.SUPABASE_ANON_KEY;
    if (!anonUrl || !anonKey) throw new Error("SUPABASE_URL or SUPABASE_ANON_KEY missing");
    const anon = createClient(anonUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const session = await anon.auth.signInWithPassword({ email, password });
    if (session.error) throw new Error("signInWithPassword: " + session.error.message);

    // Audit the signup. We have no ctx (the user is brand new), so we
    // hand-roll the row instead of going through recordAudit's
    // ctx-based path.
    try {
      await svc.from("audit_events").insert({
        tenant_id: "00000000-0000-0000-0000-000000000001",
        action: "user_signup",
        object_type: "auth.users",
        object_id: user.id,
        actor_user_id: user.id,
        detail: email,
      });
    } catch (_) { /* audit is best-effort here */ }

    return json(res, 200, {
      user: {
        id: user.id,
        email: user.email,
        display_name,
      },
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
