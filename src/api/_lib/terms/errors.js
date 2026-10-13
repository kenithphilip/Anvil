// The terms check's "migration 250 is not applied" error, shared by the
// check, the decisions and the register. Before migration 250, every terms
// endpoint answers 409 MIGRATION_NOT_APPLIED naming 250_order_terms.sql, and
// the reconcile skips its terms step (docs/SO_TERMS_AND_HANDOFF_SCOPE.md 9.4).

export const TERMS_MIGRATION = "250_order_terms.sql";

// Objects migration 250 creates. A missing table or column of any other name
// is a different fault and is not reported as this one.
const TERMS_SCHEMA = /\b(order_term_checks|order_term_flags|order_term_decisions|terms_check_mode|terms_policy|terms_snapshot|terms_snapshot_at|validity_text)\b/;
const QUOTE_TERM_COLUMN = /\b(incoterm|delivery_terms|validity_text|terms_snapshot)\b/;

export const isMissingTermsSchema = (err, { quoteColumns = false } = {}) => {
  if (!err) return false;
  const msg = [err.message, err.details, err.hint].filter(Boolean).join(" ");
  const named = TERMS_SCHEMA.test(msg) || (quoteColumns && QUOTE_TERM_COLUMN.test(msg));
  if (!named) return false;
  return ["42P01", "42703", "PGRST204", "PGRST205"].includes(err.code) || /does not exist|schema cache|could not find/i.test(msg);
};

export const migrationNotApplied = () => {
  const err = new Error("Migration " + TERMS_MIGRATION + " has not been applied to this database, so the terms check is not available. Apply it by hand, then reload the PostgREST schema cache.");
  err.status = 409;
  err.code = "MIGRATION_NOT_APPLIED";
  err.migration = TERMS_MIGRATION;
  return err;
};

// A database error as the error to throw: the migration error when it names
// the terms schema, else a plain error that says what failed.
export const termsDbError = (what, error, opts) => (isMissingTermsSchema(error, opts)
  ? migrationNotApplied()
  : new Error(what + ": " + error.message));

// The body an endpoint sends for MIGRATION_NOT_APPLIED.
export const migrationErrorBody = (err) => ({
  error: { code: err.code, migration: err.migration, message: err.message, status: err.status },
});
