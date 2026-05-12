// Locale-aware date string -> ISO YYYY-MM-DD normaliser.
//
// The DocAI prompt asks the model for "date as written on the
// document". That's locale-specific:
//   - India / UK / EU / AU / NZ:        DD/MM/YYYY
//   - US / Canada (English):            MM/DD/YYYY
//   - Japan / Korea / China / Taiwan:   YYYY/MM/DD
//
// Postgres `date` columns only accept ISO YYYY-MM-DD. Passing
// "29/04/2026" or "4/29/2026" through verbatim fails with
// "date/time field value out of range".
//
// The parser accepts:
//   YYYY-MM-DD              ISO date (pass-through)
//   YYYY-MM-DDTHH:MM...     ISO timestamp (trim to date)
//   YYYY/MM/DD              ISO-ish, also pass-through
//   D/M/Y, D-M-Y, D.M.Y     decoded with the caller-supplied
//                           or country-derived locale hint
//
// Callers pass either an explicit `hint` ("DMY" | "MDY" | "YMD")
// or a `country` ISO 3166-1 alpha-2 code which the helper maps
// to a hint. The unambiguous shapes (one field > 12 cannot be
// the month) are decoded without the hint. When both fields are
// <= 12 the hint decides.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T/;
const YMD_SLASH = /^(\d{4})[\/.\-](\d{1,2})[\/.\-](\d{1,2})$/;
const ABC = /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2}|\d{4})$/;

const pad2 = (n) => String(n).padStart(2, "0");

// Country -> hint mapping. ISO 3166-1 alpha-2 codes.
// MDY: US + Canada English.
// YMD: East Asia.
// DMY: everything else, which matches the global majority + the
// dominant Anvil customer base.
const COUNTRY_HINT = Object.freeze({
  US: "MDY", CA: "MDY",
  JP: "YMD", KR: "YMD", CN: "YMD", TW: "YMD", HK: "YMD", MO: "YMD",
  // Everything below is DMY. Listed explicitly for clarity; the
  // resolver defaults to DMY when a country is not in this map.
  IN: "DMY", GB: "DMY", IE: "DMY", AU: "DMY", NZ: "DMY", ZA: "DMY",
  DE: "DMY", FR: "DMY", IT: "DMY", ES: "DMY", NL: "DMY", BE: "DMY",
  AT: "DMY", CH: "DMY", PT: "DMY", SE: "DMY", NO: "DMY", DK: "DMY",
  FI: "DMY", PL: "DMY", CZ: "DMY", HU: "DMY", RO: "DMY", GR: "DMY",
  RU: "DMY", UA: "DMY", TR: "DMY",
  AE: "DMY", SA: "DMY", QA: "DMY", KW: "DMY", BH: "DMY", OM: "DMY",
  IL: "DMY", EG: "DMY",
  BR: "DMY", AR: "DMY", MX: "DMY", CL: "DMY", CO: "DMY", PE: "DMY",
  TH: "DMY", VN: "DMY", ID: "DMY", MY: "DMY", SG: "DMY", PH: "DMY",
  BD: "DMY", PK: "DMY", LK: "DMY", NP: "DMY",
});

export const hintForCountry = (country) => {
  if (!country) return null;
  const code = String(country).trim().toUpperCase().slice(0, 2);
  return COUNTRY_HINT[code] || null;
};

const isValidYMD = (y, m, d) => {
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return false;
  if (m < 1 || m > 12) return false;
  if (d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};

export const parsePoDate = (raw, opts) => {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;

  // 1. ISO date or timestamp -> pass through.
  if (ISO_DATE.test(s)) return s;
  if (ISO_DATETIME.test(s)) return s.slice(0, 10);

  // 2. YYYY-something. Treat as year-first regardless of hint.
  const ymd = s.match(YMD_SLASH);
  if (ymd) {
    const y = Number(ymd[1]);
    const mon = Number(ymd[2]);
    const day = Number(ymd[3]);
    if (isValidYMD(y, mon, day)) return y + "-" + pad2(mon) + "-" + pad2(day);
    return null;
  }

  // 3. Two-or-four-digit separated tokens. Apply the caller's
  // hint (or the country-derived hint) to disambiguate.
  const m = s.match(ABC);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const yRaw = Number(m[3]);
    const y = yRaw < 100 ? 2000 + yRaw : yRaw;

    // Resolve the hint. Explicit > country-derived > DMY default.
    const hint = (opts && opts.hint)
      || (opts && opts.country && hintForCountry(opts.country))
      || "DMY";

    let day;
    let mon;
    if (a > 12 && b <= 12) {
      // a cannot be a month; must be day.
      day = a;
      mon = b;
    } else if (b > 12 && a <= 12) {
      // b cannot be a month; must be day.
      day = b;
      mon = a;
    } else if (hint === "MDY") {
      mon = a;
      day = b;
    } else if (hint === "YMD") {
      // YMD hint applied to a non-year-first string is unusual.
      // Treat first two fields as MM/DD anyway, which is a
      // common shape from East-Asian export tools that
      // sometimes still write Western-style on receipts.
      mon = a;
      day = b;
    } else {
      // DMY default.
      day = a;
      mon = b;
    }
    if (isValidYMD(y, mon, day)) return y + "-" + pad2(mon) + "-" + pad2(day);
    return null;
  }

  // 4. Last resort: hand to Date. Only accept the result when
  // the parser produced a finite timestamp.
  const dt = new Date(s);
  if (!Number.isFinite(dt.getTime())) return null;
  return dt.toISOString().slice(0, 10);
};
