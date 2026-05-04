// GET /api/inbound/email/threads
// GET /api/inbound/email/threads?id=...&messages=true
//
// Read surface for the Inbox screen. Returns threads sorted by
// priority then last_received_at.

import { applyCors, handlePreflight, json, sendError } from "../../_lib/cors.js";
import { resolveContext, requirePermission } from "../../_lib/auth.js";
import { serviceClient } from "../../_lib/supabase.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const svc = serviceClient();
    const url = new URL(req.url, "http://x");
    const id = url.searchParams.get("id");

    if (id) {
      const t = await svc.from("inbound_email_threads")
        .select("*").eq("tenant_id", ctx.tenantId).eq("id", id).maybeSingle();
      if (t.error) throw new Error(t.error.message);
      if (!t.data) return json(res, 404, { error: { message: "thread not found" } });
      let messages = [];
      if (url.searchParams.get("messages") === "true") {
        const m = await svc.from("inbound_emails")
          .select("id, provider, message_id, from_address, from_name, subject, body_text, attachments, status, priority_score, customer_id, customer_tier, received_at, parsed_at")
          .eq("thread_id", id)
          .order("received_at", { ascending: true });
        messages = m.data || [];
      }
      return json(res, 200, { thread: t.data, messages });
    }

    const status = url.searchParams.get("status");
    const limit = Math.min(200, Number(url.searchParams.get("limit") || 100));
    // We pull the latest email per thread to surface tier + priority.
    const inbox = await svc.from("inbound_emails")
      .select("id, thread_id, status, priority_score, customer_id, customer_tier, from_address, subject, received_at")
      .eq("tenant_id", ctx.tenantId)
      .order("priority_score", { ascending: false })
      .order("received_at", { ascending: false })
      .limit(limit);
    if (inbox.error) throw new Error(inbox.error.message);
    const filtered = status ? (inbox.data || []).filter((r) => r.status === status) : (inbox.data || []);
    return json(res, 200, { messages: filtered });
  } catch (err) { sendError(res, err); }
}
