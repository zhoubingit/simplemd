import MarkdownIt from "markdown-it";
import type { BuiltinLanguage } from "shiki";

const commonLanguages: BuiltinLanguage[] = [
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "json",
  "bash",
  "shell",
  "rust",
  "css",
  "html",
  "markdown",
  "md",
  "yaml",
  "yml",
];

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  breaks: true,
});

let mermaidInstancePromise: Promise<
  typeof import("mermaid").default
> | null = null;
let mermaidRenderSequence = 0;

export function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function normalizeLanguage(rawInfo: string): BuiltinLanguage | null {
  const candidate = rawInfo.trim().split(/\s+/)[0]?.toLowerCase();
  if (!candidate) {
    return null;
  }

  const aliases: Record<string, BuiltinLanguage> = {
    js: "javascript",
    ts: "typescript",
    sh: "bash",
    shellscript: "shellscript",
    rs: "rust",
    md: "markdown",
    yml: "yaml",
  };

  return aliases[candidate] ?? (candidate as BuiltinLanguage);
}

function getFenceLanguage(rawInfo: string) {
  return rawInfo.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
}

async function getMermaidInstance() {
  if (!mermaidInstancePromise) {
    mermaidInstancePromise = import("mermaid").then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "base",
        fontFamily: '"Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
        themeVariables: {
          primaryColor: "#f7efe4",
          primaryTextColor: "#3a2f24",
          primaryBorderColor: "#d8c7b2",
          lineColor: "#8e6f53",
          secondaryColor: "#f3e6d8",
          tertiaryColor: "#fbf6ef",
          background: "#fffaf4",
          mainBkg: "#f7efe4",
          nodeBorder: "#ccb49a",
          clusterBkg: "#f8efe3",
          clusterBorder: "#d1b89e",
          edgeLabelBackground: "#fffaf4",
        },
      });
      return mermaid;
    });
  }

  return mermaidInstancePromise;
}

function buildPlainFence(code: string, info: string) {
  const language = info.trim().split(/\s+/)[0] || "text";
  return `<pre class="preview-code-fallback"><code class="language-${language}">${escapeHtml(code)}</code></pre>`;
}

async function buildMermaidFence(code: string, info: string) {
  try {
    const mermaid = await getMermaidInstance();
    const diagramId = `mermaid-diagram-${mermaidRenderSequence += 1}`;
    const { svg } = await mermaid.render(diagramId, code);
    return `<div class="mermaid-diagram" data-mermaid-diagram>${svg}</div>`;
  } catch {
    return buildPlainFence(code, info);
  }
}

export async function renderMarkdown(markdownSource: string) {
  const { getSingletonHighlighter } = await import("shiki");
  const tokens = markdown.parse(markdownSource, {});
  const highlighter = await getSingletonHighlighter({
    themes: ["github-dark"],
    langs: commonLanguages,
  });

  const fenceHtml = new Map<number, string>();

  await Promise.all(
    tokens.map(async (token, index) => {
      if (token.type !== "fence") {
        return;
      }

      if (getFenceLanguage(token.info) === "mermaid") {
        fenceHtml.set(index, await buildMermaidFence(token.content, token.info));
        return;
      }

      const language = normalizeLanguage(token.info);
      if (!language) {
        fenceHtml.set(index, buildPlainFence(token.content, token.info));
        return;
      }

      try {
        const highlighted = highlighter.codeToHtml(token.content, {
          lang: language,
          theme: "github-dark",
        });
        fenceHtml.set(index, highlighted);
      } catch {
        fenceHtml.set(index, buildPlainFence(token.content, token.info));
      }
    }),
  );

  const originalFence = markdown.renderer.rules.fence;
  markdown.renderer.rules.fence = (tokenList, idx, options, env, self) => {
    return (
      fenceHtml.get(idx) ??
      originalFence?.(tokenList, idx, options, env, self) ??
      self.renderToken(tokenList, idx, options)
    );
  };

  try {
    return markdown.renderer.render(tokens, markdown.options, {});
  } finally {
    markdown.renderer.rules.fence = originalFence;
  }
}

export function buildExportHtmlDocument(title: string, bodyHtml: string) {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        color-scheme: dark;
        font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      }
      body {
        max-width: 860px;
        margin: 0 auto;
        padding: 48px 24px 80px;
        color: #f3efe7;
        background: #151617;
        line-height: 1.7;
      }
      img {
        max-width: 100%;
        border-radius: 12px;
      }
      pre {
        overflow: auto;
        border-radius: 14px;
      }
      code {
        font-family: "Cascadia Code", "Consolas", monospace;
      }
      blockquote {
        margin-left: 0;
        padding-left: 14px;
        border-left: 3px solid rgba(240, 181, 106, 0.45);
      }
      a {
        color: #f0b56a;
      }
      table {
        display: table;
        width: 100%;
        margin: 0 0 18px;
        border-collapse: collapse;
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 12px;
      }
      thead {
        background: rgba(255, 255, 255, 0.06);
      }
      th,
      td {
        min-width: 120px;
        padding: 10px 14px;
        border: 1px solid rgba(255, 255, 255, 0.1);
        text-align: left;
        vertical-align: top;
      }
      th {
        color: #ffffff;
      }
      tbody tr:nth-child(even) {
        background: rgba(255, 255, 255, 0.03);
      }
      .mermaid-diagram {
        display: flex;
        justify-content: center;
        margin: 0 0 18px;
        padding: 18px 16px;
        border: 1px solid rgba(0, 0, 0, 0.08);
        border-radius: 16px;
        background: #fffaf4;
        overflow: auto;
      }
      .mermaid-diagram svg {
        max-width: 100%;
        height: auto;
      }
    </style>
  </head>
  <body>
    ${bodyHtml}
  </body>
</html>`;
}
