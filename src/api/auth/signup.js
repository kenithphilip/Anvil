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
import {
  ensureMembership,
  defaultTenantId,
  requiresApproval,
  listTenantAdmins,
  getMemberStatus,
} from "../_lib/tenancy.js";
import { recordAudit } from "../_lib/audit.js";
import { createClient } from "@supabase/supabase-js";

const SIGNUP_ALLOWED = String(process.env.SIGNUP_ALLOWED || "true").toLowerCase() === "true";
const VALID_REQUESTED_ROLES = new Set([
  "viewer", "sales_engineer", "sales_manager", "procurement", "finance",
]);

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
    const requested_role_raw = String(body?.requested_role || "").trim();
    const requested_role = VALID_REQUESTED_ROLES.has(requested_role_raw) ? requested_role_raw : null;
    const notes = String(body?.notes || "").trim().slice(0, 500) || null;
    if (!isValidEmail(email)) return json(res, 400, { error: { message: "Valid email required" } });
    if (password.length < 8) return json(res, 400, { error: { message: "Password must be at least 8 characters" } });
    if (!display_name) return json(res, 400, { error: { message: "Display name required" } });
    if (requested_role_raw && !requested_role) {
      return json(res, 400, { error: { message: "Requested role must be one of: " + [...VALID_REQUESTED_ROLES].join(", ") } });
    }

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
      user_metadata: {
        name: display_name,
        requested_role: requested_role || null,
      },
    });
    if (created.error) throw new Error("createUser: " + created.error.message);
    const user = created.data?.user;
    if (!user) throw new Error("createUser returned no user");

    // Create the membership row. The first user on a fresh tenant is
    // auto-approved as admin (otherwise nobody can ever approve);
    // every subsequent user lands status='pending' when REQUIRE_APPROVAL
    // is on. ensureMembership reads the requested_role + display_name
    // out of the opts bag and persists them on the row so the admin
    // can review the request later.
    const memberships = await ensureMembership(svc, user, {
      requested_role,
      display_name,
      notes,
    });
    const myMembership = (memberships || []).find((m) => m.tenant_id === defaultTenantId()) || memberships?.[0];

    // Audit the signup. We have no ctx (the user is brand new), so we
    // hand-roll the row instead of going through recordAudit's
    // ctx-based path.
    try {
      await svc.from("audit_events").insert({
        tenant_id: defaultTenantId(),
        action: "user_signup",
        object_type: "auth.users",
        object_id: user.id,
        actor_user_id: user.id,
        detail: email + (requested_role ? (" requested=" + requested_role) : ""),
      });
    } catch (_) { /* audit is best-effort here */ }

    // Notify every tenant admin so the bell + Access Requests tab
    // light up. Best-effort; a notify-write failure must not block
    // a signup that has already created the user.
    if (myMembership?.status === "pending") {
      try {
        const admins = await listTenantAdmins(svc, defaultTenantId());
        if (admins.length) {
          const rows = admins.map((a) => ({
            tenant_id: defaultTenantId(),
            kind: "access_request",
            title: "New access request",
            body: `${display_name || email} signed up and is requesting "${requested_role || "default"}" access. Click to review.`,
            link_route: "admin",
            link_params: { tab: "access" },
            actor_user_id: user.id,
            actor_email: email,
            object_type: "tenant_member",
            object_id: user.id,
          }));
          await svc.from("admin_notifications").insert(rows);
        }
      } catch (_) { /* best-effort */ }
    }

    // PENDING path: do NOT return a session. The frontend shows a
    // "request received, pending approval" screen and stays on the
    // landing page.
    if (myMembership?.status === "pending") {
      return json(res, 202, {
        status: "pending",
        message: "Your access request has been submitted. An admin will review it; you'll be able to sign in once approved.",
        user: { id: user.id, email: user.email, display_name },
        requested_role,
      });
    }

    // APPROVED path (first user, or REQUIRE_APPROVAL=false): mint a
    // session immediately so they can land on /home.
    const anonUrl = process.env.SUPABASE_URL;
    const anonKey = process.env.SUPABASE_ANON_KEY;
    if (!anonUrl || !anonKey) throw new Error("SUPABASE_URL or SUPABASE_ANON_KEY missing");
    const anon = createClient(anonUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const session = await anon.auth.signInWithPassword({ email, password });
    if (session.error) throw new Error("signInWithPassword: " + session.error.message);

    return json(res, 200, {
      status: "approved",
      user: { id: user.id, email: user.email, display_name },
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
