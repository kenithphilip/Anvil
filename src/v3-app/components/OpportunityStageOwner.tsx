import React, { useEffect, useMemo, useState } from "react";
import { Banner, Btn, Chip } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { AnvilBackend } from "../lib/api";
import { RBAC } from "../lib/rbac";
import { lsGet } from "../lib/storage-keys";
import { approvedMembers, memberLabel, type Member } from "./AccountOwnerPanel";

// Move, assign and lose an opportunity, from its detail card on #/opps.
//
// Before this, no screen could move an opportunity's stage or change its
// owner, so the pipeline stayed at the stage each deal was created in, and
// the funnel, forecast and win/loss reports read stages nobody could change.
//
// Every write goes through PATCH /api/sales/opportunities, which owns the
// rules:
// - a stage moves forward, or back one stage; a closed deal does not move.
//   An illegal move returns 409 INVALID_STAGE_TRANSITION with its from and to
//   stages, and this card shows both;
// - moving to Closed lost needs a lost_reason code from the taxonomy;
// - a rep may claim an unowned opportunity; any other owner change is
//   opportunity.assign (sales_manager, admin), and the new owner must be an
//   approved member of the tenant.

type Opportunity = any;
type Stage = { id: string; t: string };
type LostReason = { code: string; label?: string | null; tenant_id?: string | null; active?: boolean | null };

// The lost reasons this tenant may use. The server's rule
// (sales/opportunities.js isLostReasonCode): a tenant row wins over the
// global row with the same code, and only active codes are accepted.
export const usableLostReasons = (resp: any): LostReason[] => {
  const rows: LostReason[] = Array.isArray(resp) ? resp : (Array.isArray(resp?.reasons) ? resp.reasons : []);
  const byCode = new Map<string, LostReason>();
  for (const r of rows) {
    if (!r || !r.code) continue;
    const prev = byCode.get(r.code);
    if (!prev || (prev.tenant_id == null && r.tenant_id != null)) byCode.set(r.code, r);
  }
  return [...byCode.values()]
    .filter((r) => r.active !== false)
    .sort((a, b) => String(a.label || a.code).localeCompare(String(b.label || b.code)));
};

// The signed-in user's id, for a claim. Same lookup as orders.tsx: the cached
// profile first, then the session. The server compares it with ctx.user.id,
// so a wrong id here is refused, never trusted.
const readCurrentUserId = (): string | null => {
  try {
    const cached = JSON.parse(lsGet("auth_profile") || "null");
    if (cached?.user?.id) return String(cached.user.id);
  } catch { /* no cached profile */ }
  try {
    const session = (AnvilBackend?.getSession?.() || null) as { user?: { id?: string } } | null;
    if (session?.user?.id) return String(session.user.id);
  } catch { /* no session */ }
  return null;
};

const errorText = (e: any): string => String(e?.message || e || "");

