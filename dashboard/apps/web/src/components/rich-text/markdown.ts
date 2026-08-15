/**
 * Markdown in, Markdown out.
 *
 * The editor is a rich surface but what it stores is Markdown, the way the rest
 * of Polaris already stores written text. That is the whole reason this file
 * exists: a description, a comment, a page and a note stay readable, diffable
 * and portable out of Polaris, and nothing has to be migrated to get formatting.
 *
 * One parse and one serializer, both pure, so they can be tested without a DOM
 * and so the read-only renderer shows exactly what the editor would. Anything
 * the schema does not model - a table, a block of raw HTML - is carried through
 * verbatim in a `markdownBlock` rather than dropped: an editor that eats what it
 * cannot draw is worse than one that shows it as source.
 */

import { marked } from "marked";
import * as refs from "./references";
import type { Token, Tokens } from "marked";
import type { JSONContent } from "@tiptap/core";

/**
 * The language on a line that is only a code fence, or null when the line is
 * not one.
 *
 * Its own function because a chat composer has to decide it on a keystroke, and
 * because "is this a fence" is the sort of thing that gets written three
 * slightly different ways. An empty string is a fence with no language, which is
 * a different answer from null.
 */
export function fenceLanguage(line: string): string | null {
    const match = /^\s*(?:```|~~~)([A-Za-z0-9_+#-]*)\s*$/.exec(line);
    return match ? (match[1] ?? "") : null;
}

/** A block whose Markdown the schema has no node for, kept as it was written. */
export const MARKDOWN_BLOCK = "markdownBlock";

/** The inline node behind a mention and a Polaris chip. */
export const REFERENCE = "reference";

// ---------------------------------------------------------------------------
// Markdown -> document
// ---------------------------------------------------------------------------

/**
 * Parse Markdown into the editor's document.
 *
 * @param markdown - The stored text.
 * @param origin - Where this Polaris answers, so an absolute link to it becomes
 *   a chip rather than a URL. Omitted on the server, where there is no window.
 */
export function markdownToDoc(markdown: string, origin: string | null = null): JSONContent {
    const content = blocks(marked.lexer(markdown ?? "", { gfm: true }), origin);
    return { type: "doc", content: content.length > 0 ? content : [{ type: "paragraph" }] };
}

function blocks(tokens: readonly Token[], origin: string | null): JSONContent[] {
    const out: JSONContent[] = [];
    for (const token of tokens) {
        const node = block(token, origin);
        if (node) out.push(node);
    }
    return out;
}

function block(token: Token, origin: string | null): JSONContent | null {
    switch (token.type) {
        case "space":
            return null;
        case "heading": {
            const heading = token as Tokens.Heading;
            return {
                type: "heading",
                attrs: { level: Math.min(Math.max(heading.depth, 1), 3) },
                content: inline(heading.tokens, origin)
            };
        }
        case "paragraph": {
            const paragraph = token as Tokens.Paragraph;
            return { type: "paragraph", content: inline(paragraph.tokens, origin) };
        }
        case "text": {
            const text = token as Tokens.Text;
            return { type: "paragraph", content: inline(text.tokens ?? [text], origin) };
        }
        case "code": {
            const code = token as Tokens.Code;
            return {
                type: "codeBlock",
                attrs: { language: (code.lang ?? "").trim().split(/\s+/)[0] || null },
                // Code carries whatever was written, entities included - the
                // parser escaped it on the way in and nothing here renders HTML.
                content: code.text ? [{ type: "text", text: decodeEntities(code.text) }] : undefined
            };
        }
        case "blockquote": {
            const quote = token as Tokens.Blockquote;
            return { type: "blockquote", content: blocks(quote.tokens, origin) };
        }
        case "hr":
            return { type: "horizontalRule" };
        case "list":
            return list(token as Tokens.List, origin);
        default:
            // Tables, raw HTML and link definitions land here. Keeping the source
            // is what makes the round trip lossless for text this editor cannot
            // draw, which is the difference between a viewer and a shredder. It
            // stays editable as the Markdown it is, rather than being frozen.
            return { type: MARKDOWN_BLOCK, content: textNode(token.raw.replace(/\n+$/, "")) };
    }
}

function list(token: Tokens.List, origin: string | null): JSONContent {
    const tasks = token.items.length > 0 && token.items.every((item) => item.task);
    if (tasks) {
        return {
            type: "taskList",
            content: token.items.map((item) => ({
                type: "taskItem",
                attrs: { checked: item.checked === true },
                content: listBody(item, origin)
            }))
        };
    }
    return {
        type: token.ordered ? "orderedList" : "bulletList",
        attrs: token.ordered ? { start: typeof token.start === "number" ? token.start : 1 } : undefined,
        content: token.items.map((item) => ({ type: "listItem", content: listBody(item, origin) }))
    };
}

/** A list item always holds blocks, so a bare run of text is wrapped in one. */
function listBody(item: Tokens.ListItem, origin: string | null): JSONContent[] {
    const content = blocks(item.tokens, origin);
    return content.length > 0 ? content : [{ type: "paragraph" }];
}

function inline(tokens: readonly Token[], origin: string | null): JSONContent[] {
    const out: JSONContent[] = [];
    for (const token of tokens) out.push(...inlineNodes(token, origin));
    return out;
}

function inlineNodes(token: Token, origin: string | null): JSONContent[] {
    switch (token.type) {
        case "text":
        case "escape":
        case "html": {
            const nested = (token as Tokens.Text).tokens;
            if (nested && nested.length > 0) return inline(nested, origin);
            return textNode((token as Tokens.Text).text ?? token.raw);
        }
        case "strong":
            return withMark(inline((token as Tokens.Strong).tokens, origin), { type: "bold" });
        case "em":
            return withMark(inline((token as Tokens.Em).tokens, origin), { type: "italic" });
        case "del":
            return withMark(inline((token as Tokens.Del).tokens, origin), { type: "strike" });
        case "codespan":
            return withMark(textNode((token as Tokens.Codespan).text), { type: "code" });
        case "br":
            return [{ type: "hardBreak" }];
        case "image": {
            const image = token as Tokens.Image;
            return [{ type: "image", attrs: { src: image.href, alt: image.text || null, title: image.title } }];
        }
        case "link": {
            const link = token as Tokens.Link;
            const target = refs.parseReferenceAddress(link.href) ?? refs.referenceFromUrl(link.href, origin);
            const label = link.text || link.href;
            if (target) {
                return [
                    {
                        type: REFERENCE,
                        attrs: {
                            kind: target.kind,
                            id: target.id,
                            label: label.replace(/^@/, "")
                        }
                    }
                ];
            }
            return withMark(inline(link.tokens, origin), {
                type: "link",
                attrs: { href: link.href, title: link.title ?? null }
            });
        }
        default:
            return textNode(token.raw);
    }
}

function textNode(text: string): JSONContent[] {
    const decoded = decodeEntities(text);
    return decoded ? [{ type: "text", text: decoded }] : [];
}

/**
 * Undo the HTML escaping the Markdown parser does on the way in.
 *
 * `marked` exists to produce HTML, so it turns `"` into `&quot;` and `&` into
 * `&amp;` before handing the text over. Polaris does not render HTML - the
 * document becomes React elements, and React escapes text itself - so those
 * entities arrive at the screen as the literal characters `&quot;`, which is
 * what somebody sees when they type a pair of quotation marks and get six
 * characters back.
 *
 * Decoding here rather than at the screen is what keeps the stored Markdown and
 * what is drawn from it the same text: the serializer writes the raw character
 * back out, so a round trip through the editor does not slowly turn every quote
 * into an entity.
 *
 * Safe by construction, and worth being explicit about since this reverses an
 * escape: what comes out is a *text node*. React sets it as text, which escapes
 * it again on the way to the DOM, and ProseMirror sets it as textContent. There
 * is no path here where a decoded `<script>` becomes an element - it becomes the
 * five characters somebody typed.
 *
 * Only the five HTML entities the parser actually emits, plus numeric escapes,
 * because a general entity table would also decode things nobody wrote.
 */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&#x27;": "'",
    "&#x2F;": "/",
    // Built rather than written: a literal non-breaking space in source is
    // invisible, and the next person here would take it for an ordinary
    // space and delete it.
    "&nbsp;": String.fromCharCode(160)
};

export function decodeEntities(text: string): string {
    if (!text.includes("&")) return text;
    return text.replace(/&(?:#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (entity) => {
        const named = NAMED_ENTITIES[entity.toLowerCase()] ?? NAMED_ENTITIES[entity];
        if (named !== undefined) return named;
        const numeric = /^&#(x)?([0-9a-fA-F]+);$/.exec(entity);
        if (!numeric) return entity;
        const code = Number.parseInt(numeric[2]!, numeric[1] ? 16 : 10);
        // Anything outside what a character can be, and the C0 controls, are
        // left as they were written rather than turned into something unprintable.
        if (!Number.isFinite(code) || code < 0x20 || code > 0x10ffff) return entity;
        return String.fromCodePoint(code);
    });
}

/** Adds a mark to every node that can carry one. */
function withMark(nodes: readonly JSONContent[], mark: { type: string; attrs?: Record<string, unknown> }): JSONContent[] {
    return nodes.map((node) =>
        node.type === "text" || node.type === REFERENCE
            ? { ...node, marks: [...(node.marks ?? []), mark] }
            : node
    );
}

/**
 * Everything a piece of text points at.
 *
 * Read on the server before a write is stored, so the people named in it can be
 * told. Goes through the same parse the editor uses rather than a regular
 * expression over the Markdown, so an address inside a code fence is not a
 * mention - which is exactly where somebody would paste one to avoid pinging.
 */
export function extractReferences(markdown: string): { kind: refs.ReferenceKind; id: string }[] {
    const found = new Map<string, { kind: refs.ReferenceKind; id: string }>();
    const walk = (node: JSONContent) => {
        if (node.type === REFERENCE && node.attrs?.kind && node.attrs?.id) {
            const kind = node.attrs.kind as refs.ReferenceKind;
            const id = String(node.attrs.id);
            found.set(`${kind}/${id}`, { kind, id });
        }
        for (const child of node.content ?? []) walk(child);
    };
    walk(markdownToDoc(markdown));
    return [...found.values()];
}

// ---------------------------------------------------------------------------
// Document -> Markdown
// ---------------------------------------------------------------------------

/** Serialize the editor's document back to the Markdown that is stored. */
export function docToMarkdown(doc: JSONContent | null | undefined): string {
    if (!doc?.content) return "";
    return renderBlocks(doc.content).trim();
}

/** The block types a list can nest, which are the ones that follow their
 *  parent's text on the very next line rather than after a blank one. */
const NESTED_LISTS = ["bulletList", "orderedList", "taskList"];

/**
 * @param nodes - The blocks to write.
 * @param tight - Inside a list item, where a blank line before a nested list
 *   would end the item and start a second list at the outer level.
 */
function renderBlocks(nodes: readonly JSONContent[], tight = false): string {
    const written = nodes.map((node) => ({ node, text: renderBlock(node) })).filter((entry) => entry.text.length > 0);
    return written
        .map((entry, index) => {
            if (index === 0) return entry.text;
            const gap = tight && NESTED_LISTS.includes(entry.node.type ?? "") ? "\n" : "\n\n";
            return `${gap}${entry.text}`;
        })
        .join("");
}

function renderBlock(node: JSONContent): string {
    switch (node.type) {
        case "heading": {
            const level = Math.min(Math.max(Number(node.attrs?.level ?? 1), 1), 3);
            return `${"#".repeat(level)} ${renderInline(node.content)}`.trimEnd();
        }
        case "paragraph":
            return renderInline(node.content);
        case "codeBlock": {
            const language = typeof node.attrs?.language === "string" ? node.attrs.language : "";
            return `\`\`\`${language}\n${plainText(node)}\n\`\`\``;
        }
        case "blockquote":
            return prefixLines(renderBlocks(node.content ?? []), "> ");
        case "horizontalRule":
            return "---";
        case "bulletList":
            return renderList(node, () => "- ");
        case "orderedList": {
            const start = Number(node.attrs?.start ?? 1) || 1;
            return renderList(node, (index) => `${start + index}. `);
        }
        case "taskList":
            return renderList(node, (_index, item) => (item.attrs?.checked ? "- [x] " : "- [ ] "));
        case MARKDOWN_BLOCK:
            return plainText(node);
        default:
            return node.content ? renderBlocks(node.content) : "";
    }
}

/** The text of a block that holds nothing else: a fence, or a carried-through
 *  piece of Markdown. */
function plainText(node: JSONContent): string {
    return (node.content ?? []).map((child) => child.text ?? "").join("");
}

/** Items are indented by the width of their own marker so nesting survives. */
function renderList(node: JSONContent, marker: (index: number, item: JSONContent) => string): string {
    return (node.content ?? [])
        .map((item, index) => {
            const bullet = marker(index, item);
            const body = renderBlocks(item.content ?? [], true);
            return `${bullet}${indentAfterFirst(body, " ".repeat(bullet.length))}`;
        })
        .join("\n");
}

function prefixLines(text: string, prefix: string): string {
    return text
        .split("\n")
        .map((line) => (line ? `${prefix}${line}` : prefix.trimEnd()))
        .join("\n");
}

function indentAfterFirst(text: string, indent: string): string {
    return text
        .split("\n")
        .map((line, index) => (index === 0 || !line ? line : `${indent}${line}`))
        .join("\n");
}

/** The order marks are written in: code sits closest to the text, a link
 *  furthest out, so `[**bold**](url)` comes back as it went in. */
const MARK_ORDER = ["code", "bold", "italic", "strike", "link"];

function renderInline(nodes: readonly JSONContent[] | undefined): string {
    return (nodes ?? []).map((node) => renderInlineNode(node)).join("");
}

function renderInlineNode(node: JSONContent): string {
    if (node.type === "hardBreak") return "\\\n";
    if (node.type === "image") {
        const attrs = node.attrs ?? {};
        const title = typeof attrs.title === "string" && attrs.title ? ` "${attrs.title}"` : "";
        return `![${attrs.alt ?? ""}](${attrs.src ?? ""}${title})`;
    }

    let text: string;
    if (node.type === REFERENCE) {
        const kind = node.attrs?.kind as refs.ReferenceKind;
        const id = String(node.attrs?.id ?? "");
        const label = String(node.attrs?.label ?? "");
        text = `[${refs.referenceSigil(kind)}${label}](${refs.referenceAddress(kind, id)})`;
    } else if (node.type === "text") {
        text = escapeText(node.text ?? "");
    } else {
        return renderInline(node.content);
    }

    // A reference is already a link, so wrapping it in another one would nest
    // brackets into something no parser reads back.
    const marks = [...(node.marks ?? [])].sort(
        (left, right) => MARK_ORDER.indexOf(left.type) - MARK_ORDER.indexOf(right.type)
    );
    for (const mark of marks) {
        if (node.type === REFERENCE && mark.type === "link") continue;
        text = applyMark(text, mark);
    }
    return text;
}

function applyMark(text: string, mark: { type: string; attrs?: Record<string, unknown> | null }): string {
    switch (mark.type) {
        case "bold":
            return `**${text}**`;
        case "italic":
            return `*${text}*`;
        case "strike":
            return `~~${text}~~`;
        case "code":
            // Written raw: backticks are the escape, so the text inside must not
            // carry the backslashes `escapeText` would have added.
            return `\`${text.replace(/\\([\\`*_[\]#>~])/g, "$1")}\``;
        case "link": {
            const href = String(mark.attrs?.href ?? "");
            const title = typeof mark.attrs?.title === "string" && mark.attrs.title ? ` "${mark.attrs.title}"` : "";
            return `[${text}](${href}${title})`;
        }
        default:
            return text;
    }
}

/** Escapes what would otherwise be read back as formatting. */
function escapeText(text: string): string {
    return text
        .replace(/([\\`*[\]])/g, "\\$1")
        .replace(/^(\s*)([#>+-])/gm, "$1\\$2")
        .replace(/^(\s*\d+)\./gm, "$1\\.");
}
