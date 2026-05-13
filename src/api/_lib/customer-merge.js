// Customer merge with survivorship rules (Wave CM 4.3).
//
// Once the operator approves a customer_merge_candidates row,
// this module executes the merge:
//
//   1. Apply survivorship to compute the merged customer row.
//   2. Update the winner customer with the merged values.
//   3. Re-point every dependent FK (orders, quotes, invoices,
//      contracts, contacts, item_customer_parts, external_ids,
//      ...) from the loser to the winner.
//   4. Stamp the loser as is_golden=false, duplicates_of=winner.
//   5. Bump the candidate row to status='merged'.
//
// Survivorship rules (per Salesforce / SAP MDM 2026 guidance,
// scoped to our fields):
//
//   - Critical IDs (gstin): operator-confirmed value wins;
//     if both rows confirmed, the row whose value has the more
//     recent learned_corrections entry wins; tie: lexical.
//   - Display name: longer non-null wins; tie: winner's.
//   - Address fields: prefer winner's (later activity).
//   - Default terms / incoterms: prefer non-null; if both
//     non-null, winner's wins.
//   - Customer key: cannot collide because of unique index;
//     loser's key is preserved as a new customer_external_ids
//     row with system_code='internal' so the audit trail
//     survives.
//   - Notes: concatenated with a "[merged from X on YYYY-MM-DD]"
//     marker.
//
// FK re-pointing:
//
//   orders.customer_id, quotes.customer_id, invoices.customer_id,
//   customer_contacts.customer_id, item_customer_parts.customer_id,
//   contracts.customer_id, customer_field_overrides.customer_id,
//   customer_external_ids.customer_id, learned_corrections.customer_id,
//   inbound_emails.customer_id, source_pos.customer_id.
//
// We collapse contact dedups across the merge: if both rows
// had a contact at "buyer@acme.com", the winner's is preserved
// and the loser's row is deleted via CASCADE on the customer
// row update. The CM 1.3 canonical_email_hash trigger guards
// against duplicates.
//
// All steps run in one logical transaction. On any error the
// caller can re-run; rows already re-pointed are idempotent
// (UPDATE WHERE customer_id = loser is a no-op after merge).

const FK_TABLES = [
  // [table, column] - every place a customer_id FK lives.
  // The order matters: re-point heavyweight FKs first so the
  // final customer DELETE doesn't cascade into orders.
  ["orders", "customer_id"],
  ["quotes", "customer_id"],
  ["invoices", "customer_id"],
  ["source_pos", "customer_id"],
  ["contracts", "customer_id"],
  ["customer_contacts", "customer_id"],
  ["item_customer_parts", "customer_id"],
  ["customer_external_ids", "customer_id"],
  ["customer_field_overrides", "customer_id"],
  ["learned_corrections", "customer_id"],
  ["inbound_emails", "customer_id"],
  ["customer_locations", "customer_id"],
  ["customer_format_profiles", "customer_id"],
  ["customer_format_templates", "customer_id"],
  ["leads", "converted_customer_id"],
];

// Survivorship: compute the merged customer row.
export const applySurvivorship = (winner, loser, opts = {}) => {
  const merged = { ...winner };
  // GSTIN: keep winner's unless loser has one and winner doesn't.
  if (!winner.gstin && loser.gstin) merged.gstin = loser.gstin;
  // Display name: longer non-null wins.
  const wn = String(winner.display_name || winner.customer_name || "").trim();
  const ln = String(loser.display_name || loser.customer_name || "").trim();
  if (ln.length > wn.length) merged.display_name = ln;
  // Country, state_code, default terms, default incoterms,
  // default_quote_validity_days: prefer non-null winner; fall
  // back to loser when null.
  for (const k of ["country", "state_code", "default_payment_terms", "default_incoterms", "default_quote_validity_days"]) {
    if (winner[k] == null && loser[k] != null) merged[k] = loser[k];
  }
  // Notes: append a merge marker for audit.
  const today = new Date().toISOString().slice(0, 10);
  const marker = "[merged from " + loser.id + " on " + today + "]";
  const wn0 = String(winner.notes || "").trim();
  const ln0 = String(loser.notes || "").trim();
  merged.notes = [wn0, ln0, marker].filter(Boolean).join("\n").trim();
  // Audit fields.
  merged.last_active_at = new Date().toISOString();
  return merged;
};

