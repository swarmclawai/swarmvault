import { fromMarkdown } from "mdast-util-from-markdown";
import { normalizeWhitespace } from "./utils.js";

export type MarkdownNode = {
  type: string;
  depth?: number;
  value?: string;
  alt?: string;
  children?: MarkdownNode[];
};

/**
 * Parses markdown text into a flat list of top-level mdast nodes.
 * Returns an empty list if parsing fails so callers can fall through
 * gracefully.
 */
export function parseMarkdownNodes(text: string): MarkdownNode[] {
  try {
    const root = fromMarkdown(text) as { children?: MarkdownNode[] };
    return Array.isArray(root.children) ? root.children : [];
  } catch {
    return [];
  }
}

/**
 * Concatenates the plain-text value of an mdast node and its descendants.
 * Mirrors the logic inside analysis.ts that walks heading/text/code/image
 * nodes so we extract real titles instead of regex-scanning raw markdown.
 */
export function markdownNodeText(node: MarkdownNode): string {
  if (node.type === "text" || node.type === "inlineCode" || node.type === "code") {
    return normalizeWhitespace(node.value ?? "");
  }
  if (node.type === "image") {
    return normalizeWhitespace(node.alt ?? "");
  }
  if (node.type === "break" || node.type === "thematicBreak") {
    return " ";
  }
  return normalizeWhitespace((node.children ?? []).map((child) => markdownNodeText(child)).join(" "));
}

/**
 * Returns the plain text of the first `heading` node in the parsed markdown,
 * or undefined when the source contains no heading. This replaces the
 * previous regex-based approach (`/^#+\s+(.+)$/m`) which matched substrings
 * anywhere in the file and ignored mdast parsing rules like escape
 * sequences and fenced code blocks that may contain `#` characters.
 */
export function firstMarkdownHeading(text: string): string | undefined {
  const nodes = parseMarkdownNodes(text);
  for (const node of nodes) {
    if (node.type === "heading") {
      const title = markdownNodeText(node).trim();
      if (title) {
        return title;
      }
    }
  }
  return undefined;
}
