import { describe, expect, it } from "vitest";
import { findActiveBlock, getMarkdownLineInfo } from "./activeBlock";

describe("getMarkdownLineInfo", () => {
  it("detects headings", () => {
    expect(getMarkdownLineInfo("## Title")).toMatchObject({
      kind: "heading",
      prefixLength: 3,
    });
  });

  it("detects quotes and lists", () => {
    expect(getMarkdownLineInfo("> quote")).toMatchObject({
      kind: "quote",
      prefixLength: 2,
    });
    expect(getMarkdownLineInfo("- item")).toMatchObject({
      kind: "list",
      prefixLength: 2,
    });
  });
});

describe("findActiveBlock", () => {
  it("keeps headings on a single line", () => {
    const lines = ["# Title", "paragraph"];
    expect(findActiveBlock(lines, 1)).toEqual({
      fromLine: 1,
      toLine: 1,
      kind: "heading",
    });
  });

  it("expands list blocks with indented continuation lines", () => {
    const lines = ["- item 1", "  continuation", "- item 2", "", "tail"];
    expect(findActiveBlock(lines, 2)).toEqual({
      fromLine: 1,
      toLine: 3,
      kind: "list",
    });
  });

  it("expands quote blocks across adjacent quote lines", () => {
    const lines = ["> one", "> two", "plain"];
    expect(findActiveBlock(lines, 2)).toEqual({
      fromLine: 1,
      toLine: 2,
      kind: "quote",
    });
  });
});
