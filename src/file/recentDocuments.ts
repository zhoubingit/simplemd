export type RecentDocument = {
  path: string;
  name: string;
  openedAt: number;
};

export const RECENT_DOCUMENTS_STORAGE_KEY = "simplemd-recent-documents";
const LEGACY_RECENT_DOCUMENTS_STORAGE_KEY = "typora-selfuse-recent-documents";
const MAX_RECENT_DOCUMENTS = 8;

export function getDocumentName(path: string) {
  const segments = path.split(/[\\/]/);
  return segments[segments.length - 1] || "untitled.md";
}

export function parseStoredRecentDocuments(raw: string | null): RecentDocument[] {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter(
        (item): item is RecentDocument =>
          typeof item === "object" &&
          item !== null &&
          typeof item.path === "string" &&
          item.path.length > 0 &&
          typeof item.name === "string" &&
          item.name.length > 0 &&
          typeof item.openedAt === "number",
      )
      .sort((left, right) => right.openedAt - left.openedAt)
      .slice(0, MAX_RECENT_DOCUMENTS);
  } catch {
    return [];
  }
}

export function readStoredRecentDocuments() {
  if (typeof window === "undefined") {
    return [];
  }

  return parseStoredRecentDocuments(
    window.localStorage.getItem(RECENT_DOCUMENTS_STORAGE_KEY) ??
      window.localStorage.getItem(LEGACY_RECENT_DOCUMENTS_STORAGE_KEY),
  );
}

export function persistRecentDocuments(items: RecentDocument[]) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(
    RECENT_DOCUMENTS_STORAGE_KEY,
    JSON.stringify(items.slice(0, MAX_RECENT_DOCUMENTS)),
  );
}

export function rememberRecentDocument(
  items: RecentDocument[],
  path: string,
): RecentDocument[] {
  const nextItem: RecentDocument = {
    path,
    name: getDocumentName(path),
    openedAt: Date.now(),
  };

  return [nextItem, ...items.filter((item) => item.path !== path)].slice(
    0,
    MAX_RECENT_DOCUMENTS,
  );
}

export function removeRecentDocument(
  items: RecentDocument[],
  path: string,
): RecentDocument[] {
  return items.filter((item) => item.path !== path);
}

export function renameRecentDocument(
  items: RecentDocument[],
  previousPath: string,
  nextPath: string,
): RecentDocument[] {
  return items.map((item) =>
    item.path === previousPath
      ? {
          ...item,
          path: nextPath,
          name: getDocumentName(nextPath),
        }
      : item,
  );
}
