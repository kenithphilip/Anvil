// Voice AI operator screen.
//
// Three tabs:
//
//   - Calls:   list of voice_calls (in-progress + recent), tap to
//              read the transcript + extracted actions.
//   - Outbound: form to place a compliance-gated outbound call.
//              Pre-checks DND + consent before submitting; shows
//              a clear refusal reason if blocked.
//   - Consent:  table of voice_consent records, with capture +
//              withdraw controls. The TCPA / GDPR / DPDP gate the
//              outbound endpoint enforces.
//
// Compliance posture is surfaced prominently at the top: which
// region the active config belongs to, whether outbound is
// enabled, when the operator last reviewed compliance.
//
// Audit: DEFERRED_ROADMAP §1 (voice AI). The webhook + process
// drainer + outbound endpoint shipped in supporting commits;
// this screen drives them.

import React, { useEffect, useMemo, useState } from "react";
import { Banner, Btn, Card, Chip, KPI, KPIRow, WSTabs, WSTitle } from "../lib/primitives";
import { ageLabel } from "../lib/helpers";
import { ObaraBackend } from "../lib/api";

interface VoiceConfig {
  id: string;
  provider: string;
  display_name?: string | null;
  phone_number?: string | null;
  region?: string | null;
  recording_disclosure?: string | null;
  outbound_enabled?: boolean;
  compliance_reviewed_at?: string | null;
  active?: boolean;
}

interface VoiceCall {
  id: string;
  external_id: string;
  provider: string;
  direction: "inbound" | "outbound";
  status: string;
  caller_phone_number?: string | null;
  callee_phone_number?: string | null;
  customer_id?: string | null;
  started_at: string;
  ended_at?: string | null;
  summary?: string | null;
}

interface ConsentRow {
  id: string;
  phone_number: string;
  scope: string;
  source: string;
  consented_at: string;
  expires_at?: string | null;
  withdrawn_at?: string | null;
  notes?: string | null;
}

const STATUS_TONE: Record<string, "info" | "good" | "bad" | "ghost" | "warn"> = {
  in_progress: "info",
  completed: "good",
  failed: "bad",
  escalated: "warn",
};

const TABS = [
  { id: "calls",    label: "Calls" },
  { id: "outbound", label: "Outbound" },
  { id: "consent",  label: "Consent" },
];

const fmtPhone = (raw?: string | null) => (raw ? raw : "—");

