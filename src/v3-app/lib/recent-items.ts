// Recent items: a per-browser list of records the user recently opened or
// created (quotes, sales orders, opportunities, projects, leads, RFQs).
// Powers the "Recent" header menu for quick navigation back to your work.
//
// Purely client-side + additive: screens call pushRecent() at open/create
// points; nothing else changes. Deduped by `${type}:${id}`, newest first,
// capped. Stored in localStorage so it survives reloads.

export interface RecentItem {
  key: string;        // `${type}:${id}`
  type: string;       // "quote" | "order" | "opportunity" | "project" | "lead" | "rfq" | ...
  label: string;      // human label (quote number, customer, etc.)
  href: string;       // hash to navigate to (exact record where supported, else the screen)
  ts: number;         // last opened/created (ms)
}

const LS_KEY = "obara:v3_recent_items";
const MAX = 25;
let cache: RecentItem[] | null = null;

const read = (): RecentItem[] => {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(LS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    cache = Array.isArray(arr) ? arr : [];
  } catch (_) { cache = []; }
  return cache!;
};

const write = (arr: RecentItem[]) => {
  cache = arr;
  try { localStorage.setItem(LS_KEY, JSON.stringify(arr)); } catch (_) { /* quota / private mode */ }
  try { window.dispatchEvent(new CustomEvent("recent:change")); } catch (_) { /* SSR / tests */ }
};

export const pushRecent = (item: { type: string; id: string; label: string; href: string }): void => {
  if (!item || !item.id || !item.href) return;
  const key = `${item.type}:${item.id}`;
  const entry: RecentItem = { key, type: item.type, label: item.label || item.id, href: item.href, ts: Date.now() };
  const next = [entry, ...read().filter((r) => r.key !== key)].slice(0, MAX);
  write(next);
};

export const getRecent = (): RecentItem[] => read().slice();
export const clearRecent = (): void => write([]);
