// /api/admin/contracts
//   GET    list (filter by customer, type, status)
//   POST   create with optional contract_lines
//   PATCH  update
//   DELETE remove

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const TYPES = new Set(["ARC","BLANKET_PO","AMC","ONE_OFF"]);
const STATUSES = new Set(["ACTIVE","EXPIRED","TERMINATED","PENDING_RENEWAL"]);

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();
    if (req.method === "GET") {
      requirePermission(ctx, "read");
      let q = svc.from("contracts").select("*").eq("tenant_id", ctx.tenantId).order("start_date", { ascending: false }).limit(500);
      if (req.query.customer_id) q = q.eq("customer_id", req.query.customer_id);
      if (req.query.type && TYPES.has(req.query.type)) q = q.eq("contract_type", req.query.type);
      if (req.query.status && STATUSES.has(req.query.status)) q = q.eq("status", req.query.status);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      const ids = (data || []).map((c) => c.id);
      const { data: lines } = ids.length
        ? await svc.from("contract_lines").select("*").eq("tenant_id", ctx.tenantId).in("contract_id", ids)
        : { data: [] };
      const linesByContract = {};
      (lines || []).forEach((ln) => { (linesByContract[ln.contract_id] = linesByContract[ln.contract_id] || []).push(ln); });
      const out = (data || []).map((c) => ({ ...c, lines: linesByContract[c.id] || [] }));
      return json(res, 200, { contracts: out });
    }
    if (req.method === "POST") {
      requirePermission(ctx, "admin");
      const body = await readBody(req);
      if (!body.customer_id || !body.contract_number || !body.contract_type || !body.start_date) {
        return json(res, 400, { error: { message: "customer_id, contract_number, contract_type, start_date required" } });
      }
      if (!TYPES.has(body.contract_type)) return json(res, 400, { error: { message: "invalid contract_type" } });
      const ins = await svc.from("contracts").upsert({
        tenant_id: ctx.tenantId,
        customer_id: body.customer_id,
        contract_type: body.contract_type,
        contract_number: body.contract_number,
        parent_quote_id: body.parent_quote_id || null,
        start_date: body.start_date,
        end_date: body.end_date || null,
        total_value_inr: body.total_value_inr || null,
        currency: body.currency || "INR",
        status: STATUSES.has(body.status) ? body.status : "ACTIVE",
        notes: body.notes || null,
      }, { onConflict: "tenant_id,contract_number" }).select("*").single();
      if (ins.error) throw new Error(ins.error.message);
      const contractId = ins.data.id;
      if (Array.isArray(body.lines) && body.lines.length) {
        const rows = body.lines.map((ln) => ({
          tenant_id: ctx.tenantId,
          contract_id: contractId,
          part_no: ln.part_no,
          description: ln.description || null,
          qty_committed: Number(ln.qty_committed) || null,
          qty_consumed: Number(ln.qty_consumed) || 0,
          unit_price: Number(ln.unit_price) || null,
          uom: ln.uom || null,
          notes: ln.notes || null,
        }));
        const linesIns = await svc.from("contract_lines").insert(rows);
        if (linesIns.error) throw new Error(linesIns.error.message);
      }
      await recordAudit(ctx, { action: "contract_upsert", objectType: "contract", objectId: contractId, after: ins.data });
      return json(res, 200, { contract: ins.data });
    }
    if (req.method === "DELETE") {
      requirePermission(ctx, "admin");
      const id = req.query.id;
      if (!id) return json(res, 400, { error: { message: "id required" } });
      const { error } = await svc.from("contracts").delete().eq("tenant_id", ctx.tenantId).eq("id", id);
      if (error) throw new Error(error.message);
      await recordAudit(ctx, { action: "contract_delete", objectType: "contract", objectId: id });
      return json(res, 200, { ok: true });
    }
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
