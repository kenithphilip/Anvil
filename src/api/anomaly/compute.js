import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";

// ============================================================================
// Anomaly compute (`/api/anomaly/compute`)
// ----------------------------------------------------------------------------
// Robust-z + rule-library anomaly detector for sales-order candidates.
// Originally three rules (grand_total, line_count, line_rate); rebuilt as a
// rule-library of 18 rules grouped into 5 design buckets:
//
//   Rate    : line_rate_outlier, rate_10x_jump, cross_customer_rate_drift,
//             rate_below_landed_cost, round_number_rate
//   Margin  : margin_floor_breach, margin_drop_vs_baseline, freight_share_outlier
//   GST     : gst_class_mismatch, gst_rate_inconsistent_for_hsn, missing_hsn_or_gst
//   Credit  : payment_terms_drift, credit_overrun
//   Alias   : alias_low_confidence, ambiguous_alias
//   Hygiene : grand_total, line_count, duplicate_line, qty_step_skip, lead_time_spike
//
// Every rule is gated by `applies(ctx)` so missing optional inputs degrade
// gracefully (no throws, no false positives). The contract returned to the
// caller stays the same: { flags: [...], sample: {...} }, with the existing
// flag keys preserved (grand_total, line_count, line_rate) so v3-app screens
// don't break.
// ============================================================================

// ---- Helpers ----

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

const gcdAll = (arr) => {
  const g2 = (a, b) => (b === 0 ? Math.abs(a) : g2(b, a % b));
  const ints = arr.map((v) => Math.round(Number(v))).filter((v) => v > 0);
  if (!ints.length) return 0;
  return ints.reduce((acc, v) => g2(acc, v), ints[0]);
};

const parseDays = (text) => {
  if (text == null) return null;
  const m = String(text).match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
};

const daysBetween = (a, b) => Math.round((b.getTime() - a.getTime()) / 86400000);

// computeMargin: ported from api/cost/margin_history.js logic. Returns
// { selling, landed, marginPct } or null when priceComposition is missing
// or doesn't pair with the order's lines.
const computeMargin = (so, priceComp) => {
  if (!so || !priceComp || !Array.isArray(priceComp.lineItems)) return null;
  const compByPart = {};
  priceComp.lineItems.forEach((r) => {
    const k = String(r.partNumber || r.partNo || "").toUpperCase();
    if (k) compByPart[k] = r;
  });
  let landed = 0;
  let selling = 0;
  let matched = 0;
  (so.lineItems || []).forEach((li) => {
    const k = String(li.sellerPartNo || li.tallyItemName || li.itemName || "").toUpperCase();
    const m = compByPart[k];
    const qty = Number(li.qty) || 0;
    const rate = Number(li.rate) || 0;
    selling += qty * rate;
    if (m) {
      matched += 1;
      const unit = Number(m.landedCostINR != null ? m.landedCostINR : m.unitInr) || 0;
      landed += qty * unit;
    }
  });
  if (!matched || selling <= 0) return null;
  return { selling, landed, marginPct: ((selling - landed) / selling) * 100 };
};

// ---- The rule library ----

