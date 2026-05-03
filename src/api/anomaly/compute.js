import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";

const median = (arr) => {
  if (!arr.length) return 0;
  const sorted = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};

const mad = (arr) => {
  if (arr.length < 2) return 0;
  const m = median(arr);
  return median(arr.map((v) => Math.abs(v - m)));
};

const robustZ = (value, sample) => {
  if (sample.length < 2) return 0;
  const m = median(sample);
  const dispersion = mad(sample) || (sample.length ? Math.max(1, m * 0.05) : 1);
  return (value - m) / dispersion;
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const body = await readBody(req);
    const customerId = body.customerId;
    const candidate = body.candidate;
    if (!customerId || !candidate) return json(res, 400, { error: { message: "customerId and candidate required" } });
    const svc = serviceClient();
    const { data, error } = await svc.from("orders").select("result").eq("tenant_id", ctx.tenantId).eq("customer_id", customerId).not("result", "is", null).order("created_at", { ascending: false }).limit(40);
    if (error) throw new Error(error.message);
    const totals = [];
    const lineCounts = [];
    const partRates = {};
    (data || []).forEach((row) => {
      const so = row.result && row.result.salesOrder;
      if (!so) return;
      if (so.grandTotal) totals.push(Number(so.grandTotal));
      if (Array.isArray(so.lineItems)) {
        lineCounts.push(so.lineItems.length);
        so.lineItems.forEach((li) => {
          const key = (li.tallyItemName || li.itemName || "").toUpperCase();
          if (!key || !li.rate) return;
          partRates[key] = partRates[key] || [];
          partRates[key].push(Number(li.rate));
        });
      }
    });
    const flags = [];
    const candTotal = Number(candidate.grandTotal) || 0;
    const totalZ = robustZ(candTotal, totals);
    if (Math.abs(totalZ) > 2 && totals.length >= 3) {
      flags.push({ key: "grand_total", severity: Math.abs(totalZ) > 3 ? "high" : "medium", label: "Order value " + (totalZ > 0 ? "above" : "below") + " typical", detail: "Robust z=" + totalZ.toFixed(2) + " vs median " + median(totals).toLocaleString("en-IN") });
    }
    const candLineCount = Array.isArray(candidate.lineItems) ? candidate.lineItems.length : 0;
    const lineZ = robustZ(candLineCount, lineCounts);
    if (Math.abs(lineZ) > 2 && lineCounts.length >= 3) {
      flags.push({ key: "line_count", severity: Math.abs(lineZ) > 3 ? "medium" : "low", label: "Line count " + (lineZ > 0 ? "above" : "below") + " typical", detail: "Robust z=" + lineZ.toFixed(2) + " vs median " + median(lineCounts).toFixed(1) });
    }
    (candidate.lineItems || []).forEach((li, idx) => {
      const key = (li.tallyItemName || li.itemName || "").toUpperCase();
      const sample = key && partRates[key] ? partRates[key] : [];
      if (sample.length < 3 || !li.rate) return;
      const z = robustZ(Number(li.rate), sample);
      if (Math.abs(z) > 2) {
        flags.push({ key: "line_rate", lineIndex: idx, severity: Math.abs(z) > 4 ? "high" : "medium", label: "Line rate outlier", detail: key + ": rate " + Number(li.rate).toLocaleString("en-IN") + " vs median " + median(sample).toLocaleString("en-IN") + " (z=" + z.toFixed(2) + ")" });
      }
    });
    return json(res, 200, { flags, sample: { totals: totals.length, lineCounts: lineCounts.length, distinctParts: Object.keys(partRates).length } });
  } catch (err) {
    sendError(res, err);
  }
}
