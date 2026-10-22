/**
 * The history under a message, folded away behind "...".
 *
 * Gmail's "Show trimmed content": a reply or a forward carries the message it
 * answers, and the writer sees an empty line to write on with a small pill under
 * it rather than a screen of somebody else's words; a message read in a
 * conversation hides the copy of the conversation it quotes. The markers read
 * here are the ones Mailgun's talon and GitHub's email_reply_parser settled on -
 * an "On ... wrote:" line over a quoted block, Outlook's "From: / Sent:" header,
 * and the classes the big clients put around their quote.
 *
 * Two halves, both pure apart from the HTML parser the reader one needs:
 *
 * - **The composer** splits its own Markdown body in two and joins it back
 *   exactly, so a message whose quote was never opened is sent as the very
 *   string it would have been sent as before.
 * - **The reader** decides what a received message looks like with its history
 *   trimmed. It is conservative on purpose: it never trims a message down to
 *   nothing, never trims a forwarded message (there the "history" is the
 *   message), and never hides an answer written between quoted lines.
 */

/** A body split at the history it carries. `head` is what the writer edits;
 *  `tail` is the quote or the forwarded block, starting at its first line. */
export interface TrimmedBody {
    readonly head: string;
    readonly tail: string;
}

/** A line as the writer sees it: the editor escapes a hyphen or an angle
 *  bracket at the start of a line, and that changes nothing about what it says. */