const RULES = [
  // === HYGIENE: order-shape sanity ============================================
  {
    id: "grand_total",
    label: "Order value outlier",
    applies: (c) => c.totals.length >= 3,
    evaluate: (c) => {
      const v = Number(c.candidate.grandTotal) || 0;
      const z = robustZ(v, c.totals);
      if (Math.abs(z) <= 2) return [];
      return [{
        key: "grand_total",
        severity: Math.abs(z) > 3 ? "high" : "medium",
        label: "Order value " + (z > 0 ? "above" : "below") + " typical",
        detail: "Robust z=" + z.toFixed(2) + " vs median " + median(c.totals).toLocaleString("en-IN"),
      }];
    },
  },
  {
    id: "line_count",
    label: "Line count outlier",
    applies: (c) => c.lineCounts.length >= 3,
    evaluate: (c) => {
      const v = Array.isArray(c.candidate.lineItems) ? c.candidate.lineItems.length : 0;
      const z = robustZ(v, c.lineCounts);
      if (Math.abs(z) <= 2) return [];
      return [{
        key: "line_count",
        severity: Math.abs(z) > 3 ? "medium" : "low",
        label: "Line count " + (z > 0 ? "above" : "below") + " typical",
        detail: "Robust z=" + z.toFixed(2) + " vs median " + median(c.lineCounts).toFixed(1),
      }];
    },
  },
  {
    id: "duplicate_line",
    label: "Duplicate line",
    evaluate: (c) => {
      const seen = {};
      const out = [];
      (c.candidate.lineItems || []).forEach((li, idx) => {
        const key = [
          (li.tallyItemName || li.itemName || li.sellerPartNo || "").toUpperCase(),
          (li.uom || "").toUpperCase(),
          Number(li.rate) || 0,
        ].join("|");
        if (seen[key] != null) {
          out.push({
            key: "duplicate_line",
            lineIndex: idx,
            severity: "medium",
            label: "Duplicate line",
            detail: "Lines " + (seen[key] + 1) + " and " + (idx + 1) + " match on part/uom/rate",
          });
        } else {
          seen[key] = idx;
        }
      });
      return out;
    },
  },
  {
    id: "qty_step_skip",
    label: "Qty doesn't match pack size",
    evaluate: (c) => {
      const out = [];
      (c.candidate.lineItems || []).forEach((li, idx) => {
        const key = (li.tallyItemName || li.itemName || "").toUpperCase();
        const hist = c.qtyHistByPart[key] || [];
        if (hist.length < 5 || !li.qty) return;
        const step = gcdAll(hist);
        if (step < 2 || Number(li.qty) % step === 0) return;
        out.push({
          key: "qty_step_skip",
          lineIndex: idx,
          severity: "low",
          label: "Qty doesn't match pack size",
          detail: key + ": qty " + li.qty + " not a multiple of pack size " + step
                + " (inferred from " + hist.length + " orders)",
        });
      });
      return out;
    },
  },
  {
    id: "lead_time_spike",
    label: "Lead time tighter than typical",
    applies: (c) => c.leadTimeDays.length >= 5 && !!c.candidate.expectedDelivery,
    evaluate: (c) => {
      const days = daysBetween(new Date(), new Date(c.candidate.expectedDelivery));
      const med = median(c.leadTimeDays);
      const dev = mad(c.leadTimeDays) || 1;
      if (days >= med - 2 * dev) return [];
      return [{
        key: "lead_time_spike",
        severity: "medium",
        label: "Lead time tighter than typical",
        detail: "Expected " + days + "d vs typical " + med.toFixed(0) + "d (mad " + dev.toFixed(0) + "d)",
      }];
    },
  },

  // === RATE: price-deviation rules ============================================
  {
    id: "line_rate",
    label: "Line rate outlier",
    evaluate: (c) => {
      const out = [];
      (c.candidate.lineItems || []).forEach((li, idx) => {
        const key = (li.tallyItemName || li.itemName || "").toUpperCase();
        const sample = key && c.partRates[key] ? c.partRates[key] : [];
        if (sample.length < 3 || !li.rate) return;
        const z = robustZ(Number(li.rate), sample);
        if (Math.abs(z) <= 2) return;
        out.push({
          key: "line_rate",
          lineIndex: idx,
          severity: Math.abs(z) > 4 ? "high" : "medium",
          label: "Line rate outlier",
          detail: key + ": rate " + Number(li.rate).toLocaleString("en-IN")
                + " vs median " + median(sample).toLocaleString("en-IN")
                + " (z=" + z.toFixed(2) + ")",
        });
      });
      return out;
    },
  },
  {
    id: "rate_10x_jump",
    label: "Rate jump suggests decimal error",
    evaluate: (c) => {
      const out = [];
      (c.candidate.lineItems || []).forEach((li, idx) => {
        const key = (li.tallyItemName || li.itemName || "").toUpperCase();
        const sample = key && c.partRates[key] ? c.partRates[key] : [];
        if (sample.length < 3 || !li.rate) return;
        const m = median(sample);
        if (m <= 0) return;
        // UoM-stable check: only fire when this line's UOM matches the
        // most common historical UOM for the part, to suppress legit
        // unit-denomination flips (per-each vs per-100).
        const histUom = c.partUomByKey[key];
        const liUom = String(li.uom || "").toUpperCase();
        if (histUom && liUom && histUom !== liUom) return;
        const ratio = Number(li.rate) / m;
        if (ratio < 10 && ratio > 0.1) return;
        out.push({
          key: "rate_10x_jump",
          lineIndex: idx,
          severity: "high",
          label: "Rate jump suggests decimal error",
          detail: key + ": " + ratio.toFixed(1) + "x vs median ₹" + m.toLocaleString("en-IN"),
        });
      });
      return out;
    },
  },
  {
    id: "cross_customer_rate_drift",
    label: "Rate drifts from tenant band",
    evaluate: (c) => {
      const out = [];
      (c.candidate.lineItems || []).forEach((li, idx) => {
        const key = (li.tallyItemName || li.itemName || "").toUpperCase();
        const own = c.partRates[key] || [];
        const cross = c.crossPartRates[key] || [];
        // Only fire when this customer hasn't built up enough history yet
        // (we trust per-customer history more than tenant aggregate).
        if (cross.length < 5 || own.length >= 5 || !li.rate) return;
        const m = median(cross);
        if (m <= 0) return;
        const ratio = Number(li.rate) / m;
        if (ratio >= 0.6 && ratio <= 1.6) return;
        out.push({
          key: "cross_customer_rate_drift",
          lineIndex: idx,
          severity: "medium",
          label: "Rate vs tenant median",
          detail: key + ": " + (ratio < 1 ? "below" : "above") + " tenant median ₹"
                + m.toLocaleString("en-IN") + " by " + Math.round(Math.abs(1 - ratio) * 100) + "%",
        });
      });
      return out;
    },
  },
  {
    id: "rate_below_landed_cost",
    label: "Rate below landed cost",
    applies: (c) => !!c.priceComposition,
    evaluate: (c) => {
      const out = [];
      const compByPart = {};
      (c.priceComposition.lineItems || []).forEach((r) => {
        const k = String(r.partNumber || r.partNo || "").toUpperCase();
        if (k) compByPart[k] = r;
      });
      (c.candidate.lineItems || []).forEach((li, idx) => {
        const k = String(li.sellerPartNo || li.tallyItemName || li.itemName || "").toUpperCase();
        const m = compByPart[k];
        if (!m || !li.rate) return;
        const landed = Number(m.landedCostINR != null ? m.landedCostINR : m.unitInr) || 0;
        if (landed <= 0 || Number(li.rate) >= landed) return;
        out.push({
          key: "rate_below_landed_cost",
          lineIndex: idx,
          severity: "high",
          label: "Rate below landed cost",
          detail: k + ": rate ₹" + li.rate + " < landed ₹" + landed.toFixed(0),
        });
      });
      return out;
    },
  },
  {
    id: "round_number_rate",
    label: "Suspiciously round rate",
    evaluate: (c) => {
      const out = [];
      (c.candidate.lineItems || []).forEach((li, idx) => {
        const r = Number(li.rate) || 0;
        if (r < 5000 || r % 1000 !== 0) return;
        const key = (li.tallyItemName || li.itemName || "").toUpperCase();
        const sample = c.partRates[key] || [];
        if (sample.length < 3) return;
        const m = median(sample);
        if (m <= 0) return;
        // Only fire when the historical rates were varied (mad/median > 2%).
        if (mad(sample) / m < 0.02) return;
        out.push({
          key: "round_number_rate",
          lineIndex: idx,
          severity: "low",
          label: "Round-number rate vs varied history",
          detail: key + ": rate ₹" + r.toLocaleString("en-IN")
                + " vs history median ₹" + m.toLocaleString("en-IN"),
        });
      });
      return out;
    },
  },

  // === MARGIN ================================================================
  {
    id: "margin_floor_breach",
    label: "Margin below floor",
    applies: (c) => !!c.priceComposition,
    evaluate: (c) => {
      const m = computeMargin(c.candidate, c.priceComposition);
      if (!m || m.marginPct >= 8) return [];
      return [{
        key: "margin_floor_breach",
        severity: m.marginPct < 0 ? "high" : "medium",
        label: m.marginPct < 0 ? "Order below cost" : "Margin below 8% floor",
        detail: "Margin " + m.marginPct.toFixed(1) + "% (selling ₹"
              + m.selling.toLocaleString("en-IN") + ", landed ₹"
              + m.landed.toLocaleString("en-IN") + ")",
      }];
    },
  },
  {
    id: "margin_drop_vs_baseline",
    label: "Margin drop vs customer baseline",
    applies: (c) => !!c.priceComposition && c.marginPctHistory.length >= 5,
    evaluate: (c) => {
      const m = computeMargin(c.candidate, c.priceComposition);
      if (!m) return [];
      const med = median(c.marginPctHistory);
      const dev = mad(c.marginPctHistory) || 1;
      if (m.marginPct >= med - 2 * dev) return [];
      return [{
        key: "margin_drop_vs_baseline",
        severity: "medium",
        label: "Margin drop vs customer baseline",
        detail: m.marginPct.toFixed(1) + "% vs median " + med.toFixed(1)
              + "% (mad " + dev.toFixed(1) + "pp)",
      }];
    },
  },
  {
    id: "freight_share_outlier",
    label: "Freight share outlier",
    applies: (c) => c.freightShares.length >= 5,
    evaluate: (c) => {
      const v = (Number(c.candidate.freight) || 0) / (Number(c.candidate.grandTotal) || 1);
      if (v <= 0) return [];
      const z = robustZ(v, c.freightShares);
      if (Math.abs(z) <= 2) return [];
      return [{
        key: "freight_share_outlier",
        severity: "low",
        label: "Freight share outlier",
        detail: "Freight " + (v * 100).toFixed(1) + "% of order vs typical "
              + (median(c.freightShares) * 100).toFixed(1) + "% (z=" + z.toFixed(2) + ")",
      }];
    },
  },

  // === GST ===================================================================
  {
    id: "gst_class_mismatch",
    label: "GST class vs state mismatch",
    applies: (c) =>
      !!c.customer.state_code && !!c.supplierState && !!c.candidate.gstMode,
    evaluate: (c) => {
      const expected =
        c.customer.state_code === c.supplierState ? "CGST_SGST" : "IGST";
      if (c.candidate.gstMode === expected) return [];
      return [{
        key: "gst_class_mismatch",
        severity: "medium",
        label: "GST class mismatch",
        detail: "Customer " + c.customer.state_code + ", supplier " + c.supplierState
              + " — expected " + expected + " but order shows " + c.candidate.gstMode,
      }];
    },
  },
  {
    id: "gst_rate_inconsistent_for_hsn",
    label: "Inconsistent GST rate for HSN",
    evaluate: (c) => {
      const byHsn = {};
      (c.candidate.lineItems || []).forEach((li, idx) => {
        const h = String(li.hsnCode || "").trim();
        if (!h || li.gstPct == null) return;
        byHsn[h] = byHsn[h] || [];
        byHsn[h].push({ idx, gst: Number(li.gstPct) });
      });
      const out = [];
      Object.keys(byHsn).forEach((h) => {
        const rows = byHsn[h];
        const distinct = Array.from(new Set(rows.map((r) => r.gst)));
        if (distinct.length <= 1) return;
        out.push({
          key: "gst_rate_inconsistent_for_hsn",
          severity: "medium",
          label: "Inconsistent GST for HSN " + h,
          detail: "Rates " + distinct.join("%, ") + "% on lines "
                + rows.map((r) => r.idx + 1).join(", "),
        });
      });
      return out;
    },
  },
  {
    id: "missing_hsn_or_gst",
    label: "Missing HSN or GST",
    evaluate: (c) => {
      const out = [];
      (c.candidate.lineItems || []).forEach((li, idx) => {
        const noHsn = !li.hsnCode || String(li.hsnCode).length < 4;
        const noGst = li.gstPct == null;
        if (!noHsn && !noGst) return;
        const reasons = [];
        if (noHsn) reasons.push("no HSN");
        if (noGst) reasons.push("no GST%");
        out.push({
          key: "missing_hsn_or_gst",
          lineIndex: idx,
          severity: "low",
          label: "Missing HSN/GST",
          detail: "Line " + (idx + 1) + ": " + reasons.join(", "),
        });
      });
      return out;
    },
  },

  // === CREDIT ================================================================
  {
    id: "payment_terms_drift",
    label: "Payment terms drift",
    applies: (c) =>
      !!c.customer.default_payment_terms && !!c.candidate.paymentTerms,
    evaluate: (c) => {
      const a = parseDays(c.customer.default_payment_terms);
      const b = parseDays(c.candidate.paymentTerms);
      if (!a || !b || b <= a + 30) return [];
      return [{
        key: "payment_terms_drift",
        severity: "medium",
        label: "Payment terms drift",
        detail: "Order " + b + "d vs default " + a + "d (drift " + (b - a) + "d)",
      }];
    },
  },
  {
    id: "credit_overrun",
    label: "Credit watch",
    applies: (c) => c.openARTotal != null,
    evaluate: (c) => {
      const limit = c.customer.credit_limit;
      const projected = c.openARTotal + (Number(c.candidate.grandTotal) || 0);
      if (limit != null && limit > 0) {
        if (projected <= limit) return [];
        return [{
          key: "credit_overrun",
          severity: "high",
          label: "Credit limit overrun",
          detail: "Projected AR ₹" + projected.toLocaleString("en-IN")
                + " vs limit ₹" + limit.toLocaleString("en-IN"),
        }];
      }
      // Interim: synthetic ceiling = 2x max historical grandTotal.
      const ceiling = c.totals.length ? 2 * Math.max.apply(null, c.totals) : 0;
      if (!ceiling || projected <= ceiling) return [];
      return [{
        key: "credit_overrun",
        severity: "low",
        label: "Credit watch (no limit on file)",
        detail: "Projected AR ₹" + projected.toLocaleString("en-IN")
              + " vs synthetic ceiling ₹" + ceiling.toLocaleString("en-IN")
              + " — set customers.credit_limit for hard check",
      }];
    },
  },

  // === ALIAS CONFIDENCE ======================================================
  {
    id: "alias_low_confidence",
    label: "Alias low confidence",
    evaluate: (c) => {
      const out = [];
      (c.candidate.lineItems || []).forEach((li, idx) => {
        const k = (li.tallyItemName || li.itemName || "").toUpperCase();
        const conf = c.aliasConfByText[k];
        if (conf == null || conf >= 0.7) return;
        out.push({
          key: "alias_low_confidence",
          lineIndex: idx,
          severity: conf < 0.5 ? "medium" : "low",
          label: "Alias low confidence",
          detail: "'" + k + "' mapped at confidence " + conf.toFixed(2),
        });
      });
      return out;
    },
  },
  {
    id: "ambiguous_alias",
    label: "Ambiguous alias",
    evaluate: (c) => {
      const out = [];
      (c.candidate.lineItems || []).forEach((li, idx) => {
        const k = (li.tallyItemName || li.itemName || "").toUpperCase();
        const n = c.aliasAmbiguity[k] || 0;
        if (n < 2) return;
        out.push({
          key: "ambiguous_alias",
          lineIndex: idx,
          severity: "medium",
          label: "Ambiguous alias",
          detail: "'" + k + "' resolves to " + n + " parts — disambiguate",
        });
      });
      return out;
    },
  },
];

