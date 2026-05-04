// CRUD for tally_companies. A tenant can have one or more Tally
// companies (legal entities). Each company carries its own bridge
// URL + token, default ledger / voucher series, and GSTIN.
//
// GET    /api/tally/companies          -> { companies: [...] }
// POST   /api/tally/companies          -> create
// PATCH  /api/tally/companies?id=...   -> update
// DELETE /api/tally/companies?id=...   -> remove (cascade clears
//                                        retry queue + voucher state)
//
// The bridge token is encrypted on save via tally-client.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { tallyEncryptedTokenColumns } from "../_lib/tally-client.js";

const STRIP_TOKEN = (row) => {
  if (!row) return row;
  const { bridge_token, bridge_token_enc, bridge_iv, ...rest } = row;
  return { ...rest, bridge_token_set: !!(bridge_token || bridge_token_enc) };
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const r = await svc.from("tally_companies")
        .select("*")
        .eq("tenant_id", ctx.tenantId)
        .order("is_default", { ascending: false })
        .order("name", { ascending: true });
      if (r.error) throw new Error("companies read: " + r.error.message);
      return json(res, 200, { companies: (r.data || []).map(STRIP_TOKEN) });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "admin");
      const body = await readBody(req);
      if (!body?.name) return json(res, 400, { error: { message: "name required" } });
      const tokenColumns = tallyEncryptedTokenColumns(body.bridge_token || null);

      // First company auto-becomes default.
      const existing = await svc.from("tally_companies").select("id", { count: "exact" })
        .eq("tenant_id", ctx.tenantId);
      const isFirst = !existing.count;
      const ins = await svc.from("tally_companies").insert({
        tenant_id: ctx.tenantId,
        name: body.name,
        bridge_url: body.bridge_url || null,
        bridge_version: body.bridge_version || null,
        default_voucher_series: body.default_voucher_series || null,
        default_sales_ledger: body.default_sales_ledger || null,
        default_party_group: body.default_party_group || null,
        gstin: body.gstin || null,
        state_code: body.state_code || null,
        is_default: !!body.is_default || isFirst,
        ...tokenColumns,
      }).select("*").single();
      if (ins.error) throw new Error("company insert: " + ins.error.message);

      if (ins.data.is_default) {
        await svc.from("tally_companies")
          .update({ is_default: false })
          .eq("tenant_id", ctx.tenantId)
          .neq("id", ins.data.id);
      }

      await recordAudit(ctx, {
        action: "tally_company_created",
        objectType: "tally_company",
        objectId: ins.data.id,
        detail: ins.data.name,
      });
      return json(res, 200, { company: STRIP_TOKEN(ins.data) });
    }

    const id = (req.query?.id) || new URL(req.url, "http://x").searchParams.get("id");
    if (!id) return json(res, 400, { error: { message: "id query parameter required" } });

    if (req.method === "PATCH" || req.method === "PUT") {
      requirePermission(ctx, "admin");
      const body = await readBody(req);
      const patch = {};
      const fields = ["name", "bridge_url", "bridge_version", "default_voucher_series",
        "default_sales_ledger", "default_party_group", "gstin", "state_code"];
      for (const f of fields) if (body[f] !== undefined) patch[f] = body[f];
      if (body.bridge_token !== undefined) {
        Object.assign(patch, tallyEncryptedTokenColumns(body.bridge_token || null));
      }
      if (body.is_default === true) patch.is_default = true;

      const upd = await svc.from("tally_companies").update(patch)
        .eq("tenant_id", ctx.tenantId).eq("id", id)
        .select("*").single();
      if (upd.error) throw new Error("company update: " + upd.error.message);
      if (patch.is_default === true) {
        await svc.from("tally_companies")
          .update({ is_default: false })
          .eq("tenant_id", ctx.tenantId)
          .neq("id", id);
      }
      await recordAudit(ctx, {
        action: "tally_company_updated",
        objectType: "tally_company",
        objectId: id,
        detail: Object.keys(patch).join(","),
      });
      return json(res, 200, { company: STRIP_TOKEN(upd.data) });
    }

    if (req.method === "DELETE") {
      requirePermission(ctx, "admin");
      const del = await svc.from("tally_companies")
        .delete()
        .eq("tenant_id", ctx.tenantId)
        .eq("id", id);
      if (del.error) throw new Error("company delete: " + del.error.message);
      await recordAudit(ctx, {
        action: "tally_company_deleted",
        objectType: "tally_company",
        objectId: id,
        detail: "removed",
      });
      return json(res, 200, { ok: true });
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
