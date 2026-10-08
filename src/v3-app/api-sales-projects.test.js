// /api/sales/projects, driven through the real handler over a small
// in-memory table set that behaves like Postgres for what the handler does:
// projects carries unique (tenant_id, project_code) (migration 006), so a
// duplicate insert fails with 23505, and an upsert on that key overwrites.
//
// POST used to upsert on (tenant_id, project_code). A create that reused a
// code silently replaced that project (name, customer, value, phase reset to
// INITIAL_INFO) and logged a new phase row. POST now inserts only; edits go
// through PATCH by id.

import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => {
  const tables = {};
  const calls = [];
  const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));
  let idc = 0;
  const uniqueClash = (table, row) =>
    table === "projects" &&
    tables.projects.some((p) => p.tenant_id === row.tenant_id && p.project_code === row.project_code);
  const from = (table) => {
    if (!tables[table]) tables[table] = [];
    const filters = [];
    let op = "select";
    let payload = null;
    const rows = () => tables[table].filter((r) => filters.every((f) => f(r)));
    const exec = () => {
      calls.push({ table, op });
      if (op === "insert") {
        const out = [];
        for (const p of Array.isArray(payload) ? payload : [payload]) {
          if (uniqueClash(table, p)) {
            return {
              error: {
                code: "23505",
                message: "duplicate key value violates unique constraint \"projects_tenant_id_project_code_key\"",
                details: "Key (tenant_id, project_code)=(" + p.tenant_id + ", " + p.project_code + ") already exists.",
              },
            };
          }
          const row = { id: "row-" + (++idc), ...clone(p) };
          tables[table].push(row);
          out.push(clone(row));
        }
        return { data: out };
      }
      if (op === "upsert") {
        const hit = tables.projects.find((p) => p.tenant_id === payload.tenant_id && p.project_code === payload.project_code);
        if (hit) { Object.assign(hit, clone(payload)); return { data: [clone(hit)] }; }
        const row = { id: "row-" + (++idc), ...clone(payload) };
        tables[table].push(row);
        return { data: [clone(row)] };
      }
      if (op === "update") {
        const hit = rows();
        hit.forEach((r) => Object.assign(r, clone(payload)));
        return { data: hit.map(clone) };
      }
      return { data: rows().map(clone) };
    };
    const q = {
      select: () => q,
      eq: (c, v) => { filters.push((r) => r[c] === v); return q; },
      is: (c, v) => { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return q; },
      insert: (p) => { op = "insert"; payload = p; return q; },
      upsert: (p) => { op = "upsert"; payload = p; return q; },
      update: (p) => { op = "update"; payload = p; return q; },
      single: async () => {
        const r = exec();
        if (r.error) return { data: null, error: r.error };
        return r.data[0] ? { data: r.data[0], error: null } : { data: null, error: { message: "no rows" } };
      },
      then: (resolve, reject) => {
        try { const r = exec(); resolve({ data: r.data || null, error: r.error || null }); } catch (e) { reject(e); }
      },
    };
    return q;
  };
  return {
    tables,
    calls,
    from,
    reset() { for (const k of Object.keys(tables)) delete tables[k]; calls.length = 0; idc = 0; },
    seed(t, list) { tables[t] = list.map(clone); },
  };
});

vi.mock("../api/_lib/auth.js", () => ({
  resolveContext: vi.fn(async () => ({ user: { id: "u-se" }, tenantId: "t-1", role: "sales_engineer" })),
  requirePermission: vi.fn(() => {}),
}));
vi.mock("../api/_lib/supabase.js", () => ({ serviceClient: () => ({ from: H.from }) }));
vi.mock("../api/_lib/audit.js", () => ({ recordAudit: vi.fn(async () => {}) }));

const { requirePermission } = await import("../api/_lib/auth.js");
const { recordAudit } = await import("../api/_lib/audit.js");
const handler = (await import("../api/sales/projects.js")).default;

const call = async (method, body) => {
  let status = 200;
  let sent = "";
  const res = {
    setHeader: () => {},
    status(c) { status = c; return res; },
    send(p) { sent = p; return res; },
    json(o) { sent = JSON.stringify(o); return res; },
    end() { return res; },
  };
  await handler({ method, headers: {}, query: {}, url: "/api/sales/projects", body }, res);
  return { status, body: sent ? JSON.parse(sent) : null };
};

