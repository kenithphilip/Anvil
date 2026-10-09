// Admin > Sales & quotes > Order handoff: the To and CC lists and the sending
// mailbox for the order-processing handoff email, with a preview of who the
// lists resolve to right now. Every address is example.com.

import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, waitFor, fireEvent } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";
import { OrderHandoffSettingsEditor } from "./OrderHandoffSettingsEditor";

const LOADED = {
  applied: true,
  migration: "251_order_handoff.sql",
  settings: {
    order_handoff_enabled: false,
    order_handoff_to: ["orders@example.com", "role:operator"],
    order_handoff_cc: ["role:procurement"],
    order_handoff_sender: "graph",
    order_handoff_template: null,
  },
  recipients: {
    to: [
      { email: "orders@example.com", name: null, reason: "listed address" },
      { email: "ravi.ops@example.com", name: "Ravi Ops", reason: "role:operator" },
    ],
    cc: [],
    reply_to: null,
    dropped: [{ list: "cc", entry: "role:procurement", reason: "no_active_members", detail: "No approved member of this tenant has this role." }],
  },
  role_tokens: ["role:operator", "role:sales_manager"],
};

const migrationError = () => {
  const e: any = new Error("The order handoff settings are not in this database yet. Apply supabase/migrations/251_order_handoff.sql, then retry.");
  e.status = 409;
  e.body = { error: { code: "MIGRATION_NOT_APPLIED", migration: "251_order_handoff.sql", message: e.message } };
  return e;
};

