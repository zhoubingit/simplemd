import { describe, expect, it } from "vitest";
import {
  defaultPreferences,
  parseStoredPreferences,
} from "./usePreferences";

describe("parseStoredPreferences", () => {
  it("returns defaults for empty storage", () => {
    expect(parseStoredPreferences(null)).toEqual(defaultPreferences);
  });

  it("keeps valid stored values", () => {
    expect(
      parseStoredPreferences(
        JSON.stringify({
          autosaveEnabled: false,
          viewMode: "preview",
          editorFontSize: 18,
          theme: "ocean",
        }),
      ),
    ).toEqual({
      autosaveEnabled: false,
      viewMode: "preview",
      editorFontSize: 18,
      theme: "ocean",
    });
  });

  it("migrates legacy singleColumnMode values", () => {
    expect(
      parseStoredPreferences(
        JSON.stringify({
          singleColumnMode: true,
        }),
      ),
    ).toEqual({
      ...defaultPreferences,
      viewMode: "editor",
    });
  });

  it("falls back for invalid shapes", () => {
    expect(
      parseStoredPreferences(
        JSON.stringify({
          autosaveEnabled: "bad",
          editorFontSize: "bad",
        }),
      ),
    ).toEqual(defaultPreferences);
  });
});
