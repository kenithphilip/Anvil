// Shared helpers used across the Tally screens. The legacy build relied
// on global hoisting from wired-tally-masters-d.jsx. In ESM we extract
// the helpers into a small shared module so every Tally screen imports
// what it needs.

export const tallyOrderRows = (resp) => {
  if (!resp) return [];
  if (Array.isArray(resp)) return resp;
  if (Array.isArray(resp.orders)) return resp.orders;
  if (Array.isArray(resp.rows)) return resp.rows;
  return [];
};

export const tallyMasterRows = (resp) => {
  if (!resp) return [];
  if (Array.isArray(resp)) return resp;
  if (Array.isArray(resp.masters)) return resp.masters;
  if (Array.isArray(resp.rows)) return resp.rows;
  return [];
};

export const shortHash = (h) => {
  if (!h) return "—";
  const s = String(h);
  return s.length > 10 ? s.slice(0, 10) + "…" : s;
};
