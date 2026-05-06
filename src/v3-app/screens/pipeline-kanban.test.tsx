import { describe, it, expect, beforeEach, vi } from "vitest";
import { installBackend, installRbac, renderScreen } from "../test-utils";

beforeEach(() => {
  installBackend();
  installRbac("admin");
  vi.stubGlobal("confirm", () => true);
  vi.stubGlobal("alert", () => undefined);
  vi.stubGlobal("prompt", () => null);
});

describe("PipelineKanban", () => {
  it("renders the 6 kanban columns", async () => {
    const mod = await import("./pipeline-kanban");
    const Screen = mod.default;
    expect(typeof Screen).toBe("function");
    const { container } = renderScreen(Screen);
    expect(container).toBeTruthy();
    await new Promise((r) => setTimeout(r, 0));
    const html = container.innerHTML;
    expect(html).toContain("Inbox");
    expect(html).toContain("OCR");
    expect(html).toContain("Validate");
    expect(html).toContain("Approve");
    expect(html).toContain("Push");
    expect(html).toContain("Closed");
  });
});
