// Claude fallback adapter. Last resort when none of the layout-aware
// adapters are configured or all of them low-confidenced. Sends the
// document body (text-extracted by the caller, or the URL if Claude
// can fetch it) plus any per-customer prompt-overrides as few-shot
// examples.
//
// We keep this thin because the existing /api/claude/messages
// endpoint already wraps Anthropic with redaction + firewall.

import { safeFetch } from "../safe-fetch.js";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MODEL = process.env.ANTHROPIC_MODEL_DEFAULT || "claude-sonnet-4-20250514";

export const isConfigured = (_settings) => !!process.env.ANTHROPIC_API_KEY;

const SYSTEM = `You extract structured purchase order or RFQ data
from documents. Return ONLY a JSON object matching this shape:

{
  "customer": { "name": string|null, "email": string|null, "po_number": string|null },
  "lines": [
    {
      "partNumber": string|null,
      "description": string|null,
      "quantity": number|null,
      "unitPrice": number|null
    }
  ]
}

If a field is genuinely absent, return null. Do not invent values.`;

const buildFewShot = (overrides) => {
  if (!overrides) return [];
  // overrides shape: { "<field_path>": [{from, to, examples:[...]}] }
  const blocks = [];
  for (const [fieldPath, entries] of Object.entries(overrides)) {
    for (const e of (entries || []).slice(0, 3)) {
      if (e.from && e.to) {
        blocks.push(`Past correction on ${fieldPath}: "${e.from}" -> "${e.to}"`);
      }
    }
  }
  return blocks;
};

export const extract = async ({ url, bytes, filename, settings, hints, promptOverrides }) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, error: "ANTHROPIC_API_KEY not set" };
  const text = hints?.bodyText || (bytes ? Buffer.from(bytes).toString("utf8").slice(0, 50_000) : null);
  if (!text && !url) return { ok: false, error: "claude adapter needs hints.bodyText, bytes, or url" };

  const fewShot = buildFewShot(promptOverrides);
  const userParts = [];
  if (fewShot.length) userParts.push({ type: "text", text: fewShot.join("\n") });
  if (text) {
    userParts.push({ type: "text", text: "DOCUMENT:\n" + text });
  } else if (url) {
    userParts.push({ type: "text", text: "DOCUMENT URL: " + url });
  }
  userParts.push({ type: "text", text: "Return only the JSON object." });

  const resp = await safeFetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      system: SYSTEM,
      messages: [{ role: "user", content: userParts }],
    }),
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) return { ok: false, status: resp.status, error: body?.error?.message || "claude failed" };
  const txt = (body?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  let parsed = null;
  try {
    const m = txt.match(/\{[\s\S]+\}/);
    parsed = m ? JSON.parse(m[0]) : null;
  } catch (_e) { parsed = null; }
  if (!parsed) return { ok: false, error: "claude returned non-JSON" };

  // Heuristic confidence: lower than layout-aware adapters because
  // Claude is the fallback path.
  const confidences = { overall: parsed.lines?.length ? 0.65 : 0.3 };
  (parsed.lines || []).forEach((_li, i) => { confidences["lines[" + i + "]"] = 0.65; });
  return {
    ok: true,
    raw: body,
    normalized: parsed,
    confidences,
  };
};
