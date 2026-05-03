// /api/admin/diagnostics
//   GET   returns a tenant-scoped health snapshot (row counts per critical
//         table, integration env-var presence, last cron run timestamps,
//         storage stats). Read-only; admin role required.
//
// The v3 Admin Center > Diagnostics tab consumes this. Designed to be
// safe to call frequently (cached for 10 seconds in-memory).

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";

const CACHE = new Map(); // tenantId -> { at: number, payload: object }
const CACHE_MS = 10_000;

const CRITICAL_TABLES = [
  "tenants",
  "tenant_members",
  "customers",
  "customer_locations",
  "orders",
  "documents",
  "audit_events",
  "tally_voucher_records",
  "einvoices",
  "service_visits",
  "amc_schedules",
  "spare_recommendations",
  "model_routing_log",
  "redaction_rules",
];

const INTEGRATIONS = [
  { id: "anthropic",   env: ["ANTHROPIC_API_KEY"],                       label: "Anthropic Claude API" },
  { id: "mistral_ocr", env: ["MISTRAL_API_KEY"],                         label: "Mistral OCR" },
  { id: "clamav",      env: ["CLAMAV_URL", "CLAMAV_TOKEN"],              label: "ClamAV scanner" },
  { id: "tally",       env: ["TALLY_BRIDGE_URL", "TALLY_BRIDGE_TOKEN"],  label: "Tally bridge" },
  { id: "gstn",        env: ["GSTN_API_URL", "GSTN_API_KEY"],            label: "GSTN e-Invoice" },
  { id: "comms",       env: ["COMMS_PROVIDER_URL", "COMMS_PROVIDER_TOKEN"], label: "Comms provider" },
  { id: "email",       env: ["EMAIL_INBOUND_TOKEN"],                     label: "Inbound email webhook" },
  { id: "fx",          env: ["FX_PROVIDER_URL"],                         label: "FX provider" },
  { id: "cron",        env: ["CRON_SECRET"],                             label: "Vercel cron secret" },
];

async function rowCount(svc, table, tenantId) {
  // Use head:true and count:exact for an accurate row count without
  // pulling rows. tenant_id filter applied where the column exists.
  try {
    let q = svc.from(table).select("*", { count: "exact", head: true });
    // tenants and global tables aren't tenant-scoped; skip filter for those
    const SKIP_FILTER = new Set(["tenants"]);
    if (!SKIP_FILTER.has(table)) {
      q = q.eq("tenant_id", tenantId);
    }
    const { count, error } = await q;
    if (error) return { count: null, error: error.message };
    return { count: count ?? 0 };
  } catch (e) {
    return { count: null, error: e.message || String(e) };
  }
}

async function lastCronRun(svc, action, tenantId) {
  // Look at audit_events for the cron's most recent successful run.
  try {
    const { data, error } = await svc
      .from("audit_events")
      .select("created_at, action, detail")
      .eq("tenant_id", tenantId)
      .ilike("action", action + "%")
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) return null;
    return data?.[0]?.created_at || null;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "admin");

    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return json(res, 405, { error: "Method not allowed" });
    }

    // Cache per tenant for 10s to avoid spamming when the tab polls.
    const cached = CACHE.get(ctx.tenantId);
    if (cached && Date.now() - cached.at < CACHE_MS) {
      return json(res, 200, { cached: true, ...cached.payload });
    }

    const svc = serviceClient();

    // Row counts
    const counts = {};
    for (const t of CRITICAL_TABLES) {
      counts[t] = await rowCount(svc, t, ctx.tenantId);
    }

    // Integration presence (environment variable check, not a live ping)
    const integrations = INTEGRATIONS.map((spec) => {
      const present = spec.env.every((k) => !!process.env[k]);
      return {
        id: spec.id,
        label: spec.label,
        env: spec.env,
        configured: present,
      };
    });

    // Cron last-runs
    const crons = {
      fx: await lastCronRun(svc, "fx_cron", ctx.tenantId),
      amc: await lastCronRun(svc, "amc_cron", ctx.tenantId),
    };

    // Storage: best-effort buckets list (service role can list; we don't
    // count objects to avoid accidental N=million queries).
    let storage = null;
    try {
      const { data, error } = await svc.storage.listBuckets();
      if (!error) {
        storage = {
          buckets: (data || []).map((b) => ({
            id: b.id,
            name: b.name,
            public: b.public,
          })),
        };
      } else {
        storage = { error: error.message };
      }
    } catch (e) {
      storage = { error: e.message };
    }

    const payload = {
      tenant_id: ctx.tenantId,
      generated_at: new Date().toISOString(),
      schema: {
        migration_count: 10,
        critical_tables: CRITICAL_TABLES.length,
        counts,
      },
      integrations,
      crons,
      storage,
      runtime: {
        node: process.version,
        region: process.env.VERCEL_REGION || "local",
        deployment: process.env.VERCEL_URL || "local",
      },
    };

    CACHE.set(ctx.tenantId, { at: Date.now(), payload });
    return json(res, 200, payload);
  } catch (err) {
    return sendError(res, err);
  }
}
