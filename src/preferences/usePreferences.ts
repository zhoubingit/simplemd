import { useEffect, useState } from "react";

export type AppPreferences = {
  autosaveEnabled: boolean;
  viewMode: "split" | "editor" | "preview";
  editorFontSize: number;
  theme: "graphite" | "paper" | "forest" | "ocean" | "dune" | "ember";
};

export const STORAGE_KEY = "simplemd-preferences";
const LEGACY_STORAGE_KEY = "typora-selfuse-preferences";

export const defaultPreferences: AppPreferences = {
  autosaveEnabled: true,
  viewMode: "split",
  editorFontSize: 15,
  theme: "graphite",
};

function parseTheme(theme: unknown): AppPreferences["theme"] {
  return theme === "paper" ||
    theme === "forest" ||
    theme === "graphite" ||
    theme === "ocean" ||
    theme === "dune" ||
    theme === "ember"
    ? theme
    : defaultPreferences.theme;
}

export function parseStoredPreferences(raw: string | null): AppPreferences {
  if (!raw) {
    return defaultPreferences;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<AppPreferences>;
    const legacySingleColumnMode =
      typeof (parsed as { singleColumnMode?: unknown }).singleColumnMode === "boolean"
        ? (parsed as { singleColumnMode: boolean }).singleColumnMode
        : null;

    return {
      autosaveEnabled:
        typeof parsed.autosaveEnabled === "boolean"
          ? parsed.autosaveEnabled
          : defaultPreferences.autosaveEnabled,
      viewMode:
        parsed.viewMode === "split" ||
        parsed.viewMode === "editor" ||
        parsed.viewMode === "preview"
          ? parsed.viewMode
          : legacySingleColumnMode === true
            ? "editor"
            : defaultPreferences.viewMode,
      editorFontSize:
        typeof parsed.editorFontSize === "number"
          ? parsed.editorFontSize
          : defaultPreferences.editorFontSize,
      theme: parseTheme(parsed.theme),
    };
  } catch {
    return defaultPreferences;
  }
}

export function readStoredPreferences(): AppPreferences {
  if (typeof window === "undefined") {
    return defaultPreferences;
  }

  return parseStoredPreferences(
    window.localStorage.getItem(STORAGE_KEY) ??
      window.localStorage.getItem(LEGACY_STORAGE_KEY),
  );
}

export function usePreferences() {
  const [preferences, setPreferences] = useState<AppPreferences>(
    readStoredPreferences,
  );

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  }, [preferences]);

  return {
    preferences,
    updatePreferences(
      updater: Partial<AppPreferences> | ((current: AppPreferences) => AppPreferences),
    ) {
      setPreferences((current) =>
        typeof updater === "function" ? updater(current) : { ...current, ...updater },
      );
    },
  };
}
