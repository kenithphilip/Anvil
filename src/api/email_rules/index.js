// /api/email_rules: rules for the email classifier.
// docs/EMAIL_ACCOUNTABILITY_SCOPE.md 6.2.
//
//   GET                       the tenant's rules and the caller's own rules.
//   POST   { kind, pattern, effect, scope: "tenant" | "me", note }
//   PATCH  { id, active?, pattern?, effect?, note? }
//   DELETE ?id=
//
// A tenant rule needs email.rules (admin). Any writer keeps rules for their
// own mailboxes (scope "me"). Every change is audited.
//
// kind and pattern:
//   trusted_sender, exclusion  an address or "@domain" (exclusion: also a
//                              phrase of the subject or preview)
//   keyword                    a phrase
//   customer                   a customer id of this tenant
//   deadline                   an action type or "*"
// effect: { priority, action_type, due_hours }

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission, hasAction } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { ACTION_TYPES, PRIORITY_RANK } from "../_lib/email-accountability/rules.js";

const KINDS = ["trusted_sender", "keyword", "customer", "exclusion", "deadline"];
const COLUMNS = "id, scope_user_id, kind, pattern, effect, active, note, created_by, created_at, updated_at";
const bad = (res, status, message) => json(res, status, { error: { message } });

// Returns [effect, error].
const cleanEffect = (e = {}) => {
  const out = {};
  if (e.priority !== undefined) {
    if (!PRIORITY_RANK[e.priority]) return [null, "effect.priority must be critical, high, normal or informational"];
    out.priority = e.priority;
  }
  if (e.action_type !== undefined) {
    if (!ACTION_TYPES.includes(e.action_type)) return [null, "effect.action_type must be one of " + ACTION_TYPES.join(", ")];
    out.action_type = e.action_type;
  }
  if (e.due_hours !== undefined) {
    const h = Number(e.due_hours);
    if (!(h > 0 && h <= 720)) return [null, "effect.due_hours must be from 1 to 720"];
    out.due_hours = h;
  }
  return [out, null];
};

const checkPattern = async (svc, ctx, kind, raw) => {
  const p = String(raw || "").trim();
  if (!p || p.length > 200) return [null, "pattern must be 1 to 200 characters"];
  if (kind === "trusted_sender" && !p.includes("@")) return [null, "a trusted sender is an address or @domain"];
  if (kind === "deadline" && p !== "*" && !ACTION_TYPES.includes(p)) return [null, "a deadline rule names an action type or *"];
  if (kind === "customer") {
    const c = await svc.from("customers").select("id").eq("tenant_id", ctx.tenantId).eq("id", p).maybeSingle();
    if (c.error || !c.data) return [null, "the customer is not in this tenant"];
  }
  return [kind === "customer" ? p : p.toLowerCase(), null];
};

const mayEdit = (ctx, rule) => (rule.scope_user_id ? rule.scope_user_id === ctx.user.id : hasAction(ctx, "email.rules"));

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "write");
    const svc = serviceClient();

    if (req.method === "GET") {
      const r = await svc.from("email_rules").select(COLUMNS).eq("tenant_id", ctx.tenantId).order("created_at", { ascending: true });
      if (r.error) throw new Error("rules: " + r.error.message);
      const rules = (r.data || []).filter((x) => !x.scope_user_id || x.scope_user_id === ctx.user.id);
      return json(res, 200, { ok: true, rules, can_edit_tenant_rules: hasAction(ctx, "email.rules") });
    }

    const b = req.method === "POST" || req.method === "PATCH" ? (await readBody(req)) || {} : {};

    if (req.method === "POST") {
      if (!KINDS.includes(b.kind)) return bad(res, 400, "kind must be one of " + KINDS.join(", "));
      const tenantRule = b.scope !== "me";
      if (tenantRule && !hasAction(ctx, "email.rules")) return bad(res, 403, "only an admin can add a tenant rule; use scope \"me\" for your own mailboxes");
      const [pattern, perr] = await checkPattern(svc, ctx, b.kind, b.pattern);
      if (perr) return bad(res, 400, perr);
      const [effect, eerr] = cleanEffect(b.effect);
      if (eerr) return bad(res, 400, eerr);
      const row = {
        tenant_id: ctx.tenantId, scope_user_id: tenantRule ? null : ctx.user.id, kind: b.kind, pattern, effect,
        active: true, note: b.note ? String(b.note).slice(0, 500) : null, created_by: ctx.user.id,
      };
      const ins = await svc.from("email_rules").insert(row).select(COLUMNS);
      if (ins.error) throw new Error("rule insert: " + ins.error.message);
      const rule = ins.data?.[0] || row;
      await recordAudit(ctx, { action: "email_rule_added", objectType: "email_rule", objectId: rule.id || null, after: row });
      return json(res, 200, { ok: true, rule });
    }

    if (req.method === "PATCH" || req.method === "DELETE") {
      const id = req.method === "DELETE" ? req.query?.id : b.id;
      if (!id) return bad(res, 400, "id required");
      const cur = await svc.from("email_rules").select(COLUMNS).eq("tenant_id", ctx.tenantId).eq("id", id).maybeSingle();
      if (cur.error) throw new Error("rule read: " + cur.error.message);
      const rule = cur.data;
      // Another user's rule reads as missing.
      if (!rule || (rule.scope_user_id && rule.scope_user_id !== ctx.user.id)) return bad(res, 404, "rule not found");
      if (!mayEdit(ctx, rule)) return bad(res, 403, "only an admin can change a tenant rule");

      if (req.method === "DELETE") {
        const d = await svc.from("email_rules").delete().eq("tenant_id", ctx.tenantId).eq("id", id);
        if (d.error) throw new Error("rule delete: " + d.error.message);
        await recordAudit(ctx, { action: "email_rule_deleted", objectType: "email_rule", objectId: id, before: rule });
        return json(res, 200, { ok: true });
      }

      const patch = {};
      if (b.active !== undefined) patch.active = !!b.active;
      if (b.note !== undefined) patch.note = b.note ? String(b.note).slice(0, 500) : null;
      if (b.pattern !== undefined) {
        const [pattern, perr] = await checkPattern(svc, ctx, rule.kind, b.pattern);
        if (perr) return bad(res, 400, perr);
        patch.pattern = pattern;
      }
      if (b.effect !== undefined) {
        const [effect, eerr] = cleanEffect(b.effect);
        if (eerr) return bad(res, 400, eerr);
        patch.effect = effect;
      }
      if (!Object.keys(patch).length) return bad(res, 400, "nothing to change");
      const up = await svc.from("email_rules").update({ ...patch, updated_at: new Date().toISOString() })
        .eq("tenant_id", ctx.tenantId).eq("id", id).select(COLUMNS);
      if (up.error) throw new Error("rule update: " + up.error.message);
      await recordAudit(ctx, {
        action: "email_rule_changed", objectType: "email_rule", objectId: id,
        before: Object.fromEntries(Object.keys(patch).map((k) => [k, rule[k] ?? null])), after: patch,
      });
      return json(res, 200, { ok: true, rule: up.data?.[0] || null });
    }

    return bad(res, 405, "method not allowed");
  } catch (err) {
    return sendError(res, err);
  }
}
