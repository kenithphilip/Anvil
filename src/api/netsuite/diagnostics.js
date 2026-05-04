// GET or POST /api/netsuite/diagnostics
//
// Runs a deeper probe than /health: calls a minimal SuiteQL on
// every record type we care about, reports per-entity reachability,
// schema validity, and latency. Operators run this when "the sync
// hasn't moved in an hour" before opening a support ticket.
//
// Returns an array of probes; each has { entity, ok, status, latency_ms,
// rows_returned, sample_id, error }. The UI flags any non-ok rows.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { tenantSettings } from "../_lib/stripe-client.js";
import { suiteql, netsuiteIsConfigured } from "../_lib/netsuite-client.js";
import { decryptNetsuiteCreds, isSecretsConfigured } from "../_lib/secrets.js";

const PROBES = [
  { entity: "customer",       sql: "SELECT id FROM customer FETCH FIRST 1 ROWS ONLY" },
  { entity: "item",           sql: "SELECT id FROM item FETCH FIRST 1 ROWS ONLY" },
  { entity: "vendor",         sql: "SELECT id FROM vendor FETCH FIRST 1 ROWS ONLY" },
  { entity: "sales_order",    sql: "SELECT id FROM transaction WHERE type='SalesOrd' FETCH FIRST 1 ROWS ONLY" },
  { entity: "purchase_order", sql: "SELECT id FROM transaction WHERE type='PurchOrd' FETCH FIRST 1 ROWS ONLY" },
  { entity: "location",       sql: "SELECT id FROM location FETCH FIRST 1 ROWS ONLY" },
  { entity: "currency",       sql: "SELECT id FROM currency FETCH FIRST 1 ROWS ONLY" },
  { entity: "inventory",      sql: "SELECT item FROM inventoryitemlocations FETCH FIRST 1 ROWS ONLY" },
];

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const svc = serviceClient();
    const settingsRaw = await tenantSettings(svc, ctx.tenantId);
    const settings = decryptNetsuiteCreds(settingsRaw);
    if (!netsuiteIsConfigured(settings)) {
      return json(res, 200, {
        configured: false,
        secrets_key_present: isSecretsConfigured(),
        probes: [],
        notes: ["NetSuite not configured for this tenant"],
      });
    }

    const out = [];
    for (const p of PROBES) {
      const t0 = Date.now();
      try {
        const r = await suiteql(settings, p.sql, { limit: 1 });
        out.push({
          entity: p.entity,
          ok: r.ok,
          status: r.status,
          latency_ms: Date.now() - t0,
          rows_returned: (r.body?.items || []).length,
          sample_id: r.body?.items?.[0]?.id || null,
          error: r.ok ? null : (r.body?.["o:errorDetails"] || r.body?.error || r.body?.raw || "unknown"),
        });
      } catch (err) {
        out.push({
          entity: p.entity,
          ok: false,
          status: 0,
          latency_ms: Date.now() - t0,
          rows_returned: 0,
          sample_id: null,
          error: err.message || String(err),
        });
      }
    }

    const allOk = out.every((p) => p.ok);
    return json(res, 200, {
      configured: true,
      secrets_key_present: isSecretsConfigured(),
      account_id: settingsRaw?.netsuite_account_id || null,
      probes: out,
      summary: { all_ok: allOk, total: out.length, failed: out.filter((p) => !p.ok).length },
      ran_at: new Date().toISOString(),
    });
  } catch (err) {
    sendError(res, err);
  }
}