// Exposed so screens can render the rule list (admin / anomaly screen).
export const ANOMALY_RULES = RULES.map((r) => ({ id: r.id, label: r.label }));

// ---- Context builder ----

const buildCtx = async (svc, tenantId, customerId, candidate) => {
  // Per-customer history (existing query, kept).
  const own = await svc
    .from("orders")
    .select("result, created_at")
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .not("result", "is", null)
    .order("created_at", { ascending: false })
    .limit(40);
  if (own.error) throw new Error(own.error.message);

  const totals = [];
  const lineCounts = [];
  const partRates = {};
  const partUomByKey = {};
  const partUomCounts = {};
  const qtyHistByPart = {};
  const marginPctHistory = [];
  const leadTimeDays = [];
  const freightShares = [];
  let openARTotal = 0;
  (own.data || []).forEach((row) => {
    const so = row.result && row.result.salesOrder;
    if (!so) return;
    if (so.grandTotal) totals.push(Number(so.grandTotal));
    const pc = row.result.priceComposition;
    if (so.grandTotal && row.result && row.result.po && row.result.po.status !== "PAID") {
      // Heuristic: status info isn't always on result; the open-AR figure is
      // a coarse upper bound (every recent order). Real AR-aging join is a
      // follow-up; this still drives the credit_overrun rule with a sane ceiling.
      openARTotal += Number(so.grandTotal) || 0;
    }
    if (Array.isArray(so.lineItems)) {
      lineCounts.push(so.lineItems.length);
      so.lineItems.forEach((li) => {
        const key = (li.tallyItemName || li.itemName || "").toUpperCase();
        if (!key) return;
        if (li.rate) {
          partRates[key] = partRates[key] || [];
          partRates[key].push(Number(li.rate));
        }
        if (li.qty) {
          qtyHistByPart[key] = qtyHistByPart[key] || [];
          qtyHistByPart[key].push(Number(li.qty));
        }
        if (li.uom) {
          const uom = String(li.uom).toUpperCase();
          partUomCounts[key] = partUomCounts[key] || {};
          partUomCounts[key][uom] = (partUomCounts[key][uom] || 0) + 1;
        }
      });
    }
    const margin = computeMargin(so, pc);
    if (margin) marginPctHistory.push(margin.marginPct);
    if (so.expectedDelivery && row.created_at) {
      const lt = daysBetween(new Date(row.created_at), new Date(so.expectedDelivery));
      if (lt > 0 && lt < 365) leadTimeDays.push(lt);
    }
    if (so.freight != null && so.grandTotal) {
      freightShares.push(Number(so.freight) / Number(so.grandTotal));
    }
  });
  // Pick the most common UOM per part for the rate_10x_jump UoM check.
  Object.keys(partUomCounts).forEach((k) => {
    const uoms = partUomCounts[k];
    let best = null;
    let bestN = 0;
    Object.keys(uoms).forEach((u) => {
      if (uoms[u] > bestN) { best = u; bestN = uoms[u]; }
    });
    if (best) partUomByKey[k] = best;
  });

  // Tenant-wide history (cross-customer) for cross_customer_rate_drift.
  const cross = await svc
    .from("orders")
    .select("result")
    .eq("tenant_id", tenantId)
    .not("result", "is", null)
    .order("created_at", { ascending: false })
    .limit(200);
  const crossPartRates = {};
  if (!cross.error) {
    (cross.data || []).forEach((row) => {
      const so = row.result && row.result.salesOrder;
      if (!so || !Array.isArray(so.lineItems)) return;
      so.lineItems.forEach((li) => {
        const key = (li.tallyItemName || li.itemName || "").toUpperCase();
        if (!key || !li.rate) return;
        crossPartRates[key] = crossPartRates[key] || [];
        crossPartRates[key].push(Number(li.rate));
      });
    });
  }

  // Customer record for credit_limit + state_code + payment terms. Best-effort.
  let customer = {};
  try {
    const cr = await svc
      .from("customers")
      .select("state_code, default_payment_terms, credit_limit")
      .eq("id", customerId)
      .maybeSingle();
    if (!cr.error && cr.data) customer = cr.data;
  } catch (_) {
    customer = {};
  }

  // part_aliases: confidence by alias text + ambiguity counts. Best-effort.
  const aliasConfByText = {};
  const aliasAmbiguity = {};
  try {
    const aliasRows = await svc
      .from("part_aliases")
      .select("alias, part_no, confidence")
      .eq("tenant_id", tenantId)
      .eq("customer_id", customerId);
    if (!aliasRows.error && Array.isArray(aliasRows.data)) {
      const byKey = {};
      aliasRows.data.forEach((r) => {
        const k = String(r.alias || "").toUpperCase();
        if (!k) return;
        byKey[k] = byKey[k] || new Set();
        byKey[k].add(r.part_no);
        // Track the highest-confidence row's confidence per alias text.
        const conf = Number(r.confidence);
        if (Number.isFinite(conf)) {
          aliasConfByText[k] = aliasConfByText[k] == null
            ? conf
            : Math.max(aliasConfByText[k], conf);
        }
      });
      Object.keys(byKey).forEach((k) => {
        aliasAmbiguity[k] = byKey[k].size;
      });
    }
  } catch (_) {
    /* ignore — alias rules degrade gracefully */
  }

  // Supplier home state. Read from env (`SUPPLIER_STATE_CODE`) or first-order
  // inference. Falls through to undefined; gst_class_mismatch then no-ops.
  const supplierState =
    (typeof process !== "undefined" && process.env && process.env.SUPPLIER_STATE_CODE) || null;

  return {
    candidate,
    customer,
    supplierState,
    totals,
    lineCounts,
    partRates,
    partUomByKey,
    qtyHistByPart,
    crossPartRates,
    marginPctHistory,
    leadTimeDays,
    freightShares,
    aliasConfByText,
    aliasAmbiguity,
    openARTotal,
    priceComposition: candidate && candidate._priceComposition
      ? candidate._priceComposition
      : null,
  };
};

