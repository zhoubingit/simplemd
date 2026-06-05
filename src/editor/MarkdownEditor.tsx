import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  type CSSProperties,
} from "react";
import CodeMirror from "@uiw/react-codemirror";
import { insertNewlineContinueMarkup, markdown } from "@codemirror/lang-markdown";
import { EditorSelection, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  keymap,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import {
  history,
  historyField,
  historyKeymap,
  defaultKeymap,
} from "@codemirror/commands";
import { searchKeymap } from "@codemirror/search";
import type { AppPreferences } from "../preferences/usePreferences";
import { findActiveBlock, getMarkdownLineInfo } from "./activeBlock";

export type FormatAction =
  | "bold"
  | "italic"
  | "code"
  | "codeblock"
  | "link"
  | "heading"
  | "heading2"
  | "heading3"
  | "quote"
  | "bullet"
  | "ordered"
  | "task"
  | "table"
  | "divider";

export type MarkdownEditorHandle = {
  applyFormat: (action: FormatAction) => void;
  insertText: (text: string) => void;
  focus: () => void;
};

export const markdownEditorStateFields = {
  history: historyField,
};

export type MarkdownEditorStateSnapshot = ReturnType<
  EditorView["state"]["toJSON"]
>;

type MarkdownEditorProps = {
  value: string;
  onChange: (value: string) => void;
  initialState?: MarkdownEditorStateSnapshot;
  onEditorStateChange?: (state: MarkdownEditorStateSnapshot) => void;
  scrollRatio: number;
  syncSource: "editor" | "preview" | null;
  onScrollRatioChange: (ratio: number) => void;
  theme: AppPreferences["theme"];
};

function clampRatio(value: number) {
  if (Number.isNaN(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function applyInlineWrap(
  view: EditorView,
  before: string,
  after: string,
  placeholder: string,
) {
  const selection = view.state.selection.main;
  const selectedText = view.state.sliceDoc(selection.from, selection.to);
  const content = selectedText || placeholder;
  const insert = `${before}${content}${after}`;
  const contentStart = selection.from + before.length;
  const contentEnd = contentStart + content.length;

  view.dispatch({
    changes: { from: selection.from, to: selection.to, insert },
    selection: EditorSelection.range(contentStart, contentEnd),
    scrollIntoView: true,
  });
  view.focus();
}

function applyLink(view: EditorView) {
  const selection = view.state.selection.main;
  const selectedText = view.state.sliceDoc(selection.from, selection.to);
  const label = selectedText || "link text";
  const url = "https://example.com";
  const insert = `[${label}](${url})`;
  const urlStart = selection.from + label.length + 3;
  const urlEnd = urlStart + url.length;

  view.dispatch({
    changes: { from: selection.from, to: selection.to, insert },
    selection: EditorSelection.range(urlStart, urlEnd),
    scrollIntoView: true,
  });
  view.focus();
}

function applyBlockInsert(
  view: EditorView,
  block: string,
  selectionOffsetStart: number,
  selectionOffsetEnd: number,
) {
  const selection = view.state.selection.main;
  const insert = selection.empty ? block : `${block}\n${view.state.sliceDoc(selection.from, selection.to)}`;
  const from = selection.from;

  view.dispatch({
    changes: { from: selection.from, to: selection.to, insert },
    selection: EditorSelection.range(from + selectionOffsetStart, from + selectionOffsetEnd),
    scrollIntoView: true,
  });
  view.focus();
}

function applyLinePrefix(view: EditorView, prefix: string) {
  const selection = view.state.selection.main;
  const doc = view.state.doc;
  const startLine = doc.lineAt(selection.from);
  const endLine = doc.lineAt(selection.to);
  const changes = [];

  for (let lineNumber = startLine.number; lineNumber <= endLine.number; lineNumber += 1) {
    const line = doc.line(lineNumber);
    changes.push({ from: line.from, insert: prefix });
  }

  view.dispatch({
    changes,
    selection: EditorSelection.range(
      selection.from + prefix.length,
      selection.to + prefix.length * changes.length,
    ),
    scrollIntoView: true,
  });
  view.focus();
}

function applyFormat(view: EditorView, action: FormatAction) {
  switch (action) {
    case "bold":
      applyInlineWrap(view, "**", "**", "bold text");
      return true;
    case "italic":
      applyInlineWrap(view, "*", "*", "italic text");
      return true;
    case "code":
      applyInlineWrap(view, "`", "`", "inline code");
      return true;
    case "codeblock": {
      const template = "```ts\ncode\n```";
      const start = template.indexOf("code");
      applyBlockInsert(view, template, start, start + 4);
      return true;
    }
    case "link":
      applyLink(view);
      return true;
    case "heading":
      applyLinePrefix(view, "# ");
      return true;
    case "heading2":
      applyLinePrefix(view, "## ");
      return true;
    case "heading3":
      applyLinePrefix(view, "### ");
      return true;
    case "quote":
      applyLinePrefix(view, "> ");
      return true;
    case "bullet":
      applyLinePrefix(view, "- ");
      return true;
    case "ordered":
      applyLinePrefix(view, "1. ");
      return true;
    case "task":
      applyLinePrefix(view, "- [ ] ");
      return true;
    case "table": {
      const template = "| 列 1 | 列 2 |\n| --- | --- |\n| 内容 | 内容 |";
      const start = template.indexOf("内容");
      applyBlockInsert(view, template, start, start + 2);
      return true;
    }
    case "divider": {
      const template = "\n---\n";
      applyBlockInsert(view, template, 1, 4);
      return true;
    }
    default:
      return false;
  }
}

function buildActiveBlockDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const lines = view.state.doc.toString().split("\n");
  const currentLine = view.state.doc.lineAt(view.state.selection.main.head);
  const activeBlock = findActiveBlock(lines, currentLine.number);

  if (!activeBlock) {
    return builder.finish();
  }

  for (let lineNumber = activeBlock.fromLine; lineNumber <= activeBlock.toLine; lineNumber += 1) {
    const line = view.state.doc.line(lineNumber);
    const info = getMarkdownLineInfo(line.text);

    builder.add(
      line.from,
      line.from,
      Decoration.line({
        class: `cm-active-block-line cm-active-block-${activeBlock.kind}`,
      }),
    );

    if (info.prefixLength > 0) {
      builder.add(
        line.from,
        line.from + info.prefixLength,
        Decoration.mark({
          class: `cm-active-block-prefix cm-active-block-prefix-${info.kind}`,
        }),
      );
    }
  }

  return builder.finish();
}

const activeBlockPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildActiveBlockDecorations(view);
    }

    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged
      ) {
        this.decorations = buildActiveBlockDecorations(update.view);
      }
    }
  },
  {
    decorations: (value) => value.decorations,
  },
);

