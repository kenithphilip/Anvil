// POST /api/documents/correct
// Body: {
//   extraction_run_id,
//   corrected_payload: { header, lines, ... },
//   original_payload?:  { header, lines, ... },     // optional but recommended
//   customer_id?,
//   reason?
// }
//
// One-shot correction submit for the OCR review screen. Diffs the
// corrected payload against the original on the server, persists a
// row in `extraction_corrections` for every changed field, writes
// the customer's format profile (incremented version + new alias
// learnings + bumped orders_processed counter), and audit-logs the
// change. Compatible with the existing field-level
// /api/docai/correction endpoint, which it complements (this one is
// for "save the whole reviewed doc" UX, that one for individual
// inline edits).
//
// Returns:
//   {
//     run_id,
//     diffs: [{ field_path, from, to }],
//     diff_count,
//     profile_version,
//     learned_aliases: [{ from, to }],
//   }

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

// === Field-path-aware deep diff ============================================
// Walks the two payloads and emits one entry per leaf where they
// differ. Field paths use bracket-index for arrays
// ("lines[0].part_number") so they line up with the field_path
// convention already used in extraction_corrections.
const diffPayloads = (a, b, prefix = "") => {
  const out = [];
  const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
  if (Array.isArray(a) || Array.isArray(b)) {
    const A = Array.isArray(a) ? a : [];
    const B = Array.isArray(b) ? b : [];
    const n = Math.max(A.length, B.length);
    for (let i = 0; i < n; i++) {
      out.push(...diffPayloads(A[i], B[i], prefix + "[" + i + "]"));
    }
    return out;
  }
  if (isObj(a) || isObj(b)) {
    const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
    keys.forEach((k) => {
      out.push(...diffPayloads(
        a ? a[k] : undefined,
        b ? b[k] : undefined,
        prefix ? prefix + "." + k : k,
      ));
    });
    return out;
  }
  // Leaf compare. Treat null and undefined as equal (extraction-side
  // null means "absent" and matches a missing key).
  const eqA = a === undefined ? null : a;
  const eqB = b === undefined ? null : b;
  // eslint-disable-next-line eqeqeq
  if (eqA === eqB) return out;
  // Number tolerance: avoid emitting a "diff" for 100 vs 100.0.
  if (typeof eqA === "number" && typeof eqB === "number" && eqA === eqB) return out;
  if (typeof eqA === "string" && typeof eqB === "string" && eqA.trim() === eqB.trim()) return out;
  out.push({ field_path: prefix, from: eqA, to: eqB });
  return out;
};

// Build alias learnings from a list of part-number diffs. The
// (from, to) pair becomes a learned alias on the format profile so
// the next extraction's fuzzy-resolution path picks it up.
const aliasesFromDiffs = (diffs = []) => {
  const out = {};
  diffs.forEach((d) => {
    if (typeof d.field_path !== "string") return;
    if (!d.field_path.endsWith(".part_number")) return;
    const from = d.from == null ? "" : String(d.from).trim();
    const to = d.to == null ? "" : String(d.to).trim();
    if (!from || !to || from === to) return;
    out[from] = to;
  });
  return out;
};

