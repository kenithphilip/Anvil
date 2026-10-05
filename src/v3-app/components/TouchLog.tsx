import React, { useEffect, useState } from "react";
import { Banner, Btn, Card, Chip } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { AnvilBackend } from "../lib/api";
import { RBAC } from "../lib/rbac";
import { fmtDate } from "../lib/helpers";
import { addBusinessDays } from "../../api/_lib/datemath.js";
import { TOUCH_CHANNELS, TOUCH_DOCUMENT_TYPE } from "../../api/_lib/rep-touch.js";

// Follow-up timeline + "Log a touch" form for a quote or an opportunity.
//
// Mounted by the QuoteDetailDrawer Follow-up tab and by the opportunity detail
// card in screens/opps.tsx. Lists every communications row filed against the
// object (rep touches, the quote email, automatic nudges), newest first, and
// posts a new rep touch to /api/communications/log.
//
// A quote's timeline covers every version of it (versions=all): a revise
// inserts a new quotes row, and the call that prompted the revise was logged
// against the old one. A new touch is filed against the version on screen.
//
// The form shows only for roles the endpoint admits ("touch.log", registered
// in rbac.ts ACTIONS and auth.js SERVER_ACTIONS). Esc in a note that has text
// does not close the host drawer, so an unsent note is not lost.
//
// The form is prefilled so a rep types only what was said:
//   * channel: the channel of the last touch on this object (else "call");
//   * contact: the object's own contact (a quote's customer_contact_id), else
//     the contact of the last touch;
//   * next follow-up: today plus 3 business days, the same addBusinessDays the
//     API uses for delivery dates (_lib/datemath.js), so weekends are skipped.

export const FOLLOWUP_DEFAULT_BUSINESS_DAYS = 3;

// Today as YYYY-MM-DD in the rep's own timezone. addBusinessDays counts in
// UTC calendar days, so it is handed a plain date, not a timestamp: a rep in
// IST at 02:00 is on today's date, not yesterday's UTC one.
const localIsoDate = (d: Date): string => {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return d.getFullYear() + "-" + mm + "-" + dd;
};

export const defaultNextFollowup = (now: Date = new Date()): string =>
  addBusinessDays(localIsoDate(now), FOLLOWUP_DEFAULT_BUSINESS_DAYS)?.date || "";

const CHANNEL_LABEL: Record<string, string> = {
  call: "Call", meeting: "Meeting", whatsapp: "WhatsApp", visit: "Visit", note: "Note",
};

const asRows = (r: any): any[] => {
  if (Array.isArray(r)) return r;
  if (Array.isArray(r?.communications)) return r.communications;
  return [];
};

const isTouch = (r: any) => r?.document_type === TOUCH_DOCUMENT_TYPE;

// A date-only string rendered as that calendar day. new Date("2026-10-07")
// is UTC midnight, which is the previous evening west of Greenwich.
const fmtDay = (iso: string | null | undefined) => (iso ? fmtDate(iso + "T00:00:00", "medium") : "");

