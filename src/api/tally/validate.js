import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { safeFetch } from "../_lib/safe-fetch.js";
import { tallyResolveCompany, tallyDecryptToken } from "../_lib/tally-client.js";

const cleanName = (s) => String(s || "").trim().toLowerCase();

const validateMasters = async (svc, tenantId, so) => {
  const findings = [];
  const lookups = await Promise.all([
    svc.from("tally_masters").select("name").eq("tenant_id", tenantId).eq("master_type", "stock_item"),
    svc.from("tally_masters").select("name").eq("tenant_id", tenantId).eq("master_type", "ledger"),
    svc.from("tally_masters").select("name").eq("tenant_id", tenantId).eq("master_type", "uom"),
    svc.from("tally_masters").select("name").eq("tenant_id", tenantId).eq("master_type", "gst_ledger"),
  ]);
  const stockItems = new Set((lookups[0].data || []).map((r) => cleanName(r.name)));
  const ledgers = new Set((lookups[1].data || []).map((r) => cleanName(r.name)));
  const uoms = new Set((lookups[2].data || []).map((r) => cleanName(r.name)));
  const gstLedgers = new Set((lookups[3].data || []).map((r) => cleanName(r.name)));

  if (stockItems.size === 0) findings.push({ code: "TALLY_MASTERS_EMPTY", severity: "WARNING", detail: "Tally master sync has not been run; nothing to validate against" });

  const partyName = cleanName(so.partyName);
  if (stockItems.size > 0 && partyName && !ledgers.has(partyName)) {
    findings.push({ code: "TALLY_LEDGER_MISSING", severity: "CRITICAL", detail: "Customer ledger '" + so.partyName + "' not in Tally master" });
  }
  (so.lineItems || []).forEach((li, idx) => {
    const itemName = cleanName(li.tallyItemName || li.itemName);
    if (stockItems.size > 0 && itemName && !stockItems.has(itemName)) {
      findings.push({ code: "TALLY_STOCK_ITEM_MISSING", severity: "CRITICAL", line: idx + 1, detail: "Stock item '" + (li.tallyItemName || li.itemName) + "' not in Tally master" });
    }
    const uom = cleanName(li.uom);
    if (uoms.size > 0 && uom && !uoms.has(uom)) {
      findings.push({ code: "TALLY_UOM_MISSING", severity: "WARNING", line: idx + 1, detail: "UOM '" + li.uom + "' not in Tally master" });
    }
  });

  if (gstLedgers.size > 0) {
    const expected = ["cgst", "sgst", "igst"];
    const present = expected.filter((tag) => Array.from(gstLedgers).some((name) => name.includes(tag)));
    if (present.length < 2) findings.push({ code: "TALLY_GST_LEDGER_MISSING", severity: "WARNING", detail: "GST ledgers (CGST/SGST/IGST) appear incomplete in Tally master" });
  }

  const computedTotal = (so.lineItems || []).reduce((s, li) => s + (Number(li.totalWithGst) || 0), 0);
  const stated = Number(so.grandTotal) || 0;
  if (stated && Math.abs(computedTotal - stated) > Math.max(1, stated * 0.01)) {
    findings.push({ code: "TALLY_VOUCHER_UNBALANCED", severity: "CRITICAL", detail: "Line totals " + computedTotal.toFixed(2) + " differ from grand total " + stated.toFixed(2) });
  }

  if (!so.voucherNo) findings.push({ code: "TALLY_VOUCHER_NUMBER_MISSING", severity: "CRITICAL", detail: "Voucher number missing" });
  if (!so.date) findings.push({ code: "TALLY_VOUCHER_DATE_MISSING", severity: "CRITICAL", detail: "Voucher date missing" });

  return findings;
};

// Phase F.6 fix: route the dry-run XML through the same per-tenant
// company resolver the push path uses, so multi-company tenants
// don't get pinned to whatever TALLY_BRIDGE_URL points at. Falls
// back to env when no company resolves (single-company dev).
const tryRemoteDryRun = async (svc, tenantId, xml, companyId) => {
  if (!xml) return { skipped: true, reason: "no_xml" };
  let bridgeUrl = null;
  let bridgeHeaders = { "Content-Type": "text/xml" };
  try {
    const company = await tallyResolveCompany(svc, tenantId, companyId);
    bridgeUrl = company?.bridge_url || process.env.TALLY_BRIDGE_URL || null;
    const tok = tallyDecryptToken(company);
    if (tok) bridgeHeaders.Authorization = "Bearer " + tok;
    else if (process.env.TALLY_BRIDGE_TOKEN) bridgeHeaders.Authorization = "Bearer " + process.env.TALLY_BRIDGE_TOKEN;
  } catch (_e) {
    bridgeUrl = process.env.TALLY_BRIDGE_URL || null;
    if (process.env.TALLY_BRIDGE_TOKEN) bridgeHeaders.Authorization = "Bearer " + process.env.TALLY_BRIDGE_TOKEN;
  }
  if (!bridgeUrl) return { skipped: true, reason: "not_configured" };
  try {
    const resp = await safeFetch(bridgeUrl, { method: "POST", headers: bridgeHeaders, body: xml });
    const text = await resp.text();
    return { status: resp.status, body: text.slice(0, 4000) };
  } catch (err) {
    return { status: 0, error: err.message };
  }
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const body = await readBody(req);
    const so = body.salesOrder;
    if (!so) return json(res, 400, { error: { message: "salesOrder payload required" } });
    const svc = serviceClient();
    const findings = await validateMasters(svc, ctx.tenantId, so);
    const remote = body.attemptDryRun
      ? await tryRemoteDryRun(svc, ctx.tenantId, body.tallyXml, body.companyId || null)
      : null;
    const status = findings.some((f) => f.severity === "CRITICAL") ? "BLOCKED" : "OK";
    await recordAudit(ctx, { action: "tally_validate", objectType: "tally_voucher", objectId: so.voucherNo || null, detail: status + " findings=" + findings.length });
    return json(res, 200, { status, findings, remote });
  } catch (err) {
    sendError(res, err);
  }
}
