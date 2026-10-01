/**
 * A small XML reader for WebDAV responses.
 *
 * CalDAV servers answer in XML whose namespace prefixes are the server's own
 * choice: `<d:multistatus xmlns:d="DAV:">` from one, `<multistatus
 * xmlns="DAV:">` from another, `<x:multistatus xmlns:x="DAV:">` from a third.
 * Matching on prefixes breaks on the next server, so this reads the document
 * into elements named by `(namespace URI, local name)`, resolving each prefix in
 * the scope it was declared in.
 *
 * Deliberately not a general XML parser: there is no DTD processing at all. A
 * `<!DOCTYPE>` is skipped as an opaque block and an entity reference that is not
 * one of the five predefined ones or a character reference is kept as literal
 * text, so an external entity or an entity expansion bomb has nothing to act on
 * - safe by construction rather than by a flag somebody could turn off.
 */

/** One element, named by its namespace URI (empty for none) and local name. */
export interface XmlElement {
    readonly ns: string;
    readonly local: string;
    /** Attributes keyed by local name when unprefixed, `{ns}local` otherwise. */
    readonly attrs: ReadonlyMap<string, string>;
    readonly children: readonly XmlElement[];
    /** The element's own text (character data and CDATA), not its children's. */
    readonly text: string;
}

/** A document the reader refused, with where it gave up. */
export class XmlError extends Error {
    constructor(message: string, position: number) {
        super(`${message} at offset ${position}`);
        this.name = "XmlError";
    }
}

/** Deeper than any DAV response nests; a guard against a hostile document. */
const MAX_DEPTH = 256;

const XML_NS = "http://www.w3.org/XML/1998/namespace";

interface MutableElement {
    ns: string;
    local: string;
    attrs: Map<string, string>;
    children: MutableElement[];
    text: string;
    qname: string;
    scope: Map<string, string>;
}

const PREDEFINED: Readonly<Record<string, string>> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'"
};

/** Decodes the five predefined entities and character references; anything else stays literal. */
export function decodeEntities(text: string): string {
    if (!text.includes("&")) return text;
    return text.replace(
        /&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9._-]*);/g,
        (whole, body: string) => {
            if (body.startsWith("#")) {
                const code =
                    body[1] === "x"
                        ? Number.parseInt(body.slice(2), 16)
                        : Number.parseInt(body.slice(1), 10);
                const valid =
                    code === 0x9 ||
                    code === 0xa ||
                    code === 0xd ||
                    (code >= 0x20 && code <= 0xd7ff) ||
                    (code >= 0xe000 && code <= 0xfffd) ||
                    (code >= 0x10000 && code <= 0x10ffff);
                return valid ? String.fromCodePoint(code) : whole;
            }
            return PREDEFINED[body] ?? whole;
        }
    );
}

/** Splits `p:local` into its prefix ("" for none) and local name. */
function splitName(qname: string): { prefix: string; local: string } {
    const colon = qname.indexOf(":");
    return colon < 0
        ? { prefix: "", local: qname }
        : { prefix: qname.slice(0, colon), local: qname.slice(colon + 1) };
}

const NAME = /^[A-Za-z_À-￿][A-Za-z0-9._:·À-￿-]*/;

/**
 * Reads a document into its root element.
 *
 * Throws `XmlError` on anything malformed: an unclosed tag, a mismatched end
 * tag, an undeclared prefix, text or a second element after the root.
 */
