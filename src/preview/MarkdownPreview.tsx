import { memo, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { renderMarkdown } from "./renderMarkdown";

type MarkdownPreviewProps = {
  markdown: string;
  scrollRatio: number;
  syncSource: "editor" | "preview" | null;
  onScrollRatioChange: (ratio: number) => void;
  onExternalLinkClick?: (url: string) => void;
};

const PREVIEW_SANITIZE_OPTIONS: Parameters<typeof DOMPurify.sanitize>[1] = {
  USE_PROFILES: {
    html: true,
    svg: true,
    svgFilters: true,
  },
  ADD_TAGS: ["foreignObject"],
  ADD_ATTR: [
    "dominant-baseline",
    "marker-start",
    "marker-end",
    "refX",
    "refY",
    "viewBox",
    "preserveAspectRatio",
    "requiredFeatures",
    "requiredExtensions",
    "systemLanguage",
    "externalResourcesRequired",
  ],
};

function clampRatio(value: number) {
  if (Number.isNaN(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function MarkdownPreviewInner({
  markdown,
  scrollRatio,
  syncSource,
  onScrollRatioChange,
  onExternalLinkClick,
}: MarkdownPreviewProps) {
  const [html, setHtml] = useState("<p>Loading preview…</p>");
  const deferredMarkdown = useDeferredValue(markdown);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const ignoreScrollRef = useRef(false);
  const scrollFrameRef = useRef<number | null>(null);
  const scrollbarTimerRef = useRef<number | null>(null);
  const latestScrollRatioRef = useRef(0);
  const scrollChangeRef = useRef(onScrollRatioChange);
  const externalLinkClickRef = useRef(onExternalLinkClick);

  useEffect(() => {
    scrollChangeRef.current = onScrollRatioChange;
  }, [onScrollRatioChange]);

  useEffect(() => {
    externalLinkClickRef.current = onExternalLinkClick;
  }, [onExternalLinkClick]);

  useEffect(() => {
    let active = true;
    const renderTimer = window.setTimeout(() => {
      renderMarkdown(deferredMarkdown)
        .then((rendered) => {
          if (active) {
            setHtml(rendered);
          }
        })
        .catch(() => {
          if (active) {
            setHtml("<p>Preview render failed.</p>");
          }
        });
    }, 90);

    return () => {
      active = false;
      window.clearTimeout(renderTimer);
    };
  }, [deferredMarkdown]);

  const sanitizedHtml = useMemo(
    () => DOMPurify.sanitize(html, PREVIEW_SANITIZE_OPTIONS),
    [html],
  );

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) {
      return;
    }

    const onScroll = () => {
      container.classList.add("preview-document-scrolling");
      if (scrollbarTimerRef.current !== null) {
        window.clearTimeout(scrollbarTimerRef.current);
      }
      scrollbarTimerRef.current = window.setTimeout(() => {
        container.classList.remove("preview-document-scrolling");
        scrollbarTimerRef.current = null;
      }, 760);

      if (ignoreScrollRef.current) {
        ignoreScrollRef.current = false;
        return;
      }

      const maxScroll = container.scrollHeight - container.clientHeight;
      latestScrollRatioRef.current = clampRatio(
        maxScroll <= 0 ? 0 : container.scrollTop / maxScroll,
      );

      if (scrollFrameRef.current !== null) {
        return;
      }

      scrollFrameRef.current = window.requestAnimationFrame(() => {
        scrollFrameRef.current = null;
        scrollChangeRef.current(latestScrollRatioRef.current);
      });
    };

    container.addEventListener("scroll", onScroll);
    return () => {
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
      if (scrollbarTimerRef.current !== null) {
        window.clearTimeout(scrollbarTimerRef.current);
        scrollbarTimerRef.current = null;
      }
      container.classList.remove("preview-document-scrolling");
      container.removeEventListener("scroll", onScroll);
    };
  }, []);

  useEffect(() => {
    if (syncSource !== "editor") {
      return;
    }

    const container = scrollRef.current;
    if (!container) {
      return;
    }

    const maxScroll = container.scrollHeight - container.clientHeight;
    ignoreScrollRef.current = true;
    container.scrollTop = maxScroll * clampRatio(scrollRatio);
  }, [scrollRatio, syncSource]);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) {
      return;
    }

    const handleClick = (event: MouseEvent) => {
      const linkClickHandler = externalLinkClickRef.current;
      if (!linkClickHandler) {
        return;
      }

      const target = event.target as HTMLElement | null;
      const anchor = target?.closest("a[href]") as HTMLAnchorElement | null;
      if (!anchor) {
        return;
      }

      const href = anchor.getAttribute("href")?.trim();
      const resolvedHref = anchor.href || href || "";
      if (!resolvedHref || !/^https?:/i.test(resolvedHref)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      linkClickHandler(resolvedHref);
    };

    container.addEventListener("click", handleClick);
    return () => {
      container.removeEventListener("click", handleClick);
    };
  }, []);

  return (
    <div className="preview-shell">
      <div ref={scrollRef} className="preview-document markdown-body">
        <div
          className="preview-rendered"
          dangerouslySetInnerHTML={{
            __html: sanitizedHtml,
          }}
        />
      </div>
    </div>
  );
}

export const MarkdownPreview = memo(
  MarkdownPreviewInner,
  (previousProps, nextProps) => {
    if (previousProps.markdown !== nextProps.markdown) {
      return false;
    }

    if (previousProps.syncSource !== nextProps.syncSource) {
      return false;
    }

    if (
      nextProps.syncSource === "editor" &&
      previousProps.scrollRatio !== nextProps.scrollRatio
    ) {
      return false;
    }

    return true;
  },
);
