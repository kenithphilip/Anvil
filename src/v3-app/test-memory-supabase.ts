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
//
// Opt-in, for handlers whose select strings matter: createMemoryDb(tables,
// users, { project: true }) applies the select list to reads the way
// PostgREST does (plain columns, alias:column, and JSON paths with -> and
// ->>), so a misspelled column reads back undefined. Embedded resources are
// not supported and throw. Off by default, so existing tests see whole rows.
// Also: neq, lt, ilike, overlaps, delete, not(col, "in", "(a,b)"), not(col, "is", null), range,
// upsert(rows, { onConflict }), and or() terms with lt, lte, gt and gte.

type Row = Record<string, any>;

export type MemoryDb = {
  tables: Record<string, Row[]>;
  users: Record<string, Row>;
  failRead: Record<string, { message: string; code?: string }>;
  svc: () => any;
};

const splitTop = (str: string): string[] => {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of str) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
};

// A column or a JSON path ("result->salesOrder->>po") read off a row.
const readPath = (row: Row, path: string): any => {
  const parts = path.split(/(->>|->)/);
  let v: any = row[parts[0]];
  let asText = false;
  for (let i = 1; i < parts.length; i += 2) {
    v = v == null || typeof v !== "object" ? undefined : v[parts[i + 1]];
    asText = parts[i] === "->>";
  }
  if (v === undefined) return parts.length > 1 ? null : undefined;
  if (asText && v !== null) return typeof v === "object" ? JSON.stringify(v) : String(v);
  return v;
};

const projectRow = (row: Row, cols: string): Row => {
  const out: Row = {};
  for (const item of splitTop(cols)) {
    if (item === "*") { Object.assign(out, row); continue; }
    if (item.includes("(")) throw new Error("memory db: embedded select " + item + " unsupported");
    const i = item.indexOf(":");
    const alias = i >= 0 ? item.slice(0, i).trim() : null;
    const path = (i >= 0 ? item.slice(i + 1) : item).trim();
    const key = alias || path.split(/->>|->/).pop()!;
    const v = readPath(row, path);
    if (v !== undefined) out[key] = v;
  }
  return out;
};

