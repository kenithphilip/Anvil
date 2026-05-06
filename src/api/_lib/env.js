// Env-var validation helper.
//
// Pins the systemic-issue audit finding: handlers read process.env.X
// inside an inner call (mid-OCR, mid-fetch) and either throw with no
// context or silently degrade. This helper validates upfront and
// returns a 503 with the specific var name so the operator can fix
// configuration without reading server logs.
//
// Usage:
//   const cfg = requireEnv(["ANTHROPIC_API_KEY", "SUPABASE_URL"], res);
//   if (!cfg) return; // helper already wrote the 503
//
// Or the soft variant:
//   const apiKey = pickEnv("ANTHROPIC_API_KEY");
//   if (!apiKey) return json(res, 503, { error: ... });

import { json } from "./cors.js";

// Hard validator. Returns the resolved env map or null after writing
// a 503 response. Use when ANY missing var should fail the request.
export const requireEnv = (names, res) => {
  const missing = [];
  const out = {};
  for (const n of names) {
    const v = process.env[n];
    if (!v) missing.push(n);
    else out[n] = v;
  }
  if (missing.length) {
    if (res) {
      json(res, 503, {
        error: {
          code: "ENV_MISSING",
          message: "Server misconfiguration. Missing env: " + missing.join(", "),
          missing,
        },
      });
    }
    return null;
  }
  return out;
};

// Soft accessor. Returns the value or undefined; never writes a
// response. Use when the caller has its own degradation path.
export const pickEnv = (name) => process.env[name] || undefined;
