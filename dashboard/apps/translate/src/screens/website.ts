/**
 * A fetched web page, as text the screen can translate and draw itself.
 *
 * The HTML is parsed by the browser's own parser into an inert document
 * (`DOMParser` runs no script and loads nothing), and only text leaves it:
 * headings, paragraphs, list items, quotes, code and table cells, in reading
 * order, each with the address it links to when the whole block is one link.
 * The screen renders those as its own elements, so no markup from the page is
 * ever put on screen - there is nothing to sanitize because nothing of the
 * page's HTML is kept.
 */

export type BlockTag = "h1" | "h2" | "h3" | "h4" | "p" | "li" | "quote" | "pre" | "cell";

export interface PageBlock {
    readonly tag: BlockTag;
    readonly text: string;
    /** An absolute http(s) address, when the block is a link and nothing else. */
    readonly href: string | null;
}

export interface ReadPage {
    readonly title: string;
    readonly blocks: PageBlock[];
}

/** The most blocks kept from one page. */
export const BLOCKS_MAX = 1500;
/** The most characters kept from one block. */
export const BLOCK_TEXT_MAX = 5000;

/** Never read: what runs, what draws, and what is only there to be typed into. */
const SKIPPED = new Set([
    "script",
    "style",
    "noscript",
    "template",
    "svg",
    "canvas",
    "iframe",
    "object",
    "embed",
    "video",
    "audio",
    "picture",
    "img",
    "form",
    "button",
    "input",
    "select",
    "textarea",
    "head",
    "link",
    "meta"
]);

const BLOCKS: Readonly<Record<string, BlockTag>> = {
    h1: "h1",
    h2: "h2",
    h3: "h3",
    h4: "h4",
    h5: "h4",
    h6: "h4",
    p: "p",
    li: "li",
    dt: "p",
    dd: "p",
    blockquote: "quote",
    pre: "pre",
    figcaption: "p",
    caption: "p",
    td: "cell",
    th: "cell"
};

/** Elements that hold blocks; text sitting straight inside one is a paragraph. */
const CONTAINERS = new Set([
    "div",
    "section",
    "article",
    "main",
    "header",
    "footer",
    "aside",
    "nav",
    "body",
    "ul",
    "ol",
    "dl",
    "table",
    "thead",
    "tbody",
    "tfoot",
    "tr",
    "figure",
    "details",
    "summary",
    "address",
    "center"
]);

/** An address a reader may be sent to: absolute, http or https, or nothing. */
export function safeHref(raw: string | null, base: string): string | null {
    if (!raw) return null;
    try {
        const url = new URL(raw, base);
        return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
    } catch {
        return null;
    }
}

function hidden(element: Element): boolean {
    return (
        element.hasAttribute("hidden") ||
        element.getAttribute("aria-hidden") === "true" ||
        /display\s*:\s*none|visibility\s*:\s*hidden/i.test(element.getAttribute("style") ?? "")
    );
}

function clean(text: string, keepLines: boolean): string {
    const out = keepLines
        ? text
              .replace(/\r\n?/g, "\n")
              .replace(/[ \t]+$/gm, "")
              .replace(/^\n+|\n+$/g, "")
        : text.replace(/\s+/g, " ").trim();
    return out.slice(0, BLOCK_TEXT_MAX);
}

/** The text of an element, minus whatever is never read. */
function textOf(node: Node): string {
    if (node.nodeType === 3) return node.nodeValue ?? "";
    if (node.nodeType !== 1) return "";
    const element = node as Element;
    const name = element.localName;
    if (SKIPPED.has(name) || hidden(element)) return "";
    if (name === "br") return "\n";
    let out = "";
    for (const child of Array.from(element.childNodes)) out += textOf(child);
    return out;
}

function hasBlockInside(element: Element): boolean {
    for (const child of Array.from(element.children)) {
        const name = child.localName;
        if (SKIPPED.has(name)) continue;
        if (BLOCKS[name] || CONTAINERS.has(name) || hasBlockInside(child)) return true;
    }
    return false;
}

/** The one link a block is, or null when it is text with links in it or none. */
function wholeLink(element: Element, text: string, base: string): string | null {
    const anchor = element.localName === "a" ? element : element.querySelector("a[href]");
    if (!anchor) return null;
    if (clean(textOf(anchor), false) !== text) return null;
    return safeHref(anchor.getAttribute("href"), base);
}

/**
 * The readable text of a parsed page, in order. The page's `<main>` or single
 * `<article>` when it has one - the part a reader came for - and the whole body
 * otherwise.
 */
export function readPage(doc: Document, base: string): ReadPage {
    const title = clean(doc.querySelector("title")?.textContent ?? "", false);
    const articles = doc.querySelectorAll("article");
    const root =
        doc.querySelector("main") ?? (articles.length === 1 ? articles[0]! : null) ?? doc.body;
    const blocks: PageBlock[] = [];
    const push = (tag: BlockTag, element: Element, text: string) => {
        if (!text || blocks.length >= BLOCKS_MAX) return;
        blocks.push({ tag, text, href: wholeLink(element, text, base) });
    };

    const walk = (element: Element) => {
        if (blocks.length >= BLOCKS_MAX) return;
        const name = element.localName;
        if (SKIPPED.has(name) || hidden(element)) return;
        const tag = BLOCKS[name];
        if (tag && (tag === "pre" || !hasBlockInside(element))) {
            push(tag, element, clean(textOf(element), tag === "pre"));
            return;
        }
        if (!tag && !CONTAINERS.has(name) && !hasBlockInside(element)) {
            // An inline element straight inside a container: part of the run
            // of loose text the container holds, gathered below.
            return;
        }
        // Loose text and inline elements between blocks read as paragraphs.
        let run: Node[] = [];
        const flush = () => {
            if (run.length === 0) return;
            const text = clean(run.map(textOf).join(""), false);
            const holder = run.find((node) => node.nodeType === 1) as Element | undefined;
            if (text) {
                const only = run.filter(
                    (node) => node.nodeType === 1 || (node.nodeValue ?? "").trim()
                );
                const link =
                    only.length === 1 && holder && holder.localName === "a"
                        ? safeHref(holder.getAttribute("href"), base)
                        : null;
                if (blocks.length < BLOCKS_MAX) blocks.push({ tag: "p", text, href: link });
            }
            run = [];
        };
        for (const child of Array.from(element.childNodes)) {
            if (child.nodeType === 1) {
                const inner = child as Element;
                const childName = inner.localName;
                if (SKIPPED.has(childName) || hidden(inner)) continue;
                if (BLOCKS[childName] || CONTAINERS.has(childName) || hasBlockInside(inner)) {
                    flush();
                    walk(inner);
                    continue;
                }
            }
            if (child.nodeType === 1 || child.nodeType === 3) run.push(child);
        }
        flush();
    };

    if (root) walk(root);
    return { title, blocks };
}

/** Parse fetched HTML inert and read it. */
export function readHtml(html: string, base: string): ReadPage {
    const doc = new DOMParser().parseFromString(html, "text/html");
    return readPage(doc, base);
}
