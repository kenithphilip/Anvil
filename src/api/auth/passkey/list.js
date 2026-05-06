// /api/auth/passkey/list
//
//   GET                    list this user's registered passkeys
//   DELETE ?id=            remove one passkey by row id
//
// Removing the last passkey clears the passkey_enrolled flag on
// user_security_settings.

import { applyCors, handlePreflight, json, sendError } from "../../_lib/cors.js";
import { resolveContext } from "../../_lib/auth.js";
import { serviceClient } from "../../_lib/supabase.js";
import { safeAwait } from "../../_lib/safe-thenable.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    if (!ctx.user?.id) return json(res, 401, { error: { message: "auth required" } });
    const svc = serviceClient();

    if (req.method === "GET") {
      const { data } = await svc.from("user_passkeys")
        .select("id, credential_id, label, transports, last_used_at, created_at, backup_eligible, device_type")
        .eq("user_id", ctx.user.id)
        // Hide pending placeholders.
        .not("credential_id", "like", "pending::%")
        .order("created_at", { ascending: false });
      return json(res, 200, { passkeys: data || [] });
    }

    if (req.method === "DELETE") {
      const url = new URL(req.url, "http://x");
      const id = url.searchParams.get("id");
      if (!id) return json(res, 400, { error: { message: "id required" } });
      const { data: row } = await svc.from("user_passkeys")
        .select("id").eq("id", id).eq("user_id", ctx.user.id).maybeSingle();
      if (!row) return json(res, 404, { error: { message: "passkey not found" } });
      await svc.from("user_passkeys").delete().eq("id", id);

      // Refresh the passkey_enrolled mirror.
      const { count } = await svc.from("user_passkeys")
        .select("id", { count: "exact", head: true })
        .eq("user_id", ctx.user.id)
        .not("credential_id", "like", "pending::%");
      await svc.from("user_security_settings").upsert({
        user_id: ctx.user.id,
        passkey_enrolled: (count || 0) > 0,
        last_security_change_at: new Date().toISOString(),
      }, { onConflict: "user_id" });

      await safeAwait(svc.from("user_security_audit").insert({
        user_id: ctx.user.id,
        user_email: ctx.user.email,
        event: "passkey_removed",
        detail: { passkey_id: id },
      }));

      return json(res, 200, { ok: true });
    }

    res.setHeader("Allow", "GET, DELETE");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    return sendError(res, err);
  }
}
