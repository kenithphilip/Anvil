// POST /api/auth/password_login
//
// Body: { email, password }
//
// Email + password sign-in for accounts that opted out of magic link.
// The browser cannot call signInWithPassword directly without the
// SUPABASE_ANON_KEY in the bundle (which is fine but requires
// frontend plumbing); proxying through this endpoint keeps the anon
// key server-side and gives us a single audit point.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { serviceClient } from "../_lib/supabase.js";
import { ensureMembership } from "../_lib/tenancy.js";
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

    const anonUrl = process.env.SUPABASE_URL;
    const anonKey = process.env.SUPABASE_ANON_KEY;
    if (!anonUrl || !anonKey) throw new Error("SUPABASE_URL or SUPABASE_ANON_KEY missing");
    const anon = createClient(anonUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const session = await anon.auth.signInWithPassword({ email, password });
    if (session.error) {
      const status = /credentials/i.test(session.error.message) ? 401 : 500;
      return json(res, status, { error: { message: session.error.message } });
    }
    const user = session.data?.user;
    if (!user) return json(res, 500, { error: { message: "Sign-in returned no user" } });

    // Recovery for legacy users who signed up before auto-onboarding.
    const svc = serviceClient();
    await ensureMembership(svc, user);

    return json(res, 200, {
      user: {
        id: user.id,
        email: user.email,
        display_name: user.user_metadata?.name || user.user_metadata?.full_name || null,
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