export const createMemoryDb = (tables: Record<string, Row[]> = {}, users: Record<string, Row> = {}, opts: { project?: boolean } = {}): MemoryDb => {
  const db: MemoryDb = { tables, users, failRead: {}, svc: () => null };
  let seq = 0;

  const from = (table: string) => {
    if (!db.tables[table]) db.tables[table] = [];
    const st: any = { filters: [], mode: "select", patch: null, row: null, single: null, order: null, limit: null, cols: null, range: null };
    const matches = (r: Row) => st.filters.every((f: (r: Row) => boolean) => f(r));
    const run = () => {
      const ds = db.tables[table];
      if (st.mode === "select" && db.failRead[table]) return { data: null, error: db.failRead[table] };
      let out: Row[];
      if (st.mode === "update") {
        out = ds.filter(matches);
        for (const r of out) Object.assign(r, st.patch);
      } else if (st.mode === "delete") {
        out = ds.filter(matches);
        db.tables[table] = ds.filter((r) => !matches(r));
      } else if (st.mode === "insert") {
        const rows = Array.isArray(st.row) ? st.row : [st.row];
        out = rows.map((r: Row) => ({ id: r.id || "gen-" + (++seq), ...r }));
        ds.push(...out);
      } else if (st.mode === "upsert") {
        // On the onConflict columns (default id): update the matching row in
        // place, else insert.
        const rows = Array.isArray(st.row) ? st.row : [st.row];
        const keys = String(st.onConflict || "id").split(",").map((k) => k.trim());
        out = rows.map((r: Row) => {
          const hit = ds.find((x) => keys.every((k) => x[k] === r[k]));
          if (hit) return Object.assign(hit, r);
          const row = { id: r.id || "gen-" + (++seq), ...r };
          ds.push(row);
          return row;
        });
      } else {
        out = ds.filter(matches);
      }
      out = out.map((r) => ({ ...r }));
      if (st.order) {
        const { col, asc } = st.order;
        out.sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1));
      }
      if (st.range) out = out.slice(st.range[0], st.range[1] + 1);
      if (st.limit != null) out = out.slice(0, st.limit);
      if (opts.project && st.mode === "select" && typeof st.cols === "string") out = out.map((r) => projectRow(r, st.cols));
      if (st.single === "one") {
        return out.length === 1
          ? { data: out[0], error: null }
          : { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } };
      }
      if (st.single === "maybe") return { data: out[0] || null, error: null };
      return { data: out, error: null };
    };
    const b: any = {
      select: (cols?: string) => { if (st.mode === "select" && cols !== undefined) st.cols = cols; return b; },
      eq: (c: string, v: unknown) => { st.filters.push((r: Row) => r[c] === v); return b; },
      neq: (c: string, v: unknown) => { st.filters.push((r: Row) => r[c] !== v); return b; },
      not: (c: string, op: string, v: unknown) => {
        if (op === "in") {
          const banned = String(v).replace(/^\(|\)$/g, "").split(",").map((x) => x.trim());
          st.filters.push((r: Row) => !banned.includes(String(r[c])));
        } else if (op === "is") {
          st.filters.push((r: Row) => (r[c] ?? null) !== v);
        } else throw new Error("memory db: not(" + op + ") unsupported");
        return b;
      },
      range: (from: number, to: number) => { st.range = [from, to]; return b; },
      in: (c: string, vs: unknown[]) => { st.filters.push((r: Row) => vs.includes(r[c])); return b; },
      overlaps: (c: string, vs: unknown[]) => { st.filters.push((r: Row) => Array.isArray(r[c]) && r[c].some((x: unknown) => vs.includes(x))); return b; },
      is: (c: string, v: unknown) => { st.filters.push((r: Row) => (r[c] ?? null) === v); return b; },
      gte: (c: string, v: any) => { st.filters.push((r: Row) => r[c] >= v); return b; },
      lte: (c: string, v: any) => { st.filters.push((r: Row) => r[c] <= v); return b; },
      lt: (c: string, v: any) => { st.filters.push((r: Row) => r[c] < v); return b; },
      // Postgres ILIKE: % any run, _ one character, a backslash escapes either.
      ilike: (c: string, pattern: string) => {
        let re = "";
        for (let i = 0; i < pattern.length; i++) {
          const ch = pattern[i];
          if (ch === "\\" && i + 1 < pattern.length) { re += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); continue; }
          if (ch === "%") re += ".*";
          else if (ch === "_") re += ".";
          else re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        }
        const rx = new RegExp("^" + re + "$", "is");
        st.filters.push((r: Row) => r[c] != null && rx.test(String(r[c])));
        return b;
      },
      or: (expr: string) => {
        const terms = expr.split(",").map((p) => {
          const [c, op, ...rest] = p.split(".");
          const val = rest.join(".");
          if (op === "is" && val === "null") return (r: Row) => (r[c] ?? null) === null;
          if (op === "eq") return (r: Row) => String(r[c]) === val;
          if (op === "lt") return (r: Row) => r[c] != null && r[c] < val;
          if (op === "lte") return (r: Row) => r[c] != null && r[c] <= val;
          if (op === "gt") return (r: Row) => r[c] != null && r[c] > val;
          if (op === "gte") return (r: Row) => r[c] != null && r[c] >= val;
          throw new Error("memory db: or(" + p + ") unsupported");
        });
        st.filters.push((r: Row) => terms.some((t) => t(r)));
        return b;
      },
      order: (col: string, opts?: { ascending?: boolean }) => { st.order = { col, asc: !opts || opts.ascending !== false }; return b; },
      limit: (n: number) => { st.limit = n; return b; },
      update: (patch: Row) => { st.mode = "update"; st.patch = patch; return b; },
      delete: () => { st.mode = "delete"; return b; },
      insert: (row: Row | Row[]) => { st.mode = "insert"; st.row = row; return b; },
      upsert: (row: Row | Row[], o?: { onConflict?: string }) => { st.mode = "upsert"; st.row = row; st.onConflict = o?.onConflict || null; return b; },
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
