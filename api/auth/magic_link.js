// POST /api/auth/magic_link
// Body: { email, redirectTo? }
// Issues a Supabase magic link via the service role and audits the request.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { serviceClient } from "../_lib/supabase.js";

const DEFAULT_REDIRECT = process.env.MAGIC_LINK_REDIRECT_URL || "";

const recordMagicLink = async (svc, email, outcome, ip, ua) => {
  try {
    await svc.from("auth_magic_links").insert({
      email: String(email || "").toLowerCase(),
      outcome,
      ip: ip || null,
      user_agent: ua || null,
    });
  } catch (_) {}
};

const ipFromReq = (req) => {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length) return forwarded.split(",")[0].trim();
  return (req.socket && req.socket.remoteAddress) || null;
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const body = await readBody(req);
    const email = String(body && body.email || "").trim();
    if (!email || !email.includes("@")) return json(res, 400, { error: { message: "Valid email required" } });
    const redirectTo = (body && body.redirectTo) || DEFAULT_REDIRECT || undefined;
    const svc = serviceClient();
    const ip = ipFromReq(req);
    const ua = req.headers["user-agent"] || null;
    const result = await svc.auth.signInWithOtp({ email, options: { emailRedirectTo: redirectTo, shouldCreateUser: true } });
    if (result.error) {
      await recordMagicLink(svc, email, "failed", ip, ua);
      return json(res, 502, { error: { message: result.error.message || "Magic link request failed" } });
    }
    await recordMagicLink(svc, email, "sent", ip, ua);
    return json(res, 200, { ok: true });
  } catch (err) {
    sendError(res, err);
  }
}
