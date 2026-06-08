import { invoke } from "@tauri-apps/api/core";

export type DocumentHandle = {
  path: string;
  content: string;
};

export type MarkdownFolderNode = {
  name: string;
  path: string;
  kind: "directory" | "file";
  children: MarkdownFolderNode[];
};

export type MarkdownFolderHandle = {
  rootPath: string;
  rootName: string;
  nodes: MarkdownFolderNode[];
};

export type ImportedImageAsset = {
  savedPath: string;
  markdownPath: string;
};

export type InstalledBrowserOption = {
  id: string;
  name: string;
};

export async function openDocument() {
  return invoke<DocumentHandle | null>("open_markdown_file");
}

export async function openDocumentByPath(path: string) {
  return invoke<DocumentHandle>("open_markdown_file_by_path", { path });
}

export async function openMarkdownFolder() {
  return invoke<MarkdownFolderHandle | null>("open_markdown_folder");
}

export async function readMarkdownFolder(path: string) {
  return invoke<MarkdownFolderHandle>("read_markdown_folder", { path });
}

export const lastSaveTimestamps: Record<string, number> = {};

export async function createMarkdownFile(directoryPath: string) {
  const result = await invoke<DocumentHandle>("create_markdown_file", { directoryPath });
  if (result) {
    lastSaveTimestamps[result.path] = Date.now();
  }
  return result;
}

export async function duplicateMarkdownFile(path: string) {
  const result = await invoke<DocumentHandle>("duplicate_markdown_file", { path });
  if (result) {
    lastSaveTimestamps[result.path] = Date.now();
  }
  return result;
}

export async function deleteMarkdownFile(path: string) {
  return invoke<void>("delete_markdown_file", { path });
}

export async function renameMarkdownFile(path: string, nextName: string) {
  const result = await invoke<DocumentHandle>("rename_markdown_file", { path, nextName });
  if (result) {
    lastSaveTimestamps[result.path] = Date.now();
  }
  return result;
}

export async function saveDocument(path: string | null, content: string) {
  const result = await invoke<DocumentHandle | null>("save_markdown_file", {
    request: {
      path,
      content,
      suggestedName: "untitled.md",
    },
  });
  if (result) {
    lastSaveTimestamps[result.path] = Date.now();
  }
  return result;
}

export async function saveDocumentAs(content: string, suggestedName: string) {
  const result = await invoke<DocumentHandle | null>("save_markdown_file_as", {
    request: {
      path: null,
      content,
      suggestedName,
    },
  });
  if (result) {
    lastSaveTimestamps[result.path] = Date.now();
  }
  return result;
}

export async function importImageAsset(
  documentPath: string,
  fileName: string | null,
  mimeType: string | null,
  bytes: number[],
) {
  return invoke<ImportedImageAsset>("import_image_asset", {
    request: {
      documentPath,
      fileName,
      mimeType,
      bytes,
    },
  });
}

export async function listInstalledBrowsers() {
  return invoke<InstalledBrowserOption[]>("list_installed_browsers");
}

export async function openExternalLinkInBrowser(url: string, browserId: string) {
  return invoke<void>("open_external_link_in_browser", {
    url,
    browserId,
  });
}

export async function watchFile(path: string) {
  return invoke<void>("watch_file", { path });
}

export async function unwatchFile(path: string) {
  return invoke<void>("unwatch_file", { path });
}
