import {
  startTransition,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import {
  getCurrentWebview,
  type DragDropEvent,
} from "@tauri-apps/api/webview";
import {
  MarkdownEditor,
  type FormatAction,
  type MarkdownEditorHandle,
  type MarkdownEditorStateSnapshot,
} from "../editor/MarkdownEditor";
import { MarkdownPreview } from "../preview/MarkdownPreview";
import {
  importImageAsset,
  listInstalledBrowsers,
  createMarkdownFile,
  deleteMarkdownFile,
  duplicateMarkdownFile,
  renameMarkdownFile,
  openDocument,
  openExternalLinkInBrowser,
  openDocumentByPath,
  openMarkdownFolder,
  readMarkdownFolder,
  saveDocument,
  saveDocumentAs,
  watchFile,
  unwatchFile,
  lastSaveTimestamps,
  type DocumentHandle,
  type InstalledBrowserOption,
  type MarkdownFolderHandle,
  type MarkdownFolderNode,
} from "../file/documentApi";
import {
  persistRecentDocuments,
  readStoredRecentDocuments,
  renameRecentDocument,
  removeRecentDocument,
  rememberRecentDocument,
  type RecentDocument,
} from "../file/recentDocuments";
import { exportHtmlDocument } from "../export/exportApi";
import {
  buildExportHtmlDocument,
  renderMarkdown,
} from "../preview/renderMarkdown";
import { usePreferences } from "../preferences/usePreferences";

declare global {
  interface Window {
    showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>;
  }
}

const initialMarkdown = "";
const APP_SESSION_STORAGE_KEY = "simplemd-session";
const LEGACY_APP_SESSION_STORAGE_KEY = "typora-selfuse-session";

type SaveState = "idle" | "saving" | "saved" | "error";
type ScrollSource = "editor" | "preview" | null;
type MenuKey = "file" | "view" | "insert";
type ViewMode = "split" | "editor" | "preview";
type DesktopWindowAnimationKind = "maximize" | "restore" | null;
type FolderNodeKind = "root" | "directory" | "file";
type BrowserFolderBindings = {
  directoryHandle: FileSystemDirectoryHandle;
  directoryMap: Record<string, FileSystemDirectoryHandle>;
  fileHandleMap: Record<string, FileSystemFileHandle>;
};
type OpenFolderState = MarkdownFolderHandle & {
  source: "desktop" | "browser";
  fileMap: Record<string, File> | null;
  bindings: BrowserFolderBindings | null;
};
type FolderContextMenuState = {
  x: number;
  y: number;
  path: string;
  kind: FolderNodeKind;
  name: string;
};
type TabContextMenuState = {
  x: number;
  y: number;
  tabId: string;
  name: string;
};
type RenameDialogState = {
  source: "tab" | "folder-tree";
  tabId: string | null;
  path: string | null;
  initialName: string;
};
type AppSessionState = {
  currentPath: string | null;
  openFolderRootPath: string | null;
  folderPanelCollapsed: boolean;
};
type OpenDocumentTab = {
  id: string;
  path: string | null;
  name: string;
  markdown: string;
  lastSavedContent: string;
  saveState: SaveState;
  editorState: MarkdownEditorStateSnapshot | null;
};

type TabDropPosition = "before" | "after";

type PointerTabDragState = {
  draggedTabId: string;
  pointerId: number;
  startX: number;
  startY: number;
  started: boolean;
};

type InsertMenuAction = FormatAction | "image";

let openDocumentTabSequence = 0;

function createOpenDocumentTabId() {
  openDocumentTabSequence += 1;
  return `doc-tab-${openDocumentTabSequence}`;
}

function getFileNameFromPath(path: string | null) {
  if (!path) {
    return "untitled.md";
  }

  const segments = path.split(/[\\/]/);
  return segments[segments.length - 1] || "untitled.md";
}

function normalizeDocumentPath(path: string | null) {
  if (!path) {
    return null;
  }

  return path.replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase();
}

function isSameDocumentPath(left: string | null, right: string | null) {
  return normalizeDocumentPath(left) === normalizeDocumentPath(right);
}

function createEmptyDocumentTab(): OpenDocumentTab {
  return {
    id: createOpenDocumentTabId(),
    path: null,
    name: "untitled.md",
    markdown: initialMarkdown,
    lastSavedContent: initialMarkdown,
    saveState: "idle",
    editorState: null,
  };
}

function reorderOpenDocumentTabs(
  tabs: OpenDocumentTab[],
  draggedTabId: string,
  targetTabId: string,
  position: TabDropPosition,
) {
  if (draggedTabId === targetTabId) {
    return tabs;
  }

  const draggedIndex = tabs.findIndex((tab) => tab.id === draggedTabId);
  const targetIndex = tabs.findIndex((tab) => tab.id === targetTabId);

  if (draggedIndex < 0 || targetIndex < 0) {
    return tabs;
  }

  const nextTabs = [...tabs];
  const [draggedTab] = nextTabs.splice(draggedIndex, 1);
  const adjustedTargetIndex =
    draggedIndex < targetIndex ? targetIndex - 1 : targetIndex;
  const insertIndex =
    position === "before" ? adjustedTargetIndex : adjustedTargetIndex + 1;

  nextTabs.splice(insertIndex, 0, draggedTab);
  return nextTabs;
}

function getExternalLinkHostLabel(url: string) {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

const insertMenuGroups: Array<{
  title: string;
  items: Array<{ label: string; action: InsertMenuAction }>;
}> = [
  {
    title: "资源",
    items: [{ label: "插图", action: "image" }],
  },
  {
    title: "文本",
    items: [
      { label: "粗体", action: "bold" },
      { label: "斜体", action: "italic" },
      { label: "行内代码", action: "code" },
      { label: "链接", action: "link" },
      { label: "引用", action: "quote" },
    ],
  },
  {
    title: "标题",
    items: [
      { label: "H1 一级标题", action: "heading" },
      { label: "H2 二级标题", action: "heading2" },
      { label: "H3 三级标题", action: "heading3" },
    ],
  },
  {
    title: "列表",
    items: [
      { label: "无序列表", action: "bullet" },
      { label: "有序列表", action: "ordered" },
      { label: "任务列表", action: "task" },
    ],
  },
  {
    title: "块",
    items: [
      { label: "代码块", action: "codeblock" },
      { label: "表格", action: "table" },
      { label: "分隔线", action: "divider" },
    ],
  },
];

function createExportName(fileName: string, extension: string) {
  const base = fileName.replace(/\.[^.]+$/, "") || "document";
  return `${base}.${extension}`;
}

function countWords(text: string) {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized ? normalized.split(" ").length : 0;
}

function formatRelativeTime(timestamp: number) {
  const diffMs = Date.now() - timestamp;
  const diffMinutes = Math.max(1, Math.round(diffMs / 60000));

  if (diffMinutes < 60) {
    return `${diffMinutes} 分钟前`;
  }

  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours} 小时前`;
  }

  const diffDays = Math.round(diffHours / 24);
  if (diffDays < 30) {
    return `${diffDays} 天前`;
  }

  const diffMonths = Math.round(diffDays / 30);
  return `${diffMonths} 个月前`;
}

function getRecentDocumentDescription(
  item: RecentDocument,
  currentPath: string | null,
) {
  if (item.path === currentPath) {
    return "当前文档";
  }

  return `最近打开 · ${formatRelativeTime(item.openedAt)}`;
}

function parseStoredAppSession(raw: string | null): AppSessionState {
  if (!raw) {
    return {
      currentPath: null,
      openFolderRootPath: null,
      folderPanelCollapsed: false,
    };
  }

  try {
    const parsed = JSON.parse(raw) as Partial<AppSessionState>;
    return {
      currentPath: typeof parsed.currentPath === "string" ? parsed.currentPath : null,
      openFolderRootPath:
        typeof parsed.openFolderRootPath === "string" ? parsed.openFolderRootPath : null,
      folderPanelCollapsed: parsed.folderPanelCollapsed === true,
    };
  } catch {
    return {
      currentPath: null,
      openFolderRootPath: null,
      folderPanelCollapsed: false,
    };
  }
}

function isMarkdownFileName(name: string) {
  return /\.(md|markdown)$/i.test(name);
}

function getDroppedFilePath(file: File) {
  const candidate = file as File & { path?: unknown };
  return typeof candidate.path === "string" && candidate.path
    ? candidate.path
    : null;
}

function getMarkdownFileNameParts(name: string) {
  const match = name.match(/^(.*?)(\.(md|markdown))$/i);
  if (!match) {
    return {
      stem: name,
      extension: ".md",
    };
  }

  return {
    stem: match[1] || "untitled",
    extension: match[2],
  };
}

function buildMarkdownFileNameFromStemInput(input: string, fallbackName: string) {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("文件名不能为空");
  }

  if (trimmed.includes("/") || trimmed.includes("\\")) {
    throw new Error("文件名不能包含路径分隔符");
  }

  const { extension } = getMarkdownFileNameParts(fallbackName);
  const suffixPattern = new RegExp(`${extension.replace(".", "\\.")}$`, "i");
  const normalizedStem = trimmed.replace(suffixPattern, "").trim();

  if (!normalizedStem) {
    throw new Error("文件名不能为空");
  }

  return `${normalizedStem}${extension}`;
}

function createBrowserFolderHandleFromFiles(files: File[]): OpenFolderState | null {
  const folderFiles = files.filter(
    (file) => file.webkitRelativePath && isMarkdownFileName(file.name),
  );

  if (folderFiles.length === 0) {
    return null;
  }

  type FolderDraftNode = {
    name: string;
    path: string;
    kind: "directory" | "file";
    children: Map<string, FolderDraftNode>;
  };

  const [rootName] = folderFiles[0].webkitRelativePath.split("/");
  const fileMap: Record<string, File> = {};
  const roots = new Map<string, FolderDraftNode>();

  function ensureNode(
    container: Map<string, FolderDraftNode>,
    name: string,
    path: string,
    kind: "directory" | "file",
  ) {
    const existing = container.get(path);
    if (existing) {
      return existing;
    }

    const nextNode: FolderDraftNode = {
      name,
      path,
      kind,
      children: new Map(),
    };
    container.set(path, nextNode);
    return nextNode;
  }

  for (const file of folderFiles) {
    const relativePath = file.webkitRelativePath;
    const segments = relativePath.split("/").slice(1);
    let directoryMap = roots;
    let parentPath = rootName;

    for (const [index, segment] of segments.entries()) {
      const isLeaf = index === segments.length - 1;
      const nodePath = `${parentPath}/${segment}`;

      if (isLeaf) {
        ensureNode(directoryMap, segment, nodePath, "file");
        fileMap[nodePath] = file;
        continue;
      }

      const directoryNode = ensureNode(
        directoryMap,
        segment,
        nodePath,
        "directory",
      );
      directoryMap = directoryNode.children;
      parentPath = nodePath;
    }
  }

  function finalizeNodes(
    container: Map<string, FolderDraftNode>,
  ): MarkdownFolderNode[] {
    return Array.from(container.values())
      .map((node) => ({
        name: node.name,
        path: node.path,
        kind: node.kind,
        children: finalizeNodes(node.children),
      }))
      .sort((left, right) => {
        if (left.kind !== right.kind) {
          return left.kind === "directory" ? -1 : 1;
        }

        return left.name.localeCompare(right.name, "zh-CN", {
          sensitivity: "base",
        });
      });
  }

  return {
    source: "browser",
    rootPath: rootName,
    rootName,
    nodes: finalizeNodes(roots),
    fileMap,
    bindings: null,
  };
}

async function createBrowserFolderHandleFromDirectory(
  rootHandle: FileSystemDirectoryHandle,
): Promise<OpenFolderState> {
  async function walkDirectory(
    directoryHandle: FileSystemDirectoryHandle,
    parentPath: string,
    directoryMap: Record<string, FileSystemDirectoryHandle>,
    fileHandleMap: Record<string, FileSystemFileHandle>,
  ): Promise<MarkdownFolderNode[]> {
    const nodes: MarkdownFolderNode[] = [];

    for await (const entry of directoryHandle.values()) {
      const entryPath = `${parentPath}/${entry.name}`;

      if (entry.kind === "directory") {
        directoryMap[entryPath] = entry;
        nodes.push({
          name: entry.name,
          path: entryPath,
          kind: "directory",
          children: await walkDirectory(entry, entryPath, directoryMap, fileHandleMap),
        });
        continue;
      }

      if (isMarkdownFileName(entry.name)) {
        fileHandleMap[entryPath] = entry;
        nodes.push({
          name: entry.name,
          path: entryPath,
          kind: "file",
          children: [],
        });
      }
    }

    return nodes.sort((left, right) => {
      if (left.kind !== right.kind) {
        return left.kind === "directory" ? -1 : 1;
      }

      return left.name.localeCompare(right.name, "zh-CN", {
        sensitivity: "base",
      });
    });
  }

  const rootPath = rootHandle.name;
  const directoryMap: Record<string, FileSystemDirectoryHandle> = {
    [rootPath]: rootHandle,
  };
  const fileHandleMap: Record<string, FileSystemFileHandle> = {};

  return {
    source: "browser",
    rootPath,
    rootName: rootHandle.name,
    nodes: await walkDirectory(rootHandle, rootPath, directoryMap, fileHandleMap),
    fileMap: null,
    bindings: {
      directoryHandle: rootHandle,
      directoryMap,
      fileHandleMap,
    },
  };
}

function findDirectoryTrail(
  nodes: MarkdownFolderNode[],
  targetPath: string,
): string[] | null {
  for (const node of nodes) {
    if (node.kind === "file" && node.path === targetPath) {
      return [];
    }

    if (node.kind === "directory") {
      const childTrail = findDirectoryTrail(node.children, targetPath);
      if (childTrail) {
        return [node.path, ...childTrail];
      }
    }
  }

  return null;
}

export function App() {
  const isDesktopApp = useMemo(() => isTauri(), []);
  const desktopWindow = useMemo(
    () => (isDesktopApp ? getCurrentWindow() : null),
    [isDesktopApp],
  );
  const desktopWebview = useMemo(
    () => (isDesktopApp ? getCurrentWebview() : null),
    [isDesktopApp],
  );
  const initialSession = useMemo(
    () =>
      typeof window === "undefined"
        ? {
            currentPath: null,
            openFolderRootPath: null,
            folderPanelCollapsed: false,
          }
        : parseStoredAppSession(
            window.localStorage.getItem(APP_SESSION_STORAGE_KEY) ??
              window.localStorage.getItem(LEGACY_APP_SESSION_STORAGE_KEY),
          ),
    [],
  );
  const [markdown, setMarkdown] = useState(initialMarkdown);
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [openTabs, setOpenTabs] = useState<OpenDocumentTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [recentDocuments, setRecentDocuments] = useState<RecentDocument[]>(
    readStoredRecentDocuments,
  );
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [statusText, setStatusText] = useState("准备就绪");
  const [lastSavedContent, setLastSavedContent] = useState(initialMarkdown);
  const [scrollRatio, setScrollRatio] = useState(0);
  const [scrollSource, setScrollSource] = useState<ScrollSource>(null);
  const [showPreferences, setShowPreferences] = useState(false);
  const [showRecentDocuments, setShowRecentDocuments] = useState(false);
  const [fullscreenImageUrl, setFullscreenImageUrl] = useState<string | null>(null);
  const [renameSession, setRenameSession] = useState<RenameDialogState | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [pendingExternalLink, setPendingExternalLink] = useState<string | null>(null);
  const [showBrowserChoiceDialog, setShowBrowserChoiceDialog] = useState(false);
  const [browserChoices, setBrowserChoices] = useState<InstalledBrowserOption[]>([]);
  const [isLoadingBrowserChoices, setIsLoadingBrowserChoices] = useState(false);
  const [openFolder, setOpenFolder] = useState<OpenFolderState | null>(null);
  const [isFolderPanelCollapsed, setIsFolderPanelCollapsed] = useState(
    initialSession.folderPanelCollapsed,
  );
  const [expandedFolderPaths, setExpandedFolderPaths] = useState<Set<string>>(
    () => new Set(),
  );
  const [selectedFolderPath, setSelectedFolderPath] = useState<string | null>(null);
  const [folderContextMenu, setFolderContextMenu] = useState<FolderContextMenuState | null>(null);
  const [tabContextMenu, setTabContextMenu] = useState<TabContextMenuState | null>(null);
  const [activeMenu, setActiveMenu] = useState<MenuKey | null>(null);
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [dragOverTabId, setDragOverTabId] = useState<string | null>(null);
  const [dragOverTabPosition, setDragOverTabPosition] =
    useState<TabDropPosition | null>(null);
  const [isDesktopWindowMaximized, setIsDesktopWindowMaximized] = useState(false);
  const [isDesktopWindowAnimating, setIsDesktopWindowAnimating] = useState(false);
  const [desktopWindowAnimationKind, setDesktopWindowAnimationKind] =
    useState<DesktopWindowAnimationKind>(null);
  const editorRef = useRef<MarkdownEditorHandle | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const menuBarRef = useRef<HTMLDivElement | null>(null);
  const documentTabsStripRef = useRef<HTMLDivElement | null>(null);
  const folderContextMenuRef = useRef<HTMLDivElement | null>(null);
  const tabContextMenuRef = useRef<HTMLDivElement | null>(null);
  const activeFolderFileRef = useRef<HTMLButtonElement | null>(null);
  const inlineRenameInputRef = useRef<HTMLInputElement | null>(null);
  const inlineRenameShellRef = useRef<HTMLSpanElement | null>(null);
  const isRenameSubmittingRef = useRef(false);
  const pointerTabDragRef = useRef<PointerTabDragState | null>(null);
  const suppressTabClickRef = useRef(false);
  const desktopWindowAnimationTimerRef = useRef<number | null>(null);
  const autosaveTimerRef = useRef<number | null>(null);
  const autosaveUnsavedHintRef = useRef(false);
  const lastNativeDropRef = useRef({ key: "", handledAt: 0 });
  const [isSessionReady, setIsSessionReady] = useState(!isDesktopApp);
  const { preferences, updatePreferences } = usePreferences();
  const shellStyle = useMemo(
    () =>
      ({
        ["--editor-font-size"]: `${preferences.editorFontSize}px`,
      }) as CSSProperties,
    [preferences.editorFontSize],
  );

  const isDirty = markdown !== lastSavedContent;
  const lines = useMemo(() => markdown.split("\n"), [markdown]);
  const wordCount = useMemo(() => countWords(markdown), [markdown]);
  const displayedSaveState =
    saveState === "saving" || saveState === "error"
      ? saveState
      : isDirty
        ? "dirty"
        : saveState === "saved"
          ? "saved"
          : "idle";
  const saveStateLabel =
    displayedSaveState === "saving"
      ? "保存中"
      : displayedSaveState === "saved"
        ? "已同步"
        : displayedSaveState === "error"
          ? "有问题"
          : displayedSaveState === "dirty"
            ? "未保存"
            : "待命";
  const activeTab = useMemo(
    () => openTabs.find((tab) => tab.id === activeTabId) ?? null,
    [activeTabId, openTabs],
  );
  const currentFileName = currentPath
    ? getFileNameFromPath(currentPath)
    : activeTab?.name ?? "未打开文件";
  const currentDocumentPathLabel = currentPath
    ? currentPath
    : activeTab
      ? "尚未保存到本地"
      : "尚未打开文件";
  const desktopStatusSummary = statusText.trim();

    const openTabsRef = useRef(openTabs);
    const currentPathRef = useRef(currentPath);

    useEffect(() => {
        openTabsRef.current = openTabs;
    }, [openTabs]);

    useEffect(() => {
        currentPathRef.current = currentPath;
    }, [currentPath]);

    // 1) 收集所有已打开的、拥有物理路径的文件
    const openPaths = useMemo(() => {
        return openTabs.map((tab) => tab.path).filter((p): p is string => !!p);
    }, [openTabs]);

    const watchedPathsRef = useRef<Set<string>>(new Set());

    // 2) 同步监听列表到 Rust 后端
    useEffect(() => {
        if (!isTauri) return;

        const currentPaths = new Set(openPaths);
        const watched = watchedPathsRef.current;

        // 2.1) 移除不再打开的文件监听
        for (const p of watched) {
            if (!currentPaths.has(p)) {
                unwatchFile(p).catch((err) => {
                    console.error("Failed to unwatch file:", p, err);
                });
                watched.delete(p);
            }
        }

        // 2.2) 监听新打开的文件
        for (const p of currentPaths) {
            if (!watched.has(p)) {
                watchFile(p).catch((err) => {
                    console.error("Failed to watch file:", p, err);
                });
                watched.add(p);
            }
        }
    }, [openPaths]);

    // 3) 卸载时取消所有监听
    useEffect(() => {
        return () => {
            if (!isTauri) return;
            const watched = watchedPathsRef.current;
            for (const p of watched) {
                unwatchFile(p).catch((err) => {
                    console.error("Failed to unwatch file on unmount:", p, err);
                });
            }
            watched.clear();
        };
    }, []);

    // 4) 重新加载被外部修改过的 Tab 内容
    const reloadTabContent = (p: string, newContent: string) => {
        setOpenTabs((prevTabs) =>
            prevTabs.map((tab) => {
                if (tab.path === p) {
                    return {
                        ...tab,
                        markdown: newContent,
                        lastSavedContent: newContent,
                        saveState: "saved" as const,
                    };
                }
                return tab;
            })
        );

        if (currentPathRef.current === p) {
            setMarkdown(newContent);
            setLastSavedContent(newContent);
            setSaveState("saved");
        }
    };

    // 5) 监听后端的 file-changed 事件
    useEffect(() => {
        if (!isTauri) return;

        const unlistenPromise = listen<string>("file-changed", async (event) => {
            const changedPath = event.payload;

            // 5.1) 忽略自己保存产生的事件 (2秒内)
            const lastSave = lastSaveTimestamps[changedPath];
            if (lastSave && Date.now() - lastSave < 2000) {
                return;
            }

            const currentTabs = openTabsRef.current;
            const targetTab = currentTabs.find((t) => t.path === changedPath);
            if (!targetTab) return;

            try {
                // 5.2) 读取磁盘上的最新内容
                const doc = await openDocumentByPath(changedPath);
                if (doc.content === targetTab.markdown) {
                    return;
                }

                const isDirty = targetTab.markdown !== targetTab.lastSavedContent;
                if (isDirty) {
                    // 5.3) 文件为 dirty 时，弹窗询问用户
                    const fileName = getFileNameFromPath(changedPath);
                    const shouldReload = window.confirm(
                        `文件 "${fileName}" 在外部被修改。\n是否重新加载以载入外部修改？\n注意：这会覆盖您当前的未保存修改。`
                    );
                    if (shouldReload) {
                        reloadTabContent(changedPath, doc.content);
                    }
                } else {
                    // 5.4) 文件为 clean 时，直接自动刷新
                    reloadTabContent(changedPath, doc.content);
                }
            } catch (err) {
                console.error("Failed to reload externally changed file:", changedPath, err);
            }
        });

        return () => {
            unlistenPromise.then((unlisten) => unlisten());
        };
    }, []);

  const latestStateRef = useRef({
    markdown: initialMarkdown,
    currentPath: null as string | null,
    currentFileName: "untitled.md",
    viewMode: "split" as ViewMode,
  });

  latestStateRef.current = {
    markdown,
    currentPath,
    currentFileName,
    viewMode: preferences.viewMode,
  };

  useEffect(() => {
    if (!activeTabId) {
      return;
    }

    setOpenTabs((current) =>
      current.map((tab) =>
        tab.id === activeTabId
          ? {
              ...tab,
              path: currentPath,
              name: currentFileName,
              markdown,
              lastSavedContent,
              saveState,
              editorState: tab.editorState,
            }
          : tab,
      ),
    );
  }, [activeTabId, currentFileName, currentPath, lastSavedContent, markdown, saveState]);

  const showEditorPanel = preferences.viewMode !== "preview";
  const showPreviewPanel = preferences.viewMode !== "editor";
  const hasOpenFolder = openFolder !== null;
  const showFolderPanel = hasOpenFolder && !isFolderPanelCollapsed;
  const currentFolderTrail = useMemo(() => {
    if (!openFolder || !currentPath) {
      return null;
    }

    return findDirectoryTrail(openFolder.nodes, currentPath);
  }, [currentPath, openFolder]);
  const currentFolderTrailSet = useMemo(
    () => new Set(currentFolderTrail ?? []),
    [currentFolderTrail],
  );

  function closeExternalLinkDialogs() {
    setPendingExternalLink(null);
    setShowBrowserChoiceDialog(false);
    setBrowserChoices([]);
    setIsLoadingBrowserChoices(false);
  }

  function switchToTab(tabId: string) {
    const nextTab = openTabs.find((tab) => tab.id === tabId);
    if (!nextTab || nextTab.id === activeTabId) {
      return;
    }

    setActiveTabId(nextTab.id);
    setMarkdown(nextTab.markdown);
    setCurrentPath(nextTab.path);
    setLastSavedContent(nextTab.lastSavedContent);
    setSaveState(nextTab.saveState);
    setStatusText(`已切换到 ${nextTab.name}`);
  }

  function cycleTabs(direction: "next" | "previous") {
    if (!activeTabId || openTabs.length < 2) {
      return;
    }

    const currentIndex = openTabs.findIndex((tab) => tab.id === activeTabId);
    if (currentIndex < 0) {
      return;
    }

    const nextIndex =
      direction === "next"
        ? (currentIndex + 1) % openTabs.length
        : (currentIndex - 1 + openTabs.length) % openTabs.length;

    switchToTab(openTabs[nextIndex].id);
  }

  function handleCloseTab(tabId: string) {
    const closingTab = openTabs.find((tab) => tab.id === tabId);
    if (!closingTab) {
      return;
    }

    if (openTabs.length === 1) {
      setOpenTabs([]);
      setActiveTabId(null);
      setMarkdown(initialMarkdown);
      setCurrentPath(null);
      setLastSavedContent(initialMarkdown);
      setSaveState("idle");
      setStatusText("已关闭当前页签");
      return;
    }

    const closingIndex = openTabs.findIndex((tab) => tab.id === tabId);
    const fallbackTab =
      openTabs[closingIndex + 1] ?? openTabs[closingIndex - 1] ?? openTabs[0];
    const remainingTabs = openTabs.filter((tab) => tab.id !== tabId);

    setOpenTabs(remainingTabs);

    if (activeTabId === tabId && fallbackTab) {
      setActiveTabId(fallbackTab.id);
      setMarkdown(fallbackTab.markdown);
      setCurrentPath(fallbackTab.path);
      setLastSavedContent(fallbackTab.lastSavedContent);
      setSaveState(fallbackTab.saveState);
    }

    setStatusText(`已关闭 ${closingTab.name}`);
  }

  function getLiveTabSnapshot(tab: OpenDocumentTab) {
    if (tab.id !== activeTabId) {
      return tab;
    }

    return {
      ...tab,
      path: currentPath,
      name: currentFileName,
      markdown,
      lastSavedContent,
      saveState,
    };
  }

  function handleCloseOtherTabs(tabId: string) {
    const targetTab = openTabs.find((tab) => tab.id === tabId);
    if (!targetTab) {
      return;
    }

    const nextActiveTab = getLiveTabSnapshot(targetTab);
    setOpenTabs([nextActiveTab]);
    setActiveTabId(nextActiveTab.id);
    setMarkdown(nextActiveTab.markdown);
    setCurrentPath(nextActiveTab.path);
    setLastSavedContent(nextActiveTab.lastSavedContent);
    setSaveState(nextActiveTab.saveState);
    setStatusText(`已关闭其他页签，保留 ${nextActiveTab.name}`);
  }

  function handleCloseAllTabs() {
    setOpenTabs([]);
    setActiveTabId(null);
    setMarkdown(initialMarkdown);
    setCurrentPath(null);
    setLastSavedContent(initialMarkdown);
    setSaveState("idle");
    setStatusText("已关闭全部页签");
  }

  function resetTabDragState() {
    setDraggingTabId(null);
    setDragOverTabId(null);
    setDragOverTabPosition(null);
    pointerTabDragRef.current = null;
  }

  function resolveTabDropTarget(clientX: number, clientY: number) {
    const strip = documentTabsStripRef.current;
    if (!strip) {
      return null;
    }

    const tabElements = Array.from(
      strip.querySelectorAll<HTMLElement>("[data-tab-id]"),
    );

    for (const element of tabElements) {
      const tabId = element.dataset.tabId;
      if (!tabId) {
        continue;
      }

      const rect = element.getBoundingClientRect();
      const isWithinVerticalRange =
        clientY >= rect.top - 8 && clientY <= rect.bottom + 8;
      const isWithinHorizontalRange =
        clientX >= rect.left && clientX <= rect.right;

      if (!isWithinVerticalRange || !isWithinHorizontalRange) {
        continue;
      }

      return {
        tabId,
        position:
          clientX < rect.left + rect.width / 2 ? "before" : "after",
      } satisfies {
        tabId: string;
        position: TabDropPosition;
      };
    }

    const lastTab = tabElements[tabElements.length - 1];
    if (!lastTab) {
      return null;
    }

    const lastTabId = lastTab.dataset.tabId;
    const stripRect = strip.getBoundingClientRect();
    const lastRect = lastTab.getBoundingClientRect();
    if (
      lastTabId &&
      clientY >= stripRect.top - 8 &&
      clientY <= stripRect.bottom + 8 &&
      clientX > lastRect.right
    ) {
      return {
        tabId: lastTabId,
        position: "after",
      } satisfies {
        tabId: string;
        position: TabDropPosition;
      };
    }

    return null;
  }

  function handleTabPointerDown(
    event: ReactPointerEvent<HTMLElement>,
    tabId: string,
  ) {
    if (event.button !== 0) {
      return;
    }

    const target = event.target as HTMLElement | null;
    if (
      target?.closest(".document-tab-close") ||
      target?.closest(".inline-rename-shell")
    ) {
      return;
    }

    pointerTabDragRef.current = {
      draggedTabId: tabId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      started: false,
    };
    setDragOverTabId(null);
    setDragOverTabPosition(null);
  }

  async function refreshOpenFolder(rootPath?: string) {
    if (!openFolder && !rootPath) {
      return;
    }

    if (isDesktopApp) {
      const nextFolder = await readMarkdownFolder(rootPath ?? openFolder!.rootPath);
      setOpenFolder({
        ...nextFolder,
        source: "desktop",
        fileMap: null,
        bindings: null,
      });
      return nextFolder;
    }

    const directoryHandle = openFolder?.bindings?.directoryHandle;
    if (!directoryHandle) {
      return null;
    }

    const nextFolder = await createBrowserFolderHandleFromDirectory(directoryHandle);
    setOpenFolder(nextFolder);
    return nextFolder;
  }

  function closeFolderContextMenu() {
    setFolderContextMenu(null);
  }

  function closeTabContextMenu() {
    setTabContextMenu(null);
  }

  function closeRenameSession() {
    setRenameSession(null);
    setRenameValue("");
    isRenameSubmittingRef.current = false;
  }

  function openRenameSession(state: RenameDialogState) {
    closeFolderContextMenu();
    closeTabContextMenu();
    closeMenu();
    setRenameSession(state);
    setRenameValue(getMarkdownFileNameParts(state.initialName).stem);
  }

  function openTabContextMenu(
    event: ReactMouseEvent<HTMLElement>,
    tab: Pick<OpenDocumentTab, "id" | "name">,
  ) {
    event.preventDefault();
    event.stopPropagation();
    closeFolderContextMenu();
    closeMenu();
    resetTabDragState();
    setTabContextMenu({
      tabId: tab.id,
      name: tab.name,
      x: event.clientX,
      y: event.clientY,
    });
  }

  function openFolderContextMenu(
    event: ReactMouseEvent<HTMLElement>,
    payload: Omit<FolderContextMenuState, "x" | "y">,
  ) {
    event.preventDefault();
    event.stopPropagation();
    closeTabContextMenu();
    closeMenu();
    setFolderContextMenu({
      ...payload,
      x: event.clientX,
      y: event.clientY,
    });
  }

  async function createBrowserMarkdownFile(directoryPath: string) {
    const directoryHandle = openFolder?.bindings?.directoryMap[directoryPath];
    if (!directoryHandle) {
      throw new Error("missing-directory-handle");
    }

    let fileName = "untitled.md";
    for (let index = 2; ; index += 1) {
      try {
        await directoryHandle.getFileHandle(fileName, { create: false });
        fileName = `untitled-${index}.md`;
      } catch {
        break;
      }
    }

    const fileHandle = await directoryHandle.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write("");
    await writable.close();

    return {
      path: `${directoryPath}/${fileName}`,
      content: "",
    } satisfies DocumentHandle;
  }

  async function duplicateBrowserMarkdownFile(path: string) {
    const sourceHandle = openFolder?.bindings?.fileHandleMap[path];
    if (!sourceHandle) {
      throw new Error("missing-file-handle");
    }

    const lastSlash = path.lastIndexOf("/");
    const directoryPath = path.slice(0, lastSlash);
    const fileName = path.slice(lastSlash + 1);
    const sourceFile = await sourceHandle.getFile();
    const content = await sourceFile.text();
    const stem = fileName.replace(/\.[^.]+$/, "");
    const extension = fileName.slice(stem.length + 1) || "md";
    const directoryHandle = openFolder?.bindings?.directoryMap[directoryPath];

    if (!directoryHandle) {
      throw new Error("missing-directory-handle");
    }

    let nextName = `${stem}-copy.${extension}`;
    for (let index = 2; ; index += 1) {
      try {
        await directoryHandle.getFileHandle(nextName, { create: false });
        nextName = `${stem}-copy-${index}.${extension}`;
      } catch {
        break;
      }
    }

    const targetHandle = await directoryHandle.getFileHandle(nextName, { create: true });
    const writable = await targetHandle.createWritable();
    await writable.write(content);
    await writable.close();

    return {
      path: `${directoryPath}/${nextName}`,
      content,
    } satisfies DocumentHandle;
  }

  async function deleteBrowserMarkdownFile(path: string) {
    const lastSlash = path.lastIndexOf("/");
    const directoryPath = path.slice(0, lastSlash);
    const fileName = path.slice(lastSlash + 1);
    const directoryHandle = openFolder?.bindings?.directoryMap[directoryPath];

    if (!directoryHandle) {
      throw new Error("missing-directory-handle");
    }

    await directoryHandle.removeEntry(fileName);
  }

  async function renameBrowserMarkdownFile(path: string, nextName: string) {
    const sourceHandle = openFolder?.bindings?.fileHandleMap[path];
    if (!sourceHandle) {
      throw new Error("missing-file-handle");
    }

    const lastSlash = path.lastIndexOf("/");
    const directoryPath = path.slice(0, lastSlash);
    const currentName = path.slice(lastSlash + 1);
    const normalizedName = buildMarkdownFileNameFromStemInput(
      nextName,
      currentName,
    );
    const directoryHandle = openFolder?.bindings?.directoryMap[directoryPath];

    if (!directoryHandle) {
      throw new Error("missing-directory-handle");
    }

    if (normalizedName === currentName) {
      const sourceFile = await sourceHandle.getFile();
      return {
        path,
        content: await sourceFile.text(),
      } satisfies DocumentHandle;
    }

    try {
      await directoryHandle.getFileHandle(normalizedName, { create: false });
      throw new Error("目标文件已存在");
    } catch (error) {
      if (error instanceof Error && error.message === "目标文件已存在") {
        throw error;
      }
    }

    const sourceFile = await sourceHandle.getFile();
    const content = await sourceFile.text();
    const targetHandle = await directoryHandle.getFileHandle(normalizedName, {
      create: true,
    });
    const writable = await targetHandle.createWritable();
    await writable.write(content);
    await writable.close();
    await directoryHandle.removeEntry(currentName);

    return {
      path: `${directoryPath}/${normalizedName}`,
      content,
    } satisfies DocumentHandle;
  }

  function syncRenamedDocument(previousPath: string, renamedDocument: DocumentHandle) {
    const nextPath = renamedDocument.path;
    const nextName = getFileNameFromPath(nextPath);

    setOpenTabs((current) =>
      current.map((tab) =>
        isSameDocumentPath(tab.path, previousPath)
          ? {
              ...tab,
              path: nextPath,
              name: nextName,
              markdown: renamedDocument.content,
              lastSavedContent: renamedDocument.content,
              saveState: "saved",
            }
          : tab,
      ),
    );
    setRecentDocuments((current) =>
      renameRecentDocument(current, previousPath, nextPath),
    );

    if (isSameDocumentPath(currentPath, previousPath)) {
      setCurrentPath(nextPath);
      setMarkdown(renamedDocument.content);
      setLastSavedContent(renamedDocument.content);
      setSaveState("saved");
    }

    if (selectedFolderPath && isSameDocumentPath(selectedFolderPath, previousPath)) {
      setSelectedFolderPath(nextPath);
    }
  }

  async function applyDocument(
    result: DocumentHandle | null,
    options?: { mode?: "open-tab" | "reuse-active" },
  ) {
    if (!result) {
      setStatusText("操作已取消");
      setSaveState("idle");
      return;
    }

    const mode = options?.mode ?? "open-tab";
    const nextPath = result.path;
    const nextTabName = getFileNameFromPath(nextPath);
    const existingTab = openTabs.find((tab) =>
      isSameDocumentPath(tab.path, nextPath),
    );
    const currentActiveTab = openTabs.find((tab) => tab.id === activeTabId);
    let nextOpenTabs = openTabs;
    let nextActiveTabId = activeTabId;
    let nextMarkdown = result.content;
    let nextLastSavedContent = result.content;
    let nextSaveState: SaveState = "saved";
    let nextStatusText = "已打开文件";

    if (mode === "reuse-active" && currentActiveTab) {
      nextActiveTabId = currentActiveTab.id;
      nextOpenTabs = openTabs
        .filter(
          (tab) =>
            tab.id === currentActiveTab.id ||
            !isSameDocumentPath(tab.path, nextPath),
        )
        .map((tab) =>
          tab.id === currentActiveTab.id
            ? {
                ...tab,
                path: nextPath,
                name: nextTabName,
                markdown: result.content,
                lastSavedContent: result.content,
                saveState: "saved",
              }
            : tab,
        );
    } else if (existingTab) {
      nextActiveTabId = existingTab.id;
      nextMarkdown = existingTab.markdown;
      nextLastSavedContent = existingTab.lastSavedContent;
      nextSaveState = existingTab.saveState;
      nextStatusText = `已切换到 ${existingTab.name}`;
    } else {
      const nextTab: OpenDocumentTab = {
        id: createOpenDocumentTabId(),
        path: nextPath,
        name: nextTabName,
        markdown: result.content,
        lastSavedContent: result.content,
        saveState: "saved",
        editorState: null,
      };
      nextActiveTabId = nextTab.id;
      nextOpenTabs = [...openTabs, nextTab];
    }

    setOpenTabs(nextOpenTabs);
    setActiveTabId(nextActiveTabId);
    setMarkdown(nextMarkdown);
    setCurrentPath(nextPath);
    setLastSavedContent(nextLastSavedContent);
    setSaveState(nextSaveState);
    setStatusText(nextStatusText);
    setRecentDocuments((current) => rememberRecentDocument(current, nextPath));
  }

  async function handleOpen() {
    setStatusText("正在打开文件…");
    try {
      await applyDocument(await openDocument());
    } catch {
      setSaveState("error");
      setStatusText("打开文件失败");
    }
  }

  async function handleOpenFolder() {
    setStatusText("正在打开文件夹…");

    if (!isDesktopApp) {
      const directoryPicker = window.showDirectoryPicker;
      if (directoryPicker) {
        try {
          const directoryHandle = await directoryPicker();
          const folder = await createBrowserFolderHandleFromDirectory(directoryHandle);
          setOpenFolder(folder);
          setIsFolderPanelCollapsed(false);
          if (preferences.viewMode === "preview") {
            setViewMode("split");
          }
          setSaveState("idle");
          setStatusText(`已打开文件夹：${folder.rootName}`);
        } catch {
          setSaveState("idle");
          setStatusText("操作已取消");
        }
        return;
      }

      folderInputRef.current?.click();
      return;
    }

    try {
      const folder = await openMarkdownFolder();
      if (!folder) {
        setSaveState("idle");
        setStatusText("操作已取消");
        return;
      }

      setOpenFolder({
        ...folder,
        source: "desktop",
        fileMap: null,
        bindings: null,
      });
      setIsFolderPanelCollapsed(false);
      if (preferences.viewMode === "preview") {
        setViewMode("split");
      }
      setSaveState("idle");
      setStatusText(
        folder.nodes.length > 0
          ? `已打开文件夹：${folder.rootPath}，可在左侧双击 Markdown 文件`
          : `文件夹已打开，但没有 Markdown 文件：${folder.rootPath}`,
      );
    } catch {
      setSaveState("error");
      setStatusText("打开文件夹失败");
    }
  }

  async function handleOpenRecent(path: string) {
    setStatusText("正在打开最近文件…");
    try {
      await applyDocument(await openDocumentByPath(path));
    } catch {
      setSaveState("error");
      setStatusText("打开最近文件失败");
    }
  }

  function handleRemoveRecent(path: string) {
    setRecentDocuments((current) => removeRecentDocument(current, path));

    if (currentPath === path) {
      setStatusText("已从最近文件中移除当前文档记录");
      return;
    }

    setStatusText("已移除最近文件记录");
  }

  async function handleOpenFolderFile(path: string) {
    if (!openFolder) {
      return;
    }

    setStatusText("正在从文件夹打开文档…");

    try {
      if (openFolder.source === "desktop") {
        await applyDocument(await openDocumentByPath(path));
        return;
      }

      const fileHandle = openFolder.bindings?.fileHandleMap[path];
      if (fileHandle) {
        const file = await fileHandle.getFile();
        await applyDocument({
          path,
          content: await file.text(),
        });
        return;
      }

      const file = openFolder.fileMap?.[path];
      if (!file) {
        throw new Error("missing-file");
      }

      await applyDocument({
        path,
        content: await file.text(),
      });
    } catch {
      setSaveState("error");
      setStatusText("从文件夹打开文档失败");
    }
  }

  async function handleOpenDroppedMarkdownPath(path: string) {
    setStatusText("正在打开拖入文件…");

    try {
      await applyDocument(await openDocumentByPath(path));
    } catch {
      setSaveState("error");
      setStatusText("打开拖入文件失败");
    }
  }

  function markNativeDropHandled(path: string) {
    lastNativeDropRef.current = {
      key: normalizeDocumentPath(path) ?? path,
      handledAt: Date.now(),
    };
  }

  function wasNativeDropRecentlyHandled(file: File) {
    const droppedPath = getDroppedFilePath(file);
    const lastDrop = lastNativeDropRef.current;
    if (!lastDrop.handledAt || Date.now() - lastDrop.handledAt > 1200) {
      return false;
    }

    if (!droppedPath) {
      return true;
    }

    return lastDrop.key === (normalizeDocumentPath(droppedPath) ?? droppedPath);
  }

  async function handleOpenDroppedBrowserMarkdownFile(file: File) {
    setStatusText("正在读取拖入文件…");

    try {
      const content = await file.text();
      const nextTab: OpenDocumentTab = {
        id: createOpenDocumentTabId(),
        path: null,
        name: isMarkdownFileName(file.name) ? file.name : "untitled.md",
        markdown: content,
        lastSavedContent: content,
        saveState: "idle",
        editorState: null,
      };

      setOpenTabs((current) => [...current, nextTab]);
      setActiveTabId(nextTab.id);
      setMarkdown(content);
      setCurrentPath(null);
      setLastSavedContent(content);
      setSaveState("idle");
      setStatusText(`已载入拖入文件：${nextTab.name}`);
    } catch {
      setSaveState("error");
      setStatusText("读取拖入文件失败");
    }
  }

  function handleRevealCurrentFile() {
    if (!openFolder) {
      return;
    }

    if (!currentPath) {
      setStatusText("当前还没有打开本地文件");
      return;
    }

    if (!currentFolderTrail) {
      setStatusText("当前文件不在这个文件夹里");
      return;
    }

    setExpandedFolderPaths(new Set([openFolder.rootPath, ...currentFolderTrail]));
    setStatusText("已定位到当前文件所在目录");
    requestAnimationFrame(() => {
      activeFolderFileRef.current?.scrollIntoView({
        block: "nearest",
      });
    });
  }

  async function handleCreateFolderFile(directoryPath: string) {
    if (!openFolder) {
      return;
    }

    closeFolderContextMenu();
    setStatusText("正在创建 Markdown 文件…");

    try {
      const created = isDesktopApp
        ? await createMarkdownFile(directoryPath)
        : await createBrowserMarkdownFile(directoryPath);

      await refreshOpenFolder();
      await applyDocument(created);
      setStatusText(`已新建文件：${created.path}`);
    } catch {
      setSaveState("error");
      setStatusText("新建文件失败");
    }
  }

  async function handleDuplicateFolderFile(path: string) {
    if (!openFolder) {
      return;
    }

    closeFolderContextMenu();
    setStatusText("正在复制 Markdown 文件…");

    try {
      const duplicated = isDesktopApp
        ? await duplicateMarkdownFile(path)
        : await duplicateBrowserMarkdownFile(path);

      await refreshOpenFolder();
      setStatusText(`已复制文件：${duplicated.path}`);
    } catch {
      setSaveState("error");
      setStatusText("复制文件失败");
    }
  }

  async function handleDeleteFolderFile(path: string) {
    if (!openFolder) {
      return;
    }

    closeFolderContextMenu();
    setStatusText("正在删除 Markdown 文件…");

    try {
      if (isDesktopApp) {
        await deleteMarkdownFile(path);
      } else {
        await deleteBrowserMarkdownFile(path);
      }

      await refreshOpenFolder();

      if (currentPath === path && activeTabId) {
        handleCloseTab(activeTabId);
      }

      setSaveState("idle");
      setStatusText("文件已删除");
    } catch {
      setSaveState("error");
      setStatusText("删除文件失败");
    }
  }

  useEffect(() => {
    if (!renameSession) {
      return;
    }

    const timer = window.setTimeout(() => {
      inlineRenameInputRef.current?.focus();
      inlineRenameInputRef.current?.select();
    }, 0);

    return () => window.clearTimeout(timer);
  }, [renameSession]);

  useEffect(() => {
    if (!renameSession) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }

      if (inlineRenameShellRef.current?.contains(target)) {
        return;
      }

      void handleRenameDocument();
    }

    window.addEventListener("pointerdown", handlePointerDown, true);
    return () => window.removeEventListener("pointerdown", handlePointerDown, true);
  }, [renameSession, renameValue]);

  useEffect(() => {
    function handlePointerMove(event: PointerEvent) {
      const dragState = pointerTabDragRef.current;
      if (!dragState || event.pointerId !== dragState.pointerId) {
        return;
      }

      const movedEnough =
        Math.abs(event.clientX - dragState.startX) > 6 ||
        Math.abs(event.clientY - dragState.startY) > 6;

      if (!dragState.started) {
        if (!movedEnough) {
          return;
        }

        dragState.started = true;
        setDraggingTabId(dragState.draggedTabId);
      }

      const dropTarget = resolveTabDropTarget(event.clientX, event.clientY);
      if (!dropTarget || dropTarget.tabId === dragState.draggedTabId) {
        if (dragOverTabId !== null) {
          setDragOverTabId(null);
          setDragOverTabPosition(null);
        }
        return;
      }

      if (dragOverTabId !== dropTarget.tabId) {
        setDragOverTabId(dropTarget.tabId);
      }
      if (dragOverTabPosition !== dropTarget.position) {
        setDragOverTabPosition(dropTarget.position);
      }
    }

    function handlePointerUp(event: PointerEvent) {
      const dragState = pointerTabDragRef.current;
      if (!dragState || event.pointerId !== dragState.pointerId) {
        return;
      }

      if (
        dragState.started &&
        dragOverTabId &&
        dragOverTabPosition &&
        dragOverTabId !== dragState.draggedTabId
      ) {
        setOpenTabs((current) =>
          reorderOpenDocumentTabs(
            current,
            dragState.draggedTabId,
            dragOverTabId,
            dragOverTabPosition,
          ),
        );
        suppressTabClickRef.current = true;
      }

      resetTabDragState();
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [dragOverTabId, dragOverTabPosition]);

  async function handleRenameDocument() {
    if (!renameSession) {
      return;
    }

    if (isRenameSubmittingRef.current) {
      return;
    }

    isRenameSubmittingRef.current = true;

    const targetName = renameValue.trim();
    if (!targetName) {
      setSaveState("error");
      setStatusText("文件名不能为空");
      isRenameSubmittingRef.current = false;
      window.setTimeout(() => inlineRenameInputRef.current?.focus(), 0);
      return;
    }

    const { path, tabId, initialName } = renameSession;
    let normalizedName: string;

    try {
      normalizedName = buildMarkdownFileNameFromStemInput(targetName, initialName);
    } catch (error) {
      setSaveState("error");
      setStatusText(error instanceof Error ? error.message : "重命名失败");
      isRenameSubmittingRef.current = false;
      window.setTimeout(() => inlineRenameInputRef.current?.focus(), 0);
      return;
    }

    if (normalizedName === initialName) {
      closeRenameSession();
      return;
    }

    if (!path) {
      try {
        setOpenTabs((current) =>
          current.map((tab) =>
            tab.id === tabId ? { ...tab, name: normalizedName } : tab,
          ),
        );
        if (activeTabId === tabId) {
          setStatusText(`已更新标签名：${normalizedName}`);
        }
        closeRenameSession();
      } catch (error) {
        setSaveState("error");
        setStatusText(
          error instanceof Error ? error.message : "重命名失败",
        );
        isRenameSubmittingRef.current = false;
        window.setTimeout(() => inlineRenameInputRef.current?.focus(), 0);
      }
      return;
    }

    setStatusText("正在重命名文件…");

    try {
      const renamed = isDesktopApp
        ? await renameMarkdownFile(path, normalizedName)
        : await renameBrowserMarkdownFile(path, normalizedName);

      syncRenamedDocument(path, renamed);
      await refreshOpenFolder();
      setSaveState("saved");
      setStatusText(`已重命名为 ${getFileNameFromPath(renamed.path)}`);
      closeRenameSession();
    } catch (error) {
      setSaveState("error");
      setStatusText(
        error instanceof Error ? error.message : "重命名文件失败",
      );
      isRenameSubmittingRef.current = false;
      window.setTimeout(() => inlineRenameInputRef.current?.focus(), 0);
    }
  }

  function cancelRenameDocument() {
    closeRenameSession();
  }

  async function handleSave() {
    const { currentPath: path, markdown: nextMarkdown } = latestStateRef.current;

    setSaveState("saving");
    setStatusText("正在保存…");

    try {
      await applyDocument(await saveDocument(path, nextMarkdown), {
        mode: "reuse-active",
      });
    } catch {
      setSaveState("error");
      setStatusText("保存失败");
    }
  }

  async function handleSaveAs() {
    const { currentFileName: fileName, markdown: nextMarkdown } = latestStateRef.current;

    setSaveState("saving");
    setStatusText("正在另存为…");

    try {
      await applyDocument(await saveDocumentAs(nextMarkdown, fileName), {
        mode: "reuse-active",
      });
    } catch {
      setSaveState("error");
      setStatusText("另存为失败");
    }
  }

  function handleNewDocument() {
    const nextTab = createEmptyDocumentTab();
    setOpenTabs((current) => [...current, nextTab]);
    setActiveTabId(nextTab.id);
    setMarkdown(nextTab.markdown);
    setCurrentPath(nextTab.path);
    setLastSavedContent(nextTab.lastSavedContent);
    setSaveState(nextTab.saveState);
    setStatusText("已创建新文档");
  }

  function handleFormat(action: FormatAction) {
    editorRef.current?.applyFormat(action);
    editorRef.current?.focus();
  }

  function handleEditorStateChange(nextState: MarkdownEditorStateSnapshot) {
    if (!activeTabId) {
      return;
    }

    setOpenTabs((current) =>
      current.map((tab) =>
        tab.id === activeTabId ? { ...tab, editorState: nextState } : tab,
      ),
    );
  }

  async function handleImportImageFile(file: File) {
    const { currentPath: path } = latestStateRef.current;

    if (!path) {
      setSaveState("error");
      setStatusText("请先保存文档，再插入图片");
      return;
    }

    setStatusText("正在导入图片…");

    try {
      const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
      const imported = await importImageAsset(
        path,
        file.name || null,
        file.type || null,
        bytes,
      );

      const altText = file.name ? file.name.replace(/\.[^.]+$/, "") : "image";

      editorRef.current?.insertText(`![${altText}](${imported.markdownPath})`);
      setStatusText(`图片已导入：${imported.markdownPath}`);
      setSaveState("idle");
    } catch {
      setSaveState("error");
      setStatusText("图片导入失败");
    }
  }

  async function handleExportHtml() {
    const { markdown: nextMarkdown, currentFileName: fileName } = latestStateRef.current;

    setStatusText("正在导出 HTML…");

    try {
      const bodyHtml = await renderMarkdown(nextMarkdown);
      const fullHtml = buildExportHtmlDocument(fileName, bodyHtml);
      const savedPath = await exportHtmlDocument(
        createExportName(fileName, "html"),
        fullHtml,
      );

      setStatusText(savedPath ? `HTML 已导出：${savedPath}` : "导出已取消");
    } catch {
      setSaveState("error");
      setStatusText("导出 HTML 失败");
    }
  }

  async function handleExportPdf() {
    const { markdown: nextMarkdown, currentFileName: fileName } = latestStateRef.current;

    setStatusText("正在打开打印对话框…");
    try {
      const bodyHtml = await renderMarkdown(nextMarkdown);
      const fullHtml = buildExportHtmlDocument(fileName, bodyHtml);
      const printWindow = window.open("", "_blank", "width=960,height=720");
      if (!printWindow) {
        setSaveState("error");
        setStatusText("无法打开打印窗口");
        return;
      }

      printWindow.document.write(fullHtml);
      printWindow.document.close();
      printWindow.focus();
      printWindow.print();
      setStatusText("请在打印对话框中选择“另存为 PDF”");
    } catch {
      setSaveState("error");
      setStatusText("导出 PDF 失败");
    }
  }

  function handleInsertImage() {
    imageInputRef.current?.click();
  }

  function handleInsertMenuAction(action: InsertMenuAction) {
    if (action === "image") {
      handleInsertImage();
      return;
    }

    handleFormat(action);
  }

  function setViewMode(viewMode: ViewMode) {
    updatePreferences({ viewMode });
  }

  function openPreferences() {
    setShowPreferences(true);
    closeMenu();
  }

  function openRecentDocumentsDialog() {
    setShowRecentDocuments(true);
    closeMenu();
  }

  function handleExternalLinkIntent(url: string) {
    setPendingExternalLink(url);
    setShowBrowserChoiceDialog(false);
    setBrowserChoices([]);
    setIsLoadingBrowserChoices(false);
  }

  async function handleConfirmExternalLinkOpen() {
    if (!pendingExternalLink) {
      return;
    }

    if (!isDesktopApp) {
      window.open(pendingExternalLink, "_blank", "noopener,noreferrer");
      setStatusText(`已在浏览器中打开链接：${getExternalLinkHostLabel(pendingExternalLink)}`);
      closeExternalLinkDialogs();
      return;
    }

    setIsLoadingBrowserChoices(true);
    try {
      const browsers = await listInstalledBrowsers();
      setBrowserChoices(browsers);
      setShowBrowserChoiceDialog(true);
    } catch {
      setSaveState("error");
      setStatusText("读取浏览器列表失败");
      closeExternalLinkDialogs();
    } finally {
      setIsLoadingBrowserChoices(false);
    }
  }

  async function handleOpenExternalLinkWithBrowser(browser: InstalledBrowserOption) {
    if (!pendingExternalLink) {
      return;
    }

    try {
      await openExternalLinkInBrowser(pendingExternalLink, browser.id);
      setStatusText(`已使用 ${browser.name} 打开链接`);
      closeExternalLinkDialogs();
    } catch {
      setSaveState("error");
      setStatusText(`使用 ${browser.name} 打开链接失败`);
    }
  }

  async function handleFolderInputChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    const folder = createBrowserFolderHandleFromFiles(files);
    event.target.value = "";

    if (!folder) {
      setOpenFolder(null);
      setSaveState("idle");
      setStatusText("选中的文件夹里没有 Markdown 文件");
      return;
    }

    setOpenFolder(folder);
    setIsFolderPanelCollapsed(false);
    if (preferences.viewMode === "preview") {
      setViewMode("split");
    }
    setSaveState("idle");
    setStatusText(`已打开文件夹：${folder.rootName}，可在左侧双击 Markdown 文件`);
  }

  function toggleMenu(menu: MenuKey) {
    setActiveMenu((current) => (current === menu ? null : menu));
  }

  function closeMenu() {
    setActiveMenu(null);
  }

  function formatDesktopWindowError(error: unknown, fallback: string) {
    if (error instanceof Error && error.message) {
      return `${fallback}：${error.message}`;
    }

    if (typeof error === "string" && error) {
      return `${fallback}：${error}`;
    }

    return fallback;
  }

  function triggerDesktopWindowAnimation(kind: Exclude<DesktopWindowAnimationKind, null>) {
    if (desktopWindowAnimationTimerRef.current !== null) {
      window.clearTimeout(desktopWindowAnimationTimerRef.current);
    }

    setIsDesktopWindowAnimating(true);
    setDesktopWindowAnimationKind(kind);
    desktopWindowAnimationTimerRef.current = window.setTimeout(() => {
      setIsDesktopWindowAnimating(false);
      setDesktopWindowAnimationKind(null);
      desktopWindowAnimationTimerRef.current = null;
    }, 280);
  }

  async function handleDesktopWindowMinimize() {
    try {
      await desktopWindow?.minimize();
    } catch (error) {
      setStatusText(formatDesktopWindowError(error, "窗口最小化失败"));
    }
  }

  async function handleDesktopWindowToggleMaximize() {
    try {
      triggerDesktopWindowAnimation(
        isDesktopWindowMaximized ? "restore" : "maximize",
      );
      await desktopWindow?.toggleMaximize();
      const maximized = await desktopWindow?.isMaximized();
      setIsDesktopWindowMaximized(Boolean(maximized));
    } catch (error) {
      setStatusText(formatDesktopWindowError(error, "窗口缩放失败"));
    }
  }

  async function handleDesktopWindowClose() {
    try {
      await desktopWindow?.close();
    } catch (error) {
      setStatusText(formatDesktopWindowError(error, "窗口关闭失败"));
    }
  }

  useEffect(() => {
    return () => {
      if (desktopWindowAnimationTimerRef.current !== null) {
        window.clearTimeout(desktopWindowAnimationTimerRef.current);
      }
      if (autosaveTimerRef.current !== null) {
        window.clearTimeout(autosaveTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    persistRecentDocuments(recentDocuments);
  }, [recentDocuments]);

  useEffect(() => {
    if (!isDesktopApp) {
      setIsSessionReady(true);
      return;
    }

    let active = true;

    async function restoreSession() {
      const { currentPath: storedPath, openFolderRootPath } = initialSession;

      try {
        if (openFolderRootPath) {
          const restoredFolder = await readMarkdownFolder(openFolderRootPath);
          if (active) {
            setOpenFolder({
              ...restoredFolder,
              source: "desktop",
              fileMap: null,
              bindings: null,
            });
          }
        }

        if (storedPath) {
          const restoredDocument = await openDocumentByPath(storedPath);
          if (active) {
            await applyDocument(restoredDocument);
            setStatusText("已恢复上次会话");
          }
        }
      } catch {
        if (active) {
          setStatusText("准备就绪");
        }
      } finally {
        if (active) {
          setIsSessionReady(true);
        }
      }
    }

    void restoreSession();

    return () => {
      active = false;
    };
  }, [initialSession, isDesktopApp]);

  useEffect(() => {
    if (!isSessionReady || typeof window === "undefined") {
      return;
    }

    const nextSession: AppSessionState = {
      currentPath,
      openFolderRootPath: openFolder?.rootPath ?? null,
      folderPanelCollapsed: isFolderPanelCollapsed,
    };

    window.localStorage.setItem(APP_SESSION_STORAGE_KEY, JSON.stringify(nextSession));
  }, [currentPath, isFolderPanelCollapsed, isSessionReady, openFolder]);

  useEffect(() => {
    if (!openFolder) {
      setExpandedFolderPaths(new Set());
      setSelectedFolderPath(null);
      return;
    }

    setExpandedFolderPaths(new Set([openFolder.rootPath]));
  }, [openFolder]);

  useEffect(() => {
    if (currentPath) {
      setSelectedFolderPath(currentPath);
    }
  }, [currentPath]);

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (!menuBarRef.current?.contains(event.target as Node)) {
        closeMenu();
      }
    }

    window.addEventListener("mousedown", handlePointerDown);
    return () => window.removeEventListener("mousedown", handlePointerDown);
  }, []);

  useEffect(() => {
    if (!isDesktopApp) {
      return;
    }

    let active = true;

    async function syncWindowState() {
      try {
        const maximized = await desktopWindow?.isMaximized();
        if (active) {
          setIsDesktopWindowMaximized(Boolean(maximized));
        }
      } catch {
        if (active) {
          setIsDesktopWindowMaximized(false);
        }
      }
    }

    void syncWindowState();

    const unlistenPromise = desktopWindow?.onResized(async () => {
      await syncWindowState();
    });

    return () => {
      active = false;
      void unlistenPromise?.then((unlisten) => unlisten());
    };
  }, [desktopWindow, isDesktopApp]);

  useEffect(() => {
    if (!isDesktopApp || (!desktopWindow && !desktopWebview)) {
      return;
    }

    const handleDragDropEvent = (event: { payload: DragDropEvent }) => {
      if (event.payload.type !== "drop") {
        return;
      }

      const markdownPath = event.payload.paths.find((path) =>
        isMarkdownFileName(path),
      );
      if (!markdownPath) {
        return;
      }

      const normalizedPath = normalizeDocumentPath(markdownPath) ?? markdownPath;
      const lastDrop = lastNativeDropRef.current;
      if (
        lastDrop.key === normalizedPath &&
        Date.now() - lastDrop.handledAt < 1200
      ) {
        return;
      }

      markNativeDropHandled(markdownPath);
      void handleOpenDroppedMarkdownPath(markdownPath);
    };

    const unlistenPromises = [
      desktopWindow?.onDragDropEvent(handleDragDropEvent),
      desktopWebview?.onDragDropEvent(handleDragDropEvent),
    ].filter(
      (promise): promise is Promise<() => void> => promise !== undefined,
    );

    return () => {
      void Promise.all(unlistenPromises).then((unlisteners) => {
        for (const unlisten of unlisteners) {
          unlisten();
        }
      });
    };
  }, [activeTabId, desktopWebview, desktopWindow, isDesktopApp, openTabs]);

  useEffect(() => {
    if (!folderContextMenu) {
      return;
    }

    function handlePointerDown(event: MouseEvent) {
      if (!folderContextMenuRef.current?.contains(event.target as Node)) {
        closeFolderContextMenu();
      }
    }

    function handleWindowScroll() {
      closeFolderContextMenu();
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        closeFolderContextMenu();
      }
    }

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("scroll", handleWindowScroll, true);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("scroll", handleWindowScroll, true);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [folderContextMenu]);

  useEffect(() => {
    if (!tabContextMenu) {
      return;
    }

    function handlePointerDown(event: MouseEvent) {
      if (!tabContextMenuRef.current?.contains(event.target as Node)) {
        closeTabContextMenu();
      }
    }

    function handleWindowScroll() {
      closeTabContextMenu();
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        closeTabContextMenu();
      }
    }

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("scroll", handleWindowScroll, true);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("scroll", handleWindowScroll, true);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [tabContextMenu]);

  useEffect(() => {
    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }

    if (!preferences.autosaveEnabled || !isDirty) {
      autosaveUnsavedHintRef.current = false;
      return;
    }

    if (!currentPath) {
      if (!autosaveUnsavedHintRef.current) {
        autosaveUnsavedHintRef.current = true;
        setStatusText("自动保存需要先手动保存一次文档");
      }
      return;
    }

    autosaveUnsavedHintRef.current = false;

    autosaveTimerRef.current = window.setTimeout(async () => {
      const { currentPath: path, markdown: nextMarkdown } = latestStateRef.current;
      if (!path) {
        return;
      }

      setSaveState("saving");
      setStatusText("自动保存中…");

      try {
        const result = await saveDocument(path, nextMarkdown);
        if (result) {
          setCurrentPath(result.path);
          setLastSavedContent(result.content);
          setSaveState("saved");
          setStatusText(`已自动保存：${result.path}`);
          setRecentDocuments((current) => rememberRecentDocument(current, result.path));
        }
      } catch {
        setSaveState("error");
        setStatusText("自动保存失败");
      } finally {
        autosaveTimerRef.current = null;
      }
    }, 1000);

    return () => {
      if (autosaveTimerRef.current !== null) {
        window.clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = null;
      }
    };
  }, [currentPath, isDirty, markdown, preferences.autosaveEnabled]);

  useEffect(() => {
    if (
      !showPreferences &&
      !showRecentDocuments &&
      !pendingExternalLink &&
      !showBrowserChoiceDialog
    ) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setShowPreferences(false);
        setShowRecentDocuments(false);
        closeExternalLinkDialogs();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [pendingExternalLink, showBrowserChoiceDialog, showPreferences, showRecentDocuments]);

  useEffect(() => {
    const input = folderInputRef.current;
    if (!input) {
      return;
    }

    input.setAttribute("webkitdirectory", "");
    input.setAttribute("directory", "");
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey)) {
        return;
      }

      const key = event.key.toLowerCase();

      if (key === "tab") {
        event.preventDefault();
        cycleTabs(event.shiftKey ? "previous" : "next");
        return;
      }

      if (key === "w") {
        if (!activeTabId) {
          return;
        }

        event.preventDefault();
        handleCloseTab(activeTabId);
        return;
      }

      if (key === "o" && event.shiftKey) {
        event.preventDefault();
        void handleOpenFolder();
        return;
      }

      if (key === "s" && event.shiftKey) {
        event.preventDefault();
        void handleSaveAs();
        return;
      }

      if (key === "s") {
        event.preventDefault();
        void handleSave();
        return;
      }

      if (key === "o") {
        event.preventDefault();
        void handleOpen();
        return;
      }

      if (key === "n") {
        event.preventDefault();
        handleNewDocument();
        return;
      }

      if (key === "1") {
        event.preventDefault();
        handleFormat("heading");
        return;
      }

      if (key === "e") {
        event.preventDefault();
        handleFormat("code");
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeTabId, cycleTabs, handleCloseTab]);

  useEffect(() => {
    async function handlePaste(event: ClipboardEvent) {
      const items = Array.from(event.clipboardData?.items ?? []);
      const imageItem = items.find((item) => item.type.startsWith("image/"));
      if (!imageItem) {
        return;
      }

      const file = imageItem.getAsFile();
      if (!file) {
        return;
      }

      event.preventDefault();
      await handleImportImageFile(file);
    }

    async function handleDrop(event: DragEvent) {
      const files = Array.from(event.dataTransfer?.files ?? []);
      const markdownFile = files.find((file) => isMarkdownFileName(file.name));
      if (markdownFile) {
        event.preventDefault();

        const droppedPath = getDroppedFilePath(markdownFile);
        if (isDesktopApp && wasNativeDropRecentlyHandled(markdownFile)) {
          return;
        }

        if (isDesktopApp && droppedPath) {
          markNativeDropHandled(droppedPath);
          await handleOpenDroppedMarkdownPath(droppedPath);
          return;
        }

        await handleOpenDroppedBrowserMarkdownFile(markdownFile);
        return;
      }

      const imageFile = files.find((file) => file.type.startsWith("image/"));
      if (!imageFile) {
        return;
      }

      event.preventDefault();
      await handleImportImageFile(imageFile);
    }

    function handleDragOver(event: DragEvent) {
      const files = Array.from(event.dataTransfer?.files ?? []);
      const types = Array.from(event.dataTransfer?.types ?? []);
      if (
        types.includes("Files") ||
        files.some(
          (file) => file.type.startsWith("image/") || isMarkdownFileName(file.name),
        )
      ) {
        event.preventDefault();
      }
    }

    window.addEventListener("paste", handlePaste);
    window.addEventListener("drop", handleDrop);
    window.addEventListener("dragover", handleDragOver);
    return () => {
      window.removeEventListener("paste", handlePaste);
      window.removeEventListener("drop", handleDrop);
      window.removeEventListener("dragover", handleDragOver);
    };
  }, [activeTabId, currentPath, isDesktopApp, openTabs]);

  function renderFolderNodes(nodes: MarkdownFolderNode[]) {
    return nodes.map((node) => {
      if (node.kind === "directory") {
        const isExpanded = expandedFolderPaths.has(node.path);
        const isCurrentTrail = currentFolderTrailSet.has(node.path);
        return (
          <div key={node.path} className="folder-tree-branch">
            <button
              type="button"
              className={`folder-tree-directory folder-tree-toggle ${isExpanded ? "folder-tree-toggle-expanded" : ""} ${isCurrentTrail ? "folder-tree-directory-current" : ""}`}
              title={node.path}
              onContextMenu={(event) =>
                openFolderContextMenu(event, {
                  path: node.path,
                  kind: "directory",
                  name: node.name,
                })}
              onClick={() => {
                setExpandedFolderPaths((current) => {
                  const next = new Set(current);
                  if (next.has(node.path)) {
                    next.delete(node.path);
                  } else {
                    next.add(node.path);
                  }
                  return next;
                });
              }}
            >
              <span className="folder-tree-icon" aria-hidden="true">&gt;</span>
              <span
                className="folder-tree-entry-icon folder-tree-entry-icon-folder"
                aria-hidden="true"
              />
              <span className="folder-tree-entry-label">{node.name}</span>
            </button>
            {isExpanded && node.children.length > 0
              ? (
                  <div className="folder-tree-children">
                    {renderFolderNodes(node.children)}
                  </div>
                )
              : null}
          </div>
        );
      }

      return (
        <button
          key={node.path}
          type="button"
          ref={node.path === currentPath ? activeFolderFileRef : null}
          className={`folder-tree-file ${node.path === selectedFolderPath ? "folder-tree-file-selected" : ""} ${node.path === currentPath ? "folder-tree-file-active" : ""}`}
          title={node.path}
          onContextMenu={(event) =>
            openFolderContextMenu(event, {
              path: node.path,
              kind: "file",
              name: node.name,
            })}
          onClick={() => setSelectedFolderPath(node.path)}
          onDoubleClick={() => void handleOpenFolderFile(node.path)}
        >
          <span
            className="folder-tree-entry-icon folder-tree-entry-icon-file"
            aria-hidden="true"
          />
          {renameSession?.source === "folder-tree" &&
          isSameDocumentPath(renameSession.path, node.path) ? (
            <span
              ref={inlineRenameShellRef}
              className="inline-rename-shell folder-tree-rename-shell"
            >
              <input
                ref={inlineRenameInputRef}
                className="inline-rename-input folder-tree-rename-input"
                value={renameValue}
                onChange={(event) => setRenameValue(event.target.value)}
                onClick={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
                onBlur={() => void handleRenameDocument()}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void handleRenameDocument();
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    cancelRenameDocument();
                  }
                }}
              />
              <span className="inline-rename-extension" aria-hidden="true">
                {getMarkdownFileNameParts(node.name).extension}
              </span>
            </span>
          ) : (
            <span className="folder-tree-file-name">{node.name}</span>
          )}
        </button>
      );
    });
  }

  const menuBarContent = (
    <div ref={menuBarRef} className={`menu-bar ${isDesktopApp ? "menu-bar-desktop" : ""}`}>
      <div className="menu-wrap">
        <button
          className={`toolbar-button menu-text-button ${activeMenu === "file" ? "toolbar-button-active" : ""}`}
          type="button"
          onClick={() => toggleMenu("file")}
        >
          <span className="menu-text-button-label">文件</span>
        </button>
        {activeMenu === "file" ? (
          <div className="menu-dropdown menu-dropdown-file">
            <button
              className="menu-item"
              onClick={() => {
                handleNewDocument();
                closeMenu();
              }}
            >
              新建
            </button>
            <button
              className="menu-item"
              onClick={() => {
                void handleOpen();
                closeMenu();
              }}
            >
              打开
            </button>
            <button
              className="menu-item"
              onClick={() => {
                void handleOpenFolder();
                closeMenu();
              }}
            >
              打开文件夹
            </button>
            <button
              className="menu-item"
              onClick={() => {
                void handleSave();
                closeMenu();
              }}
            >
              保存
            </button>
            <button
              className="menu-item"
              onClick={() => {
                void handleSaveAs();
                closeMenu();
              }}
            >
              另存为
            </button>
            <button
              className="menu-item"
              onClick={() => {
                openRecentDocumentsDialog();
              }}
            >
              最近文件
            </button>
            <div className="menu-section-label">导出</div>
            <button
              className="menu-item"
              onClick={() => {
                void handleExportHtml();
                closeMenu();
              }}
            >
              导出 HTML
            </button>
            <button
              className="menu-item"
              onClick={() => {
                void handleExportPdf();
                closeMenu();
              }}
            >
              导出 PDF
            </button>
          </div>
        ) : null}
      </div>

      <div className="menu-wrap">
        <button
          className={`toolbar-button menu-text-button ${activeMenu === "view" ? "toolbar-button-active" : ""}`}
          type="button"
          onClick={() => toggleMenu("view")}
        >
          <span className="menu-text-button-label">视图</span>
        </button>
        {activeMenu === "view" ? (
          <div className="menu-dropdown">
            <button
              className="menu-item"
              onClick={() => {
                setViewMode("split");
                closeMenu();
              }}
            >
              双栏
            </button>
            <button
              className="menu-item"
              onClick={() => {
                setViewMode("editor");
                closeMenu();
              }}
            >
              仅编辑
            </button>
            <button
              className="menu-item"
              onClick={() => {
                setViewMode("preview");
                closeMenu();
              }}
            >
              仅预览
            </button>
          </div>
        ) : null}
      </div>

      <div className="menu-wrap">
        <button
          className={`toolbar-button menu-text-button ${activeMenu === "insert" ? "toolbar-button-active" : ""}`}
          type="button"
          onClick={() => toggleMenu("insert")}
        >
          <span className="menu-text-button-label">插入</span>
        </button>
        {activeMenu === "insert" ? (
          <div className="menu-dropdown menu-dropdown-insert">
            {insertMenuGroups.map((group) => (
              <div key={group.title} className="menu-drawer">
                <button
                  type="button"
                  className="menu-item menu-item-drawer"
                  title={group.title}
                  aria-label={group.title}
                >
                  <span className="menu-item-label">{group.title}</span>
                  <span className="menu-item-drawer-arrow" aria-hidden="true" />
                </button>
                <div className="menu-drawer-panel">
                  <div className="menu-drawer-panel-label">{group.title}</div>
                  {group.items.map((item) => (
                    <button
                      key={`${group.title}-${item.action}`}
                      type="button"
                      className="menu-drawer-option"
                      onClick={() => {
                        handleInsertMenuAction(item.action);
                        closeMenu();
                      }}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <button
        className={`toolbar-button menu-text-button ${showPreferences ? "toolbar-button-active" : ""}`}
        type="button"
        onClick={() => openPreferences()}
      >
        <span className="menu-text-button-label">设置</span>
      </button>
    </div>
  );

  const documentTabsContent =
    openTabs.length > 0 ? (
      <div className="document-tabs-shell">
        <div ref={documentTabsStripRef} className="document-tabs-strip">
          {openTabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            const isTabDirty = isActive
              ? isDirty
              : tab.markdown !== tab.lastSavedContent;
            const tabTitle = tab.path ?? "未保存到本地";

            return (
              <div
                key={tab.id}
                role="button"
                tabIndex={0}
                data-tab-id={tab.id}
                className={`document-tab ${isActive ? "document-tab-active" : ""} ${isTabDirty ? "document-tab-dirty" : ""} ${draggingTabId === tab.id ? "document-tab-dragging" : ""} ${dragOverTabId === tab.id && dragOverTabPosition === "before" ? "document-tab-drop-before" : ""} ${dragOverTabId === tab.id && dragOverTabPosition === "after" ? "document-tab-drop-after" : ""}`}
                title={tabTitle}
                onClick={() => {
                  if (suppressTabClickRef.current) {
                    suppressTabClickRef.current = false;
                    return;
                  }
                  switchToTab(tab.id);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    switchToTab(tab.id);
                  }
                }}
                onDoubleClick={() =>
                  openRenameSession({
                    source: "tab",
                    tabId: tab.id,
                    path: tab.path,
                    initialName: tab.name,
                  })
                }
                onContextMenu={(event) => openTabContextMenu(event, tab)}
                onPointerDown={(event) => handleTabPointerDown(event, tab.id)}
                onMouseDown={(event) => {
                  if (event.button === 1) {
                    event.preventDefault();
                    handleCloseTab(tab.id);
                  }
                }}
              >
                <span className="document-tab-file">
                  {isTabDirty ? (
                    <span
                      className="document-tab-inline-dirty-dot"
                      aria-label="未保存"
                      title="未保存"
                    >
                      ●
                    </span>
                  ) : null}
                  {renameSession?.source === "tab" && renameSession.tabId === tab.id ? (
                    <span
                      ref={inlineRenameShellRef}
                      className="inline-rename-shell document-tab-rename-shell"
                    >
                      <input
                        ref={inlineRenameInputRef}
                        className="inline-rename-input document-tab-rename-input"
                        value={renameValue}
                        onChange={(event) => setRenameValue(event.target.value)}
                        onClick={(event) => event.stopPropagation()}
                        onDoubleClick={(event) => event.stopPropagation()}
                        onBlur={() => void handleRenameDocument()}
                        onKeyDown={(event) => {
                          event.stopPropagation();
                          if (event.key === "Enter") {
                            event.preventDefault();
                            void handleRenameDocument();
                          }
                          if (event.key === "Escape") {
                            event.preventDefault();
                            cancelRenameDocument();
                          }
                        }}
                      />
                      <span className="inline-rename-extension" aria-hidden="true">
                        {getMarkdownFileNameParts(tab.name).extension}
                      </span>
                    </span>
                  ) : (
                    <span className="document-tab-file-label">{tab.name}</span>
                  )}
                  {isTabDirty ? (
                    <span className="document-tab-dirty-badge">未保存</span>
                  ) : null}
                </span>
                <span className="document-tab-meta">
                  {isTabDirty ? (
                    <span
                      className="document-tab-dirty-dot"
                      aria-label="未保存"
                      title="未保存"
                    >
                      ●
                    </span>
                  ) : null}
                  <span
                    className="document-tab-close"
                    aria-hidden="true"
                    onClick={(event) => {
                      event.stopPropagation();
                      handleCloseTab(tab.id);
                    }}
                  >
                    ×
                  </span>
                </span>
              </div>
            );
          })}
        </div>
      </div>
    ) : null;

  const viewModeShortcutBar = (
    <div className="view-mode-shortcuts">
      <button
        type="button"
        className={`view-mode-shortcut ${preferences.viewMode === "editor" ? "view-mode-shortcut-active" : ""}`}
        onClick={() => setViewMode("editor")}
        title="仅编辑"
        aria-label="仅编辑"
      >
        <span className="view-mode-shortcut-icon view-mode-shortcut-icon-editor" aria-hidden="true" />
      </button>
      <button
        type="button"
        className={`view-mode-shortcut ${preferences.viewMode === "preview" ? "view-mode-shortcut-active" : ""}`}
        onClick={() => setViewMode("preview")}
        title="仅预览"
        aria-label="仅预览"
      >
        <span className="view-mode-shortcut-icon view-mode-shortcut-icon-preview" aria-hidden="true" />
      </button>
      <button
        type="button"
        className={`view-mode-shortcut ${preferences.viewMode === "split" ? "view-mode-shortcut-active" : ""}`}
        onClick={() => setViewMode("split")}
        title="双栏"
        aria-label="双栏"
      >
        <span className="view-mode-shortcut-icon view-mode-shortcut-icon-split" aria-hidden="true" />
      </button>
    </div>
  );

  const documentTabsBarContent =
    openTabs.length > 0 ? (
      <section className="document-tabs-bar">
        <div className="document-tabs-bar-shell">
          {documentTabsContent}
          <div className="document-tabs-bar-actions">{viewModeShortcutBar}</div>
        </div>
      </section>
    ) : null;

  return (
    <main
      className="shell"
      style={shellStyle}
      data-theme={preferences.theme}
      data-shell-mode={isDesktopApp ? "desktop" : "browser"}
      data-window-maximized={isDesktopWindowMaximized ? "true" : "false"}
      data-window-animating={isDesktopWindowAnimating ? "true" : "false"}
      data-window-animation-kind={desktopWindowAnimationKind ?? "none"}
    >
      <div className="shell-backdrop shell-backdrop-left" />
      <div className="shell-backdrop shell-backdrop-right" />

      {isDesktopApp ? (
        <div
          className="desktop-window-bar"
          data-tauri-drag-region
          onDoubleClick={() => {
              void handleDesktopWindowToggleMaximize();
          }}
        >
          <div className="desktop-window-bar-shell" data-tauri-drag-region>
            <div
              className="desktop-window-bar-menu"
              onDoubleClick={(event) => event.stopPropagation()}
            >
              {menuBarContent}
            </div>
            <div
              className="desktop-titlebar-info"
              data-tauri-drag-region
              onDoubleClick={() => {
                void handleDesktopWindowToggleMaximize();
              }}
            >
              <div
                className="desktop-titlebar-topline"
                data-tauri-drag-region
              >
                <div
                  className="desktop-titlebar-file"
                  title={currentFileName}
                  data-tauri-drag-region
                >
                  {currentFileName}
                </div>
                <span className={`save-state save-state-${displayedSaveState}`}>{saveStateLabel}</span>
              </div>
              <div className="desktop-titlebar-meta" data-tauri-drag-region>
                {desktopStatusSummary ? (
                  <span className="desktop-titlebar-status" data-tauri-drag-region>
                    {desktopStatusSummary}
                  </span>
                ) : null}
                {desktopStatusSummary ? (
                  <span className="status-meta-divider" aria-hidden="true" />
                ) : null}
                <span
                  className="desktop-titlebar-path"
                  title={currentDocumentPathLabel}
                  data-tauri-drag-region
                >
                  {currentDocumentPathLabel}
                </span>
              </div>
            </div>
            <div
              className="desktop-window-controls"
              onDoubleClick={(event) => event.stopPropagation()}
            >
              <button
                type="button"
                className="desktop-window-control"
                onClick={() => void handleDesktopWindowMinimize()}
                aria-label="最小化"
                title="最小化"
              >
                <span className="desktop-window-control-glyph desktop-window-control-glyph-minimize" aria-hidden="true" />
              </button>
              <button
                type="button"
                className="desktop-window-control"
                onClick={() => void handleDesktopWindowToggleMaximize()}
                aria-label={isDesktopWindowMaximized ? "还原" : "最大化"}
                title={isDesktopWindowMaximized ? "还原" : "最大化"}
              >
                <span
                  className={`desktop-window-control-glyph ${isDesktopWindowMaximized ? "desktop-window-control-glyph-restore" : "desktop-window-control-glyph-maximize"}`}
                  aria-hidden="true"
                />
              </button>
              <button
                type="button"
                className="desktop-window-control desktop-window-control-close"
                onClick={() => void handleDesktopWindowClose()}
                aria-label="关闭"
                title="关闭"
              >
                <span className="desktop-window-control-glyph desktop-window-control-glyph-close" aria-hidden="true" />
              </button>
            </div>
          </div>
          <div className="desktop-window-transition-glow" aria-hidden="true" />
        </div>
      ) : (
        <div className="app-chrome">
          <div className="app-chrome-shell">{menuBarContent}</div>
        </div>
      )}

      {showPreferences ? (
        <div
          className="preferences-modal-backdrop"
          onClick={() => setShowPreferences(false)}
        >
          <section
            className="preferences-modal"
            role="dialog"
            aria-modal="true"
            aria-label="编辑设置"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="preferences-modal-header">
              <div>
                <p className="preferences-modal-eyebrow">Preferences</p>
                <h2>编辑设置</h2>
                <p className="preferences-modal-copy">
                  调整主题、视图模式、字号和自动保存。
                </p>
              </div>
              <button
                type="button"
                className="toolbar-button toolbar-button-ghost"
                onClick={() => setShowPreferences(false)}
              >
                关闭
              </button>
            </header>

            <div className="preferences-modal-grid">
              <section className="preferences-section">
                <div className="sidebar-title-row">
                  <strong>视图</strong>
                  <span>工作区布局</span>
                </div>
                <div className="preferences-option-group">
                  <button
                    type="button"
                    className={`preferences-choice ${preferences.viewMode === "editor" ? "preferences-choice-active" : ""}`}
                    onClick={() => setViewMode("editor")}
                  >
                    <strong>仅编辑</strong>
                    <span>专注写作，不显示预览。</span>
                  </button>
                  <button
                    type="button"
                    className={`preferences-choice ${preferences.viewMode === "preview" ? "preferences-choice-active" : ""}`}
                    onClick={() => setViewMode("preview")}
                  >
                    <strong>仅预览</strong>
                    <span>只看最终渲染效果。</span>
                  </button>
                  <button
                    type="button"
                    className={`preferences-choice ${preferences.viewMode === "split" ? "preferences-choice-active" : ""}`}
                    onClick={() => setViewMode("split")}
                  >
                    <strong>双栏</strong>
                    <span>编辑和预览同时显示。</span>
                  </button>
                </div>
              </section>

              <section className="preferences-section">
                <div className="sidebar-title-row">
                  <strong>编辑</strong>
                  <span>本地持久化</span>
                </div>
                <div className="preferences-stack">
                  <label className="preferences-item">
                    <span>自动保存</span>
                    <input
                      type="checkbox"
                      checked={preferences.autosaveEnabled}
                      onChange={(event) =>
                        updatePreferences({ autosaveEnabled: event.target.checked })
                      }
                    />
                  </label>
                  <label className="preferences-item preferences-item-range">
                    <span>编辑字号 {preferences.editorFontSize}px</span>
                    <input
                      type="range"
                      min="13"
                      max="20"
                      value={preferences.editorFontSize}
                      onChange={(event) =>
                        updatePreferences({ editorFontSize: Number(event.target.value) })
                      }
                    />
                  </label>
                  <label className="preferences-item preferences-item-select">
                    <span>主题</span>
                    {/* 1) 在设置界面中加入 Lavender、Dracula 和 Sakura 三款新主题的可选下拉项 */}
                    <select
                      value={preferences.theme}
                      onChange={(event) =>
                        updatePreferences({
                          theme: event.target.value as typeof preferences.theme,
                        })
                      }
                    >
                      <option value="graphite">Graphite</option>
                      <option value="paper">Paper</option>
                      <option value="forest">Forest</option>
                      <option value="ocean">Ocean</option>
                      <option value="dune">Dune</option>
                      <option value="ember">Ember</option>
                      <option value="lavender">Lavender (薰衣草)</option>
                      <option value="dracula">Dracula (德古拉)</option>
                      <option value="sakura">Sakura (樱花)</option>
                      {/* 1) 额外新增 Cyberpunk (赛博朋克)、Nord (冰雪北欧)、Macha (日式抹茶) 三款具有高级审美设计的主题 */}
                      <option value="cyberpunk">Cyberpunk (赛博朋克)</option>
                      <option value="nord">Nord (冰雪北欧)</option>
                      <option value="macha">Macha (日式抹茶)</option>
                    </select>
                  </label>
                </div>
              </section>
            </div>
          </section>
        </div>
      ) : null}

      {showRecentDocuments ? (
        <div
          className="preferences-modal-backdrop"
          onClick={() => setShowRecentDocuments(false)}
        >
          <section
            className="preferences-modal recent-documents-modal"
            role="dialog"
            aria-modal="true"
            aria-label="最近文件"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="preferences-modal-header">
              <div>
                <p className="preferences-modal-eyebrow">Recent Files</p>
                <h2>最近文件</h2>
                <p className="preferences-modal-copy">
                  从这里快速回到最近打开或保存过的文档。
                </p>
              </div>
              <button
                type="button"
                className="toolbar-button toolbar-button-ghost"
                onClick={() => setShowRecentDocuments(false)}
              >
                关闭
              </button>
            </header>

            <div className="recent-documents-body">
              {recentDocuments.length > 0 ? (
                <div className="recent-list recent-list-stack">
                  {recentDocuments.map((item) => (
                    <div
                      key={item.path}
                      className={`recent-item ${item.path === currentPath ? "recent-item-active" : ""}`}
                      title={item.path}
                    >
                      <button
                        className="recent-item-open"
                        onClick={() => {
                          void handleOpenRecent(item.path);
                          setShowRecentDocuments(false);
                        }}
                        type="button"
                      >
                        <strong>{item.name}</strong>
                        <span className="recent-item-path">{item.path}</span>
                        <span className="recent-item-meta">
                          {getRecentDocumentDescription(item, currentPath)}
                        </span>
                      </button>
                      <button
                        className="recent-item-remove"
                        type="button"
                        onClick={() => handleRemoveRecent(item.path)}
                        aria-label={`删除最近文件 ${item.name}`}
                        title="删除记录"
                      >
                        删除
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="empty-card">
                  <strong>还没有最近文件</strong>
                  <p>打开或保存文档后，这里会出现可直接返回的记录。</p>
                </div>
              )}
            </div>
          </section>
        </div>
      ) : null}

      <section
        className={`workbench-layout ${hasOpenFolder ? "workbench-layout-with-folder" : ""} ${isFolderPanelCollapsed ? "workbench-layout-folder-collapsed" : ""}`}
      >
        {showFolderPanel ? (
          <aside className="folder-panel">
            <div className="folder-panel-header">
              <div className="folder-panel-header-copy">
                <strong>Project</strong>
                <span>Markdown 工作区</span>
              </div>
              <div className="folder-panel-actions">
                <button
                  type="button"
                  className="folder-panel-locate-button"
                  onClick={handleRevealCurrentFile}
                  disabled={!currentFolderTrail}
                  title={currentFolderTrail ? "定位到当前文件" : "当前文件不在这个文件夹中"}
                  aria-label="定位到当前文件"
                >
                  <span className="folder-panel-locate-icon" aria-hidden="true">
                    <span className="folder-panel-locate-ring" />
                    <span className="folder-panel-locate-dot" />
                  </span>
                </button>
                <button
                  type="button"
                  className="folder-panel-toggle-button"
                  onClick={() => setIsFolderPanelCollapsed(true)}
                  title="隐藏文件树"
                  aria-label="隐藏文件树"
                >
                  <span className="folder-panel-toggle-glyph" aria-hidden="true" />
                </button>
              </div>
            </div>
            <div className="folder-tree-panel">
              <button
                type="button"
                className={`folder-tree-root folder-tree-toggle ${expandedFolderPaths.has(openFolder.rootPath) ? "folder-tree-toggle-expanded" : ""} ${currentFolderTrail ? "folder-tree-root-current" : ""}`}
                title={openFolder.rootPath}
                onContextMenu={(event) =>
                  openFolderContextMenu(event, {
                    path: openFolder.rootPath,
                    kind: "root",
                    name: openFolder.rootName,
                  })}
                onClick={() => {
                  setExpandedFolderPaths((current) => {
                    const next = new Set(current);
                    if (next.has(openFolder.rootPath)) {
                      next.delete(openFolder.rootPath);
                    } else {
                      next.add(openFolder.rootPath);
                    }
                    return next;
                  });
                }}
              >
                <span className="folder-tree-icon" aria-hidden="true">&gt;</span>
                <span
                  className="folder-tree-entry-icon folder-tree-entry-icon-folder"
                  aria-hidden="true"
                />
                <span className="folder-tree-entry-label">{openFolder.rootName}</span>
              </button>
              {expandedFolderPaths.has(openFolder.rootPath) &&
              openFolder.nodes.length > 0 ? (
                <div className="folder-tree-list folder-tree-root-children">
                  {renderFolderNodes(openFolder.nodes)}
                </div>
              ) : !expandedFolderPaths.has(openFolder.rootPath) ? null : (
                <div className="empty-card empty-card-compact">
                  <strong>这个文件夹里没有 Markdown 文件</strong>
                  <p>这里只展示 `.md` 和 `.markdown` 文档。</p>
                </div>
              )}
            </div>
          </aside>
        ) : null}
        <div className="workbench-main">
          {hasOpenFolder && isFolderPanelCollapsed ? (
            <button
              type="button"
              className="folder-panel-reveal-button"
              onClick={() => setIsFolderPanelCollapsed(false)}
            >
              显示文件树
            </button>
          ) : null}
          {!isDesktopApp ? (
            <section className="status-strip">
              <div className="status-copy-block">
                <div className="status-title-row">
                  <h1>{currentFileName}</h1>
                  <span className={`save-state save-state-${displayedSaveState}`}>{saveStateLabel}</span>
                </div>
                <div className="status-meta-row">
                  <span className="status-meta-item">{statusText}</span>
                  <span className="status-meta-divider" aria-hidden="true" />
                  <span className="status-meta-item">{lines.length} 行</span>
                  <span className="status-meta-item">{wordCount} 词</span>
                </div>
                <p className="status-path">
                  <span title={currentPath ?? "尚未保存到本地，建议先用“另存为”落盘。"}>
                    {currentPath ?? "尚未保存到本地，建议先用“另存为”落盘。"}
                  </span>
                </p>
              </div>
            </section>
          ) : null}

          {documentTabsBarContent}

          <section className="workspace-grid workspace-grid-wide">
            <section className="editor-stage">
              <input
                ref={imageInputRef}
                className="hidden-input"
                type="file"
                accept="image/*"
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  if (!file) {
                    return;
                  }

                  await handleImportImageFile(file);
                  event.target.value = "";
                }}
              />
              <input
                ref={folderInputRef}
                className="hidden-input"
                type="file"
                multiple
                onChange={(event) => {
                  void handleFolderInputChange(event);
                }}
              />

              <section
                className={`workspace ${preferences.viewMode === "split" ? "" : "workspace-single"}`}
              >
                {showEditorPanel ? (
                  <article className="panel panel-editor">
                    {/* 1) 移除了原来的 panel-header 顶部栏 */}
                    <MarkdownEditor
                      key={activeTabId ?? "no-open-tab"}
                      ref={editorRef}
                      value={markdown}
                      onChange={setMarkdown}
                      initialState={activeTab?.editorState ?? undefined}
                      onEditorStateChange={handleEditorStateChange}
                      scrollRatio={scrollRatio}
                      syncSource={scrollSource}
                      onScrollRatioChange={(ratio) => {
                        startTransition(() => {
                          setScrollSource("editor");
                          setScrollRatio(ratio);
                        });
                      }}
                      theme={preferences.theme}
                    />
                  </article>
                ) : null}

                {showPreviewPanel ? (
                  <article
                    className="panel panel-preview"
                    /* 2) 使用事件委托监听对图片的点击，从而触发全屏预览 */
                    onClick={(e) => {
                        const target = e.target as HTMLElement;
                        if (target.tagName === "IMG") {
                            const img = target as HTMLImageElement;
                            setFullscreenImageUrl(img.src);
                        }
                    }}
                  >
                    {/* 3) 移除了原来的 panel-header 顶部栏 */}
                    <MarkdownPreview
                      markdown={markdown}
                      scrollRatio={scrollRatio}
                      syncSource={scrollSource}
                      onScrollRatioChange={(ratio) => {
                        startTransition(() => {
                          setScrollSource("preview");
                          setScrollRatio(ratio);
                        });
                      }}
                      onExternalLinkClick={handleExternalLinkIntent}
                    />
                  </article>
                ) : null}
              </section>
            </section>
          </section>
        </div>
      </section>

      {tabContextMenu ? (
        <div
          ref={tabContextMenuRef}
          className="folder-context-menu tab-context-menu"
          style={{ left: tabContextMenu.x, top: tabContextMenu.y }}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div className="tab-context-menu-title" title={tabContextMenu.name}>
            {tabContextMenu.name}
          </div>
          <button
            type="button"
            className="folder-context-menu-item"
            onClick={() => {
              handleCloseTab(tabContextMenu.tabId);
              closeTabContextMenu();
            }}
          >
            关闭当前
          </button>
          <button
            type="button"
            className="folder-context-menu-item"
            disabled={openTabs.length <= 1}
            onClick={() => {
              handleCloseOtherTabs(tabContextMenu.tabId);
              closeTabContextMenu();
            }}
          >
            关闭其他
          </button>
          <button
            type="button"
            className="folder-context-menu-item folder-context-menu-item-danger"
            onClick={() => {
              handleCloseAllTabs();
              closeTabContextMenu();
            }}
          >
            全部关闭
          </button>
        </div>
      ) : null}

      {folderContextMenu ? (
        <div
          ref={folderContextMenuRef}
          className="folder-context-menu"
          style={{ left: folderContextMenu.x, top: folderContextMenu.y }}
        >
          {folderContextMenu.kind !== "file" ? (
            <button
              className="folder-context-menu-item"
              onClick={() => void handleCreateFolderFile(folderContextMenu.path)}
            >
              新建 Markdown 文件
            </button>
          ) : null}

          {folderContextMenu.kind === "file" ? (
            <>
              <button
                className="folder-context-menu-item"
                onClick={() =>
                  openRenameSession({
                    source: "folder-tree",
                    tabId: null,
                    path: folderContextMenu.path,
                    initialName: folderContextMenu.name,
                  })
                }
              >
                重命名
              </button>
              <button
                className="folder-context-menu-item"
                onClick={() => void handleDuplicateFolderFile(folderContextMenu.path)}
              >
                复制
              </button>
              <button
                className="folder-context-menu-item folder-context-menu-item-danger"
                onClick={() => void handleDeleteFolderFile(folderContextMenu.path)}
              >
                删除
              </button>
            </>
          ) : null}
        </div>
      ) : null}

      {pendingExternalLink && !showBrowserChoiceDialog ? (
        <div
          className="preferences-modal-backdrop"
          onClick={() => closeExternalLinkDialogs()}
        >
          <section
            className="preferences-modal link-open-modal"
            role="dialog"
            aria-modal="true"
            aria-label="打开外部链接"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="preferences-modal-header">
              <div>
                <p className="preferences-modal-eyebrow">External Link</p>
                <h2>打开外部链接</h2>
                <p className="preferences-modal-copy">
                  即将离开当前应用，在系统浏览器中打开以下链接。
                </p>
              </div>
              <button
                type="button"
                className="toolbar-button toolbar-button-ghost"
                onClick={() => closeExternalLinkDialogs()}
              >
                取消
              </button>
            </header>

            <div className="preferences-modal-grid">
              <div className="link-preview-card">
                <span className="link-preview-label">链接地址</span>
                <strong>{getExternalLinkHostLabel(pendingExternalLink)}</strong>
                <span className="link-preview-url">{pendingExternalLink}</span>
              </div>
              <div className="link-open-actions">
                <button
                  type="button"
                  className="toolbar-button toolbar-button-ghost"
                  onClick={() => closeExternalLinkDialogs()}
                >
                  暂不打开
                </button>
                <button
                  type="button"
                  className="toolbar-button"
                  disabled={isLoadingBrowserChoices}
                  onClick={() => void handleConfirmExternalLinkOpen()}
                >
                  {isLoadingBrowserChoices ? "读取浏览器…" : "打开链接"}
                </button>
              </div>
            </div>
          </section>
        </div>
      ) : null}

      {pendingExternalLink && showBrowserChoiceDialog ? (
        <div
          className="preferences-modal-backdrop"
          onClick={() => closeExternalLinkDialogs()}
        >
          <section
            className="preferences-modal link-open-modal"
            role="dialog"
            aria-modal="true"
            aria-label="选择浏览器"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="preferences-modal-header">
              <div>
                <p className="preferences-modal-eyebrow">Browser Picker</p>
                <h2>选择浏览器</h2>
                <p className="preferences-modal-copy">
                  请选择要用来打开这个链接的浏览器。
                </p>
              </div>
              <button
                type="button"
                className="toolbar-button toolbar-button-ghost"
                onClick={() => closeExternalLinkDialogs()}
              >
                关闭
              </button>
            </header>

            <div className="preferences-modal-grid">
              <div className="link-preview-card">
                <span className="link-preview-label">将打开</span>
                <strong>{getExternalLinkHostLabel(pendingExternalLink)}</strong>
                <span className="link-preview-url">{pendingExternalLink}</span>
              </div>
              <div className="browser-choice-list">
                {browserChoices.map((browser) => (
                  <button
                    key={browser.id}
                    type="button"
                    className="browser-choice-button"
                    onClick={() => void handleOpenExternalLinkWithBrowser(browser)}
                  >
                    <strong>{browser.name}</strong>
                    <span>{browser.id === "system-default" ? "遵循当前系统默认设置" : "外部浏览器打开"}</span>
                  </button>
                ))}
              </div>
            </div>
          </section>
        </div>
      ) : null}

      {/* 4) 全屏大图预览的覆盖层 */}
      {fullscreenImageUrl && (
        <div
          className="fullscreen-image-overlay"
          onClick={() => setFullscreenImageUrl(null)}
        >
          <div className="fullscreen-image-container">
            <img src={fullscreenImageUrl} alt="Full screen preview" />
            <button
              className="fullscreen-image-close"
              onClick={() => setFullscreenImageUrl(null)}
            >
              &times;
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
