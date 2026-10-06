import React, { useEffect, useMemo, useRef, useState } from "react";
import { Btn, Chip } from "../lib/primitives";
import { AnvilBackend } from "../lib/api";
import { RBAC } from "../lib/rbac";

// Account owner on a customer (migration 227, POST /api/customers/owner).
//
// Shows who owns the account and, for sales_manager and admin (action
// customer.assign_owner), a picker of APPROVED members. When the account has
// no owner, the server's suggestion (the member who owns a strict majority of
// its opportunities and authored quotes over 365 days) is preselected in the
// picker, but nothing is saved until someone clicks Save: a suggestion is a
// reading of the history, not a decision.

type Customer = any;
export type Member = { user_id: string; display_name?: string | null; email?: string | null; status?: string | null; role?: string | null };

// The members an account can be given to. admin/members GET returns everyone
// on the tenant row, including pending access requests and denied users; the
// server refuses all but approved members, so the picker offers only those.
export const approvedMembers = (resp: any): Member[] => {
  const rows: Member[] = Array.isArray(resp) ? resp : (Array.isArray(resp?.members) ? resp.members : []);
  return rows
    .filter((m) => m && m.user_id && m.status === "approved")
    .sort((a, b) => memberLabel(a).localeCompare(memberLabel(b)));
};

export const memberLabel = (m: Member | null | undefined): string =>
  (m && (m.display_name || m.email || (m.user_id ? m.user_id.slice(0, 8) : ""))) || "";

const SUGGESTION_WHY: Record<string, string> = {
  no_activity: "No suggestion: no opportunities or quotes on this account in the last 365 days.",
  no_majority: "No suggestion: no single member owns more than half of this account's opportunities and quotes.",
  not_a_member: "No suggestion: the member who owns most of this account's activity is no longer an approved member.",
  evidence_incomplete: "No suggestion: there was too much history to read in full, so it was not guessed.",
};