// === Profile upsert + version bump ========================================
// Idempotent, additive. If no profile exists for the (tenant,
// customer) pair, creates v1. Otherwise increments version, merges
// new aliases, increments orders_processed.
const upsertProfile = async (svc, tenantId, customerId, learnedAliases) => {
  if (!customerId) return null;
  const cur = await svc.from("customer_format_profiles")
    .select("id, version, learned_rules, orders_processed")
    .eq("tenant_id", tenantId).eq("customer_id", customerId).eq("is_current", true)
    .maybeSingle();
  const aliasesIn = learnedAliases || {};
  if (cur.error) throw new Error(cur.error.message);
  if (!cur.data) {
    const ins = await svc.from("customer_format_profiles").insert({
      tenant_id: tenantId,
      customer_id: customerId,
      version: 1,
      learned_rules: { aliases: aliasesIn },
      orders_processed: 1,
      is_current: true,
    }).select("id, version").single();
    if (ins.error) throw new Error(ins.error.message);
    return { profile_id: ins.data.id, version: ins.data.version };
  }
  const existing = (cur.data.learned_rules && cur.data.learned_rules.aliases) || {};
  const merged = { ...existing, ...aliasesIn };
  const aliasCountChanged = Object.keys(aliasesIn).some((k) => existing[k] !== aliasesIn[k]);
  const nextVersion = aliasCountChanged ? cur.data.version + 1 : cur.data.version;
  const upd = await svc.from("customer_format_profiles")
    .update({
      learned_rules: { ...(cur.data.learned_rules || {}), aliases: merged },
      orders_processed: (cur.data.orders_processed || 0) + 1,
      version: nextVersion,
      updated_at: new Date().toISOString(),
    })
    .eq("id", cur.data.id)
    .select("id, version").single();
  if (upd.error) throw new Error(upd.error.message);
  return { profile_id: upd.data.id, version: upd.data.version };
};

export const __test = { diffPayloads, aliasesFromDiffs };

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") {
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "approve");
    const body = await readBody(req);
    if (!body || !body.extraction_run_id || !body.corrected_payload) {
      return json(res, 400, { error: { message: "extraction_run_id and corrected_payload required" } });
    }
    const svc = serviceClient();

    // Load the run for tenant scoping + the original normalized
    // extract (used as the diff base when caller didn't supply one).
    const r = await svc.from("extraction_runs")
      .select("id, customer_id, normalized_extract")
      .eq("tenant_id", ctx.tenantId).eq("id", body.extraction_run_id).maybeSingle();
    if (r.error) throw new Error(r.error.message);
    if (!r.data) return json(res, 404, { error: { message: "extraction_run not found" } });

    const original = body.original_payload || r.data.normalized_extract || {};
    const corrected = body.corrected_payload || {};
    const diffs = diffPayloads(original, corrected);

    if (diffs.length === 0) {
      return json(res, 200, {
        run_id: r.data.id,
        diffs: [],
        diff_count: 0,
        profile_version: null,
        learned_aliases: [],
        message: "No changes",
      });
    }

    const customerId = body.customer_id || r.data.customer_id || null;

    // Persist one extraction_corrections row per diff. Bulk insert
    // for the round-trip cost; we still get one row per field for
    // the existing aggregator.
    const rows = diffs.map((d) => ({
      tenant_id: ctx.tenantId,
      extraction_run_id: r.data.id,
      customer_id: customerId,
      field_path: d.field_path,
      original_value: d.from,
      corrected_value: d.to,
      reason: body.reason || null,
      user_id: ctx.userId || null,
    }));
    const ins = await svc.from("extraction_corrections").insert(rows);
    if (ins.error) throw new Error(ins.error.message);

    // Build alias learnings + upsert customer profile.
    const learnedAliases = aliasesFromDiffs(diffs);
    let profileResult = null;
    if (customerId) {
      profileResult = await upsertProfile(svc, ctx.tenantId, customerId, learnedAliases);
    }

    // Audit-log every diff in one append-only event; the operator's
    // change set is searchable from the audit screen.
    await recordAudit(ctx, {
      action: "document.corrected",
      objectType: "extraction_run",
      objectId: r.data.id,
      before: { diff_count: diffs.length },
      after: {
        diffs: diffs.slice(0, 200), // hard-cap for audit row size
        learned_aliases: Object.keys(learnedAliases).length,
        customer_id: customerId,
        profile_version: profileResult ? profileResult.version : null,
      },
      reason: body.reason || null,
    });

    return json(res, 200, {
      run_id: r.data.id,
      diffs,
      diff_count: diffs.length,
      profile_version: profileResult ? profileResult.version : null,
      learned_aliases: Object.entries(learnedAliases).map(([from, to]) => ({ from, to })),
    });
  } catch (err) {
    sendError(res, err);
  }
}
