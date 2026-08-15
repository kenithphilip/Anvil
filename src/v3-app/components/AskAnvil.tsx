// Ask Anvil — the floating, module-scoped agent surface.
//
// A button bottom-right; a panel above it. The persona follows the module, and
// in this slice there is exactly one: the read-only Sales Order agent.
//
// THREE THINGS THIS DELIBERATELY DOES NOT DO
//
// 1. It does not render unless /api/agent/personas says the tenant enabled it.
//    The flag is server-side (tenant_settings.so_agent_enabled, migration 210),
//    default false, and /api/erp_chat/send re-checks it — so a client that
//    forges a persona gets a 403 regardless of what this component believes.
//
// 2. It does not write. The persona's scope list has no write.* scope, so the
//    write tools are never offered to the model. There is no approval card here
//    because there is nothing to approve yet.
//
// 3. It does not ask a model what to suggest. The chips come from anomalies and
//    findings the workspace already fetched — no call fires until the operator
//    sends something.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnvilBackend } from "../lib/api";
import { renderMarkdown } from "../lib/markdown";
import { suggestionsForOrder, type Suggestion } from "../lib/agent-suggestions";

interface Persona { id: string; label: string; routes?: string[]; placeholder?: string }

// Personas change when an operator flips a tenant flag — not within a session.
// The SO workspace remounts this component as its data lands, and each mount
// was re-fetching the same list. Cache the in-flight promise per tab so N
// mounts cost one request.
let personaCache: Promise<Persona[]> | null = null;
const fetchPersonas = (): Promise<Persona[]> => {
  if (!personaCache) {
    personaCache = Promise.resolve()
      .then(() => (AnvilBackend as any)?.agent?.personas?.())
      .then((r: any) => (r?.personas || []) as Persona[])
      .catch(() => {
        // Do not cache a failure: a 401 during a token refresh would otherwise
        // disable the surface for the rest of the session.
        personaCache = null;
        return [] as Persona[];
      });
  }
  return personaCache;
};

// Test-only: the cache is module-level and would otherwise leak the first
// test's answer into every later one.
export const __resetPersonaCache = () => { personaCache = null; };
interface Turn { role: "user" | "assistant"; text: string; tools?: string[] }

interface Props {
  /** Route id this mount sits on; must match the persona's `routes`. */
  route: string;
  /** Signals the panel derives its suggested actions from. */
  context: Parameters<typeof suggestionsForOrder>[0];
  /** Record this panel is about. Sent as a STRUCTURED id, never as message text —
   *  a PO number written into the message was matched by a redaction rule and
   *  reached the model as "[redacted-phone]". The server loads the record from
   *  its own tables and puts it in the system prompt, which is not redacted. */
  recordId?: string | null;
}

