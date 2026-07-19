// /api/fmeca - FMECA criticality (reliability step 4c). See docs/FMECA_DESIGN.md.
//   GET ?view=catalog                     -> failure_mode_catalog (global + tenant)
//   GET ?view=suggest[&part_no=]          -> occurrence suggestions from failure_events
//   GET (default)[&part_no=]              -> fmeca_criticality rows (RPN-sorted) + mode labels
//   POST { kind:"mode", code, label, category }        -> upsert a tenant failure mode
//   POST { kind:"fmeca", part_no, failure_mode_id, severity, occurrence, detection, ... }
//                                          -> upsert an FMECA record (rpn is DB-generated)
//   DELETE ?id=                           -> delete an FMECA record
//
// item_id on fmeca_criticality is auto-resolved from part_no by the shared DB
// trigger (mig 178 reuses 171), so this endpoint keys on part_no. Additive +
// isolated -- it does not touch quotes, the (s,S) sheet, or the planning cron.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { suggestOccurrence } from "../_lib/fmeca.js";

const HISTORY_WEEKS = 104;
const sod = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 1 && n <= 10 ? n : null; };
const cleanStr = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();
    const tenantOrGlobal = `tenant_id.is.null,tenant_id.eq.${ctx.tenantId}`;

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const view = req.query.view;

      if (view === "catalog") {
        const { data, error } = await svc.from("failure_mode_catalog").select("*")
          .or(tenantOrGlobal).eq("active", true).order("label");
        if (error) throw new Error(error.message);
        return json(res, 200, { modes: data || [] });
      }

      if (view === "suggest") {
        // Same window + event-type filter the planning cron uses, so demand and
        // criticality agree on what a "failure" is.
        const since = new Date(Date.now() - HISTORY_WEEKS * 7 * 86400000).toISOString();
        let q = svc.from("failure_events").select("item_id, part_no, failure_mode, event_type, failed_at")
          .eq("tenant_id", ctx.tenantId).gte("failed_at", since)
          .in("event_type", ["breakdown", "replacement"]);
        if (req.query.part_no) q = q.eq("part_no", req.query.part_no);
        const { data, error } = await q;
        if (error) throw new Error(error.message);
        const agg = new Map();
        (data || []).forEach((r) => {
          const key = `${r.item_id || ""}|${r.part_no || ""}|${(r.failure_mode || "").toLowerCase()}`;
          const cur = agg.get(key) || { item_id: r.item_id || null, part_no: r.part_no || null, failure_mode: r.failure_mode || null, count: 0 };
          cur.count += 1; agg.set(key, cur);
        });
        const suggestions = Array.from(agg.values())
          .map((s) => ({ ...s, window_weeks: HISTORY_WEEKS, suggested_occurrence: suggestOccurrence({ count: s.count, windowWeeks: HISTORY_WEEKS }) }))
          .sort((a, b) => b.count - a.count);
        return json(res, 200, { suggestions });
      }

      let q = svc.from("fmeca_criticality").select("*").eq("tenant_id", ctx.tenantId)
        .order("rpn", { ascending: false, nullsFirst: false }).limit(2000);
      if (req.query.part_no) q = q.eq("part_no", req.query.part_no);
      const rows = await q;
      if (rows.error) throw new Error(rows.error.message);
      const modeIds = [...new Set((rows.data || []).map((r) => r.failure_mode_id).filter(Boolean))];
      const modeMap = {};
      if (modeIds.length) {
        const { data: modes } = await svc.from("failure_mode_catalog").select("id, code, label, category").in("id", modeIds);
        (modes || []).forEach((m) => { modeMap[m.id] = m; });
      }
      return json(res, 200, { rows: (rows.data || []).map((r) => ({ ...r, mode: modeMap[r.failure_mode_id] || null })) });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      const kind = body.kind || "fmeca";

      if (kind === "mode") {
        const code = cleanStr(body.code);
        const label = cleanStr(body.label);
        if (!code || !label) return json(res, 400, { error: { message: "code and label required" } });
        const row = {
          tenant_id: ctx.tenantId,
          code: code.toUpperCase().replace(/\s+/g, "_").slice(0, 60),
          label,
          category: cleanStr(body.category),
          active: body.active !== false,
        };
        const result = await svc.from("failure_mode_catalog").upsert(row, { onConflict: "tenant_id,code" }).select("*").single();
        if (result.error) throw new Error(result.error.message);
        await recordAudit(ctx, { action: "fmeca_mode_upsert", objectType: "failure_mode_catalog", objectId: result.data.id, detail: row.code });
        return json(res, 200, { mode: result.data });
      }

      // kind === "fmeca". item_id is trigger-derived from part_no, so require part_no.
      if (!cleanStr(body.part_no)) return json(res, 400, { error: { message: "part_no required" } });
      if (!body.failure_mode_id) return json(res, 400, { error: { message: "failure_mode_id required" } });
      // The mode must be global or belong to this tenant (never trust a raw id).
      const mode = await svc.from("failure_mode_catalog").select("id").eq("id", body.failure_mode_id).or(tenantOrGlobal).maybeSingle();
      if (mode.error) throw new Error(mode.error.message);
      if (!mode.data) return json(res, 400, { error: { message: "failure_mode not found in this tenant." } });

      const row = {
        tenant_id: ctx.tenantId,
        part_no: cleanStr(body.part_no),
        failure_mode_id: body.failure_mode_id,
        asset_class: cleanStr(body.asset_class),
        severity: sod(body.severity),
        occurrence: sod(body.occurrence),
        detection: sod(body.detection),
        suggested_occurrence: sod(body.suggested_occurrence),
        occurrence_basis: (body.occurrence_basis && typeof body.occurrence_basis === "object" && !Array.isArray(body.occurrence_basis)) ? body.occurrence_basis : {},
        notes: cleanStr(body.notes),
        created_by: ctx.user?.id || null,
        updated_at: new Date().toISOString(),
      };
      const result = await svc.from("fmeca_criticality").upsert(row, { onConflict: "tenant_id,part_no,failure_mode_id" }).select("*").single();
      if (result.error) throw new Error(result.error.message);
      await recordAudit(ctx, { action: "fmeca_upsert", objectType: "fmeca_criticality", objectId: result.data.id, detail: result.data.rpn != null ? "rpn=" + result.data.rpn : null });
      return json(res, 200, { row: result.data });
    }

    if (req.method === "DELETE") {
      requirePermission(ctx, "write");
      const id = req.query.id;
      if (!id) return json(res, 400, { error: { message: "id required" } });
      const { error } = await svc.from("fmeca_criticality").delete().eq("tenant_id", ctx.tenantId).eq("id", id);
      if (error) throw new Error(error.message);
      await recordAudit(ctx, { action: "fmeca_delete", objectType: "fmeca_criticality", objectId: id });
      return json(res, 200, { ok: true });
    }

    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