export const TouchLog: React.FC<{
  objectType: "quote" | "opportunity";
  objectId: string;
  customerId?: string | null;
  // The object's own contact (a quote's customer_contact_id). Opportunities
  // carry none, so the last touch's contact is used instead.
  contactId?: string | null;
  // The customer's contacts when the host already loaded them (the quote
  // drawer does). Omitted: TouchLog loads them itself.
  contacts?: any[] | null;
}> = ({ objectType, objectId, customerId, contactId, contacts: hostContacts }) => {
  const [rows, setRows] = useState<any[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [bump, setBump] = useState(0);
  const [ownContacts, setOwnContacts] = useState<any[] | null>(null);
  // null / undefined = the rep has not chosen, so the prefill applies.
  const [channelPick, setChannelPick] = useState<string | null>(null);
  const [contactPick, setContactPick] = useState<string | undefined>(undefined);
  const [body, setBody] = useState("");
  const [nextDate, setNextDate] = useState<string>(() => defaultNextFollowup());
  const [busy, setBusy] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const canLog = RBAC.canDo("touch.log");

  useEffect(() => {
    let cancelled = false;
    setLoadErr(null);
    const filters: Record<string, string> = { object_type: objectType, object_id: objectId };
    if (objectType === "quote") filters.versions = "all";
    Promise.resolve((AnvilBackend as any)?.communications?.list?.(filters))
      .then((r: any) => { if (!cancelled) setRows(asRows(r)); })
      .catch((e: any) => { if (!cancelled) { setRows([]); setLoadErr(e?.message || String(e)); } });
    return () => { cancelled = true; };
  }, [objectType, objectId, bump]);

  useEffect(() => {
    if (hostContacts !== undefined || !customerId) return;
    let cancelled = false;
    Promise.resolve((AnvilBackend as any)?.customers?.listContacts?.({ customer_id: customerId }))
      .then((r: any) => { if (!cancelled) setOwnContacts(Array.isArray(r) ? r : (r?.contacts || [])); })
      .catch(() => { if (!cancelled) setOwnContacts([]); });
    return () => { cancelled = true; };
  }, [customerId, hostContacts]);

  const contacts = (hostContacts !== undefined ? hostContacts : ownContacts) || [];
  const contactName = (id: string | null | undefined) => {
    const c = id ? contacts.find((x: any) => x.id === id) : null;
    return c ? (c.name || c.email || "") : "";
  };

  // Newest first. The API already orders by created_at desc; sorting again
  // keeps the timeline right if a host ever hands over an unsorted list.
  const sorted = (rows || []).slice().sort((a, b) =>
    String(b.created_at || "").localeCompare(String(a.created_at || "")));
  const lastTouch = sorted.find((r) => isTouch(r) && TOUCH_CHANNELS.includes(r.channel));

  const channel = channelPick ?? lastTouch?.channel ?? "call";
  const contact = contactPick !== undefined ? contactPick : (contactId || lastTouch?.customer_contact_id || "");

  const logTouch = async () => {
    const text = body.trim();
    if (!text) return;
    setBusy(true);
    setSaveErr(null);
    const payload: any = { object_type: objectType, object_id: objectId, channel, body: text };
    if (contact) payload.customer_contact_id = contact;
    if (nextDate) payload.metadata = { next_followup_at: nextDate };
    try {
      await (AnvilBackend as any)?.communications?.log?.(payload);
      window.notifySuccess?.("Touch logged", (CHANNEL_LABEL[channel] || channel) + (nextDate ? ", next " + fmtDay(nextDate) : ""));
      setBody("");
      setNextDate(defaultNextFollowup());
      setBump((n) => n + 1);
    } catch (e: any) {
      const msg = e?.message || String(e);
      setSaveErr(msg);
      window.notifyError?.("Could not log touch", msg);
    } finally {
      setBusy(false);
    }
  };

  // The quote drawer and quotes.tsx both close on Esc from a window listener.
  // Stopping the key here (React dispatches at the root, before window) keeps
  // a note with text in it from being thrown away by a reflex Esc.
  const onNoteKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape" && body.trim()) e.stopPropagation();
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {!canLog ? (
        <div className="mono-sm" style={{ color: "var(--ink-3)" }}>Your role can read follow-ups but not log them.</div>
      ) : (
        <Card title="Log a touch" eyebrow="A call, meeting or visit outside Anvil. Never sent to the customer.">
          {saveErr && (
            <div style={{ marginBottom: 8 }}>
              <Banner kind="bad" icon={Icon.alert} title="Could not log touch"><span className="mono-sm">{saveErr}</span></Banner>
            </div>
          )}
          <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
            <label className="mono-sm" style={{ display: "flex", flexDirection: "column", gap: 4, color: "var(--ink-3)" }}>
              Channel
              <select className="select" aria-label="Touch channel" value={channel} onChange={(e) => setChannelPick(e.target.value)}>
                {TOUCH_CHANNELS.map((c: string) => <option key={c} value={c}>{CHANNEL_LABEL[c] || c}</option>)}
              </select>
            </label>
            <label className="mono-sm" style={{ display: "flex", flexDirection: "column", gap: 4, color: "var(--ink-3)", flex: 1, minWidth: 180 }}>
              Contact
              <select className="select" aria-label="Touch contact" value={contact}
                disabled={!customerId}
                onChange={(e) => setContactPick(e.target.value)}>
                <option value="">{!customerId ? "No customer linked" : contacts.length === 0 ? "No contacts on file" : "No contact"}</option>
                {/* The prefilled contact before the list arrives (or one since
                    removed from the list) still shows as chosen, so what is on
                    screen is what gets sent. */}
                {contact && !contacts.some((c: any) => c.id === contact) && <option value={contact}>contact on file</option>}
                {contacts.map((c: any) => (
                  <option key={c.id} value={c.id}>{(c.name || c.email || String(c.id).slice(0, 8)) + (c.role ? " - " + c.role : "")}</option>
                ))}
              </select>
            </label>
            <label className="mono-sm" style={{ display: "flex", flexDirection: "column", gap: 4, color: "var(--ink-3)" }}>
              Next follow-up
              <input className="input mono" type="date" aria-label="Next follow-up" value={nextDate} onChange={(e) => setNextDate(e.target.value)} />
            </label>
          </div>
          <textarea className="input" rows={3} aria-label="Touch notes" style={{ width: "100%", marginTop: 8 }}
            placeholder="What was said, and what happens next"
            value={body} onChange={(e) => setBody(e.target.value)} onKeyDown={onNoteKeyDown} />
          <div className="row" style={{ justifyContent: "flex-end", marginTop: 8 }}>
            <Btn sm kind="primary" disabled={busy || !body.trim()} onClick={logTouch}>{busy ? "Logging..." : "Log touch"}</Btn>
          </div>
        </Card>
      )}

      <Card title="Follow-up timeline" eyebrow="Touches, quote emails and automatic nudges, newest first">
        {loadErr && <Banner kind="bad" icon={Icon.alert} title="Could not load follow-ups"><span className="mono-sm">{loadErr}</span></Banner>}
        {rows == null ? (
          <div className="mono-sm" style={{ color: "var(--ink-3)", padding: 10 }}>Loading follow-ups...</div>
        ) : sorted.length === 0 ? (
          !loadErr && <div className="mono-sm" style={{ color: "var(--ink-3)", padding: 10 }}>No touches yet. Log the first call, meeting or visit above.</div>
        ) : (
          <ul aria-label="Follow-up timeline" style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 10 }}>
            {sorted.map((r) => {
              const touch = isTouch(r);
              const label = touch
                ? (CHANNEL_LABEL[r.channel] || r.channel)
                : String(r.document_type || r.channel || "message").replace(/_/g, " ");
              const next = r.next_followup_at || r.metadata?.next_followup_at;
              const who = contactName(r.customer_contact_id);
              const earlier = objectType === "quote" && r.object_id && r.object_id !== objectId;
              return (
                <li key={r.id} style={{ borderBottom: "1px solid var(--line)", paddingBottom: 8 }}>
                  <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <Chip k={touch ? "info" : "ghost"}>{label}</Chip>
                    {!touch && r.status && r.status !== "sent" && <Chip k={r.status === "failed" ? "bad" : "warn"}>{r.status}</Chip>}
                    {earlier && <Chip k="ghost">earlier version</Chip>}
                    <span className="mono-sm" style={{ color: "var(--ink-3)" }}>{fmtDate(r.sent_at || r.created_at, "medium")}</span>
                    {who && <span className="mono-sm" style={{ color: "var(--ink-3)" }}>with {who}</span>}
                    {next && <span className="mono-sm" style={{ marginLeft: "auto", color: "var(--ink-2)" }}>next follow-up {fmtDay(next)}</span>}
                  </div>
                  <div style={{ fontSize: 12.5, color: "var(--ink-2)", whiteSpace: "pre-wrap", marginTop: 4 }}>
                    {/* The API returns body for touches only (list.js). */}
                    {touch ? r.body : (r.subject || "")}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
};

export default TouchLog;
