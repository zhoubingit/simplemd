import { describe, expect, it } from "vitest";
import {
  buildExportHtmlDocument,
  escapeHtml,
  renderMarkdown,
} from "./renderMarkdown";

describe("escapeHtml", () => {
  it("escapes core html characters", () => {
    expect(escapeHtml("<tag>&value>")).toBe("&lt;tag&gt;&amp;value&gt;");
  });
});

describe("buildExportHtmlDocument", () => {
  it("wraps body html into a standalone document", () => {
    const html = buildExportHtmlDocument("Doc", "<h1>Hello</h1>");

    expect(html).toContain("<!doctype html>");
    expect(html).toContain("<title>Doc</title>");
    expect(html).toContain("<h1>Hello</h1>");
  });

  it("escapes title content", () => {
    const html = buildExportHtmlDocument("<unsafe>", "<p>body</p>");
    expect(html).toContain("<title>&lt;unsafe&gt;</title>");
  });

  it("includes table styles for exported documents", () => {
    const html = buildExportHtmlDocument("Doc", "<table><tr><td>Hello</td></tr></table>");
    expect(html).toContain("table {");
    expect(html).toContain("tbody tr:nth-child(even)");
  });
});

describe("renderMarkdown", () => {
  it("renders markdown tables into table html", async () => {
    const html = await renderMarkdown(`| Name | Value |
| --- | --- |
| Theme | Ocean |`);

    expect(html).toContain("<table>");
    expect(html).toContain("<thead>");
    expect(html).toContain("<tbody>");
    expect(html).toContain("<td>Ocean</td>");
  });
});
