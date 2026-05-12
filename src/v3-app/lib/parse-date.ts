// Locale-aware date string -> ISO YYYY-MM-DD normaliser.
//
// Mirror of src/api/_lib/parse-date.js. See that file for the
// full design notes. Both keep an identical accepted-shape set
// and country -> hint map.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T/;
const YMD_SLASH = /^(\d{4})[\/.\-](\d{1,2})[\/.\-](\d{1,2})$/;
const ABC = /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2}|\d{4})$/;

export type DateHint = "DMY" | "MDY" | "YMD";

export interface ParseDateOpts {
  hint?: DateHint;
  country?: string | null;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

const COUNTRY_HINT: Record<string, DateHint> = Object.freeze({
  US: "MDY", CA: "MDY",
  JP: "YMD", KR: "YMD", CN: "YMD", TW: "YMD", HK: "YMD", MO: "YMD",
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

export const hintForCountry = (country: string | null | undefined): DateHint | null => {
  if (!country) return null;
  const code = String(country).trim().toUpperCase().slice(0, 2);
  return COUNTRY_HINT[code] || null;
};

const isValidYMD = (y: number, m: number, d: number): boolean => {
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return false;
  if (m < 1 || m > 12) return false;
  if (d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};

export const parsePoDate = (raw: unknown, opts?: ParseDateOpts): string | null => {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;

  if (ISO_DATE.test(s)) return s;
  if (ISO_DATETIME.test(s)) return s.slice(0, 10);

  const ymd = s.match(YMD_SLASH);
  if (ymd) {
    const y = Number(ymd[1]);
    const mon = Number(ymd[2]);
    const day = Number(ymd[3]);
    if (isValidYMD(y, mon, day)) return y + "-" + pad2(mon) + "-" + pad2(day);
    return null;
  }

  const m = s.match(ABC);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const yRaw = Number(m[3]);
    const y = yRaw < 100 ? 2000 + yRaw : yRaw;

    const hint: DateHint = (opts?.hint)
      || (opts?.country ? hintForCountry(opts.country) : null)
      || "DMY";

    let day: number;
    let mon: number;
    if (a > 12 && b <= 12) {
      day = a;
      mon = b;
    } else if (b > 12 && a <= 12) {
      day = b;
      mon = a;
    } else if (hint === "MDY") {
      mon = a;
      day = b;
    } else if (hint === "YMD") {
      mon = a;
      day = b;
    } else {
      day = a;
      mon = b;
    }
    if (isValidYMD(y, mon, day)) return y + "-" + pad2(mon) + "-" + pad2(day);
    return null;
  }

  const dt = new Date(s);
  if (!Number.isFinite(dt.getTime())) return null;
  return dt.toISOString().slice(0, 10);
};
