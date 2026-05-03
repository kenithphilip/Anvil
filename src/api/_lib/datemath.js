// Date math helpers for delivery promise calculations.
// Excludes weekends and dates that appear in the supplied holiday set.

export const parseISODate = (value) => {
  if (!value) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  const s = String(value).trim();
  if (!s) return null;
  const direct = new Date(s);
  if (Number.isFinite(direct.getTime())) return direct;
  const m = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return Number.isFinite(d.getTime()) ? d : null;
  }
  return null;
};

const dateKey = (d) => {
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return year + "-" + month + "-" + day;
};

export const buildHolidaySet = (rows) => {
  const set = new Map();
  (rows || []).forEach((row) => {
    if (!row || !row.country || !row.date) return;
    const country = String(row.country).toUpperCase();
    const key = country + "|" + (row.date instanceof Date ? dateKey(row.date) : String(row.date).slice(0, 10));
    if (!set.has(key)) set.set(key, row.name || "Holiday");
  });
  return set;
};

export const isWeekend = (d) => {
  const day = d.getUTCDay();
  return day === 0 || day === 6;
};

export const addBusinessDays = (start, days, country, holidaySet) => {
  const startDate = start instanceof Date ? new Date(start) : parseISODate(start);
  if (!startDate) return null;
  const target = Number(days) || 0;
  const cursor = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate()));
  let added = 0;
  let safety = 0;
  const upper = (country || "").toUpperCase();
  const skipped = [];
  while (added < target && safety < 1500) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    safety++;
    if (isWeekend(cursor)) continue;
    const key = upper + "|" + dateKey(cursor);
    if (holidaySet && holidaySet.has(key)) {
      skipped.push({ date: dateKey(cursor), reason: holidaySet.get(key) });
      continue;
    }
    added++;
  }
  return { date: dateKey(cursor), skipped, country: upper, leadDays: target };
};

export const earliestEta = (estimates) => {
  // estimates: [{ date, country, leadDays, source }]
  const valid = (estimates || []).filter((e) => e && e.date);
  if (!valid.length) return null;
  valid.sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : 0)); // latest first
  return valid[0];
};

export const todayUTC = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
};
