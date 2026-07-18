// FMECA helpers (reliability step 4c). See docs/FMECA_DESIGN.md.
//
// suggestOccurrence maps a failure-event count over an observation window onto an
// FMECA occurrence rating (1-10) via a standard log-frequency ladder. It is a
// SUGGESTION only -- the reliability engineer accepts or overrides it. Severity
// and Detection have no field-data source and are always human-authored.

// count = # of breakdown/replacement events for a part x mode over windowWeeks.
export const suggestOccurrence = ({ count, windowWeeks } = {}) => {
  const c = Math.max(0, Number(count) || 0);
  const w = Math.max(1, Number(windowWeeks) || 104);
  if (c <= 0) return 1;
  const perYear = c / (w / 52);
  if (perYear < 0.34) return 2;   // rarer than ~1 per 3 years
  if (perYear < 0.6) return 3;    // ~1 per 2 years
  if (perYear < 1.5) return 4;    // ~1 per year
  if (perYear < 3) return 5;      // ~1 per 6 months
  if (perYear < 6) return 6;      // ~1 per quarter
  if (perYear < 12) return 7;     // ~1 per 2 months
  if (perYear < 26) return 8;     // ~1 per month
  if (perYear < 52) return 9;     // ~fortnightly
  return 10;                       // weekly or more
};

// rpn from S/O/D (mirrors the DB generated column) -- for UI preview before save.
export const computeRpn = (severity, occurrence, detection) => {
  const s = Number(severity), o = Number(occurrence), d = Number(detection);
  if (![s, o, d].every((n) => Number.isFinite(n) && n >= 1 && n <= 10)) return null;
  return s * o * d;
};