export const AskAnvil: React.FC<Props> = ({ route, context, recordId }) => {
  const [persona, setPersona] = useState<Persona | null>(null);
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const sessionRef = useRef<string | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Ask once per mount which personas this tenant has. A tenant without the
  // flag gets an empty list and this component renders nothing at all — no
  // button, no keyboard target, no DOM.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const list = await fetchPersonas();
        if (!alive) return;
        setPersona(list.find((p) => (p.routes || []).includes(route)) || null);
      } catch { if (alive) setPersona(null); }
    })();
    return () => { alive = false; };
  }, [route]);

  const suggestions: Suggestion[] = React.useMemo(
    () => (persona ? suggestionsForOrder(context) : []),
    [persona, context],
  );

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [turns, busy]);

  const send = useCallback(async (text: string) => {
    const content = text.trim();
    if (!content || busy || !persona) return;
    setErr(null);
    setDraft("");
    setTurns((t) => [...t, { role: "user", text: content }]);
    setBusy(true);
    try {
      // record_id is sent on the FIRST turn only: the server folds it into the
      // system prompt, and the session carries the history from then on.
      // Resending it every turn would re-read the order for no benefit.
      const resp: any = await AnvilBackend?.erpChat?.send?.({
        content,
        persona: persona.id,
        ...(!sessionRef.current && recordId ? { record_id: recordId } : {}),
        session_id: sessionRef.current || undefined,
      });
      if (resp?.session_id) sessionRef.current = resp.session_id;
      const tools = Array.isArray(resp?.tool_trace)
        ? resp.tool_trace.map((t: any) => (typeof t === "string" ? t : t?.name)).filter(Boolean)
        : [];
      setTurns((t) => [...t, { role: "assistant", text: String(resp?.content || resp?.message || "No answer returned."), tools }]);
    } catch (e: any) {
      // Surface the reason. A 403 here means the flag was turned off mid-session,
      // and "something went wrong" would send the operator hunting.
      setErr(e?.message ? String(e.message) : "The assistant could not be reached.");
    } finally {
      setBusy(false);
    }
  }, [busy, persona, recordId]);

  if (!persona) return null;

  // PORTALLED TO <body> ON PURPOSE.
  //
  // position:fixed resolves against the nearest ancestor that establishes a
  // containing block, and ANY non-`none` transform does that — including the
  // identity matrix left behind by a finished animation. The v3 screen wrapper
  // `.route-enter` carries exactly that, so rendering in place pinned the
  // button to the bottom of the SCREEN CONTENT and let it scroll away instead
  // of floating over the viewport.
  //
  // Fixing the wrapper would work until the next transform, filter or
  // will-change lands anywhere above this component. A portal is immune to all
  // of them, and it also puts the panel in a clean stacking context alongside
  // the other overlays rather than inside whatever the screen happens to nest.
  if (typeof document === "undefined") return null;

  return createPortal(
    <>
      {!open && (
        <button type="button" className="aa-fab" onClick={() => setOpen(true)}
          aria-expanded={false} aria-controls="aa-panel"
          title={persona.label + " — read-only"}>
          <span className="aa-dot" aria-hidden="true" />
          Ask Anvil
          {suggestions.length > 0 && <span className="aa-count">{suggestions.length}</span>}
        </button>
      )}

      {open && (
        <aside className="aa-panel" id="aa-panel" aria-label={persona.label}>
          <header className="aa-head">
            <span className="aa-avatar" aria-hidden="true">SO</span>
            <span className="aa-meta">
              <span className="aa-name">{persona.label}</span>
              <span className="aa-scope">read-only · cannot change this order</span>
            </span>
            <button type="button" className="aa-x" onClick={() => setOpen(false)} aria-label="Close Ask Anvil">×</button>
          </header>

          <div className="aa-body" ref={bodyRef}>
            {turns.length === 0 && (
              <p className="aa-hello">
                I can read this order and the checks that ran on it. I can’t change anything —
                ask me what’s wrong with it and I’ll show you where I looked.
              </p>
            )}
            {turns.map((t, i) => (
              <div key={i} className={t.role === "user" ? "aa-msg aa-me" : "aa-msg aa-ai"}>
                {t.role === "assistant" && t.tools && t.tools.length > 0 && (
                  <details className="aa-trace">
                    <summary>▸ read {t.tools.length} source{t.tools.length > 1 ? "s" : ""}</summary>
                    <ol>{t.tools.map((n, j) => <li key={j}>{n}</li>)}</ol>
                  </details>
                )}
                {t.role === "assistant"
                  ? <div dangerouslySetInnerHTML={{ __html: renderMarkdown(t.text) }} />
                  : t.text}
              </div>
            ))}
            {busy && <div className="aa-msg aa-ai aa-busy">Looking…</div>}
            {err && <div className="aa-err" role="alert">{err}</div>}
          </div>

          {suggestions.length > 0 && turns.length === 0 && (
            <div className="aa-sugg">
              <div className="aa-sugg-lbl">Suggested · from this order’s checks</div>
              {suggestions.map((s) => (
                <button key={s.id} type="button" onClick={() => { setDraft(s.text); inputRef.current?.focus(); }}>
                  <span className={"aa-sev aa-sev-" + s.severity} aria-hidden="true" />
                  {s.text}
                  <span className="aa-src">{s.source}</span>
                </button>
              ))}
            </div>
          )}

          <form className="aa-composer" onSubmit={(e) => { e.preventDefault(); send(draft); }}>
            <input ref={inputRef} value={draft} onChange={(e) => setDraft(e.target.value)}
              placeholder={persona.placeholder || "Ask about this order…"}
              aria-label="Ask Anvil" disabled={busy} />
            <button type="submit" className="aa-send" disabled={busy || !draft.trim()}>Send</button>
          </form>
        </aside>
      )}
    </>,
    document.body,
  );
};
