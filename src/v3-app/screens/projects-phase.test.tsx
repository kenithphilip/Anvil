// The Projects screen read r.phase (the column is current_phase) and counted
// KPIs over phase names the project_phase enum does not have, so every KPI
// but Active was 0. No control could move a phase, and the create form never
// sent related_opportunity_id.
//
// These tests put the REAL /api/sales/projects handler behind the screen's
// listProjects, updateProject and createProject (screen -> real client ->
// handler) over a small in-memory table set, so the response shapes and the
// phase guard's 409 are the server's own.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";

const db = vi.hoisted(() => ({ tables: {} as Record<string, Array<Record<string, any>>> }));

vi.mock("../../api/_lib/supabase.js", () => {
  let idc = 0;
  const from = (table: string) => {
    const filters: Array<(r: any) => boolean> = [];
    let op = "select";
    let cols = "*";
    let payload: any = null;
    const rows = () => (db.tables[table] || []).filter((r) => filters.every((f) => f(r)));
    // The one embed the GET asks for: customer:customer_id(customer_name).
    const shape = (r: any) => {
      const out = { ...r };
      if (cols.includes("customer:customer_id(")) {
        const c = (db.tables.customers || []).find((x) => x.id === r.customer_id);
        out.customer = c ? { customer_name: c.customer_name } : null;
      }
      return out;
    };
    const exec = () => {
      if (op === "insert") {
        const row = { id: table + "-new-" + (++idc), ...JSON.parse(JSON.stringify(payload)) };
        (db.tables[table] = db.tables[table] || []).push(row);
        return [{ ...row }];
      }
      if (op === "update") {
        const hit = rows();
        hit.forEach((r) => Object.assign(r, JSON.parse(JSON.stringify(payload))));
        return hit.map((r) => ({ ...r }));
      }
      return rows().map(shape);
    };
    const q: any = {
      select: (c?: string) => { if (op === "select" && c) cols = c; return q; },
      order: () => q,
      limit: () => q,
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; },
      in: (c: string, v: unknown[]) => { filters.push((r) => v.includes(r[c])); return q; },
      is: (c: string, v: unknown) => { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return q; },
      insert: (p: any) => { op = "insert"; payload = p; return q; },
      update: (p: any) => { op = "update"; payload = p; return q; },
      single: async () => { const d = exec(); return d[0] ? { data: d[0], error: null } : { data: null, error: { message: "no rows" } }; },
      maybeSingle: async () => ({ data: exec()[0] || null, error: null }),
      then: (resolve: (v: unknown) => void) => resolve({ data: exec(), error: null }),
    };
    return q;
  };
  return { serviceClient: () => ({ from }), userClient: () => ({ from }) };
});
vi.mock("../../api/_lib/auth.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveContext: vi.fn(async () => ({ user: { id: "u-se" }, tenantId: "t-1", role: "sales_engineer" })),
}));
vi.mock("../../api/_lib/audit.js", () => ({ recordAudit: vi.fn(async () => {}) }));

const projectsHandler = (await import("../../api/sales/projects.js")).default;

// test-setup.ts ran the client IIFE before this file loaded, so this is the
// real client, captured before installBackend swaps in a stub.
const realClient = (window as any).AnvilBackend;

const serverFetch = vi.fn(async (url: string, init: { method: string; body?: string }) => {
  let status = 200;
  let sent = "";
  const res: any = {
    setHeader: () => {},
    status(c: number) { status = c; return res; },
    send(p: string) { sent = p; return res; },
    end() { return res; },
  };
  const query = Object.fromEntries(new URL(url).searchParams.entries());
  await projectsHandler({ method: init.method, headers: {}, query, url: "/api/sales/projects", body: init.body ? JSON.parse(init.body) : undefined }, res);
  return { ok: status < 400, status, text: async () => sent };
});

const CUST = "0ccccccc-0000-4000-8000-000000000003";
const OPP = "0aaaaaaa-0000-4000-8000-000000000001";

const project = (id: string, current_phase: string, extra: Record<string, unknown> = {}) => ({
  id,
  tenant_id: "t-1",
  project_code: "PRJ-" + id,
  project_name: "Project " + id,
  customer_id: CUST,
  total_value_inr: 5000000,
  current_phase,
  status: "ACTIVE",
  ...extra,
});

beforeEach(() => {
  db.tables = {
    projects: [
      project("p1", "STRATEGY"),
      project("p2", "PRICE_NEGOTIATION"),
      project("p3", "DESIGN"),
      project("p4", "MANUFACTURING"),
      project("p5", "SHIPPING"),
      project("p6", "CLOSED"),
      project("p7", "KICKOFF", { status: "CANCELLED" }),
    ],
    project_phase_log: [{ id: "pl-4", tenant_id: "t-1", project_id: "p4", phase: "MANUFACTURING", completed_at: null }],
    customers: [{ id: CUST, tenant_id: "t-1", customer_name: "Heron Castings" }],
    opportunities: [{ id: OPP, tenant_id: "t-1", customer_id: CUST, opportunity_name: "Line 5 welding cells", amount_inr: 7500000 }],
  };
  realClient.setConfig({ url: "https://api.test", tenantId: "t-1" });
  vi.stubGlobal("fetch", serverFetch);
  serverFetch.mockClear();
  installBackend({
    sales: {
      listProjects: () => realClient.sales.listProjects(),
      updateProject: (p: unknown) => realClient.sales.updateProject(p),
      createProject: (p: unknown) => realClient.sales.createProject(p),
      // The real response shape of GET /api/sales/opportunities.
      listOpportunities: vi.fn(async () => ({ opportunities: db.tables.opportunities.map((o) => ({ ...o })) })),
    },
    customers: { list: vi.fn(async () => ({ customers: [{ id: CUST, customer_name: "Heron Castings" }], profiles: {} })) },
  });
  installRbac("sales_engineer");
  (window as any).notifySuccess = vi.fn();
  (window as any).notifyError = vi.fn();
  window.location.hash = "#/projects";
});