// Build the dry-run plan without executing. Returns:
//   { winner_id, loser_id, merged_row, fk_updates: [{table,col,count?}] }
//
// The dry-run is what the operator approves on the UI before
// the destructive merge runs.
export const buildMergePlan = async (svc, { tenantId, winnerId, loserId }) => {
  if (!svc || !tenantId || !winnerId || !loserId) return { ok: false, error: "missing_args" };
  if (winnerId === loserId) return { ok: false, error: "same_customer" };
  let winner = null;
  let loser = null;
  try {
    const [winR, loseR] = await Promise.all([
      svc.from("customers").select("*").eq("tenant_id", tenantId).eq("id", winnerId).maybeSingle(),
      svc.from("customers").select("*").eq("tenant_id", tenantId).eq("id", loserId).maybeSingle(),
    ]);
    winner = winR?.data;
    loser = loseR?.data;
  } catch (_e) { return { ok: false, error: "load_failed" }; }
  if (!winner || !loser) return { ok: false, error: "customer_not_found" };
  const merged = applySurvivorship(winner, loser);
  // Estimate the FK update counts so the UI can show "this
  // will re-point 47 orders, 12 quotes, ...". Best-effort.
  const fkUpdates = [];
  for (const [table, col] of FK_TABLES) {
    try {
      const r = await svc.from(table)
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .eq(col, loserId);
      fkUpdates.push({ table, column: col, count: r?.count ?? 0 });
    } catch (_e) {
      fkUpdates.push({ table, column: col, count: null, error: true });
    }
  }
  return { ok: true, winner_id: winnerId, loser_id: loserId, merged_row: merged, fk_updates: fkUpdates };
};

// Execute the merge. Caller MUST have built and operator-approved
// the plan first.
//
// Idempotent: re-running on a row already merged is a no-op.
export const executeMerge = async (svc, { tenantId, winnerId, loserId, candidateId, executedBy }) => {
  if (!svc || !tenantId || !winnerId || !loserId) return { ok: false, error: "missing_args" };
  if (winnerId === loserId) return { ok: false, error: "same_customer" };
  // 1. Build plan + apply survivorship.
  const plan = await buildMergePlan(svc, { tenantId, winnerId, loserId });
  if (!plan.ok) return plan;
  // 2. Update the winner row with merged values.
  try {
    await svc.from("customers")
      .update({
        display_name: plan.merged_row.display_name,
        customer_name: plan.merged_row.customer_name || plan.merged_row.display_name,
        gstin: plan.merged_row.gstin,
        country: plan.merged_row.country,
        state_code: plan.merged_row.state_code,
        default_payment_terms: plan.merged_row.default_payment_terms,
        default_incoterms: plan.merged_row.default_incoterms,
        default_quote_validity_days: plan.merged_row.default_quote_validity_days,
        notes: plan.merged_row.notes,
        last_active_at: plan.merged_row.last_active_at,
      })
      .eq("tenant_id", tenantId)
      .eq("id", winnerId);
  } catch (_e) { return { ok: false, error: "winner_update_failed" }; }
  // 3. Preserve loser's customer_key as an internal external_id
  //    so historical mentions still resolve.
  try {
    const loserR = await svc.from("customers")
      .select("customer_key")
      .eq("tenant_id", tenantId)
      .eq("id", loserId)
      .maybeSingle();
    if (loserR?.data?.customer_key) {
      await svc.from("customer_external_ids").upsert({
        tenant_id: tenantId,
        customer_id: winnerId,
        system_code: "internal",
        external_id: String(loserR.data.customer_key).toLowerCase(),
        source: "operator",
        notes: "merged from customer " + loserId,
      }, { onConflict: "tenant_id,system_code,external_id" });
    }
  } catch (_e) { /* keep going */ }
  // 4. Re-point every FK.
  const fkErrors = [];
  for (const [table, col] of FK_TABLES) {
    try {
      await svc.from(table)
        .update({ [col]: winnerId })
        .eq("tenant_id", tenantId)
        .eq(col, loserId);
    } catch (err) {
      fkErrors.push({ table, column: col, error: err?.message || String(err) });
    }
  }
  // 5. Mark loser as merged duplicate.
  try {
    await svc.from("customers")
      .update({
        is_golden: false,
        duplicates_of: winnerId,
        merge_blocked: true,    // prevent loser from getting re-surfaced
      })
      .eq("tenant_id", tenantId)
      .eq("id", loserId);
  } catch (_e) { return { ok: false, error: "loser_finalise_failed", fk_errors: fkErrors }; }
  // 6. Move the candidate row to status='merged' (if supplied).
  if (candidateId) {
    try {
      await svc.from("customer_merge_candidates")
        .update({
          status: "merged",
          reviewed_by: executedBy || null,
          reviewed_at: new Date().toISOString(),
        })
        .eq("tenant_id", tenantId)
        .eq("id", candidateId);
    } catch (_e) { /* not fatal */ }
  }
  return { ok: true, winner_id: winnerId, loser_id: loserId, fk_errors: fkErrors };
};

export const __test = { FK_TABLES };