// ---- Handler ----

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctxAuth = await resolveContext(req);
    requirePermission(ctxAuth, "read");
    const body = await readBody(req);
    const customerId = body.customerId;
    const candidate = body.candidate;
    if (!customerId || !candidate) {
      return json(res, 400, { error: { message: "customerId and candidate required" } });
    }
    const svc = serviceClient();
    const ctx = await buildCtx(svc, ctxAuth.tenantId, customerId, candidate);
    const flags = [];
    for (const rule of RULES) {
      if (rule.applies && !rule.applies(ctx)) continue;
      flags.push(...rule.evaluate(ctx));
    }
    return json(res, 200, {
      flags,
      sample: {
        totals: ctx.totals.length,
        lineCounts: ctx.lineCounts.length,
        distinctParts: Object.keys(ctx.partRates).length,
        crossDistinctParts: Object.keys(ctx.crossPartRates).length,
        marginSamples: ctx.marginPctHistory.length,
        leadTimeSamples: ctx.leadTimeDays.length,
        aliasMatches: Object.keys(ctx.aliasConfByText).length,
      },
      rulesEvaluated: RULES.length,
    });
  } catch (err) {
    sendError(res, err);
  }
}

// Test-only export so unit tests can exercise the rule library without
// spinning up a Supabase client. Keep the public default export unchanged.
export const __test = { RULES, buildCtx, computeMargin, median, mad, robustZ, gcdAll, parseDays };
