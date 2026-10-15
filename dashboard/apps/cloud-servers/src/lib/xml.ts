/**
 * Just enough XML to read EC2's answers: elements, text, entities and CDATA.
 *
 * The EC2 Query API answers in XML and the dashboard carries no XML parser an app
 * may use. This is a real tokenizer rather than pattern matching on tags, so
 * nesting, empty elements and escaped text come out right; what it leaves out
 * (attributes' values, namespaces, processing instructions, DTDs) is what EC2's
 * responses do not use for data. A malformed document throws.
 *
 * Pure.
 */

export interface XmlNode {
    readonly name: string;
    readonly children: XmlNode[];
    text: string;
}

const ENTITIES: Readonly<Record<string, string>> = {
    lt: "<",
    gt: ">",
    amp: "&",
    quot: '"',
    apos: "'"
};

function decode(raw: string): string {
    return raw.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (whole, entity: string) => {
        if (entity.startsWith("#x"))
            return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
        if (entity.startsWith("#"))
            return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
        return ENTITIES[entity] ?? whole;
    });
}

/** Parse a document into its root element. */
export function parseXml(source: string): XmlNode {
    const root: XmlNode = { name: "#document", children: [], text: "" };
    const stack: XmlNode[] = [root];
    let i = 0;
    while (i < source.length) {
        const open = source.indexOf("<", i);
        const textEnd = open === -1 ? source.length : open;
        if (textEnd > i) stack[stack.length - 1]!.text += decode(source.slice(i, textEnd));
        if (open === -1) break;
        if (source.startsWith("<?", open)) {
            i = expectEnd(source, "?>", open) + 2;
        } else if (source.startsWith("<!--", open)) {
            i = expectEnd(source, "-->", open) + 3;
        } else if (source.startsWith("<![CDATA[", open)) {
            const end = expectEnd(source, "]]>", open);
            stack[stack.length - 1]!.text += source.slice(open + 9, end);
            i = end + 3;
        } else if (source.startsWith("<!", open)) {
            i = expectEnd(source, ">", open) + 1;
        } else if (source.startsWith("</", open)) {
            const end = expectEnd(source, ">", open);
            const name = source.slice(open + 2, end).trim();
            const top = stack.pop();
            if (!top || top.name !== name || stack.length === 0) {
                throw new Error(`Unexpected closing tag </${name}>`);
            }
            i = end + 1;
        } else {
            const end = expectEnd(source, ">", open);
            const inner = source.slice(open + 1, end);
            const selfClosing = inner.endsWith("/");
            const name = (selfClosing ? inner.slice(0, -1) : inner).trim().split(/\s+/)[0] ?? "";
            if (!/^[A-Za-z_][\w.:-]*$/.test(name)) throw new Error("Malformed tag");
            const node: XmlNode = { name: localName(name), children: [], text: "" };
            stack[stack.length - 1]!.children.push(node);
            if (!selfClosing) stack.push(node);
            i = end + 1;
        }
    }
    if (stack.length !== 1) throw new Error("Unclosed element");
    const [first] = root.children;
    if (!first || root.children.length !== 1) throw new Error("A document has one root element");
    return first;
}

function expectEnd(source: string, token: string, from: number): number {
    const end = source.indexOf(token, from);
    if (end === -1) throw new Error("Unterminated markup");
    return end;
}

function localName(name: string): string {
    const colon = name.indexOf(":");
    return colon === -1 ? name : name.slice(colon + 1);
}

/** The first child with this name. */
export function child(node: XmlNode | undefined, name: string): XmlNode | undefined {
    return node?.children.find((c) => c.name === name);
}

/** The trimmed text of the child with this name, or null. */
export function textOf(node: XmlNode | undefined, name: string): string | null {
    const found = child(node, name);
    return found ? found.text.trim() : null;
}

/** The `<item>` elements under a `...Set` child, EC2's way of writing a list. */
export function items(node: XmlNode | undefined, setName: string): XmlNode[] {
    return child(node, setName)?.children.filter((c) => c.name === "item") ?? [];
}
