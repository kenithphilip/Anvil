// Shared helpers used across the Tally screens.

type Envelope<T> = T[] | { orders?: T[]; masters?: T[]; rows?: T[] } | null | undefined;

export const tallyOrderRows = <T = any>(resp: Envelope<T>): T[] => {
  if (!resp) return [];
  if (Array.isArray(resp)) return resp;
  if (Array.isArray(resp.orders)) return resp.orders;
  if (Array.isArray(resp.rows)) return resp.rows;
  return [];
};

export const tallyMasterRows = <T = any>(resp: Envelope<T>): T[] => {
  if (!resp) return [];
  if (Array.isArray(resp)) return resp;
  if (Array.isArray(resp.masters)) return resp.masters;
  if (Array.isArray(resp.rows)) return resp.rows;
  return [];
};

export const shortHash = (h: string | null | undefined): string => {
  if (!h) return "—";
  const s = String(h);
  return s.length > 10 ? s.slice(0, 10) + "…" : s;
};