const EXISTING = {
  id: "prj-1",
  tenant_id: "t-1",
  project_code: "PRJ-2026-0001",
  project_name: "Line 4 body shop",
  customer_id: "cust-1",
  total_value_inr: 5000000,
  currency: "INR",
  current_phase: "MANUFACTURING",
  status: "ACTIVE",
};

beforeEach(() => {
  H.reset();
  H.seed("projects", [EXISTING, { ...EXISTING, id: "prj-t2", tenant_id: "t-2", project_code: "PRJ-T2-ONLY" }]);
  H.seed("project_phase_log", [{ id: "pl-1", tenant_id: "t-1", project_id: "prj-1", phase: "MANUFACTURING", completed_at: null }]);
  vi.mocked(requirePermission).mockClear();
  vi.mocked(recordAudit).mockClear();
});

describe("POST /api/sales/projects", () => {
  it("refuses a code that already exists with 409, and leaves that project alone", async () => {
    const r = await call("POST", { project_code: "PRJ-2026-0001", project_name: "Someone else's project", current_phase: "INITIAL_INFO", total_value_inr: 1 });

    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("PROJECT_CODE_EXISTS");
    expect(r.body.error.message).toContain("PRJ-2026-0001");
    expect(r.body.error.field).toBe("project_code");

    // The original row is exactly as it was, and nothing tried to change it.
    expect(H.tables.projects.find((p) => p.id === "prj-1")).toEqual(EXISTING);
    expect(H.calls.filter((c) => c.table === "projects" && (c.op === "update" || c.op === "upsert"))).toEqual([]);
    expect(H.tables.project_phase_log).toHaveLength(1);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("inserts a new code, logs its first phase, and audits the create", async () => {
    const r = await call("POST", { project_code: "PRJ-2026-0002", project_name: "Paint shop", current_phase: "STRATEGY" });

    expect(r.status).toBe(201);
    expect(requirePermission).toHaveBeenCalledWith(expect.anything(), "write");
    const row = H.tables.projects.find((p) => p.project_code === "PRJ-2026-0002");
    expect(row).toMatchObject({ tenant_id: "t-1", project_name: "Paint shop", current_phase: "STRATEGY", status: "ACTIVE" });
    expect(r.body.project.id).toBe(row.id);
    expect(H.tables.project_phase_log.filter((pl) => pl.project_id === row.id)).toEqual([
      expect.objectContaining({ tenant_id: "t-1", phase: "STRATEGY" }),
    ]);
    expect(recordAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "project_create", objectId: row.id }));
  });

  it("allows a code another tenant uses (the code is unique per tenant)", async () => {
    const r = await call("POST", { project_code: "PRJ-T2-ONLY", project_name: "Our own" });

    expect(r.status).toBe(201);
    expect(H.tables.projects.find((p) => p.id === "prj-t2").project_name).toBe("Line 4 body shop");
    expect(H.tables.projects.filter((p) => p.project_code === "PRJ-T2-ONLY").map((p) => p.tenant_id).sort()).toEqual(["t-1", "t-2"]);
  });
});

describe("PATCH /api/sales/projects (the edit path, by id)", () => {
  it("updates the project by id and logs a phase step", async () => {
    const r = await call("PATCH", { id: "prj-1", current_phase: "SHIPPING", total_value_inr: 5200000, phase_remark: "dispatched" });

    expect(r.status).toBe(200);
    const row = H.tables.projects.find((p) => p.id === "prj-1");
    expect(row.current_phase).toBe("SHIPPING");
    expect(row.total_value_inr).toBe(5200000);
    expect(row.project_code).toBe("PRJ-2026-0001");
    const log = H.tables.project_phase_log;
    expect(log.find((pl) => pl.id === "pl-1").completed_at).toEqual(expect.any(String));
    expect(log.find((pl) => pl.phase === "SHIPPING")).toMatchObject({ project_id: "prj-1", responsible_user: "u-se", remarks: "dispatched" });
  });

  it("keeps the phase guard: a jump back over two phases is refused", async () => {
    const r = await call("PATCH", { id: "prj-1", current_phase: "INITIAL_INFO" });

    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("INVALID_PHASE_TRANSITION");
    expect(H.tables.projects.find((p) => p.id === "prj-1")).toEqual(EXISTING);
  });

  it("does not touch another tenant's project", async () => {
    const r = await call("PATCH", { id: "prj-t2", total_value_inr: 1 });

    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(H.tables.projects.find((p) => p.id === "prj-t2").total_value_inr).toBe(5000000);
  });
});
