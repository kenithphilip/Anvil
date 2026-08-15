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
import { AnvilBackend } from "../lib/api";
import { renderMarkdown } from "../lib/markdown";
import { suggestionsForOrder, type Suggestion } from "../lib/agent-suggestions";

interface Persona { id: string; label: string; routes?: string[]; placeholder?: string }
interface Turn { role: "user" | "assistant"; text: string; tools?: string[] }

interface Props {
  /** Route id this mount sits on; must match the persona's `routes`. */
  route: string;
  /** Signals the panel derives its suggested actions from. */
  context: Parameters<typeof suggestionsForOrder>[0];
  /** Extra sentence prepended to the first message so the agent knows the record. */
  contextLine?: string;
}

export const AskAnvil: React.FC<Props> = ({ route, context, contextLine }) => {
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
        const r: any = await AnvilBackend?.agent?.personas?.();
        if (!alive) return;
        const match = (r?.personas || []).find((p: Persona) => (p.routes || []).includes(route));
        setPersona(match || null);
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
      // The record context rides on the FIRST turn only. Resending it every
      // turn is what makes a panel like this expensive — the session already
      // carries the history server-side.
      const prefix = !sessionRef.current && contextLine ? contextLine + "\n\n" : "";
      const resp: any = await AnvilBackend?.erpChat?.send?.({
        content: prefix + content,
        persona: persona.id,
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
  }, [busy, persona, contextLine]);

  if (!persona) return null;

  return (
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
    </>
  );
};
