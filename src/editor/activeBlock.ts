export type MarkdownBlockKind =
  | "heading"
  | "quote"
  | "list"
  | "paragraph"
  | "other";

export type MarkdownLineInfo = {
  kind: MarkdownBlockKind;
  prefixLength: number;
  indent: number;
};

export type BlockRange = {
  fromLine: number;
  toLine: number;
  kind: MarkdownBlockKind;
};

const headingPattern = /^(\s{0,3}#{1,6}\s+)/;
const quotePattern = /^(\s{0,3}(?:>\s?)+)/;
const listPattern = /^(\s*)(?:[-+*]\s+|\d+[.)]\s+|\[(?: |x|X)\]\s+)/;

function getIndentSize(text: string) {
  const match = text.match(/^(\s*)/);
  return match?.[1]?.length ?? 0;
}

function isBlank(text: string) {
  return text.trim().length === 0;
}

export function getMarkdownLineInfo(text: string): MarkdownLineInfo {
  const headingMatch = text.match(headingPattern);
  if (headingMatch) {
    return {
      kind: "heading",
      prefixLength: headingMatch[1].length,
      indent: getIndentSize(text),
    };
  }

  const quoteMatch = text.match(quotePattern);
  if (quoteMatch) {
    return {
      kind: "quote",
      prefixLength: quoteMatch[1].length,
      indent: getIndentSize(text),
    };
  }

  const listMatch = text.match(listPattern);
  if (listMatch) {
    return {
      kind: "list",
      prefixLength: listMatch[0].length,
      indent: listMatch[1].length,
    };
  }

  if (!isBlank(text)) {
    return {
      kind: "paragraph",
      prefixLength: 0,
      indent: getIndentSize(text),
    };
  }

  return {
    kind: "other",
    prefixLength: 0,
    indent: 0,
  };
}

function canExtendListBlock(text: string, baseIndent: number) {
  if (isBlank(text)) {
    return false;
  }

  const info = getMarkdownLineInfo(text);
  if (info.kind === "list") {
    return info.indent >= baseIndent;
  }

  if (info.kind === "quote" || info.kind === "heading") {
    return false;
  }

  return info.indent > baseIndent;
}

function canExtendQuoteBlock(text: string) {
  return getMarkdownLineInfo(text).kind === "quote";
}

function canExtendParagraphBlock(text: string) {
  const info = getMarkdownLineInfo(text);
  return info.kind === "paragraph";
}

export function findActiveBlock(lines: string[], currentLineNumber: number): BlockRange | null {
  const currentText = lines[currentLineNumber - 1];
  if (currentText === undefined) {
    return null;
  }

  let currentInfo = getMarkdownLineInfo(currentText);
  if (currentInfo.kind === "paragraph") {
    for (let lineNumber = currentLineNumber - 1; lineNumber >= 1; lineNumber -= 1) {
      const candidateText = lines[lineNumber - 1];
      if (isBlank(candidateText)) {
        break;
      }

      const candidateInfo = getMarkdownLineInfo(candidateText);
      if (candidateInfo.kind === "list" && currentInfo.indent > candidateInfo.indent) {
        currentInfo = candidateInfo;
        break;
      }

      if (candidateInfo.kind !== "paragraph") {
        break;
      }
    }
  }

  if (currentInfo.kind === "other") {
    return null;
  }

  if (currentInfo.kind === "heading") {
    return {
      fromLine: currentLineNumber,
      toLine: currentLineNumber,
      kind: currentInfo.kind,
    };
  }

  let fromLine = currentLineNumber;
  let toLine = currentLineNumber;

  const canExtend = (text: string) => {
    if (currentInfo.kind === "quote") {
      return canExtendQuoteBlock(text);
    }

    if (currentInfo.kind === "list") {
      return canExtendListBlock(text, currentInfo.indent);
    }

    return canExtendParagraphBlock(text);
  };

  for (let lineNumber = currentLineNumber - 1; lineNumber >= 1; lineNumber -= 1) {
    const text = lines[lineNumber - 1];
    if (!canExtend(text)) {
      break;
    }
    fromLine = lineNumber;
  }

  for (let lineNumber = currentLineNumber + 1; lineNumber <= lines.length; lineNumber += 1) {
    const text = lines[lineNumber - 1];
    if (!canExtend(text)) {
      break;
    }
    toLine = lineNumber;
  }

  return {
    fromLine,
    toLine,
    kind: currentInfo.kind,
  };
}
