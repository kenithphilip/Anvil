// GET or POST /api/tally/diagnostics?companyId=...
//
// Probes the Tally bridge: hits /health, then a minimal /sync probe
// (since=now, expects empty list), then /payments. Reports per-probe
// status, latency, and parsed JSON. Operators run this when a push
// fails to verify whether the bridge or Tally itself is the issue.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { tallyResolveCompany, tallyHealth, tallySyncVouchers, tallySyncPayments } from "../_lib/tally-client.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const svc = serviceClient();
    const companyId = req.query?.companyId
      || new URL(req.url, "http://x").searchParams.get("companyId");
    const company = await tallyResolveCompany(svc, ctx.tenantId, companyId);
    if (!company) {
      return json(res, 200, {
        configured: false,
        probes: [],
        notes: ["No Tally company configured"],
      });
    }
    if (!company.bridge_url) {
      return json(res, 200, {
        configured: false,
        company: company.name,
        probes: [],
        notes: ["Company has no bridge URL"],
      });
    }

    const probes = [];

    // Health.
    const h = await tallyHealth(company);
    probes.push({
      probe: "health",
      ok: h.ok,
      status: h.status,
      latency_ms: h.latency_ms,
      body: h.body,
    });

    // Sync (since=now to get an empty list quickly, just to test the endpoint).
    const sinceNow = new Date().toISOString();
    const s = await tallySyncVouchers(company, sinceNow).catch((err) => ({
      ok: false, status: 0, body: { error: err.message },
    }));
    probes.push({
      probe: "sync",
      ok: s.ok,
      status: s.status,
      vouchers_returned: (s.body?.vouchers || []).length,
    });

    // Payments.
    const p = await tallySyncPayments(company, sinceNow).catch((err) => ({
      ok: false, status: 0, body: { error: err.message },
    }));
    probes.push({
      probe: "payments",
      ok: p.ok,
      status: p.status,
      receipts_returned: (p.body?.receipts || []).length,
    });

    // Update health snapshot on the row.
    const allOk = probes.every((x) => x.ok);
    await svc.from("tally_companies").update({
      last_health_at: new Date().toISOString(),
      last_health_status: allOk ? "ok" : (probes[0].ok ? "degraded" : "down"),
      last_health_error: allOk ? null : JSON.stringify(probes.filter((x) => !x.ok)).slice(0, 800),
    }).eq("id", company.id);

    return json(res, 200, {
      configured: true,
      company: company.name,
      bridge_url: company.bridge_url,
      probes,
      summary: { all_ok: allOk, total: probes.length, failed: probes.filter((p) => !p.ok).length },
      ran_at: new Date().toISOString(),
    });
  } catch (err) {
    sendError(res, err);
  }
}
