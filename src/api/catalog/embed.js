// /api/catalog/embed
//
// Audit P8.4 + P12. Catalog embedding indexer.
//
//   GET    /api/catalog/embed                   inspect what would be re-embedded
//   POST   /api/catalog/embed { ids?, target? } embed specific ids or every row
//                                                missing an embedding. `target`:
//                                                'items' | 'synonyms' | 'both'
//                                                (default 'both').
//
// Cron-callable with Bearer CRON_SECRET to drain `embedding is null`
// rows for every tenant in batches of 64. Manual admin invocation
// runs only against the caller's tenant.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { voyageEmbed, voyageIsConfigured, itemEmbedText, synonymEmbedText } from "../_lib/voyage.js";

const CRON_SECRET = process.env.CRON_SECRET;
const BATCH_SIZE = 64;
const MAX_BATCHES_PER_RUN = 16;

// Audit P12. Pluggable target table descriptor: which table to
// drain, what columns to select, what fields to embed, what
// columns to update on success. Lets one drainTenant loop work
// for both item_master and catalog_synonyms.
const TARGETS = {
  items: {
    table: "item_master",
    selectCols: "id, part_no, description, item_group, sub_category, embedding",
    buildText: itemEmbedText,
  },
  synonyms: {
    table: "catalog_synonyms",
    selectCols: "id, item_id, synonym, embedding",
    buildText: synonymEmbedText,
  },
};

const fetchPending = async (svc, target, tenantId, ids) => {
  let q = svc.from(target.table)
    .select(target.selectCols)
    .order("created_at", { ascending: true })
    .limit(BATCH_SIZE);
  if (tenantId) q = q.eq("tenant_id", tenantId);
  if (ids && ids.length) q = q.in("id", ids);
  else q = q.is("embedding", null);
  const r = await q;
  if (r.error) throw new Error(r.error.message);
  return r.data || [];
};

const embedAndPersist = async (svc, target, tenantId, rows) => {
  const inputs = rows.map((it) => target.buildText(it));
  const result = await voyageEmbed(inputs, { input_type: "document" });
  if (!result.ok) return { embedded: 0, error: result.error };
  let embedded = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const it = rows[i];
    const vec = result.vectors[i];
    if (!vec || !Array.isArray(vec)) continue;
    const upd = await svc.from(target.table).update({
      embedding: vec,
      embedding_model: result.model,
      embedding_text: inputs[i],
      embedded_at: new Date().toISOString(),
    }).eq("tenant_id", tenantId || it.tenant_id).eq("id", it.id);
    if (!upd.error) embedded += 1;
  }
  return { embedded, model: result.model };
};

const drainOneTarget = async (svc, target, tenantId, opts) => {
  const ids = Array.isArray(opts?.ids) ? opts.ids : null;
  let batches = 0;
  let totalEmbedded = 0;
  let lastError = null;
  while (batches < MAX_BATCHES_PER_RUN) {
    const rows = await fetchPending(svc, target, tenantId, ids);
    if (!rows.length) break;
    const r = await embedAndPersist(svc, target, tenantId, rows);
    if (r.error) { lastError = r.error; break; }
    totalEmbedded += r.embedded;
    batches += 1;
    if (ids) break;            // explicit-id runs are single-pass
    if (rows.length < BATCH_SIZE) break;
  }
  return { embedded: totalEmbedded, batches, error: lastError };
};

const drainTenant = async (svc, tenantId, opts) => {
  // Audit P12. Pick which targets to drain. Default = both.
  const targetsArg = opts?.target || "both";
  const which = targetsArg === "items" ? ["items"]
              : targetsArg === "synonyms" ? ["synonyms"]
              : ["items", "synonyms"];
  const out = { tenant_id: tenantId, embedded: 0, by_target: {} };
  let firstError = null;
  for (const key of which) {
    const r = await drainOneTarget(svc, TARGETS[key], tenantId, opts);
    out.by_target[key] = r;
    out.embedded += r.embedded;
    if (r.error && !firstError) firstError = r.error;
  }
  if (firstError) out.error = firstError;
  return out;
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    if (!voyageIsConfigured()) {
      return json(res, 503, { error: { message: "VOYAGE_API_KEY not configured" } });
    }
    const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const isCron = !!CRON_SECRET && auth === CRON_SECRET;
    const svc = serviceClient();

    if (req.method === "GET") {
      const ctx = await resolveContext(req);
      requirePermission(ctx, "read");
      const itemsPending = await svc.from("item_master")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", ctx.tenantId)
        .is("embedding", null);
      const synPending = await svc.from("catalog_synonyms")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", ctx.tenantId)
        .is("embedding", null);
      return json(res, 200, {
        tenant_id: ctx.tenantId,
        pending_items: itemsPending.count || 0,
        pending_synonyms: synPending.count || 0,
        batch_size: BATCH_SIZE,
        max_batches_per_run: MAX_BATCHES_PER_RUN,
      });
    }

    if (req.method === "POST") {
      if (isCron) {
        const tenants = await svc.from("tenants").select("id").limit(1000);
        if (tenants.error) throw new Error(tenants.error.message);
        const out = [];
        for (const t of tenants.data || []) {
          out.push(await drainTenant(svc, t.id, {}));
        }
        const total = out.reduce((s, r) => s + (r.embedded || 0), 0);
        return json(res, 200, { ran_at: new Date().toISOString(), tenants_considered: out.length, embedded: total, results: out });
      }
      const ctx = await resolveContext(req);
      requirePermission(ctx, "write");
      const body = await readBody(req);
      const out = await drainTenant(svc, ctx.tenantId, { ids: body?.ids, target: body?.target });
      await recordAudit(ctx, {
        action: "catalog_embed",
        objectType: "tenant",
        objectId: ctx.tenantId,
        detail: "embedded=" + out.embedded + " target=" + (body?.target || "both"),
      });
      return json(res, 200, out);
    }

    res.setHeader("Allow", "GET, POST");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) { sendError(res, err); }
}
