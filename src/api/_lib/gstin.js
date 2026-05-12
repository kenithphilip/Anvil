// GSTIN validator (Phase 1 F8 from
// docs/audits/2026_05_11_product_deep_dive/phases/01_p0_fixes.md).
//
// A GSTIN (Goods and Services Tax Identification Number) is 15
// characters: <state-code 2><PAN 10><entity 1><Z 1><checksum 1>.
//   - pos 1-2  : state code (numeric, "01" through "38" plus "97").
//   - pos 3-12 : PAN (5 alpha + 4 digit + 1 alpha).
//   - pos 13   : entity number for this PAN-state combo (1-9 then A-Z).
//   - pos 14   : literal "Z" (a constant separator).
//   - pos 15   : Mod-36 checksum over the first 14 characters.
//
// Reference: https://en.wikipedia.org/wiki/GSTIN#Verification
// (cross-checked against CBIC's gstin-validator behaviour).
//
// API entry points that handle GSTINs validate by calling
// validateGstin(s); the returned shape is either
//   { ok: true, normalized }
// or
//   { ok: false, code, message }
// where `code` is one of INVALID_GSTIN_SHAPE, INVALID_GSTIN_STATE,
// INVALID_GSTIN_PAN, INVALID_GSTIN_CHECKSUM. The caller maps to a
// 400 response without exposing internals.

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

// Canonical state-code -> ISO-like 2-letter abbreviation. Used by
// place-of-supply classification (intrastate vs interstate) and by
// the einvoice IRN generator. Pulled from CBIC's Schedule of State
// Codes (post-2019 reorgs).
export const STATE_CODES = Object.freeze({
  "01": "JK", "02": "HP", "03": "PB", "04": "CH", "05": "UA",
  "06": "HR", "07": "DL", "08": "RJ", "09": "UP", "10": "BR",
  "11": "SK", "12": "AR", "13": "NL", "14": "MN", "15": "MZ",
  "16": "TR", "17": "ML", "18": "AS", "19": "WB", "20": "JH",
  "21": "OR", "22": "CT", "23": "MP", "24": "GJ", "25": "DD",
  "26": "DN", "27": "MH", "28": "AP", "29": "KA", "30": "GA",
  "31": "LD", "32": "KL", "33": "TN", "34": "PY", "35": "AN",
  "36": "TG", "37": "AP", "38": "LA", "97": "OT", "99": "CD",
});

// Shape: 15 chars total. Pos 13 may be a digit or letter, pos 14
// must be literal "Z" except for some legacy GSTINs where it has
// been seen as alpha; the strict spec is "Z", which is what we
// enforce.
const SHAPE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;

export const isValidGstinShape = (s) => {
  if (typeof s !== "string") return false;
  return SHAPE.test(s);
};

// Compute the Mod-36 checksum character for the first 14
// characters of the GSTIN. Factor pattern is 1,2,1,2,...,1,2
// reading left-to-right (position 1 has factor 1, position 14
// has factor 2). Hand-verified against TCS Gujarat GSTIN
// 24AAACC4175D1Z4 (real, public): the algorithm reproduces the
// terminal '4'.
export const gstinChecksumChar = (first14) => {
  if (typeof first14 !== "string" || first14.length !== 14) return null;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const idx = ALPHABET.indexOf(first14[i]);
    if (idx < 0) return null;
    const factor = i % 2 === 0 ? 1 : 2;
    const product = idx * factor;
    const digit = Math.floor(product / 36) + (product % 36);
    sum += digit;
  }
  const check = (36 - (sum % 36)) % 36;
  return ALPHABET[check];
};

// Two-character state code (e.g. "27"). null if shape is bad.
export const gstinStateCode = (s) => {
  if (!isValidGstinShape(s)) return null;
  return s.slice(0, 2);
};

// State abbreviation from the GSTIN. null on shape error or
// unrecognised code.
export const gstinStateAbbr = (s) => {
  const code = gstinStateCode(s);
  if (!code) return null;
  return STATE_CODES[code] || null;
};

// Validate. Returns { ok: true, normalized } or
// { ok: false, code, message } where normalized is the upper-cased
// trimmed value the caller should persist instead of the raw input.
export const validateGstin = (s) => {
  const raw = String(s == null ? "" : s).trim().toUpperCase();
  if (!isValidGstinShape(raw)) {
    return {
      ok: false,
      code: "INVALID_GSTIN_SHAPE",
      message: "GSTIN must be 15 characters: 2 digit state code, then PAN (5 alpha + 4 digit + 1 alpha), then entity, Z, checksum.",
    };
  }
  const state = raw.slice(0, 2);
  if (!STATE_CODES[state]) {
    return {
      ok: false,
      code: "INVALID_GSTIN_STATE",
      message: "State code " + state + " is not on the CBIC schedule.",
    };
  }
  const checksum = gstinChecksumChar(raw.slice(0, 14));
  if (checksum !== raw[14]) {
    return {
      ok: false,
      code: "INVALID_GSTIN_CHECKSUM",
      message: "GSTIN checksum failed Mod-36 verification. Check the last character against the first 14.",
    };
  }
  return { ok: true, normalized: raw };
};

// Convenience predicate for places that only want a boolean.
export const isValidGstin = (s) => validateGstin(s).ok;
