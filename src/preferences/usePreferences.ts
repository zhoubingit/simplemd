import { useEffect, useState } from "react";

// 1) 扩展 AppPreferences 类型声明，加入 lavender（薰衣草）、dracula（德古拉）、sakura（樱花）、cyberpunk（赛博朋克）、nord（冰雪北欧）和 macha（日式抹茶）新主题
export type AppPreferences = {
    autosaveEnabled: boolean;
    viewMode: "split" | "editor" | "preview";
    editorFontSize: number;
    theme:
        | "graphite"
        | "paper"
        | "forest"
        | "ocean"
        | "dune"
        | "ember"
        | "lavender"
        | "dracula"
        | "sakura"
        | "cyberpunk"
        | "nord"
        | "macha";
};

export const STORAGE_KEY = "simplemd-preferences";
const LEGACY_STORAGE_KEY = "typora-selfuse-preferences";

export const defaultPreferences: AppPreferences = {
    autosaveEnabled: true,
    viewMode: "split",
    editorFontSize: 15,
    /* 1) 将默认初始化主题从暗灰色 Graphite 切换为干净典雅的白色 Paper 主题 */
    theme: "paper",
};

// 2) 重构主题校验解析器，确保新引入的三个主题可以正确通过合规白名单并被持久化
function parseTheme(theme: unknown): AppPreferences["theme"] {
    return theme === "paper" ||
        theme === "forest" ||
        theme === "graphite" ||
        theme === "ocean" ||
        theme === "dune" ||
        theme === "ember" ||
        theme === "lavender" ||
        theme === "dracula" ||
        theme === "sakura" ||
        theme === "cyberpunk" ||
        theme === "nord" ||
        theme === "macha"
        ? (theme as AppPreferences["theme"])
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