function plainLine(line: string): string {
    return line.replace(/\\(?=[-<>_*[\]()!#.+`~|])/g, "").trim();
}

/** The attribution line `quoteForReply` writes. */
const ATTRIBUTION = /^On .+ wrote:$/;

/** The header line `forwardSeed` writes, with or without the editor's escapes. */
const FORWARD_HEADER = /^-{3,}\s*Forwarded message\s*-{3,}$/;

/** The signature delimiter, which may sit under a quote. */
const DELIMITER = "-- ";

/**
 * Where the history in a composer body starts, or -1.
 *
 * A reply's attribution counts only with a quoted line under it, so a sentence
 * of the writer's own that happens to end in "wrote:" is left alone.
 */
function historyStart(lines: readonly string[]): number {
    for (let index = 0; index < lines.length; index += 1) {
        const line = plainLine(lines[index] ?? "");
        if (FORWARD_HEADER.test(line)) return index;
        if (!ATTRIBUTION.test(line)) continue;
        const next = lines.slice(index + 1).find((one) => one.trim() !== "");
        if (next?.trimStart().startsWith(">")) return index;
    }
    return -1;
}

/**
 * Whether a reply's history is still only a quote: the attribution, quoted
 * lines, and at most a signature under them.
 *
 * A reopened draft is trimmed again only then. Somebody who opened the quote to
 * answer between its lines left lines of their own in it, and folding those
 * away would hide what they wrote.
 */
function onlyQuoted(tail: string): boolean {
    const [first = "", ...rest] = tail.split("\n");
    if (FORWARD_HEADER.test(plainLine(first))) return true;
    for (const line of rest) {
        if (line === DELIMITER) return true;
        if (line.trim() !== "" && !line.trimStart().startsWith(">")) return false;
    }
    return true;
}

/**
 * The composer body split at its history, or null when there is nothing to
 * trim.
 *
 * `reopened` is a draft coming back: it is trimmed only while its history is
 * still the shape it was written in (see `onlyQuoted`).
 */
export function trimComposerBody(body: string, reopened: boolean): TrimmedBody | null {
    const lines = body.split("\n");
    const start = historyStart(lines);
    if (start < 0) return null;
    const head = lines.slice(0, start).join("\n") + (start > 0 ? "\n" : "");
    const tail = lines.slice(start).join("\n");
    if (reopened && !onlyQuoted(tail)) return null;
    return { head, tail };
}

/**
 * The whole body again.
 *
 * A head nobody touched still ends in the blank line it was cut with, and is put
 * back exactly. One the editor has written back has lost its trailing break, and
 * gets the blank line a paragraph needs before the history.
 */
export function joinComposerBody(head: string, tail: string): string {
    if (!tail) return head;
    if (head.endsWith("\n\n") || head === "") return `${head}${tail}`;
    return `${head.replace(/\s+$/, "")}\n\n${tail}`;
}

/** Words that say the history IS the message: a forward. */
const FORWARDED = /forwarded message|begin forwarded message|mensaje reenviado/i;

/** An Outlook header block's subject line naming a forward. */
const FORWARDED_SUBJECT =
    /(?:^|\n)\s*(?:subject|asunto)\s*:\s*(?:fw|fwd|rv)\s*:/i;

/** The line a forward's header opens with, in plain text. */
const FORWARD_DIVIDER =
    /^(?:-{2,}.*(?:forwarded message|mensaje reenviado)|begin forwarded message:)/i;

/** An attribution line in any of the forms clients write it. */
const WROTE = /(?:wrote|escribió|a écrit|schrieb|ha scritto)\s*:\s*$/i;

/** The words an attribution wrapped over two lines starts with. */
const ATTRIBUTION_OPENS = /^(?:On|El|Le|Am|Il)\s/;

/** The headers Outlook writes above the message it answers. */
const HEADER_FROM = /^\*?(?:from|de)\s*:\*?\s/i;
const HEADER_SENT = /^\*?(?:sent|date|enviado|fecha)\s*:\*?\s/i;
const HEADER_TO = /^\*?(?:to|para|subject|asunto)\s*:\*?\s/i;
const ORIGINAL_MESSAGE = /^-{2,}\s*(?:original message|mensaje original)\s*-{2,}$/i;

/**
 * A plain-text message without its history, or null when it should be shown
 * whole.
 *
 * Two shapes: Outlook's divider ("-----Original Message-----", or a "From:"
 * line with a "Sent:" under it), after which everything is history; and a
 * trailing quoted block under an attribution line. Quoting without an
 * attribution is left alone - that is somebody answering point by point.
 */
export function trimReceivedText(text: string): string | null {
    const lines = text.split(/\r?\n/);
    let cut = -1;

    for (let index = 0; index < lines.length; index += 1) {
        const line = (lines[index] ?? "").trim();
        if (ORIGINAL_MESSAGE.test(line)) {
            cut = index;
            break;
        }
        const below = lines.slice(index + 1, index + 6).map((next) => next.trim());
        // A "From:" and a date alone could be an itinerary; a header also names
        // who it went to or what it was about.
        if (
            HEADER_FROM.test(line) &&
            below.some((next) => HEADER_SENT.test(next)) &&
            below.some((next) => HEADER_TO.test(next))
        ) {
            cut = index;
            // Outlook draws a rule of underscores over the header.
            const above = (lines[index - 1] ?? "").trim();
            if (/^_{5,}$/.test(above)) cut = index - 1;
            const header = lines.slice(index, index + 6).join("\n");
            if (FORWARDED_SUBJECT.test(header)) return null;
            break;
        }
    }

    if (cut < 0) {
        let end = lines.length - 1;
        while (end >= 0 && (lines[end] ?? "").trim() === "") end -= 1;
        let start = end;
        while (start >= 0) {
            const line = (lines[start] ?? "").trim();
            if (line !== "" && !line.startsWith(">")) break;
            start -= 1;
        }
        // `start` is now the line above the quoted block.
        if (start === end) return null;
        while (start >= 0 && (lines[start] ?? "").trim() === "") start -= 1;
        const said = (lines[start] ?? "").trim();
        if (!WROTE.test(said)) return null;
        cut = start;
        const above = (lines[start - 1] ?? "").trim();
        if (!ATTRIBUTION_OPENS.test(said) && ATTRIBUTION_OPENS.test(above)) cut = start - 1;
    }

    if (FORWARDED.test(lines.slice(cut, cut + 3).join("\n"))) return null;
    // A quote inside a forwarded message is part of what was forwarded.
    if (lines.slice(0, cut).some((line) => FORWARD_DIVIDER.test(line.trim()))) return null;
    const fresh = lines.slice(0, cut).join("\n").replace(/\s+$/, "");
    return fresh.trim() ? fresh : null;
}

/** The elements the big clients wrap the message they answer in. */
const QUOTE_CONTAINERS = [
    ".gmail_quote_container",
    ".gmail_quote",
    ".yahoo_quoted",
    "blockquote[type='cite']",
    "#divRplyFwdMsg",
    "#appendonsend"
].join(",");

/** Whether an element is Outlook's own header block over the message it
 *  answers: a rule along its top and a "From:" line first. */
function isOutlookHeader(element: Element): boolean {
    const style = element.getAttribute("style") ?? "";
    if (!/border-top\s*:\s*solid\s+#(?:e1e1e1|b5c4df)/i.test(style)) return false;
    return /^\s*(?:from|de)\s*:/i.test(element.textContent ?? "");
}

/** Whether an element is an attribution line standing on its own. */
function isAttribution(node: Node): boolean {
    if (node.nodeType !== 1 && node.nodeType !== 3) return false;
    const element = node as Element;
    if (node.nodeType === 1 && element.classList.contains("moz-cite-prefix")) return true;
    const text = (node.textContent ?? "").trim();
    return text.length < 400 && WROTE.test(text);
}

/** Whether a node carries something a reader would call content. */
function meaningful(node: Node): boolean {
    if (node.nodeType === 3) return (node.textContent ?? "").trim() !== "";
    if (node.nodeType !== 1) return false;
    const element = node as Element;
    if ((element.textContent ?? "").trim() !== "") return true;
    return element.matches("img, video, table") || element.querySelector("img, video") !== null;
}

/** Everything after `node` in document order, outside it. */
function following(node: Node): Node[] {
    const after: Node[] = [];
    for (let at: Node | null = node; at && at.nodeName !== "BODY"; at = at.parentNode) {
        for (let next = at.nextSibling; next; next = next.nextSibling) after.push(next);
    }
    return after;
}

/** Whether a node is the whitespace or line break between two blocks. */
function blank(node: Node): boolean {
    return !meaningful(node) || (node.nodeType === 1 && (node as Element).matches("br, hr"));
}

/** Where history starts for one marker: the marker, or the attribution line or
 *  Outlook rule standing just above it. */
function extendUp(marker: Element): Node {
    let start: Node = marker;
    let prev = marker.previousSibling;
    while (prev && blank(prev) && !(prev.nodeType === 1 && (prev as Element).matches("hr"))) {
        prev = prev.previousSibling;
    }
    if (prev && (isAttribution(prev) || (prev.nodeType === 1 && (prev as Element).matches("hr")))) {
        start = prev;
    }
    return start;
}

/**
 * An HTML message without its history, or null when it should be shown whole.
 *
 * Only removes nodes from the parsed document - nothing is written into it - and
 * what it returns still goes through the sanitizer before it is drawn.
 */
export function trimReceivedHtml(html: string): string | null {
    if (typeof DOMParser === "undefined") return null;
    const doc = new DOMParser().parseFromString(html, "text/html");
    const body = doc.body;

    const markers: { element: Element; divider: boolean }[] = [];
    for (const element of Array.from(body.querySelectorAll(QUOTE_CONTAINERS))) {
        // The outermost one only: Gmail nests its quote in a container, and a
        // quote quotes quotes.
        if (element.parentElement?.closest(QUOTE_CONTAINERS)) continue;
        const divider = element.matches("#divRplyFwdMsg, #appendonsend");
        markers.push({ element, divider });
    }
    for (const element of Array.from(body.querySelectorAll("div"))) {
        if (isOutlookHeader(element) && !element.parentElement?.closest(QUOTE_CONTAINERS)) {
            markers.push({ element, divider: true });
        }
    }
    markers.sort((one, other) =>
        one.element.compareDocumentPosition(other.element) & 4 ? -1 : 1
    );

    for (const { element, divider } of markers) {
        const start = extendUp(element);
        // Only the opening: a reply whose history somewhere deep down holds a
        // forward is still a reply.
        const opening = (element.textContent ?? "").slice(0, 240);
        if (FORWARDED.test(opening) || FORWARDED.test(start.textContent ?? "")) continue;
        if (divider && FORWARDED_SUBJECT.test(opening)) continue;
        // A quote with an answer after it is somebody replying between the
        // lines; only the history at the end of a message is trimmed.
        const after = following(element);
        if (!divider && after.some(meaningful)) continue;

        for (const node of after) node.parentNode?.removeChild(node);
        // The attribution or rule above it, and the breaks between them.
        for (let node: Node | null = start; node && node !== element; ) {
            const next: Node | null = node.nextSibling;
            node.parentNode?.removeChild(node);
            node = next;
        }
        element.parentNode?.removeChild(element);
        if (!meaningful(body)) return null;
        return body.innerHTML;
    }
    return null;
}
