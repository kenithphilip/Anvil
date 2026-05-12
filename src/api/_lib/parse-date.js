// Permissive date string -> ISO YYYY-MM-DD normaliser.
//
// Used by the orders POST + PATCH path (and by callers that
// build orders from extractor output). The DocAI prompts ask the
// model to return "PO/RFQ date as written", which for Indian
// purchase orders is DD/MM/YYYY or DD-MM-YYYY. Postgres `date`
// columns only accept ISO-style values, so unnormalised dates
// produce a "date/time field value out of range" error.
//
// Returns the original string when it already parses as a valid
// ISO date, the normalised value when it can be parsed from a
// common locale-specific format, or null when the input is
// empty / unrecognised.
//
// Accepted shapes:
//   "YYYY-MM-DD"          (ISO date)
//   "YYYY-MM-DDTHH:MM..." (ISO timestamp; first 10 chars)
//   "DD/MM/YYYY" / "DD-MM-YYYY"
//   "DD/MM/YY" / "DD-MM-YY"   (assumes 20YY when YY < 100)
//   "MM/DD/YYYY"          (US locale, accepted when DD > 12 is
//                          impossible; ambiguous values default
//                          to DD/MM since that is the dominant
//                          Anvil locale)

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T/;
const DMY = /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2}|\d{4})$/;

const pad2 = (n) => String(n).padStart(2, "0");

const isValidYMD = (y, m, d) => {
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return false;
  if (m < 1 || m > 12) return false;
  if (d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};

export const parsePoDate = (raw) => {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // Already ISO date (or first 10 chars of a timestamp).
  if (ISO_DATE.test(s)) return s;
  if (ISO_DATETIME.test(s)) return s.slice(0, 10);

  const m = s.match(DMY);
  if (m) {
    let a = Number(m[1]);
    let b = Number(m[2]);
    let yRaw = Number(m[3]);
    const y = yRaw < 100 ? 2000 + yRaw : yRaw;
    // Default to DD/MM. If the first field is clearly not a day
    // (>12) and the second is, fall back to MM/DD interpretation.
    let day = a;
    let mon = b;
    if (a > 12 && b <= 12) { day = a; mon = b; }
    else if (b > 12 && a <= 12) { day = b; mon = a; }
    if (isValidYMD(y, mon, day)) return y + "-" + pad2(mon) + "-" + pad2(day);
    return null;
  }
  // Last resort: hand to Date parser. Reject if it produces
  // garbage (Date will happily accept "29/04/2026" but yield NaN
  // here, so this rarely fires after the DMY branch above).
  const dt = new Date(s);
  if (!Number.isFinite(dt.getTime())) return null;
  return dt.toISOString().slice(0, 10);
};
