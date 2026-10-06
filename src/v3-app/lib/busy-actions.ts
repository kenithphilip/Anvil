// What the SO workspace is doing right now.
//
// Every stage action shared one `busy` boolean, so the screen could only say
// THAT something was running, never WHICH. The loader read "Extracting" whether
// you pressed Approve, Validate or Push to Tally, and the extract button read
// "extracting…" while an approval was in flight — six labels all lying at once.
//
// Two labels per action, because they appear in different places and a button
// caption is not a status line:
//   verb   goes inside the button that started it — lowercase, trailing ellipsis
//   label  goes in the LoadingState banner — title case, no ellipsis (the
//          component renders its own animation and elapsed timer)

export type BusyAction =
  | null
  | "extract"
  | "validate"
  | "review"
  | "correct"
  | "approve"
  | "push"
  | "reconcile"
  | "cancel"
  | "bulk_add"
  | "clear_lines"
  | "delete_line"
  | "resolve_finding";

export const BUSY_ACTIONS: Record<Exclude<BusyAction, null>, { verb: string; label: string }> = {
  extract:     { verb: "extracting…",  label: "Extracting" },
  validate:    { verb: "validating…",  label: "Validating" },
  review:      { verb: "sending…",     label: "Sending for review" },
  correct:     { verb: "returning…",   label: "Returning for fix" },
  approve:     { verb: "approving…",   label: "Approving" },
  push:        { verb: "pushing…",     label: "Pushing to Tally" },
  reconcile:   { verb: "reconciling…", label: "Reconciling" },
  cancel:      { verb: "cancelling…",  label: "Cancelling order" },
  bulk_add:    { verb: "adding…",      label: "Adding lines" },
  clear_lines: { verb: "clearing…",    label: "Clearing lines" },
  delete_line: { verb: "deleting…",    label: "Deleting line" },
  resolve_finding: { verb: "resolving…", label: "Resolving finding" },
};

/** Banner text for the running action. "Working" only if an id ever goes unmapped. */
export const busyLabel = (a: BusyAction): string =>
  (a && BUSY_ACTIONS[a]?.label) || "Working";

/**
 * Caption for a button, given the action that button starts.
 *
 * `idle` unless THIS button's action is the one running — the whole point. The
 * other buttons stay disabled (any non-null action is truthy) but keep their
 * resting captions instead of borrowing this one's verb.
 */
export const busyVerb = (busy: BusyAction, mine: Exclude<BusyAction, null>, idle: string): string =>
  busy === mine ? BUSY_ACTIONS[mine].verb : idle;