export const MarkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(
  function MarkdownEditor(
    {
      value,
      onChange,
      initialState,
      onEditorStateChange,
      scrollRatio,
      syncSource,
      onScrollRatioChange,
      theme,
    },
    ref,
  ) {
    const viewRef = useRef<EditorView | null>(null);
    const ignoreScrollRef = useRef(false);

    const palette = useMemo(() => {
      if (theme === "paper") {
        return {
          background: "#fffaf0",
          text: "#2d2418",
          caret: "#b75d2a",
          gutter: "rgba(86, 64, 40, 0.46)",
          activeLine: "rgba(183, 93, 42, 0.08)",
          selection: "rgba(183, 93, 42, 0.22)",
        };
      }

      if (theme === "ocean") {
        return {
          background: "#0d2230",
          text: "#e4f4fb",
          caret: "#7ed0ff",
          gutter: "rgba(173, 223, 245, 0.36)",
          activeLine: "rgba(126, 208, 255, 0.12)",
          selection: "rgba(126, 208, 255, 0.24)",
        };
      }

      if (theme === "dune") {
        return {
          background: "#f4eadb",
          text: "#3a2c1f",
          caret: "#b77a3c",
          gutter: "rgba(96, 72, 44, 0.42)",
          activeLine: "rgba(183, 122, 60, 0.1)",
          selection: "rgba(183, 122, 60, 0.24)",
        };
      }

      if (theme === "ember") {
        return {
          background: "#1d1411",
          text: "#f7ebe4",
          caret: "#ff9a6b",
          gutter: "rgba(247, 207, 189, 0.3)",
          activeLine: "rgba(255, 154, 107, 0.1)",
          selection: "rgba(255, 154, 107, 0.24)",
        };
      }

      if (theme === "forest") {
        return {
          background: "#0f1f1c",
          text: "#e8f0e7",
          caret: "#77d39b",
          gutter: "rgba(191, 226, 204, 0.32)",
          activeLine: "rgba(119, 211, 155, 0.1)",
          selection: "rgba(119, 211, 155, 0.2)",
        };
      }

      /* 1) 薰衣草 (lavender) 专属 CodeMirror 浅色温和紫色调 */
      if (theme === "lavender") {
        return {
          background: "#f5f3ff",
          text: "#252035",
          caret: "#7c62cc",
          gutter: "rgba(124, 98, 204, 0.3)",
          activeLine: "rgba(124, 98, 204, 0.06)",
          selection: "rgba(124, 98, 204, 0.18)",
        };
      }

      /* 2) 德古拉 (dracula) 专属 CodeMirror 极客暗黑高对比 */
      if (theme === "dracula") {
        return {
          background: "#282a36",
          text: "#f8f8f2",
          caret: "#ff79c6",
          gutter: "rgba(189, 147, 249, 0.35)",
          activeLine: "rgba(255, 255, 255, 0.05)",
          selection: "rgba(189, 147, 249, 0.25)",
        };
      }

      /* 3) 樱花 (sakura) 专属 CodeMirror 清新淡雅浅粉 */
      if (theme === "sakura") {
        return {
          background: "#fff0f2",
          text: "#4a2830",
          caret: "#db6b83",
          gutter: "rgba(219, 107, 131, 0.3)",
          activeLine: "rgba(219, 107, 131, 0.06)",
          selection: "rgba(219, 107, 131, 0.18)",
        };
      }

      /* 4) 赛博朋克 (cyberpunk) 专属 CodeMirror 霓虹炫酷深紫 */
      if (theme === "cyberpunk") {
        return {
          background: "#0d0a1a",
          text: "#e0f7fc",
          caret: "#ff007f",
          gutter: "rgba(0, 240, 255, 0.3)",
          activeLine: "rgba(255, 0, 127, 0.08)",
          selection: "rgba(0, 240, 255, 0.25)",
        };
      }

      /* 5) 北欧冰雪 (nord) 专属 CodeMirror 极简霜灰冰蓝 */
      if (theme === "nord") {
        return {
          background: "#2e3440",
          text: "#eceff4",
          caret: "#88c0d0",
          gutter: "rgba(136, 192, 208, 0.3)",
          activeLine: "rgba(255, 255, 255, 0.04)",
          selection: "rgba(136, 192, 208, 0.22)",
        };
      }

      /* 6) 抹茶 (macha) 专属 CodeMirror 日式护眼治愈绿 */
      if (theme === "macha") {
        return {
          background: "#f6f8f4",
          text: "#2d3e24",
          caret: "#5e824d",
          gutter: "rgba(94, 130, 77, 0.3)",
          activeLine: "rgba(94, 130, 77, 0.06)",
          selection: "rgba(94, 130, 77, 0.18)",
        };
      }

      return {
        background: "#14171b",
        text: "#f5f1e8",
        caret: "#f0b56a",
        gutter: "rgba(245, 241, 232, 0.28)",
        activeLine: "rgba(240, 181, 106, 0.08)",
        selection: "rgba(240, 181, 106, 0.28)",
      };
    }, [theme]);

    const editorExtensions = useMemo(
      () => [
        markdown(),
        history(),
        EditorView.lineWrapping,
        activeBlockPlugin,
        keymap.of([
          {
            key: "Enter",
            run: insertNewlineContinueMarkup,
          },
          {
            key: "Mod-b",
            run: (view) => applyFormat(view, "bold"),
          },
          {
            key: "Mod-i",
            run: (view) => applyFormat(view, "italic"),
          },
          {
            key: "Mod-k",
            run: (view) => applyFormat(view, "link"),
          },
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
        ]),
        EditorView.theme({
          "&": {
            height: "100%",
            backgroundColor: palette.background,
            fontSize: "15px",
            color: palette.text,
          },
          ".cm-scroller": {
            fontFamily: '"Cascadia Code", "Consolas", monospace',
            padding: "18px 20px 28px",
          },
          ".cm-content": {
            minHeight: "420px",
            caretColor: palette.caret,
          },
          ".cm-cursor, .cm-dropCursor": {
            borderLeftColor: `${palette.caret} !important`,
          },
          ".cm-line": {
            padding: "0",
            transition: "background-color 120ms ease, transform 120ms ease",
          },
          ".cm-gutters": {
            backgroundColor: palette.background,
            border: "none",
            color: palette.gutter,
          },
          ".cm-line.cm-active-block-line": {
            borderRadius: "10px",
            backgroundColor: palette.activeLine,
          },
          ".cm-line.cm-active-block-heading": {
            fontWeight: "700",
            transform: "translateX(2px)",
          },
          ".cm-line.cm-active-block-quote": {
            borderLeft: `3px solid ${palette.caret}`,
            paddingLeft: "10px",
          },
          ".cm-line.cm-active-block-list": {
            transform: "translateX(2px)",
          },
          ".cm-active-block-prefix": {
            opacity: "0.42",
            fontWeight: "600",
          },
          ".cm-active-block-prefix-heading": {
            color: palette.caret,
            letterSpacing: "0.06em",
          },
          ".cm-active-block-prefix-quote, .cm-active-block-prefix-list": {
            color: palette.caret,
          },
          ".cm-activeLine, .cm-activeLineGutter": {
            backgroundColor: palette.activeLine,
          },
          ".cm-selectionBackground, ::selection": {
            backgroundColor: `${palette.selection} !important`,
          },
        }),
      ],
      [palette],
    );

    const editorStyle = useMemo(
      () =>
        ({
          ["--cm-editor-background"]: palette.background,
          ["--cm-editor-text"]: palette.text,
          ["--cm-editor-caret"]: palette.caret,
          ["--cm-editor-gutter"]: palette.gutter,
          ["--cm-editor-selection"]: palette.selection,
          ["--cm-editor-active-line"]: palette.activeLine,
        }) as CSSProperties,
      [palette],
    );

    useImperativeHandle(ref, () => ({
      applyFormat(action) {
        const view = viewRef.current;
        if (view) {
          applyFormat(view, action);
        }
      },
      insertText(text) {
        const view = viewRef.current;
        if (!view) {
          return;
        }

        const selection = view.state.selection.main;
        const insert = selection.empty ? `\n${text}\n` : text;
        const cursor = selection.from + insert.length;
        view.dispatch({
          changes: { from: selection.from, to: selection.to, insert },
          selection: EditorSelection.cursor(cursor),
          scrollIntoView: true,
        });
        view.focus();
      },
      focus() {
        viewRef.current?.focus();
      },
    }));

    useEffect(() => {
      const view = viewRef.current;
      if (!view) {
        return;
      }

      const scroller = view.scrollDOM;
      const onScroll = () => {
        if (ignoreScrollRef.current) {
          ignoreScrollRef.current = false;
          return;
        }

        const maxScroll = scroller.scrollHeight - scroller.clientHeight;
        const ratio = maxScroll <= 0 ? 0 : scroller.scrollTop / maxScroll;
        onScrollRatioChange(clampRatio(ratio));
      };

      scroller.addEventListener("scroll", onScroll);
      return () => {
        scroller.removeEventListener("scroll", onScroll);
      };
    }, [onScrollRatioChange]);

    useEffect(() => {
      if (syncSource !== "preview") {
        return;
      }

      const view = viewRef.current;
      if (!view) {
        return;
      }

      const scroller = view.scrollDOM;
      const maxScroll = scroller.scrollHeight - scroller.clientHeight;
      ignoreScrollRef.current = true;
      scroller.scrollTop = maxScroll * clampRatio(scrollRatio);
    }, [scrollRatio, syncSource]);

    return (
      <div className="editor-surface" style={editorStyle}>
        <CodeMirror
          value={value}
          height="100%"
          initialState={
            initialState
              ? {
                  json: initialState,
                  fields: markdownEditorStateFields,
                }
              : undefined
          }
          extensions={editorExtensions}
          basicSetup={{
            foldGutter: false,
            highlightActiveLine: true,
            highlightActiveLineGutter: true,
            lineNumbers: true,
          }}
          onCreateEditor={(view) => {
            viewRef.current = view;
          }}
          onChange={(nextValue, viewUpdate) => {
            onChange(nextValue);
            onEditorStateChange?.(
              viewUpdate.state.toJSON(markdownEditorStateFields),
            );
          }}
        />
      </div>
    );
  },
);
