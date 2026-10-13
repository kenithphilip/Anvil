// The terms check's rollout mode, and the "migration 250 is not applied" test.
//
// docs/SO_TERMS_AND_HANDOFF_SCOPE.md section 4.5 (the modes) and 9.4 (readers
// on a database without the migration). A small file on its own because three
// PRs read it: the terms pass (plan PR 11) decides whether to read the PO at
// all, and the comparator (PR 12) and the Terms tab (PR 13) decide what to
// show.
//
//   off     the default. The check does not run, and no T&C text is sent to
//           any provider.
//   shadow  the check runs and is stored, and the Terms tab hides the flags
//           from engineers (admins see them labelled "shadow").
//   on      the check runs, is stored, and is shown.
//
// Fail closed. A mode that cannot be read, or a value outside the three, is
// "off": the only safe reading when the question is "may this tenant's PO text
// go to an LLM provider".

export const TERMS_CHECK_MODES = Object.freeze(["off", "shadow", "on"]);

// True when the mode lets the check run (and send T&C text to a provider).
export const termsCheckRuns = (mode) => mode === "shadow" || mode === "on";

// The mode a tenant_settings row states.
//
//   { mode, migrated }
//   migrated  true   the row has the column (migration 250 is applied)
//             false  the row has no such column: a select("*") on a
//                    database without 250 (or with a stale schema cache)
//             null   there is no row to tell
export const termsModeOf = (row) => {
  if (!row || typeof row !== "object") return { mode: "off", migrated: null };
  if (!Object.prototype.hasOwnProperty.call(row, "terms_check_mode")) return { mode: "off", migrated: false };
  const m = String(row.terms_check_mode == null ? "" : row.terms_check_mode).trim().toLowerCase();
  return { mode: TERMS_CHECK_MODES.includes(m) ? m : "off", migrated: true };
};

// A read or write refused because migration 250's objects are not there:
// 42P01 (no such table), 42703 (no such column), and PostgREST's PGRST205 and
// PGRST204 (not in the schema cache). The message must name one of the 250
// objects (or be empty, when only the code came back), so a missing object of
// any other name is a different fault and is not swallowed. A message that
// names one and says "does not exist" or "schema cache" counts without a
// code, because PostgREST does not always carry one.
const MISSING_CODES = new Set(["42P01", "42703", "PGRST205", "PGRST204"]);
const TERMS_OBJECTS = /\b(?:order_term_checks|order_term_flags|order_term_decisions|terms_check_mode|terms_policy|terms_snapshot)\b/;

export const isMissingTermsSchema = (err) => {
  if (!err) return false;
  const msg = String(err.message || "");
  const names = TERMS_OBJECTS.test(msg);
  if (MISSING_CODES.has(String(err.code || ""))) return names || !msg.trim();
  return names && /does not exist|schema cache|could not find/i.test(msg);
};

// The tenant's mode, read from its tenant_settings row. Never throws.
//
// Returns { mode, migrated, settings, error }. `settings` is the whole row,
// so a caller that needs the provider keys and limits does not read it twice.
// Every read is scoped to the tenant, and there is no read without one.
export const readTermsCheckMode = async (svc, tenantId) => {
  if (!svc || !tenantId) return { mode: "off", migrated: null, settings: null, error: "no tenant" };
  try {
    const r = await svc.from("tenant_settings").select("*").eq("tenant_id", tenantId).maybeSingle();
    if (r.error) {
      return { mode: "off", migrated: isMissingTermsSchema(r.error) ? false : null, settings: null, error: r.error.message || "tenant_settings read failed" };
    }
    return { ...termsModeOf(r.data || null), settings: r.data || null, error: null };
  } catch (err) {
    return { mode: "off", migrated: null, settings: null, error: err?.message || String(err) };
  }
};
