// Minimal customer-portal API client. The session (a Supabase JWT) is stored in
// localStorage and sent as an Authorization: Bearer header — the token is NEVER
// placed in the URL. Completely separate from the staff app's client.
//
// (Compliance follow-up: move the session to an httpOnly cookie; localStorage +
// Bearer is the v1 pattern, consistent with the internal app.)

const KEY = "anvil_portal_session";

export interface PortalSession {
  access_token: string;
  refresh_token?: string | null;
  expires_at?: number | null;
  customer_id?: string;
  email?: string;
  role?: string;
}

export const getSession = (): PortalSession | null => {
  try { const s = localStorage.getItem(KEY); return s ? JSON.parse(s) : null; } catch { return null; }
};

const setSession = (s: PortalSession | null): void => {
  try { if (s) localStorage.setItem(KEY, JSON.stringify(s)); else localStorage.removeItem(KEY); } catch { /* noop */ }
};

const request = async (path: string, opts: any = {}): Promise<any> => {
  const s = getSession();
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (s?.access_token) headers["Authorization"] = "Bearer " + s.access_token;
  const r = await fetch(path, { ...opts, headers });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    // A stale/expired session should bounce the user back to login.
    if (r.status === 401) setSession(null);
    throw new Error(body?.error?.message || ("Request failed (" + r.status + ")"));
  }
  return body;
};

export const PortalAPI = {
  isAuthed: (): boolean => !!getSession()?.access_token,
  login: async (email: string, password: string): Promise<PortalSession> => {
    const r = await request("/api/portal/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
    const s: PortalSession = {
      access_token: r.session?.access_token,
      refresh_token: r.session?.refresh_token,
      expires_at: r.session?.expires_at,
      customer_id: r.user?.customer_id,
      email: r.user?.email,
      role: r.user?.role,
    };
    setSession(s);
    return s;
  },
  logout: (): void => setSession(null),
  me: (): Promise<any> => request("/api/portal/auth/me"),
  view: (kind: string, extra = ""): Promise<any> => request("/api/portal/view?kind=" + encodeURIComponent(kind) + extra),
};