afterEach(() => {
  vi.unstubAllGlobals();
  realClient.setConfig(null);
});

const renderProjects = async () => {
  const mod = await import("./projects");
  return renderScreen(mod.default);
};

// The value cell of the KPI tile with this label.
const kpi = (label: string) => {
  const lbl = screen.getByText(label);
  return (lbl.parentElement as HTMLElement).querySelector(".v")?.textContent || "";
};

describe("Projects: the KPIs and the list read what the API returns", () => {
  it("counts open projects by their current_phase", async () => {
    await renderProjects();
    await screen.findByText("PRJ-p1");

    // p6 is CLOSED and p7 CANCELLED, so 5 are active: 2 pre-order
    // (STRATEGY, PRICE_NEGOTIATION), 2 in execution (DESIGN,
    // MANUFACTURING) and 1 shipping (SHIPPING).
    expect(kpi("Active")).toBe("5");
    expect(kpi("Pre-order")).toBe("2");
    expect(kpi("In execution")).toBe("2");
    expect(kpi("Shipping and site")).toBe("1");
  });

  it("shows each project's phase, customer name and value", async () => {
    await renderProjects();
    const row = within((await screen.findByText("PRJ-p4")).closest("tr") as HTMLElement);

    expect(row.getByText("manufacturing")).toBeTruthy();
    expect(row.getByText("Heron Castings")).toBeTruthy();
    expect(row.getByText("₹ 50.0 L")).toBeTruthy();
  });
});

describe("Projects: move a phase", () => {
  it("moves the open project to the next phase through the PATCH, and logs it", async () => {
    window.location.hash = "#/projects?id=p4";
    await renderProjects();
    const select = await screen.findByLabelText("Move to phase") as HTMLSelectElement;
    expect(select.value).toBe("SHIPPING");

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Move" })); });

    await waitFor(() => expect(db.tables.projects.find((p) => p.id === "p4")!.current_phase).toBe("SHIPPING"));
    expect(db.tables.project_phase_log.find((pl) => pl.phase === "SHIPPING")).toMatchObject({ project_id: "p4", responsible_user: "u-se" });
    expect(db.tables.project_phase_log.find((pl) => pl.id === "pl-4")!.completed_at).toEqual(expect.any(String));
    expect(screen.queryByText("Phase not moved")).toBeNull();
  });

  it("shows the guard's refusal for a jump back of more than one phase, and changes nothing", async () => {
    window.location.hash = "#/projects?id=p4";
    await renderProjects();
    const select = await screen.findByLabelText("Move to phase");

    fireEvent.change(select, { target: { value: "INITIAL_INFO" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Move" })); });

    await screen.findByText("Phase not moved");
    expect(screen.getByText("Cannot move project from MANUFACTURING to INITIAL_INFO directly.")).toBeTruthy();
    expect(db.tables.projects.find((p) => p.id === "p4")!.current_phase).toBe("MANUFACTURING");
    expect(db.tables.project_phase_log).toHaveLength(1);
  });

  it("offers no move on a closed project", async () => {
    window.location.hash = "#/projects?id=p6";
    await renderProjects();
    await screen.findByText("project detail · p6");

    expect(screen.queryByLabelText("Move to phase")).toBeNull();
  });
});

describe("Projects: create from an opportunity", () => {
  it("prefills from the opportunity and writes related_opportunity_id", async () => {
    await renderProjects();
    await screen.findByText("PRJ-p1");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /New project/ })); });
    await screen.findByRole("option", { name: "Line 5 welding cells" });

    fireEvent.change(screen.getByLabelText("Opportunity"), { target: { value: OPP } });
    expect((screen.getByLabelText("Customer") as HTMLSelectElement).value).toBe(CUST);
    expect((screen.getByLabelText("Project name *") as HTMLInputElement).value).toBe("Line 5 welding cells");
    fireEvent.change(screen.getByLabelText("Project code *"), { target: { value: "PRJ-2026-0009" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Create project" })); });

    await waitFor(() => expect(db.tables.projects.find((p) => p.project_code === "PRJ-2026-0009")).toBeTruthy());
    expect(db.tables.projects.find((p) => p.project_code === "PRJ-2026-0009")).toMatchObject({
      tenant_id: "t-1",
      related_opportunity_id: OPP,
      customer_id: CUST,
      project_name: "Line 5 welding cells",
      total_value_inr: 7500000,
    });
  });
});