export const OpportunityStageOwner: React.FC<{
  opportunity: Opportunity;
  stages: Stage[];
  onChanged?: () => void;
}> = ({ opportunity, stages, onChanged }) => {
  const canAssign = RBAC.canDo("opportunity.assign");
  const canEdit = RBAC.canWrite("opps") || canAssign;
  const me = useMemo(() => readCurrentUserId(), []);
  const currentOwner: string = opportunity.owner_id || "";

  const [stage, setStage] = useState<string>(opportunity.stage || "");
  const [reason, setReason] = useState<string>("");
  const [owner, setOwner] = useState<string>(currentOwner);
  const [busy, setBusy] = useState(false);
  const [stageErr, setStageErr] = useState<any>(null);
  const [ownerErr, setOwnerErr] = useState<any>(null);
  const [reasons, setReasons] = useState<LostReason[]>([]);
  const [reasonsErr, setReasonsErr] = useState<string | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [membersErr, setMembersErr] = useState<string | null>(null);

  // A different opportunity, or this one after a save, starts clean.
  useEffect(() => {
    setStage(opportunity.stage || ""); setReason(""); setStageErr(null);
    setOwner(currentOwner); setOwnerErr(null);
  }, [opportunity.id, opportunity.stage, currentOwner]);

  // The lost reasons, when a lost deal is on screen or being made.
  const needReasons = stage === "CLOSE_LOST" || opportunity.stage === "CLOSE_LOST";
  useEffect(() => {
    if (!needReasons) return;
    let cancelled = false;
    Promise.resolve(AnvilBackend?.admin?.listLostReasons?.())
      .then((r: any) => { if (!cancelled) { setReasons(usableLostReasons(r)); setReasonsErr(null); } })
      .catch((e: any) => { if (!cancelled) setReasonsErr(errorText(e)); });
    return () => { cancelled = true; };
  }, [needReasons]);

  // The team, for a manager's owner picker.
  useEffect(() => {
    if (!canAssign) return;
    let cancelled = false;
    Promise.resolve(AnvilBackend?.admin?.listMembers?.())
      .then((r: any) => { if (!cancelled) { setMembers(approvedMembers(r)); setMembersErr(null); } })
      .catch((e: any) => { if (!cancelled) setMembersErr(errorText(e)); });
    return () => { cancelled = true; };
  }, [canAssign]);

  const stageLabel = (id: string) => stages.find((s) => s.id === id)?.t || id;
  const ownerName = opportunity.owner_name
    || memberLabel(members.find((m) => m.user_id === currentOwner))
    || (currentOwner ? currentOwner.slice(0, 8) : "");
  const lostLabel = (code: string) => reasons.find((r) => r.code === code)?.label || code;

  const save = async (payload: Record<string, unknown>, done: string, setErr: (e: any) => void) => {
    setBusy(true); setErr(null);
    try {
      await AnvilBackend?.sales?.updateOpportunity?.({ id: opportunity.id, ...payload });
      window.notifySuccess?.(done, opportunity.opportunity_name || "");
      onChanged?.();
    } catch (e: any) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  const moveStage = () => {
    if (stage === opportunity.stage) return;
    if (stage === "CLOSE_LOST" && !reason) {
      setStageErr({ message: "Pick a lost reason. A lost opportunity needs one." });
      return;
    }
    const payload: Record<string, unknown> = { stage };
    if (stage === "CLOSE_LOST") payload.lost_reason = reason;
    save(payload, "Stage moved to " + stageLabel(stage).toLowerCase(), setStageErr);
  };

  // The server's 409 names both stages. Say them in words, with the rule.
  const stageError = (() => {
    if (!stageErr) return null;
    const e = stageErr?.body?.error;
    if (stageErr?.status === 409 && e?.code === "INVALID_STAGE_TRANSITION") {
      return {
        title: "This stage move is not allowed",
        text: "Cannot move from " + stageLabel(e.from) + " to " + stageLabel(e.to)
          + ". An opportunity moves forward, or back one stage. A closed opportunity does not move.",
      };
    }
    return { title: "Could not move the stage", text: errorText(stageErr) };
  })();

  const ownerError = (() => {
    if (!ownerErr) return null;
    if (ownerErr?.status === 403) return "Only a sales manager or admin can reassign an opportunity.";
    return errorText(ownerErr);
  })();

  // A controlled select whose value matches no option shows its first
  // option, so an owner who is not in the member list gets an option.
  const listed = new Set(members.map((m) => m.user_id));
  const offList = currentOwner && !listed.has(currentOwner)
    ? [{ id: currentOwner, label: ownerName + (members.length ? " (not an approved member)" : "") }]
    : [];

  return (
    <div data-testid="opportunity-stage-owner">
      <div className="mono-sm" style={{ color: "var(--ink-3)", marginBottom: 8 }}>Stage</div>
      {canEdit ? (
        <div className="row" style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <select className="select" aria-label="Opportunity stage" disabled={busy} value={stage}
                  onChange={(e) => { setStage(e.target.value); setStageErr(null); }} style={{ minWidth: 200 }}>
            {stages.map((s) => <option key={s.id} value={s.id}>{s.t}</option>)}
          </select>
          {stage === "CLOSE_LOST" && stage !== opportunity.stage && (
            <select className="select" aria-label="Lost reason" disabled={busy} value={reason}
                    onChange={(e) => { setReason(e.target.value); setStageErr(null); }} style={{ minWidth: 220 }}>
              <option value="">Pick a lost reason</option>
              {reasons.map((r) => <option key={r.code} value={r.code}>{r.label || r.code}</option>)}
            </select>
          )}
          <Btn sm kind="primary" disabled={busy || stage === opportunity.stage} onClick={moveStage}
               title="Move this opportunity to the chosen stage">
            {busy ? "Saving..." : "Move"}
          </Btn>
        </div>
      ) : (
        <Chip k="info">{stageLabel(opportunity.stage)}</Chip>
      )}
      {stageError && (
        <div style={{ marginTop: 8 }}>
          <Banner kind="bad" icon={Icon.alert} title={stageError.title}>
            <span className="mono-sm">{stageError.text}</span>
          </Banner>
        </div>
      )}
      {needReasons && reasonsErr && (
        <div className="mono-sm" role="alert" style={{ color: "var(--bad)", fontSize: 10, marginTop: 4 }}>
          Could not load the lost reasons: {reasonsErr}
        </div>
      )}
      {opportunity.stage === "CLOSE_LOST" && (
        <div className="mono-sm" style={{ marginTop: 6 }}>
          Lost reason: <span className="pri" data-testid="opportunity-lost-reason">
            {opportunity.lost_reason ? lostLabel(opportunity.lost_reason) : "not recorded"}
          </span>
        </div>
      )}

      <div className="mono-sm" style={{ color: "var(--ink-3)", margin: "14px 0 8px" }}>Owner</div>
      <div className="row" style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        {currentOwner
          ? <span className="pri" data-testid="opportunity-owner-name">{ownerName}</span>
          : <Chip k="ghost">unassigned</Chip>}
        {canAssign && (
          <>
            <select className="select" aria-label="Opportunity owner" disabled={busy} value={owner}
                    onChange={(e) => { setOwner(e.target.value); setOwnerErr(null); }} style={{ minWidth: 220 }}>
              <option value="">Unassigned</option>
              {offList.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              {members.map((m) => <option key={m.user_id} value={m.user_id}>{memberLabel(m)}</option>)}
            </select>
            <Btn sm kind="primary" disabled={busy || owner === currentOwner}
                 onClick={() => save({ owner_id: owner || null }, owner ? "Owner saved" : "Opportunity unassigned", setOwnerErr)}
                 title="Save the owner">
              Save owner
            </Btn>
          </>
        )}
        {!canAssign && canEdit && !currentOwner && me && (
          <Btn sm kind="ghost" disabled={busy} onClick={() => save({ owner_id: me }, "Opportunity claimed", setOwnerErr)}
               title="Make yourself the owner of this unowned opportunity">
            Claim
          </Btn>
        )}
      </div>
      {canAssign && membersErr && (
        <div className="mono-sm" role="alert" style={{ color: "var(--bad)", fontSize: 10, marginTop: 4 }}>
          Could not load the team list, so no other member can be picked: {membersErr}
        </div>
      )}
      {ownerError && (
        <div className="mono-sm" role="alert" style={{ color: "var(--bad)", fontSize: 10, marginTop: 4 }}>
          {ownerError}
        </div>
      )}
      {!canAssign && (
        <div className="mono-sm" style={{ color: "var(--ink-4)", fontSize: 10, marginTop: 4 }}>
          A sales manager or admin reassigns opportunities.
        </div>
      )}
    </div>
  );
};

export default OpportunityStageOwner;
