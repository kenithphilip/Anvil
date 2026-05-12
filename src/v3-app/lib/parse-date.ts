// Permissive date string -> ISO YYYY-MM-DD normaliser.
//
// Mirrors src/api/_lib/parse-date.js so the SO intake can sanitise
// the extractor's po_date (DD/MM/YYYY for Indian POs) before
// posting to the orders endpoint. Postgres `date` columns reject
// non-ISO values with "date/time field value out of range".
//
// See the server helper for the full accepted-shape list.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T/;
const DMY = /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2}|\d{4})$/;

const pad2 = (n: number) => String(n).padStart(2, "0");

const isValidYMD = (y: number, m: number, d: number): boolean => {
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return false;
  if (m < 1 || m > 12) return false;
  if (d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};

export const parsePoDate = (raw: unknown): string | null => {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (ISO_DATE.test(s)) return s;
  if (ISO_DATETIME.test(s)) return s.slice(0, 10);

  const m = s.match(DMY);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const yRaw = Number(m[3]);
    const y = yRaw < 100 ? 2000 + yRaw : yRaw;
    let day = a;
    let mon = b;
    if (a > 12 && b <= 12) { day = a; mon = b; }
    else if (b > 12 && a <= 12) { day = b; mon = a; }
    if (isValidYMD(y, mon, day)) return y + "-" + pad2(mon) + "-" + pad2(day);
    return null;
  }
  const dt = new Date(s);
  if (!Number.isFinite(dt.getTime())) return null;
  return dt.toISOString().slice(0, 10);
};
