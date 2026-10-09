// An in-memory stand-in for the Supabase service client, for tests that run
// REAL API handlers. Enough of the PostgREST builder for the opportunity
// handlers and the helpers they call (assignee, audit, funnel analytics,
// lost reasons, members): eq, in, is, gte, lte, or (eq / is null terms),
// order, limit, select after a write, update, insert, maybeSingle, single,
// and auth.admin.getUserById.
//
// Use it from a vi.mock factory through a hoisted holder, so the handler
// reads the database the current test seeded:
//
//   const H = vi.hoisted(() => ({ db: null as any }));
//   vi.mock("../api/_lib/supabase.js", () => ({ serviceClient: () => H.db.svc() }));
//   beforeEach(() => { H.db = createMemoryDb({ opportunities: [...] }); });
//
// failRead[table] makes every read of that table return that error.

type Row = Record<string, any>;

export type MemoryDb = {
  tables: Record<string, Row[]>;
  users: Record<string, Row>;
  failRead: Record<string, { message: string; code?: string }>;
  svc: () => any;
};

export const createMemoryDb = (tables: Record<string, Row[]> = {}, users: Record<string, Row> = {}): MemoryDb => {
  const db: MemoryDb = { tables, users, failRead: {}, svc: () => null };
  let seq = 0;

  const from = (table: string) => {
    if (!db.tables[table]) db.tables[table] = [];
    const st: any = { filters: [], mode: "select", patch: null, row: null, single: null, order: null, limit: null };
    const matches = (r: Row) => st.filters.every((f: (r: Row) => boolean) => f(r));
    const run = () => {
      const ds = db.tables[table];
      if (st.mode === "select" && db.failRead[table]) return { data: null, error: db.failRead[table] };
      let out: Row[];
      if (st.mode === "update") {
        out = ds.filter(matches);
        for (const r of out) Object.assign(r, st.patch);
      } else if (st.mode === "insert") {
        const rows = Array.isArray(st.row) ? st.row : [st.row];
        out = rows.map((r: Row) => ({ id: r.id || "gen-" + (++seq), ...r }));
        ds.push(...out);
      } else {
        out = ds.filter(matches);
      }
      out = out.map((r) => ({ ...r }));
      if (st.order) {
        const { col, asc } = st.order;
        out.sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1));
      }
      if (st.limit != null) out = out.slice(0, st.limit);
      if (st.single === "one") {
        return out.length === 1
          ? { data: out[0], error: null }
          : { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } };
      }
      if (st.single === "maybe") return { data: out[0] || null, error: null };
      return { data: out, error: null };
    };
    const b: any = {
      select: () => b,
      eq: (c: string, v: unknown) => { st.filters.push((r: Row) => r[c] === v); return b; },
      in: (c: string, vs: unknown[]) => { st.filters.push((r: Row) => vs.includes(r[c])); return b; },
      is: (c: string, v: unknown) => { st.filters.push((r: Row) => (r[c] ?? null) === v); return b; },
      gte: (c: string, v: any) => { st.filters.push((r: Row) => r[c] >= v); return b; },
      lte: (c: string, v: any) => { st.filters.push((r: Row) => r[c] <= v); return b; },
      or: (expr: string) => {
        const terms = expr.split(",").map((p) => {
          const [c, op, ...rest] = p.split(".");
          const val = rest.join(".");
          if (op === "is" && val === "null") return (r: Row) => (r[c] ?? null) === null;
          if (op === "eq") return (r: Row) => String(r[c]) === val;
          throw new Error("memory db: or(" + p + ") unsupported");
        });
        st.filters.push((r: Row) => terms.some((t) => t(r)));
        return b;
      },
      order: (col: string, opts?: { ascending?: boolean }) => { st.order = { col, asc: !opts || opts.ascending !== false }; return b; },
      limit: (n: number) => { st.limit = n; return b; },
      update: (patch: Row) => { st.mode = "update"; st.patch = patch; return b; },
      insert: (row: Row | Row[]) => { st.mode = "insert"; st.row = row; return b; },
      maybeSingle: () => { st.single = "maybe"; return Promise.resolve(run()); },
      single: () => { st.single = "one"; return Promise.resolve(run()); },
      then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
    };
    return b;
  };

  db.svc = () => ({
    from,
    auth: { admin: { getUserById: async (id: string) => ({ data: { user: db.users[id] || null }, error: null }) } },
  });
  return db;
};

// Call a handler the way the router does, and read back status and JSON.
export const callHandler = async (handler: any, { method = "GET", query = {}, body }: { method?: string; query?: Row; body?: Row } = {}) => {
  let out: any = null;
  const res: any = {
    statusCode: 200,
    setHeader() {},
    status(c: number) { this.statusCode = c; return this; },
    json(o: any) { out = o; return this; },
    send(p: any) { out = typeof p === "string" ? JSON.parse(p) : p; return this; },
    end() { return this; },
  };
  await handler({ method, headers: {}, query, body, url: "/" }, res);
  return { status: res.statusCode, body: out };
};
