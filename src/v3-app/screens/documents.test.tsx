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

  it("OCR review tab renders an empty-state prompt when no doc is selected", async () => {
    const mod = await import("./documents");
    const Screen = mod.default;
    const { container } = renderScreen(Screen);
    await new Promise((r) => setTimeout(r, 0));
    // The empty-state copy is on the OCR review tab; with no doc
    // selected and the default tab being "library", click the
    // OCR review tab via DOM.
    const tabBtns = Array.from(container.querySelectorAll("[role='tab'], button"));
    const ocrTab = tabBtns.find((b) => (b.textContent || "").trim().startsWith("OCR review"));
    if (ocrTab) {
      (ocrTab as HTMLElement).click();
      await new Promise((r) => setTimeout(r, 0));
      // The empty state mentions "Pick a document".
      expect(container.innerHTML).toContain("Pick a document");
    }
  });
});