export function parseXml(input: string): XmlElement {
    const src = input.replace(/\r\n?/g, "\n");
    let pos = src.charCodeAt(0) === 0xfeff ? 1 : 0;
    const stack: MutableElement[] = [];
    let root: MutableElement | null = null;
    const rootScope = new Map<string, string>([["xml", XML_NS]]);

    const fail = (message: string): never => {
        throw new XmlError(message, pos);
    };

    const appendText = (text: string, raw: boolean) => {
        const top = stack[stack.length - 1];
        if (!top) {
            if (text.trim() !== "") fail("Text outside the root element");
            return;
        }
        top.text += raw ? text : decodeEntities(text);
    };

    while (pos < src.length) {
        const lt = src.indexOf("<", pos);
        if (lt < 0) {
            appendText(src.slice(pos), false);
            break;
        }
        if (lt > pos) appendText(src.slice(pos, lt), false);
        pos = lt;

        if (src.startsWith("<!--", pos)) {
            const end = src.indexOf("-->", pos + 4);
            if (end < 0) fail("Unclosed comment");
            pos = end + 3;
            continue;
        }
        if (src.startsWith("<![CDATA[", pos)) {
            const end = src.indexOf("]]>", pos + 9);
            if (end < 0) fail("Unclosed CDATA section");
            appendText(src.slice(pos + 9, end), true);
            pos = end + 3;
            continue;
        }
        if (src.startsWith("<?", pos)) {
            const end = src.indexOf("?>", pos + 2);
            if (end < 0) fail("Unclosed processing instruction");
            pos = end + 2;
            continue;
        }
        if (src.startsWith("<!", pos)) {
            // A DOCTYPE (or any other declaration) is skipped whole, internal
            // subset included, without reading a single declaration in it.
            if (stack.length > 0 || root) fail("Declaration inside the document");
            let depth = 0;
            let i = pos + 2;
            let quote = "";
            for (; i < src.length; i++) {
                const c = src[i];
                if (quote) {
                    if (c === quote) quote = "";
                } else if (c === '"' || c === "'") quote = c;
                else if (c === "[") depth++;
                else if (c === "]") depth--;
                else if (c === ">" && depth <= 0) break;
            }
            if (i >= src.length) fail("Unclosed declaration");
            pos = i + 1;
            continue;
        }
        if (src.startsWith("</", pos)) {
            const end = src.indexOf(">", pos + 2);
            if (end < 0) fail("Unclosed end tag");
            const qname = src.slice(pos + 2, end).trim();
            const top = stack.pop();
            if (!top || top.qname !== qname) fail(`Unexpected end tag </${qname}>`);
            pos = end + 1;
            continue;
        }

        // A start tag.
        pos++;
        const nameMatch = NAME.exec(src.slice(pos, pos + 512));
        if (!nameMatch) fail("Malformed tag name");
        const qname = nameMatch![0];
        pos += qname.length;
        const rawAttrs: [string, string][] = [];
        let selfClosing = false;
        for (;;) {
            while (pos < src.length && /\s/.test(src[pos]!)) pos++;
            if (pos >= src.length) fail("Unclosed start tag");
            if (src.startsWith("/>", pos)) {
                selfClosing = true;
                pos += 2;
                break;
            }
            if (src[pos] === ">") {
                pos++;
                break;
            }
            const attrMatch = NAME.exec(src.slice(pos, pos + 512));
            if (!attrMatch) fail("Malformed attribute");
            const attrName = attrMatch![0];
            pos += attrName.length;
            while (pos < src.length && /\s/.test(src[pos]!)) pos++;
            if (src[pos] !== "=") fail("Attribute without a value");
            pos++;
            while (pos < src.length && /\s/.test(src[pos]!)) pos++;
            const quote = src[pos];
            if (quote !== '"' && quote !== "'") fail("Unquoted attribute value");
            const close = src.indexOf(quote!, pos + 1);
            if (close < 0) fail("Unclosed attribute value");
            const value = src.slice(pos + 1, close);
            if (value.includes("<")) fail("'<' in an attribute value");
            rawAttrs.push([attrName, decodeEntities(value)]);
            pos = close + 1;
        }

        const parent = stack[stack.length - 1];
        if (!parent && root) fail("A second root element");
        if (stack.length >= MAX_DEPTH) fail("Document nested too deeply");
        const scope = new Map(parent ? parent.scope : rootScope);
        for (const [name, value] of rawAttrs) {
            if (name === "xmlns") scope.set("", value);
            else if (name.startsWith("xmlns:")) {
                const prefix = name.slice(6);
                if (value === "") fail(`Empty namespace for prefix ${prefix}`);
                scope.set(prefix, value);
            }
        }
        const { prefix, local } = splitName(qname);
        const ns = scope.get(prefix);
        if (ns === undefined && prefix !== "") fail(`Undeclared namespace prefix ${prefix}`);
        const attrs = new Map<string, string>();
        for (const [name, value] of rawAttrs) {
            if (name === "xmlns" || name.startsWith("xmlns:")) continue;
            const split = splitName(name);
            if (split.prefix === "") attrs.set(split.local, value);
            else {
                const attrNs = scope.get(split.prefix);
                if (attrNs === undefined) fail(`Undeclared namespace prefix ${split.prefix}`);
                attrs.set(`{${attrNs}}${split.local}`, value);
            }
        }
        const element: MutableElement = {
            ns: ns ?? "",
            local,
            attrs,
            children: [],
            text: "",
            qname,
            scope
        };
        if (parent) parent.children.push(element);
        else root = element;
        if (!selfClosing) stack.push(element);
    }

    if (stack.length > 0) fail(`Unclosed element <${stack[stack.length - 1]!.qname}>`);
    if (!root) fail("No root element");
    return root!;
}

/** The first child named `(ns, local)`, or null. */
export function child(
    element: XmlElement | null | undefined,
    ns: string,
    local: string
): XmlElement | null {
    return element?.children.find((c) => c.ns === ns && c.local === local) ?? null;
}

/** Every child named `(ns, local)`. */
export function childrenOf(
    element: XmlElement | null | undefined,
    ns: string,
    local: string
): XmlElement[] {
    return element ? element.children.filter((c) => c.ns === ns && c.local === local) : [];
}

/** The text of an element and all its descendants, in document order. */
export function textContent(element: XmlElement | null | undefined): string {
    if (!element) return "";
    if (element.children.length === 0) return element.text;
    // Own text is kept as one string, so interleaving is not preserved; DAV
    // values are either text or elements, never both, so this is enough.
    return element.text + element.children.map(textContent).join("");
}

/** Escapes text for use inside an element or a double-quoted attribute. */
export function escapeXml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}
