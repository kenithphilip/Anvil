// /api/comms/routing
//
//   GET  ?customer_id=...            the matrix for one customer + the tenant's
//                                    function taxonomy + that customer's contacts
//   PUT  { customer_id, rules: [...] } replace the matrix for one customer
//   POST { code, label }             add a function to the tenant taxonomy
//
// The matrix is document_type x function -> To/CC/BCC. See
// docs/CUSTOMER_COMMS_DESIGN.md §3 and _lib/comms-routing.js for the resolver.
//
// A customer with no rules is the normal starting state, not an error — the
// resolver degrades to function, then primary contact, then operator. This
// endpoint exists so that fallback becomes deliberate configuration over time.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const DISPOSITIONS = new Set(["to", "cc", "bcc"]);

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const customerId = req.query?.customer_id;

      const fns = await svc.from("contact_functions")
        .select("id, code, label, sort_order, is_active")
        .eq("tenant_id", ctx.tenantId).eq("is_active", true)
        .order("sort_order", { ascending: true });

      if (!customerId) return json(res, 200, { functions: fns.data || [], rules: [], contacts: [] });

      const [rules, contacts] = await Promise.all([
        svc.from("comms_routing_rules")
          .select("id, document_type, function_id, disposition, is_active")
          .eq("tenant_id", ctx.tenantId).eq("customer_id", customerId),
        svc.from("customer_contacts")
          .select("id, name, email, function_id, is_primary, is_active, marketing_consent")
          .eq("tenant_id", ctx.tenantId).eq("customer_id", customerId),
      ]);

      return json(res, 200, {
        functions: fns.data || [],
        rules: rules.data || [],
        contacts: contacts.data || [],
      });
    }

    if (req.method === "POST") {
      // Add a function to the tenant taxonomy. The seed set is generic on
      // purpose; a tenant whose vocabulary differs adds its own here rather
      // than needing a migration.
      requirePermission(ctx, "write");
      const body = await readBody(req);
      const code = String(body?.code || "").trim().toLowerCase().replace(/\s+/g, "_");
      const label = String(body?.label || "").trim();
      if (!code || !label) return json(res, 400, { error: { message: "code and label required" } });

      const ins = await svc.from("contact_functions").upsert({
        tenant_id: ctx.tenantId,
        code,
        label,
        sort_order: Number(body?.sort_order) || 100,
        is_active: true,
      }, { onConflict: "tenant_id,code" }).select("*").single();
      if (ins.error) throw new Error(ins.error.message);
      return json(res, 200, { ok: true, function: ins.data });
    }

    if (req.method === "PUT") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      const customerId = body?.customer_id;
      if (!customerId) return json(res, 400, { error: { message: "customer_id required" } });
      const rules = Array.isArray(body?.rules) ? body.rules : [];

      for (const r of rules) {
        if (!r?.document_type || !r?.function_id) {
          return json(res, 400, { error: { message: "each rule needs document_type + function_id" } });
        }
        if (r.disposition && !DISPOSITIONS.has(r.disposition)) {
          return json(res, 400, { error: { message: "disposition must be to|cc|bcc" } });
        }
      }

      // Replace wholesale: the UI sends the complete matrix for this customer,
      // so a removed row must actually disappear rather than linger.
      const del = await svc.from("comms_routing_rules")
        .delete().eq("tenant_id", ctx.tenantId).eq("customer_id", customerId);
      if (del.error) throw new Error(del.error.message);

      let saved = [];
      if (rules.length) {
        const payload = rules.map((r) => ({
          tenant_id: ctx.tenantId,
          customer_id: customerId,
          document_type: String(r.document_type),
          function_id: r.function_id,
          disposition: r.disposition || "to",
          is_active: r.is_active !== false,
        }));
        const ins = await svc.from("comms_routing_rules").insert(payload).select("*");
        if (ins.error) throw new Error(ins.error.message);
        saved = ins.data || [];
      }

      await recordAudit(ctx, {
        action: "comms_routing_updated",
        objectType: "customer",
        objectId: customerId,
        detail: saved.length + " rule(s)",
      });
      return json(res, 200, { ok: true, rules: saved });
    }

    res.setHeader("Allow", "GET, POST, PUT");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    return sendError(res, err);
  }
}
