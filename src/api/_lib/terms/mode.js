// The terms check's rollout mode: the ONE place it is read.
//
// docs/SO_TERMS_AND_HANDOFF_SCOPE.md section 4.5 (the modes) and 9.4 (readers
// on a database without the migration). The terms pass (plan PR 11), the
// judge (PR 12b), the check and its endpoints (PR 12) and the decisions (PR
// 13) all read the mode through readTermsCheckMode; check.js's
// readTermsSettings is that read plus the policy and the 409.
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

import { isMissingTermsSchema } from "./errors.js";

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

// The tenant's mode, read from its tenant_settings row. Never throws.
//
// Returns { mode, migrated, settings, error }. `settings` is the whole row,
// so a caller that needs the policy, the provider keys or the limits does not
// read it again. A read refused because migration 250's column is missing
// (errors.js isMissingTermsSchema) is migrated: false; any other refusal is
// migrated: null with the error. Either way the mode is "off". Every read is
// scoped to the tenant, and there is no read without one.
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
