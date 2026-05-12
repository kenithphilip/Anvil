// /api/admin/customer_terms
//   GET    ?customer_id=  lists packs + clauses for one customer
//   POST   /pack          upsert a pack (body: { customer_id, pack_name, version?, ... })
//   POST   /clause        upsert a clause (body: { pack_id, clause_index, heading?, body, is_blocking? })
//   DELETE ?pack_id=      hard-delete a pack and its clauses
//   DELETE ?clause_id=    hard-delete a single clause
//
// Drives the per-customer terms library introduced in migration 106.
// HMIL's 15-clause boilerplate is stored once as a pack, with each
// clause as a child row, so individual clauses can be acknowledged or
// overridden per order.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();
    const path = req.url || "";

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      if (!req.query.customer_id) {
        return json(res, 400, { error: { message: "customer_id required" } });
      }
      const packs = await svc.from("customer_terms_packs")
        .select("*")
        .eq("tenant_id", ctx.tenantId)
        .eq("customer_id", req.query.customer_id)
        .order("version", { ascending: false });
      if (packs.error) throw new Error(packs.error.message);
      const packIds = (packs.data || []).map((p) => p.id);
      const clauses = packIds.length
        ? await svc.from("customer_terms_clauses")
            .select("*")
            .eq("tenant_id", ctx.tenantId)
            .in("pack_id", packIds)
            .order("pack_id", { ascending: true })
            .order("clause_index", { ascending: true })
        : { data: [] };
      return json(res, 200, { packs: packs.data || [], clauses: clauses.data || [] });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "admin");
      const body = await readBody(req);
      if (path.includes("/clause")) {
        if (!body.pack_id || body.clause_index == null || !body.body) {
          return json(res, 400, { error: { message: "pack_id, clause_index, body required" } });
        }
        const row = {
          tenant_id: ctx.tenantId,
          pack_id: body.pack_id,
          clause_index: Number(body.clause_index),
          heading: body.heading || null,
          body: String(body.body),
          is_blocking: !!body.is_blocking,
        };
        if (body.id) {
          const { data, error } = await svc.from("customer_terms_clauses")
            .update(row)
            .eq("tenant_id", ctx.tenantId)
            .eq("id", body.id)
            .select("*")
            .single();
          if (error) throw new Error(error.message);
          return json(res, 200, { clause: data });
        }
        const { data, error } = await svc.from("customer_terms_clauses").insert(row).select("*").single();
        if (error) throw new Error(error.message);
        await recordAudit(ctx, { action: "customer_terms_clause_create", objectType: "customer_terms_pack", objectId: body.pack_id, after: data });
        return json(res, 200, { clause: data });
      }
      // Default + /pack route: pack upsert.
      if (!body.customer_id || !body.pack_name) {
        return json(res, 400, { error: { message: "customer_id and pack_name required" } });
      }
      const row = {
        tenant_id: ctx.tenantId,
        customer_id: body.customer_id,
        pack_name: String(body.pack_name).trim(),
        version: body.version != null ? Number(body.version) : 1,
        is_active: body.is_active == null ? true : !!body.is_active,
        effective_from: body.effective_from || null,
        effective_to: body.effective_to || null,
        notes: body.notes || null,
      };
      if (body.id) {
        const { data, error } = await svc.from("customer_terms_packs")
          .update(row)
          .eq("tenant_id", ctx.tenantId)
          .eq("id", body.id)
          .select("*")
          .single();
        if (error) throw new Error(error.message);
        return json(res, 200, { pack: data });
      }
      const { data, error } = await svc.from("customer_terms_packs").insert(row).select("*").single();
      if (error) throw new Error(error.message);
      await recordAudit(ctx, { action: "customer_terms_pack_create", objectType: "customer", objectId: body.customer_id, after: data });
      return json(res, 200, { pack: data });
    }

    if (req.method === "DELETE") {
      requirePermission(ctx, "admin");
      const { pack_id, clause_id } = req.query || {};
      if (clause_id) {
        const { error } = await svc.from("customer_terms_clauses")
          .delete()
          .eq("tenant_id", ctx.tenantId)
          .eq("id", clause_id);
        if (error) throw new Error(error.message);
        return json(res, 200, { ok: true });
      }
      if (pack_id) {
        const { error } = await svc.from("customer_terms_packs")
          .delete()
          .eq("tenant_id", ctx.tenantId)
          .eq("id", pack_id);
        if (error) throw new Error(error.message);
        await recordAudit(ctx, { action: "customer_terms_pack_delete", objectType: "customer_terms_pack", objectId: pack_id });
        return json(res, 200, { ok: true });
      }
      return json(res, 400, { error: { message: "pack_id or clause_id required" } });
    }

    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