export const AccountOwnerPanel: React.FC<{
  customer: Customer;
  members: Member[];
  // Set when the member list could not be loaded: the picker then has only
  // the current owner and Unassigned, and says why.
  membersError?: string | null;
  onChanged?: () => void;
}> = ({ customer, members, membersError, onChanged }) => {
  const canAssign = RBAC.canDo("customer.assign_owner");
  const currentOwner: string = customer.owner_user_id || "";
  const [draft, setDraft] = useState<string>(currentOwner);
  const [moveOpps, setMoveOpps] = useState(false);
  const [busy, setBusy] = useState(false);
  const [suggestion, setSuggestion] = useState<any>(null);
  // True once the person has used the picker. A suggestion that arrives after
  // that must not replace their choice: Save would then send the computed
  // guess instead of the member they picked.
  const touched = useRef(false);

  // Reset the staged choice whenever a different customer (or a saved owner)
  // arrives, so switching rows never carries a stale draft across.
  useEffect(() => {
    touched.current = false;
    setDraft(currentOwner); setMoveOpps(false); setSuggestion(null);
  }, [customer.id, currentOwner]);

  // Ask for a suggestion only where one can be acted on: an unowned account,
  // seen by someone who may assign it.
  useEffect(() => {
    if (!canAssign || currentOwner || !customer.id) return;
    let cancelled = false;
    Promise.resolve(AnvilBackend?.customers?.ownerSuggestions?.({ customer_id: customer.id }))
      .then((r: any) => {
        if (cancelled) return;
        const s = (r?.suggestions || []).find((x: any) => x.customer_id === customer.id) || null;
        setSuggestion(s);
        // Preselect, do not save; and only into a picker nobody has touched.
        if (s?.owner_user_id && !touched.current) setDraft(s.owner_user_id);
      })
      .catch(() => { if (!cancelled) setSuggestion(null); });
    return () => { cancelled = true; };
  }, [canAssign, currentOwner, customer.id]);

  const options = useMemo(() => approvedMembers(members), [members]);
  const ownerName = customer.owner_name
    || memberLabel(options.find((m) => m.user_id === currentOwner))
    || (currentOwner ? currentOwner.slice(0, 8) : "");
  const dirty = draft !== currentOwner;
  const suggested = suggestion?.owner_user_id || "";
  const suggestedName = suggestion?.owner_name || memberLabel(options.find((m) => m.user_id === suggested)) || suggested.slice(0, 8);
  // A controlled <select> whose value matches no option shows its FIRST
  // option, "Unassigned", beside a chip naming the owner, and choosing
  // Unassigned then fires no change. So the current owner (an ex-member, or
  // anyone while the member list is loading or failed) and the suggestion get
  // an option of their own when the member list does not have them.
  const listed = new Set(options.map((m) => m.user_id));
  const offList: { id: string; label: string }[] = [];
  if (currentOwner && !listed.has(currentOwner)) {
    offList.push({ id: currentOwner, label: ownerName + (options.length ? " (not an approved member)" : "") });
  }
  if (suggested && suggested !== currentOwner && !listed.has(suggested)) {
    offList.push({ id: suggested, label: suggestedName });
  }

  const save = async () => {
    if (!canAssign || !dirty) return;
    setBusy(true);
    try {
      const r: any = await AnvilBackend?.customers?.assignOwner?.({
        customer_ids: [customer.id],
        owner_user_id: draft || null,
        move_open_opportunities: !!draft && moveOpps,
      });
      window.notifySuccess?.(draft ? "Account owner saved" : "Account unassigned", customer.customer_name || "");
      for (const w of r?.warnings || []) window.notifyWarn?.("Opportunities not moved", w.message || "");
      onChanged?.();
    } catch (e: any) {
      window.notifyError?.("Could not save the account owner", e?.message || String(e));
    } finally { setBusy(false); }
  };

  return (
    <div>
      <div className="mono-sm" style={{ color: "var(--ink-3)", marginBottom: 8 }}>Account owner</div>
      <div className="row" style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        {currentOwner
          ? <span className="pri" data-testid="account-owner-name">{ownerName}</span>
          : <Chip k="ghost">unassigned</Chip>}
        {canAssign && (
          <>
            <select
              className="select"
              aria-label="Account owner"
              disabled={busy}
              value={draft}
              onChange={(e) => { touched.current = true; setDraft(e.target.value); }}
              style={{ minWidth: 220 }}
            >
              <option value="">Unassigned</option>
              {offList.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              {options.map((m) => <option key={m.user_id} value={m.user_id}>{memberLabel(m)}</option>)}
            </select>
            {!!draft && (
              <label className="mono-sm" style={{ display: "inline-flex", gap: 6, alignItems: "center", color: "var(--ink-3)" }}>
                <input type="checkbox" checked={moveOpps} onChange={(e) => setMoveOpps(e.target.checked)} aria-label="Move open opportunities" />
                move open opportunities
              </label>
            )}
            <Btn sm kind="primary" disabled={!dirty || busy} onClick={save} title="Save the account owner">
              {busy ? "Saving..." : "Save"}
            </Btn>
            {dirty && !busy && (
              <Btn sm kind="ghost" onClick={() => setDraft(currentOwner)} title="Discard the change">Reset</Btn>
            )}
          </>
        )}
      </div>
      {canAssign && membersError && (
        <div className="mono-sm" role="alert" style={{ color: "var(--bad)", fontSize: 10, marginTop: 4 }}>
          Could not load the team list, so no other member can be picked: {membersError}
        </div>
      )}
      {canAssign && !currentOwner && suggestion && (
        <div className="mono-sm" style={{ color: "var(--ink-4)", fontSize: 10, marginTop: 4 }}>
          {suggested
            ? <>Suggested: <span className="pri">{suggestedName}</span> owns {suggestion.votes} of {suggestion.total} opportunities and quotes on this account in the last 365 days. Not saved until you click Save.</>
            : (SUGGESTION_WHY[suggestion.reason] || "No suggestion.")}
        </div>
      )}
      {canAssign && moveOpps && !!draft && (
        <div className="mono-sm" style={{ color: "var(--ink-4)", fontSize: 10, marginTop: 4 }}>
          Open opportunities held by the previous owner, or by nobody, move to the new owner. Another rep's opportunities stay theirs.
        </div>
      )}
      {!canAssign && (
        <div className="mono-sm" style={{ color: "var(--ink-4)", fontSize: 10, marginTop: 4 }}>
          Read-only. A sales manager or admin assigns account owners.
        </div>
      )}
    </div>
  );
};

export default AccountOwnerPanel;
