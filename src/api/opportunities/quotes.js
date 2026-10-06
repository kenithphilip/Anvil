// /api/opportunities/quotes
//
// Uploaded external quote revisions per opportunity (migration 203). Each row is
// one PDF the sales engineer sent to the customer (budgetary -> revised ->
// discount/final), with the deal size at that revision + who it went to (primary
// + CC contacts). Distinct from the generate-a-quote `quotes` table.
//
// GET    ?opportunity_id=<uuid>   list revisions (newest version first) + recipients
// POST                            add a revision (auto-numbers the version)
//        body: { opportunity_id, quote_type?, document_id?, original_filename?,
//                amount?, amount_currency?, change_note?, status?, supersedes_id?,
//                recipients?: [{ contact_id?, kind: 'to'|'cc', email?, name? }] }
// PATCH  ?id=<uuid>               update status / amount / type / note (+ recipients)
// DELETE ?id=<uuid>               remove a revision

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const QUOTE_TYPES = new Set(["budgetary", "revised", "final", "discount"]);
const STATUSES = new Set(["draft", "sent", "accepted", "declined", "superseded"]);
const ALLOWED_PATCH = new Set(["quote_type", "amount", "amount_currency", "change_note", "status", "document_id", "original_filename"]);

const num = (v) => { if (v == null || v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : null; };

// Normalise a recipients[] payload into insertable rows (snapshotting email/name).
const recipientRows = (recipients, tenantId, quoteId) =>
  (Array.isArray(recipients) ? recipients : [])
    .filter((r) => r && (r.contact_id || r.email))
    .map((r) => ({
      tenant_id: tenantId,
      opportunity_quote_id: quoteId,
      contact_id: r.contact_id || null,
      kind: r.kind === "cc" ? "cc" : "to",
      email: r.email ? String(r.email).trim() : null,
      name: r.name ? String(r.name).trim() : null,
    }));

const listRecipients = async (svc, tenantId, quoteIds) => {
  if (!quoteIds.length) return {};
  const q = await svc.from("opportunity_quote_recipients")
    .select("id, opportunity_quote_id, contact_id, kind, email, name")
    .eq("tenant_id", tenantId).in("opportunity_quote_id", quoteIds);
  if (q.error) throw new Error("recipients read: " + q.error.message);
  const byQuote = {};
  for (const r of q.data || []) (byQuote[r.opportunity_quote_id] = byQuote[r.opportunity_quote_id] || []).push(r);
  return byQuote;
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const opportunityId = req.query.opportunity_id;
      if (!opportunityId) return json(res, 400, { error: { message: "opportunity_id required" } });
      const q = await svc.from("opportunity_quotes")
        .select("*")
        .eq("tenant_id", ctx.tenantId).eq("opportunity_id", opportunityId)
        .order("version", { ascending: false });
      if (q.error) throw new Error(q.error.message);
      const quotes = q.data || [];
      const recips = await listRecipients(svc, ctx.tenantId, quotes.map((x) => x.id));
      return json(res, 200, { quotes: quotes.map((x) => ({ ...x, recipients: recips[x.id] || [] })) });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      if (!body?.opportunity_id) return json(res, 400, { error: { message: "opportunity_id required" } });
      if (body.quote_type && !QUOTE_TYPES.has(body.quote_type)) return json(res, 400, { error: { message: "invalid quote_type" } });
      if (body.status && !STATUSES.has(body.status)) return json(res, 400, { error: { message: "invalid status" } });

      // The opportunity must belong to this tenant; grab its customer_id to denormalise.
      const oppQ = await svc.from("opportunities").select("id, customer_id")
        .eq("tenant_id", ctx.tenantId).eq("id", body.opportunity_id).maybeSingle();
      if (oppQ.error) throw new Error("opportunity read: " + oppQ.error.message);
      if (!oppQ.data) return json(res, 404, { error: { message: "Opportunity not found" } });

      const status = body.status && STATUSES.has(body.status) ? body.status : "draft";
      const nowIso = new Date().toISOString();
      const baseRow = {
        tenant_id: ctx.tenantId,
        opportunity_id: body.opportunity_id,
        customer_id: oppQ.data.customer_id || null,
        supersedes_id: body.supersedes_id || null,
        quote_type: body.quote_type && QUOTE_TYPES.has(body.quote_type) ? body.quote_type : "budgetary",
        document_id: body.document_id || null,
        original_filename: body.original_filename || null,
        amount: num(body.amount),
        amount_currency: body.amount_currency || "INR",
        status,
        change_note: body.change_note || null,
        created_by: ctx.user?.id || null,
        sent_at: status === "sent" ? nowIso : null,
        sent_by: status === "sent" ? (ctx.user?.id || null) : null,
      };

      // Version = next after the opportunity's current max. Retry once on the
      // unique(tenant_id, opportunity_id, version) race.
      let inserted = null;
      for (let attempt = 0; attempt < 2 && !inserted; attempt += 1) {
        const maxQ = await svc.from("opportunity_quotes").select("version")
          .eq("tenant_id", ctx.tenantId).eq("opportunity_id", body.opportunity_id)
          .order("version", { ascending: false }).limit(1).maybeSingle();
        if (maxQ.error) throw new Error("version read: " + maxQ.error.message);
        const version = ((maxQ.data && maxQ.data.version) || 0) + 1;
        const ins = await svc.from("opportunity_quotes").insert({ ...baseRow, version }).select("*").single();
        if (!ins.error) { inserted = ins.data; break; }
        if (ins.error.code === "23505") continue;   // version raced — recompute
        throw new Error("opportunity_quotes insert: " + ins.error.message);
      }
      if (!inserted) return json(res, 409, { error: { message: "Could not allocate a quote version — retry." } });

      // Mark the prior revision superseded (best-effort).
      if (baseRow.supersedes_id) {
        await svc.from("opportunity_quotes").update({ status: "superseded", updated_at: nowIso })
          .eq("tenant_id", ctx.tenantId).eq("id", baseRow.supersedes_id).neq("status", "accepted");
      }

      const rrows = recipientRows(body.recipients, ctx.tenantId, inserted.id);
      if (rrows.length) {
        const rIns = await svc.from("opportunity_quote_recipients").insert(rrows);
        if (rIns.error) throw new Error("recipients insert: " + rIns.error.message);
      }

      await recordAudit(ctx, {
        action: "opportunity_quote_add",
        objectType: "opportunity",
        objectId: body.opportunity_id,
        detail: "v" + inserted.version + " " + inserted.quote_type + " (" + status + ")",
      });
      return json(res, 200, { quote: { ...inserted, recipients: rrows } });
    }

    if (req.method === "PATCH") {
      requirePermission(ctx, "write");
      const id = req.query.id;
      if (!id) return json(res, 400, { error: { message: "id required" } });
      const body = await readBody(req);
      const patch = { updated_at: new Date().toISOString() };
      for (const k of Object.keys(body || {})) if (ALLOWED_PATCH.has(k)) patch[k] = body[k];
      if (patch.quote_type && !QUOTE_TYPES.has(patch.quote_type)) return json(res, 400, { error: { message: "invalid quote_type" } });
      if (patch.status && !STATUSES.has(patch.status)) return json(res, 400, { error: { message: "invalid status" } });
      if ("amount" in patch) patch.amount = num(patch.amount);
      // Stamp sent_at/sent_by when a revision is marked sent for the first time.
      if (patch.status === "sent") { patch.sent_at = new Date().toISOString(); patch.sent_by = ctx.user?.id || null; }

      const upd = await svc.from("opportunity_quotes").update(patch)
        .eq("tenant_id", ctx.tenantId).eq("id", id).select("*").maybeSingle();
      if (upd.error) throw new Error(upd.error.message);
      if (!upd.data) return json(res, 404, { error: { message: "Quote revision not found" } });

      // Replace recipients when the caller sends a recipients[] array.
      if (Array.isArray(body.recipients)) {
        await svc.from("opportunity_quote_recipients").delete().eq("tenant_id", ctx.tenantId).eq("opportunity_quote_id", id);
        const rrows = recipientRows(body.recipients, ctx.tenantId, id);
        if (rrows.length) {
          const rIns = await svc.from("opportunity_quote_recipients").insert(rrows);
          if (rIns.error) throw new Error("recipients insert: " + rIns.error.message);
        }
      }
      await recordAudit(ctx, { action: "opportunity_quote_update", objectType: "opportunity", objectId: upd.data.opportunity_id, detail: "v" + upd.data.version + " -> " + upd.data.status });
      return json(res, 200, { quote: upd.data });
    }

    if (req.method === "DELETE") {
      requirePermission(ctx, "write");
      const id = req.query.id;
      if (!id) return json(res, 400, { error: { message: "id required" } });
      const del = await svc.from("opportunity_quotes").delete()
        .eq("tenant_id", ctx.tenantId).eq("id", id).select("id, opportunity_id").maybeSingle();
      if (del.error) throw new Error(del.error.message);
      if (!del.data) return json(res, 404, { error: { message: "Quote revision not found" } });
      await recordAudit(ctx, { action: "opportunity_quote_delete", objectType: "opportunity", objectId: del.data.opportunity_id, detail: "quote=" + id });
      return json(res, 200, { ok: true });
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    return sendError(res, err);
  }
}
