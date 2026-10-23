// Business-time arithmetic in a tenant timezone, for due times.
//
// The hours come from the tenant policy (policy.js business_hours): a start, an
// end and the weekend days. The default weekend is Saturday and Sunday, the
// same rule as datemath.isWeekend.
// shortcut: no holidays yet; read holiday_calendar here when a tenant needs it.

export const BUSINESS_HOURS = { start: "09:30", end: "17:30", weekend: ["Sat", "Sun"] };
export const BUSINESS_DAY_MINUTES = 480;

const hm = (s) => {
  const [h, m] = String(s).split(":").map(Number);
  return { h: h || 0, m: m || 0 };
};

// The wall-clock parts of an instant in a timezone.
export const zonedParts = (date, tz) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, hourCycle: "h23", weekday: "short",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(date).map((p) => [p.type, p.value]));
  return {
    y: Number(parts.year), mo: Number(parts.month), d: Number(parts.day),
    h: Number(parts.hour), mi: Number(parts.minute), s: Number(parts.second),
    weekday: parts.weekday,
  };
};

// The UTC instant of a wall-clock time in a timezone. Day overflow is fine
// (d + 1 on the last day of a month is the first of the next).
// shortcut: one offset step, so a time inside a DST change can be an hour
// off. India has no DST.
export const zonedToUtc = (y, mo, d, h, mi, tz) => {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const p = zonedParts(new Date(guess), tz);
  const asIfUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return new Date(guess - (asIfUtc - guess));
};

const isWeekend = (p, hours) => (hours.weekend || BUSINESS_HOURS.weekend).includes(p.weekday);

// The business minutes in one working day.
export const dayMinutes = (hours = BUSINESS_HOURS) => {
  const a = hm(hours.start);
  const b = hm(hours.end);
  return Math.max(1, (b.h * 60 + b.m) - (a.h * 60 + a.m));
};

// Add business minutes to an instant: time counts only inside the business
// hours of a weekday.
export const addBusinessMinutes = (start, minutes, tz, hours = BUSINESS_HOURS) => {
  const open = hm(hours.start);
  const close = hm(hours.end);
  let t = start.getTime();
  let left = Math.max(0, Number(minutes) || 0);
  for (let guard = 0; guard < 800; guard++) {
    const p = zonedParts(new Date(t), tz);
    const dayOpen = zonedToUtc(p.y, p.mo, p.d, open.h, open.m, tz).getTime();
    const dayClose = zonedToUtc(p.y, p.mo, p.d, close.h, close.m, tz).getTime();
    if (isWeekend(p, hours) || t >= dayClose) {
      t = zonedToUtc(p.y, p.mo, p.d + 1, open.h, open.m, tz).getTime();
      continue;
    }
    if (t < dayOpen) t = dayOpen;
    const room = (dayClose - t) / 60_000;
    if (left <= room) return new Date(t + left * 60_000);
    left -= room;
    t = dayClose;
  }
  return new Date(t);
};

// The close of business on a calendar date (YYYY-MM-DD) in a timezone.
export const closeOfBusiness = (ymd, tz, hours = BUSINESS_HOURS) => {
  const [y, mo, d] = ymd.split("-").map(Number);
  const close = hm(hours.end);
  return zonedToUtc(y, mo, d, close.h, close.m, tz);
};

export const localYmd = (date, tz) => {
  const p = zonedParts(date, tz);
  return p.y + "-" + String(p.mo).padStart(2, "0") + "-" + String(p.d).padStart(2, "0");
};
