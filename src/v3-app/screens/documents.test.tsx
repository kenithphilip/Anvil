import { describe, it, expect, beforeEach, vi } from "vitest";
import { installBackend, installRbac, renderScreen } from "../test-utils";

beforeEach(() => {
  installBackend();
  installRbac("admin");
  vi.stubGlobal("confirm", () => true);
  vi.stubGlobal("alert", () => undefined);
  vi.stubGlobal("prompt", () => null);
});

describe("Documents", () => {
  it("renders the library / review / upload tabs", async () => {
    const mod = await import("./documents");
    const Screen = mod.default;
    expect(typeof Screen).toBe("function");
    const { container } = renderScreen(Screen);
    expect(container).toBeTruthy();
    await new Promise((r) => setTimeout(r, 0));
    const html = container.innerHTML;
    expect(html).toContain("Documents");
    expect(html).toContain("Library");
    expect(html).toContain("OCR review");
    expect(html).toContain("Upload");
  });
});
