// Markdown renderer — output correctness AND the safety model.
import { describe, it, expect } from "vitest";
import { renderMarkdown, escapeHtml } from "./markdown";

describe("renderMarkdown / the constructs an ERP answer actually uses", () => {
  it("renders a table (the reported bug: pipes showed literally)", () => {
    const html = renderMarkdown("| PO | Value |\n|---|---|\n| 0066026562 | 1,825,261 |");
    expect(html).toContain("<table");
    expect(html).toContain("<th>PO</th>");
    expect(html).toContain("<td>0066026562</td>");
    expect(html).not.toContain("|---|");
  });

  it("renders bold and italic instead of showing asterisks", () => {
    expect(renderMarkdown("**total** is *high*")).toContain("<strong>total</strong>");
    expect(renderMarkdown("**total** is *high*")).toContain("<em>high</em>");
    expect(renderMarkdown("**total**")).not.toContain("**");
  });

  it("renders bullet and ordered lists", () => {
    expect(renderMarkdown("- one\n- two")).toBe("<ul><li>one</li><li>two</li></ul>");
    expect(renderMarkdown("1. one\n2. two")).toBe("<ol><li>one</li><li>two</li></ol>");
  });

  it("renders headings below the page title level", () => {
    expect(renderMarkdown("# Summary")).toBe("<h3>Summary</h3>");
  });

  it("renders inline and fenced code without interpreting it", () => {
    expect(renderMarkdown("use `SELECT *`")).toContain("<code>SELECT *</code>");
    expect(renderMarkdown("```\n**not bold**\n```")).toContain("<code>**not bold**</code>");
  });

  it("keeps paragraphs separate", () => {
    expect(renderMarkdown("one\n\ntwo")).toBe("<p>one</p><p>two</p>");
  });
});

describe("renderMarkdown / safety — assistant text is UNTRUSTED", () => {
  it("neutralises a script tag", () => {
    const html = renderMarkdown("<script>alert(1)</script>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("neutralises an img onerror payload", () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)">');
    // The text "onerror=" may appear as VISIBLE TEXT — that is fine and is the
    // point. What must never happen is a live tag, so assert on the escaping.
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(html).toContain("&quot;");           // the attribute quote is escaped
  });

  it("refuses a javascript: link — renders as text, not an anchor", () => {
    const html = renderMarkdown("[click](javascript:alert(1))");
    // Rendering the raw text is the DESIRED outcome: visible but inert. The
    // security property is that no anchor (and so no navigable href) is built.
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("href=");
  });

  it("refuses a data: link", () => {
    expect(renderMarkdown("[x](data:text/html,<script>alert(1)</script>)")).not.toContain("<a ");
  });

  it("allows an http/https/mailto link with noopener", () => {
    const html = renderMarkdown("[docs](https://example.com/a)");
    expect(html).toContain('href="https://example.com/a"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("escapes HTML inside table cells too", () => {
    const html = renderMarkdown("| a |\n|---|\n| <script>x</script> |");
    expect(html).not.toContain("<script>");
  });

  it("escapeHtml covers the five dangerous characters", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
});