describe("OrderHandoffSettingsEditor", () => {
  let get: any;
  let save: any;
  let preview: any;
  beforeEach(() => {
    installRbac("admin");
    get = vi.fn(async () => LOADED);
    save = vi.fn(async (patch: any) => ({
      ...LOADED,
      settings: { ...LOADED.settings, ...patch },
      recipients: { to: [{ email: "team@example.com", name: null, reason: "listed address" }], cc: [], reply_to: null, dropped: [] },
    }));
    preview = vi.fn(async () => ({
      preview: true,
      recipients: { to: [{ email: "sana.ops@example.com", name: "Sana Ops", reason: "role:operator" }], cc: [], reply_to: null, dropped: [{ list: "to", entry: "role:wizard", reason: "unknown_role", detail: "No such role." }] },
    }));
    installBackend({ admin: { orderHandoffSettings: get, updateOrderHandoffSettings: save, previewOrderHandoffRecipients: preview } });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("renders the saved settings and the resolved preview with the reason for each address", async () => {
    const { getByLabelText, getByTestId, getByText } = render(<OrderHandoffSettingsEditor />);
    await waitFor(() => expect((getByLabelText("To") as HTMLTextAreaElement).value).toBe("orders@example.com\nrole:operator"));
    expect((getByLabelText("CC") as HTMLTextAreaElement).value).toBe("role:procurement");
    expect((getByLabelText("Sending mailbox") as HTMLSelectElement).value).toBe("graph");
    expect((getByLabelText("Handoff email on") as HTMLInputElement).checked).toBe(false);
    const to = getByTestId("handoff-to-resolved");
    expect(to.textContent).toContain("ravi.ops@example.com");
    expect(to.textContent).toContain("Ravi Ops");
    expect(to.textContent).toContain("role:operator");
    expect(to.textContent).toContain("listed address");
    expect(getByTestId("handoff-cc-empty").textContent).toBe("Nobody.");
    expect(getByTestId("handoff-dropped").textContent).toContain("role:procurement: No approved member of this tenant has this role.");
    expect(getByText(/Role tokens: role:operator, role:sales_manager/)).toBeTruthy();
  });

  it("saves the edited lists with the exact payload, and shows the new resolution", async () => {
    const { getByLabelText, getByText, getByTestId } = render(<OrderHandoffSettingsEditor />);
    await waitFor(() => expect((getByLabelText("To") as HTMLTextAreaElement).value).not.toBe(""));
    fireEvent.change(getByLabelText("To"), { target: { value: "team@example.com, role:operator\n\n" } });
    fireEvent.change(getByLabelText("CC"), { target: { value: "" } });
    fireEvent.change(getByLabelText("Sending mailbox"), { target: { value: "mailer" } });
    fireEvent.click(getByLabelText("Handoff email on"));
    fireEvent.click(getByText("Save"));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][0]).toEqual({
      order_handoff_enabled: true,
      order_handoff_to: ["team@example.com", "role:operator"],
      order_handoff_cc: [],
      order_handoff_sender: "mailer",
    });
    await waitFor(() => expect(getByTestId("handoff-to-resolved").textContent).toContain("team@example.com"));
    expect(getByText(/Saved\. The preview below shows who receives the handoff right now\./)).toBeTruthy();
  });

  it("previews a draft without saving it", async () => {
    const { getByLabelText, getByText, getByTestId } = render(<OrderHandoffSettingsEditor />);
    await waitFor(() => expect((getByLabelText("To") as HTMLTextAreaElement).value).not.toBe(""));
    fireEvent.change(getByLabelText("To"), { target: { value: "role:operator\nrole:wizard" } });
    fireEvent.click(getByText("Preview recipients"));
    await waitFor(() => expect(preview).toHaveBeenCalledTimes(1));
    expect(preview.mock.calls[0][0]).toEqual({ to: ["role:operator", "role:wizard"], cc: ["role:procurement"] });
    await waitFor(() => expect(getByTestId("handoff-to-resolved").textContent).toContain("sana.ops@example.com"));
    expect(getByTestId("handoff-dropped").textContent).toContain("role:wizard: No such role.");
    expect(save).not.toHaveBeenCalled();
  });

  it("shows the server's MIGRATION_NOT_APPLIED message, which names the file, and offers no save", async () => {
    get.mockImplementation(async () => { throw migrationError(); });
    const { getByTestId, getByText } = render(<OrderHandoffSettingsEditor />);
    await waitFor(() => expect(getByTestId("handoff-migration-missing").textContent)
      .toBe("The order handoff settings are not in this database yet. Apply supabase/migrations/251_order_handoff.sql, then retry."));
    expect((getByText("Save").closest("button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the same message when a save meets the missing migration", async () => {
    save.mockImplementation(async () => { throw migrationError(); });
    const { getByLabelText, getByText, getByTestId } = render(<OrderHandoffSettingsEditor />);
    await waitFor(() => expect((getByLabelText("To") as HTMLTextAreaElement).value).not.toBe(""));
    fireEvent.change(getByLabelText("To"), { target: { value: "team@example.com" } });
    fireEvent.click(getByText("Save"));
    await waitFor(() => expect(getByTestId("handoff-migration-missing").textContent).toMatch(/251_order_handoff\.sql/));
    // The draft is still unsaved, but a second click can only meet the same 409.
    expect((getByText("Save").closest("button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows any other error as an error", async () => {
    get.mockImplementation(async () => { const e: any = new Error("HTTP 500"); e.status = 500; throw e; });
    const { getByText } = render(<OrderHandoffSettingsEditor />);
    await waitFor(() => expect(getByText("HTTP 500")).toBeTruthy());
    expect(getByText("Could not load or save")).toBeTruthy();
  });

  it("is admin only: a sales manager sees a notice, and nothing is fetched", async () => {
    installRbac("sales_manager");
    const { getByText, queryByLabelText } = render(<OrderHandoffSettingsEditor />);
    expect(getByText("Admin only")).toBeTruthy();
    expect(queryByLabelText("To")).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(get).not.toHaveBeenCalled();
  });
});

describe("the Admin screen", () => {
  beforeEach(() => {
    installRbac("admin");
    installBackend({ admin: { orderHandoffSettings: vi.fn(async () => LOADED) } });
    vi.stubGlobal("confirm", () => true);
  });
  afterEach(() => {
    window.location.hash = "";
    vi.unstubAllGlobals();
  });

  it("opens the Order handoff tab from #/admin?tab=order_handoff", async () => {
    window.location.hash = "#/admin?tab=order_handoff";
    const Screen = (await import("../screens/admin")).default;
    const { findByLabelText } = renderScreen(Screen);
    const to = (await findByLabelText("To")) as HTMLTextAreaElement;
    await waitFor(() => expect(to.value).toBe("orders@example.com\nrole:operator"));
  });

  it("reaches the tab from the Sales & quotes category, without the deep link", async () => {
    const Screen = (await import("../screens/admin")).default;
    const { getByText, findByLabelText, queryByLabelText } = renderScreen(Screen);
    expect(queryByLabelText("Sending mailbox")).toBeNull();
    fireEvent.click(getByText("Sales & quotes"));
    fireEvent.click(getByText("Order handoff"));
    expect(await findByLabelText("Sending mailbox")).toBeTruthy();
  });
});
