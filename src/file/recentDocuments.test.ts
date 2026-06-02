import { describe, expect, it } from "vitest";
import {
  getDocumentName,
  parseStoredRecentDocuments,
  removeRecentDocument,
  rememberRecentDocument,
  type RecentDocument,
} from "./recentDocuments";

describe("recentDocuments", () => {
  it("extracts document names from windows paths", () => {
    expect(getDocumentName("D:\\docs\\note.md")).toBe("note.md");
  });

  it("ignores invalid storage payloads", () => {
    expect(parseStoredRecentDocuments('{"bad":true}')).toEqual([]);
  });

  it("moves reopened documents to the top without duplicates", () => {
    const initial: RecentDocument[] = [
      { path: "D:\\docs\\a.md", name: "a.md", openedAt: 10 },
      { path: "D:\\docs\\b.md", name: "b.md", openedAt: 5 },
    ];

    const next = rememberRecentDocument(initial, "D:\\docs\\b.md");

    expect(next).toHaveLength(2);
    expect(next[0].path).toBe("D:\\docs\\b.md");
    expect(next[1].path).toBe("D:\\docs\\a.md");
  });

  it("removes a recent document by path", () => {
    const initial: RecentDocument[] = [
      { path: "D:\\docs\\a.md", name: "a.md", openedAt: 10 },
      { path: "D:\\docs\\b.md", name: "b.md", openedAt: 5 },
    ];

    const next = removeRecentDocument(initial, "D:\\docs\\a.md");

    expect(next).toEqual([{ path: "D:\\docs\\b.md", name: "b.md", openedAt: 5 }]);
  });
});
