// Creating a project with a code that already exists used to overwrite that
// project: POST /api/sales/projects upserted on (tenant_id, project_code).
// It now refuses with 409, and the New project form shows the server's
// message. The create goes screen -> real client -> real handler, over a
// small in-memory projects table that raises 23505 on a duplicate code.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";

const db = vi.hoisted(() => ({ projects: [] as Array<Record<string, any>>, project_phase_log: [] as Array<Record<string, any>> }));

vi.mock("../../api/_lib/supabase.js", () => {
  const from = (table: string) => {
    let payload: Record<string, any> | null = null;
    const exec = () => {
      const rows = (db as any)[table] as Array<Record<string, any>>;
      if (table === "projects" && rows.some((p) => p.tenant_id === payload!.tenant_id && p.project_code === payload!.project_code)) {
        return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint \"projects_tenant_id_project_code_key\"" } };
      }
      const row = { id: table + "-" + (rows.length + 1), ...payload };
      rows.push(row);
      return { data: { ...row }, error: null };
    };
    const q: any = {
      insert: (p: Record<string, any>) => { payload = p; return q; },
      select: () => q,
      single: async () => exec(),
      then: (resolve: (v: unknown) => void) => resolve(exec()),
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

// fetch, answered by the real handler.
const serverFetch = vi.fn(async (_url: string, init: { method: string; body: string }) => {
  let status = 200;
  let sent = "";
  const res: any = {
    setHeader: () => {},
    status(c: number) { status = c; return res; },
    send(p: string) { sent = p; return res; },
    end() { return res; },
  };
  await projectsHandler({ method: init.method, headers: {}, query: {}, url: "/api/sales/projects", body: JSON.parse(init.body) }, res);
  return { ok: status < 400, status, text: async () => sent };
});

const EXISTING = {
  id: "prj-1",
  tenant_id: "t-1",
  project_code: "PRJ-2026-0001",
  project_name: "Line 4 body shop",
  current_phase: "MANUFACTURING",
  status: "ACTIVE",
};

let listSpy: any;

beforeEach(() => {
  db.projects.length = 0;
  db.projects.push({ ...EXISTING });
  db.project_phase_log.length = 0;
  realClient.setConfig({ url: "https://api.test", tenantId: "t-1" });
  vi.stubGlobal("fetch", serverFetch);
  serverFetch.mockClear();
  listSpy = vi.fn(async () => ({ projects: db.projects.map((p) => ({ ...p })) }));
  installBackend({
    sales: {
      listProjects: listSpy,
      createProject: (payload: unknown) => realClient.sales.createProject(payload),
    },
    customers: { list: vi.fn(async () => ({ customers: [] })) },
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

const createProject = async (code: string, name: string) => {
  const mod = await import("./projects");
  renderScreen(mod.default);
  const open = await screen.findByRole("button", { name: /New project/ });
  await act(async () => { fireEvent.click(open); });
  fireEvent.change(screen.getByLabelText("Project code *"), { target: { value: code } });
  fireEvent.change(screen.getByLabelText("Project name *"), { target: { value: name } });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Create project" })); });
};

describe("Projects: create", () => {
  it("shows the server's 409 message for a code that exists, and leaves that project alone", async () => {
    await createProject("PRJ-2026-0001", "Someone else's project");

    await waitFor(() => expect(document.body.textContent).toContain("Could not create project"));
    expect(document.body.textContent).toContain("A project with code \"PRJ-2026-0001\" already exists.");
    expect((window as any).notifyError).toHaveBeenCalledWith("Could not create project", expect.stringContaining("PRJ-2026-0001"));
    // The form stays open with the draft, so the operator can change the code.
    expect((screen.getByLabelText("Project code *") as HTMLInputElement).value).toBe("PRJ-2026-0001");
    expect(db.projects).toEqual([EXISTING]);
    expect(db.project_phase_log).toEqual([]);
  });

  it("creates a project with a new code", async () => {
    await createProject("PRJ-2026-0002", "Paint shop");

    await waitFor(() => expect((window as any).notifySuccess).toHaveBeenCalledWith("Project created", "PRJ-2026-0002"));
    expect(db.projects.map((p) => p.project_code)).toEqual(["PRJ-2026-0001", "PRJ-2026-0002"]);
    expect(db.projects[0]).toEqual(EXISTING);
    expect(serverFetch).toHaveBeenCalledTimes(1);
    expect(serverFetch.mock.calls[0][1].method).toBe("POST");
  });
});
