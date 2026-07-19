# OpenRouter as a failover provider — spike notes

Status: spike landed (behind `llm.js`, inert by default). Not for production
tenant traffic until the compliance gate below is cleared.

## What this is

A third provider (`openrouter`) behind Anvil's existing provider-agnostic router
`src/api/_lib/llm.js`, alongside `claude` and `gemini`. OpenRouter
(https://openrouter.ai) is an OpenAI-compatible gateway fronting many models.
Two capabilities:

1. **Selectable provider** — a non-DocAI reasoning/generation feature can run on
   OpenRouter via the existing selection chain (explicit arg → per-tenant
   `tenant_settings.llm_provider[_overrides]` → `LLM_PROVIDER[_<FEATURE>]` env).
2. **Opt-in live failover** — with `LLM_FAILOVER=1`, `callLLM` retries the next
   configured provider ONCE on a retryable upstream error (network / 429 / 5xx).
   Off by default → behaviour is byte-identical.

## Why it does NOT touch extraction (yet)

The DocAI document path (`claude.js` / `gemini.js` adapters) is deliberately
untouched. It depends on features a generic gateway does not expose identically:

- **Anthropic native PDF `document` blocks** — not all OpenRouter models accept a
  PDF base64 block; behaviour varies per underlying model.
- **1-hour prompt caching** (`cache_control` + `extended-cache-ttl` beta) — a real
  input-token cost saver on the big system prompt + tool schema; not a portable
  passthrough.
- **Forced `tool_choice`** with the exact extraction schema.

`llm.js` is the TEXT router (structured/chat features), so this spike sends text
only; non-text blocks are summarised, never shipped raw. Extending failover to
the extraction document path is a separate evaluation (per-model PDF + tool-use
validation on the eval set, measured against the lost prompt-cache savings).

## Security carried through

The injection firewall (`applyFirewall`) and PII redaction (`redactMessages`)
live in Anvil's call layer, not the provider, so `openrouter.js` re-applies BOTH
before sending. Requests go through `safeFetch` (timeout + SSRF guard) like the
Anthropic path. Tested in `api-openrouter.test.js`.

## ⚠️ Compliance gate — answer BEFORE enabling for a real tenant

Routing customer POs / commercial terms (multi-tenant industrial data, PII)
through OpenRouter adds a **new subprocessor that itself proxies to sub-providers**
— an extra vendor and an extra hop. This must clear:

- Data-egress / residency review — does the tenant's contract or vendor-security
  posture permit a third-party inference aggregator? (Ties into the compliance /
  CISO backlog.) OpenRouter offers ZDR + data-policy filters; confirm and pin.
- Subprocessor disclosure — add OpenRouter to the DPA / subprocessor list.
- Key handling — `OPENROUTER_API_KEY` is a server-side env secret (never bundled).

Until then: leave `OPENROUTER_API_KEY` unset in production. With no key the
provider is unreachable and `callLLM` falls back to a configured provider, so the
code is inert.

## How to enable (dev / eval only)

```
OPENROUTER_API_KEY=sk-or-...          # makes the provider reachable
OPENROUTER_MODEL=anthropic/claude-sonnet-4.5   # optional; default shown
LLM_PROVIDER=openrouter               # or per-feature LLM_PROVIDER_<FEATURE>, or tenant_settings.llm_provider
LLM_FAILOVER=1                        # optional: enable one-shot live failover
OPENROUTER_REFERER=https://anvil.app  # optional attribution
```

No migration — the existing `tenant_settings.llm_provider` / `llm_provider_overrides`
mechanism already accepts arbitrary provider strings; `resolveProvider` now
recognises `openrouter` (and still collapses unknown strings to `claude`).

## Follow-ups (not in this spike)

- Per-tenant admin UI toggle for provider + failover (today it's env / settings JSON).
- Cost/latency telemetry on the OpenRouter path (parity with `model_routing_log`).
- The extraction-document-path evaluation described above.