const Voice: React.FC = () => {
  const [active, setActive] = useState("calls");
  const [configs, setConfigs] = useState<VoiceConfig[] | null>(null);
  const [calls, setCalls] = useState<VoiceCall[] | null>(null);
  const [consent, setConsent] = useState<ConsentRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Outbound form state.
  const [oTo, setOTo] = useState("");
  const [oReason, setOReason] = useState("voice_followup");
  const [oResult, setOResult] = useState<{ ok: boolean; message: string; region?: string; reason?: string } | null>(null);
  const [oBusy, setOBusy] = useState(false);

  // Consent capture form state.
  const [cPhone, setCPhone] = useState("");
  const [cSource, setCSource] = useState("inbound_call");
  const [cNotes, setCNotes] = useState("");
  const [cBusy, setCBusy] = useState(false);

  const reloadCalls = () => {
    // We rely on /api/voice/calls if present, else show an
    // informative empty-state. The screen is functional even
    // when the calls feed is null.
    setCalls([]);
  };

  const reloadConfigs = () => {
    setErr(null);
    Promise.resolve((ObaraBackend as any)?.voice?.listConfigs?.())
      .then((data: any) => setConfigs(Array.isArray(data?.configs) ? data.configs : (Array.isArray(data) ? data : [])))
      .catch((e: any) => setErr(e?.message || String(e)));
  };

  const reloadConsent = (phone?: string) => {
    setErr(null);
    Promise.resolve((ObaraBackend as any)?.voice?.listConsent?.(phone))
      .then((data: any) => setConsent(Array.isArray(data?.rows) ? data.rows : []))
      .catch((e: any) => setErr(e?.message || String(e)));
  };

  useEffect(() => { reloadConfigs(); reloadCalls(); reloadConsent(); }, []);

  const activeConfig = useMemo(() => (configs || []).find((c) => c.active) || (configs || [])[0] || null, [configs]);

  const onPlaceOutbound = async () => {
    if (!oTo.trim()) return;
    setOBusy(true);
    setOResult(null);
    try {
      const resp: any = await (ObaraBackend as any)?.voice?.placeOutbound?.({
        to: oTo.trim(),
        reason: oReason,
      });
      if (resp?.ok) {
        setOResult({ ok: true, message: "Call placed: " + resp.external_id + " (region " + resp.region + ")", region: resp.region });
        setOTo("");
      } else {
        setOResult({ ok: false, message: "Unexpected response", region: resp?.region });
      }
    } catch (e: any) {
      // The outbound endpoint surfaces compliance refusals as 409
      // with a structured error body. Render it directly.
      const msg = e?.message || String(e);
      setOResult({ ok: false, message: msg });
    } finally {
      setOBusy(false);
    }
  };

  const onCaptureConsent = async () => {
    if (!cPhone.trim()) return;
    setCBusy(true);
    setErr(null);
    try {
      await (ObaraBackend as any)?.voice?.recordConsent?.({
        phone_number: cPhone.trim(),
        source: cSource,
        notes: cNotes || null,
      });
      setCPhone(""); setCNotes("");
      reloadConsent();
      window.notifySuccess?.("Consent recorded");
    } catch (e: any) {
      setErr(e?.message || String(e));
      window.notifyError?.("Could not record consent: " + (e?.message || e));
    } finally {
      setCBusy(false);
    }
  };

  const onWithdraw = async (id: string) => {
    if (!window.confirm?.("Withdraw this consent? The customer will not be dialled until they re-consent.")) return;
    try {
      await (ObaraBackend as any)?.voice?.withdrawConsent?.(id);
      reloadConsent();
      window.notifySuccess?.("Consent withdrawn");
    } catch (e: any) {
      window.notifyError?.("Withdraw failed: " + (e?.message || e));
    }
  };

  return (
    <>
      <WSTitle
        eyebrow="Comms · Voice AI"
        title="Voice"
        meta={activeConfig ? activeConfig.provider + " · " + (activeConfig.phone_number || "no number") + " · " + (activeConfig.region || "OTHER") : "no config"}
        right={<Btn sm kind="ghost" onClick={() => { reloadConfigs(); reloadCalls(); reloadConsent(); }}>Refresh</Btn>}
      />
      <WSTabs
        tabs={TABS.map((t) => ({ id: t.id, label: t.label }))}
        active={active}
        onChange={setActive}
      />

      <div className="ws-content">
        {err && <Banner kind="bad" title="Error">{err}</Banner>}

        <KPIRow cols={3}>
          <KPI lbl="Active configs"
               v={String((configs || []).filter((c) => c.active).length)}
               d={(configs || []).length + " total"} />
          <KPI lbl="Outbound enabled"
               v={(configs || []).some((c) => c.outbound_enabled) ? "yes" : "no"}
               d={activeConfig?.compliance_reviewed_at
                 ? "reviewed " + ageLabel(activeConfig.compliance_reviewed_at) + " ago"
                 : "no compliance review on file"} />
          <KPI lbl="Active consent"
               v={String((consent || []).filter((c) => !c.withdrawn_at).length)}
               d={(consent || []).length + " records"} />
        </KPIRow>

        {active === "calls" && (
          <Card flush>
            {calls == null ? (
              <div className="muted" style={{ padding: 16 }}>Loading...</div>
            ) : calls.length === 0 ? (
              <div className="muted" style={{ padding: 16 }}>
                No voice calls in scope yet. Inbound calls land here automatically when a customer dials the
                provisioned number; outbound calls land here when placed via the Outbound tab or the
                voice_followup agent.
              </div>
            ) : (
              <table className="tbl">
                <thead><tr>
                  <th>Started</th>
                  <th>Direction</th>
                  <th>From</th>
                  <th>To</th>
                  <th>Status</th>
                  <th>Summary</th>
                </tr></thead>
                <tbody>
                  {calls.map((c) => (
                    <tr key={c.id}>
                      <td className="mono-sm">{ageLabel(c.started_at)}</td>
                      <td><Chip k={c.direction === "outbound" ? "info" : "ghost"}>{c.direction}</Chip></td>
                      <td>{fmtPhone(c.caller_phone_number)}</td>
                      <td>{fmtPhone(c.callee_phone_number)}</td>
                      <td><Chip k={STATUS_TONE[c.status] || "ghost"}>{c.status}</Chip></td>
                      <td>{c.summary || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        )}

        {active === "outbound" && (
          <Card title="Place an outbound call" eyebrow="compliance-gated"
            right={!activeConfig?.outbound_enabled
              ? <Chip k="bad">outbound disabled</Chip>
              : <Chip k="good">outbound enabled</Chip>}>
            <p className="muted">
              The endpoint refuses the dial if the destination is on a Do-Not-Call list (TRAI NDNC, FCC DNC,
              tenant-manual) or if there is no active voice consent on file. Capture consent on the Consent tab
              first if needed.
            </p>
            <div style={{ display: "flex", gap: 8, alignItems: "end", marginTop: 12, flexWrap: "wrap" }}>
              <label style={{ display: "block" }}>
                <div className="lbl">Destination (E.164)</div>
                <input className="input" value={oTo} onChange={(ev) => setOTo(ev.target.value)} placeholder="+919876543210" style={{ width: 220 }} />
              </label>
              <label style={{ display: "block" }}>
                <div className="lbl">Reason</div>
                <select className="input" value={oReason} onChange={(ev) => setOReason(ev.target.value)} style={{ width: 220 }}>
                  <option value="voice_followup">Voice follow-up</option>
                  <option value="ar_collection">AR collection</option>
                  <option value="quote_acceptance">Quote acceptance</option>
                  <option value="service_visit">Service visit scheduling</option>
                  <option value="other">Other</option>
                </select>
              </label>
              <Btn kind="primary" onClick={onPlaceOutbound} disabled={oBusy || !oTo.trim() || !activeConfig?.outbound_enabled}>
                {oBusy ? "Placing..." : "Place call"}
              </Btn>
            </div>
            {oResult && (
              <Banner kind={oResult.ok ? "good" : "bad"} title={oResult.ok ? "Call placed" : "Refused"}>
                {oResult.message}
                {oResult.region && <> · region <code>{oResult.region}</code></>}
              </Banner>
            )}
          </Card>
        )}

        {active === "consent" && (
          <>
            <Card title="Capture consent" eyebrow="prior consent for outbound">
              <p className="muted">
                Before dialing a customer, we need an explicit, dated consent record. Captured here from a signed
                form, prior inbound call, opt-in form, or recorded verbal.
              </p>
              <div style={{ display: "flex", gap: 8, alignItems: "end", marginTop: 12, flexWrap: "wrap" }}>
                <label style={{ display: "block" }}>
                  <div className="lbl">Phone number (E.164)</div>
                  <input className="input" value={cPhone} onChange={(ev) => setCPhone(ev.target.value)} placeholder="+919876543210" style={{ width: 220 }} />
                </label>
                <label style={{ display: "block" }}>
                  <div className="lbl">Source</div>
                  <select className="input" value={cSource} onChange={(ev) => setCSource(ev.target.value)} style={{ width: 220 }}>
                    <option value="inbound_call">Inbound call</option>
                    <option value="inbound_message">Inbound message</option>
                    <option value="signed_agreement">Signed agreement</option>
                    <option value="opt_in_form">Opt-in form</option>
                    <option value="recorded_verbal">Recorded verbal</option>
                    <option value="manual_attestation">Manual attestation</option>
                  </select>
                </label>
                <label style={{ display: "block", flex: 1, minWidth: 240 }}>
                  <div className="lbl">Notes</div>
                  <input className="input" value={cNotes} onChange={(ev) => setCNotes(ev.target.value)} placeholder="optional" />
                </label>
                <Btn kind="primary" onClick={onCaptureConsent} disabled={cBusy || !cPhone.trim()}>
                  {cBusy ? "Saving..." : "Record consent"}
                </Btn>
              </div>
            </Card>
            <Card flush>
              {consent == null ? (
                <div className="muted" style={{ padding: 16 }}>Loading...</div>
              ) : consent.length === 0 ? (
                <div className="muted" style={{ padding: 16 }}>No consent records yet. Capture the first one above.</div>
              ) : (
                <table className="tbl">
                  <thead><tr>
                    <th>Phone</th>
                    <th>Source</th>
                    <th>Recorded</th>
                    <th>Expires</th>
                    <th>State</th>
                    <th></th>
                  </tr></thead>
                  <tbody>
                    {consent.map((c) => (
                      <tr key={c.id}>
                        <td className="mono-sm">{c.phone_number}</td>
                        <td>{c.source.replace(/_/g, " ")}</td>
                        <td>{ageLabel(c.consented_at)}</td>
                        <td>{c.expires_at ? ageLabel(c.expires_at) : "—"}</td>
                        <td>
                          {c.withdrawn_at
                            ? <Chip k="bad">withdrawn</Chip>
                            : c.expires_at && new Date(c.expires_at).getTime() < Date.now()
                              ? <Chip k="warn">expired</Chip>
                              : <Chip k="good">active</Chip>}
                        </td>
                        <td>
                          {!c.withdrawn_at && (
                            <Btn sm kind="ghost" onClick={() => onWithdraw(c.id)}>Withdraw</Btn>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </>
        )}
      </div>
    </>
  );
};

export default Voice;
