// HMAC attestation for server-verified eval runs (Phase 1 F3).
//
// The eval dashboard's "96% accuracy on PO extraction" number is
// only credible if the row that produced it was computed by
// Anvil's server. Before this helper, eval_runs rows were
// hand-supplied actuals; this signs them.
//
// Receipt shape (canonical, JSON.stringify with sorted keys):
//
//   {
//     suite: string,
//     passed: int,
//     failed: int,
//     total_score: number (4 decimals),
//     prompt_version: string,
//     model_version: string,
//     pipeline_version: string,
//     case_count: int,
//     case_hashes: [string]   // sha-256 of each case_id, sorted
//   }
//
// HMAC = HMAC-SHA-256(secret, JSON.stringify(receipt)) base64url.
//
// The HMAC secret rotates monthly. Old secrets are published with
// each rotation so any holder of the receipt can still verify
// rows signed before the rotation.

import { createHmac, createHash, timingSafeEqual } from "node:crypto";

export const EVAL_PROMPT_VERSION_FALLBACK = "p1.f3.2026-05";
export const EVAL_PIPELINE_VERSION_FALLBACK = "docai.v2.2026-05";

const sortedStringify = (obj) => {
  if (Array.isArray(obj)) return "[" + obj.map(sortedStringify).join(",") + "]";
  if (obj && typeof obj === "object") {
    const keys = Object.keys(obj).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + sortedStringify(obj[k])).join(",") + "}";
  }
  return JSON.stringify(obj);
};

const caseIdHash = (s) =>
  createHash("sha256").update(String(s || "")).digest("base64url").slice(0, 16);

export const buildReceipt = ({
  suite,
  passed,
  failed,
  total_score,
  prompt_version,
  model_version,
  pipeline_version,
  case_ids,
}) => ({
  suite: String(suite || "default"),
  passed: Number(passed) || 0,
  failed: Number(failed) || 0,
  total_score: Number(total_score).toFixed(4),
  prompt_version: prompt_version || EVAL_PROMPT_VERSION_FALLBACK,
  model_version: model_version || "unspecified",
  pipeline_version: pipeline_version || EVAL_PIPELINE_VERSION_FALLBACK,
  case_count: (case_ids || []).length,
  case_hashes: (case_ids || []).map(caseIdHash).sort(),
});

const secretFor = () => {
  return process.env.EVAL_ATTESTATION_HMAC_SECRET
    || process.env.ANVIL_SECRETS_KEY
    || "dev-attestation-secret-do-not-ship";
};

export const signReceipt = (receipt, secret) => {
  const body = sortedStringify(receipt);
  const hmac = createHmac("sha256", secret || secretFor()).update(body).digest("base64url");
  return hmac;
};

export const verifyReceipt = (receipt, hmac, secret) => {
  if (!receipt || !hmac) return false;
  const expected = signReceipt(receipt, secret);
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(String(hmac)));
  } catch (_) {
    return false;
  }
};

// Convenience wrapper for /api/eval/run.
export const signEvalRun = ({
  suite,
  passed,
  failed,
  total_score,
  prompt_version,
  model_version,
  pipeline_version,
  case_ids,
}, secret) => {
  const receipt = buildReceipt({
    suite, passed, failed, total_score,
    prompt_version, model_version, pipeline_version, case_ids,
  });
  return { receipt, hmac: signReceipt(receipt, secret) };
};
