/**
 * The little markdown an announcement may carry: paragraphs, "- " bullets,
 * **bold**, *italic*, `code` and [links](https://...).
 *
 * Parsed into tokens and drawn as React elements, never as HTML, so nothing an
 * administrator types can become markup; a link is kept only when it is a path
 * inside Polaris or https. Client-safe and pure.
 */

import { safeLink } from "./schema";

export type Inline =
    | { kind: "text"; text: string }
    | { kind: "bold"; text: string }
    | { kind: "italic"; text: string }
    | { kind: "code"; text: string }
    | { kind: "link"; text: string; href: string };

export type Block = { kind: "paragraph"; lines: Inline[][] } | { kind: "list"; items: Inline[][] };

const INLINE = /\*\*([^*]+)\*\*|\*([^*]+)\*|_([^_]+)_|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;

export function parseInline(text: string): Inline[] {
    const out: Inline[] = [];
    let last = 0;
    for (const match of text.matchAll(INLINE)) {
        const at = match.index ?? 0;
        if (at > last) out.push({ kind: "text", text: text.slice(last, at) });
        const [whole, bold, star, under, code, label, href] = match;
        if (bold) out.push({ kind: "bold", text: bold });
        else if (star || under) out.push({ kind: "italic", text: (star ?? under)! });
        else if (code) out.push({ kind: "code", text: code });
        else if (label && href) {
            out.push(
                safeLink(href) ? { kind: "link", text: label, href } : { kind: "text", text: whole }
            );
        }
        last = at + whole.length;
    }
    if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
    return out;
}

export function parseMarkdown(source: string): Block[] {
    const blocks: Block[] = [];
    for (const chunk of source.replace(/\r\n?/g, "\n").split(/\n{2,}/)) {
        const lines = chunk.split("\n").filter((line) => line.trim().length > 0);
        if (lines.length === 0) continue;
        if (lines.every((line) => /^\s*[-*]\s+/.test(line))) {
            blocks.push({
                kind: "list",
                items: lines.map((line) => parseInline(line.replace(/^\s*[-*]\s+/, "")))
            });
        } else {
            blocks.push({ kind: "paragraph", lines: lines.map((line) => parseInline(line)) });
        }
    }
    return blocks;
}

/** The same text with the marks taken out, for the bell and mail. */
export function plainText(source: string): string {
    return parseMarkdown(source)
        .map((block) =>
            block.kind === "list"
                ? block.items.map((item) => `- ${item.map((one) => one.text).join("")}`).join("\n")
                : block.lines.map((line) => line.map((one) => one.text).join("")).join("\n")
        )
        .join("\n\n");
}
