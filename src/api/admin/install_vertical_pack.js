// POST /api/admin/install_vertical_pack
//
// Installs a vertical pack (paper-converting / fasteners / pvf /
// electrical / hvac) into the calling tenant. Idempotent per-tenant
// per-pack-version: re-installing the same pack with the same
// content_hash skips the seed inserts but still updates the
// tenant_settings.vertical discriminator.
//
// Pack contents come from src/v3-app/verticals/<id>.json. We read
// the JSON from the API runtime via Node's fs (the file is shipped
// alongside the bundle in the public/ tree at build time).

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { tenantSettings, updateTenantSettings } from "../_lib/stripe-client.js";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Vertical JSON lives in src/v3-app/verticals/. Resolve relative to
// this file: api/admin/install_vertical_pack.js → ../../v3-app/verticals.
const VERTICALS_DIR = resolve(__dirname, "..", "..", "v3-app", "verticals");
const ALLOWED = new Set(["paper_converting", "fasteners", "pvf", "electrical", "hvac"]);

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

const loadPack = async (verticalId) => {
  if (!ALLOWED.has(verticalId)) {
    const err = new Error("Unknown vertical: " + verticalId);
    err.status = 400;
    throw err;
  }
  const path = resolve(VERTICALS_DIR, verticalId + ".json");
  const raw = await readFile(path, "utf8");
  return { pack: JSON.parse(raw), raw };
};

// Per-pack idempotent inserts. We never delete existing tenant data
// — packs only add. If the tenant has overrides, those win on
// subsequent installs (we use insert .. on conflict do nothing for
// approval thresholds and lead times keyed by vertical-pack-marker).
const seedApprovalThresholds = async (svc, tenantId, vertical, rows) => {
  if (!rows?.length) return 0;
  let n = 0;
  for (const t of rows) {
    const ins = await svc.from("approval_thresholds").upsert({
      tenant_id: tenantId,
      level: t.level,
      min_amount: t.min_amount,
      max_amount: t.max_amount,
      currency: t.currency || "USD",
      pack_origin: vertical,
    }, { onConflict: "tenant_id,level,pack_origin", ignoreDuplicates: true });
    if (!ins.error) n += 1;
  }
  return n;
};

const seedLeadTimes = async (svc, tenantId, vertical, lookup) => {
  if (!lookup) return 0;
  let n = 0;
  for (const [code, days] of Object.entries(lookup)) {
    const ins = await svc.from("admin_lead_times").upsert({
      tenant_id: tenantId,
      lead_code: code,
      lead_days: Number(days),
      pack_origin: vertical,
    }, { onConflict: "tenant_id,lead_code,pack_origin", ignoreDuplicates: true });
    if (!ins.error) n += 1;
  }
  return n;
};

const seedLostReasons = async (svc, tenantId, vertical, reasons) => {
  if (!reasons?.length) return 0;
  let n = 0;
  for (const r of reasons) {
    const ins = await svc.from("admin_lost_reasons").upsert({
      tenant_id: tenantId,
      reason: r,
      pack_origin: vertical,
    }, { onConflict: "tenant_id,reason,pack_origin", ignoreDuplicates: true });
    if (!ins.error) n += 1;
  }
  return n;
};

const seedItemMaster = async (svc, tenantId, vertical, examples) => {
  if (!examples?.length) return 0;
  let n = 0;
  for (const it of examples) {
    const ins = await svc.from("item_master").upsert({
      tenant_id: tenantId,
      item_code: it.code,
      description: it.description,
      base_uom: it.uom || "pcs",
      pack_origin: vertical,
    }, { onConflict: "tenant_id,item_code", ignoreDuplicates: true });
    if (!ins.error) n += 1;
  }
  return n;
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "admin");
    const body = await readBody(req);
    const verticalId = String(body?.vertical_id || "").toLowerCase();
    if (!ALLOWED.has(verticalId)) {
      return json(res, 400, { error: { message: "vertical_id must be one of: " + [...ALLOWED].join(", ") } });
    }
    const svc = serviceClient();
    const { pack, raw } = await loadPack(verticalId);
    const contentHash = sha256(raw);

    // Idempotency: if this exact pack version already installed for
    // this tenant, skip the seed pass and just refresh the tenant's
    // vertical discriminator.
    const prior = await svc.from("vertical_pack_installs")
      .select("id, installed_at, details")
      .eq("tenant_id", ctx.tenantId)
      .eq("vertical_id", verticalId)
      .eq("content_hash", contentHash)
      .maybeSingle();

    let details = prior.data?.details || {};
    if (!prior.data) {
      const at = await seedApprovalThresholds(svc, ctx.tenantId, verticalId, pack.approval_thresholds);
      const lt = await seedLeadTimes(svc, ctx.tenantId, verticalId, pack.lead_time_defaults_days);
      const lr = await seedLostReasons(svc, ctx.tenantId, verticalId, pack.lost_reasons);
      const im = await seedItemMaster(svc, ctx.tenantId, verticalId, pack.item_master_examples);
      details = { approval_thresholds: at, lead_times: lt, lost_reasons: lr, item_master: im };
      await svc.from("vertical_pack_installs").insert({
        tenant_id: ctx.tenantId,
        vertical_id: verticalId,
        pack_version: pack.version || 1,
        content_hash: contentHash,
        installed_by: ctx.userId || null,
        details,
      });
    }

    await tenantSettings(svc, ctx.tenantId);
    await updateTenantSettings(svc, ctx.tenantId, {
      vertical: verticalId,
      vertical_kpis: pack.kpis || [],
      vertical_quote_template: pack.quote_template || null,
    });

    await recordAudit(ctx, {
      action: "install_vertical_pack",
      objectType: "tenant_settings",
      objectId: ctx.tenantId,
      detail: verticalId + "::v" + (pack.version || 1) + "::" + (prior.data ? "already_installed" : "fresh_install"),
    });

    return json(res, 200, {
      ok: true,
      vertical_id: verticalId,
      pack_version: pack.version || 1,
      content_hash: contentHash,
      already_installed: !!prior.data,
      details,
      kpis: pack.kpis || [],
    });
  } catch (err) {
    return sendError(res, err);
  }
}
