/**
 * Search and replace inside PHP-serialized values, the way WordPress stores
 * options and metadata.
 *
 * A serialized string records its length in bytes (`s:5:"hello";`), so a plain
 * replace that changes a string's length leaves a value PHP refuses to read,
 * and WordPress silently drops the setting. The technique the WordPress command
 * line converged on is followed instead: read the value into a tree, replace in
 * its strings, and write it back with every length counted again. Lengths are
 * bytes, not characters, so everything here works on bytes.
 *
 * A value that looks serialized but does not read as such - truncated, a
 * custom `C:` format, nesting past the limit - is returned untouched: changing
 * bytes in something that cannot be read back is how a site gets broken. A
 * value that is not serialized at all is replaced plainly.
 */

type Node =
    | { readonly kind: "raw"; readonly bytes: Buffer }
    | { readonly kind: "string"; readonly bytes: Buffer }
    | { readonly kind: "array"; readonly entries: readonly (readonly [Node, Node])[] }
    | { readonly kind: "object"; readonly className: Buffer; readonly entries: readonly (readonly [Node, Node])[] };

/** Deeper than any real option, shallow enough that a crafted value cannot
 *  exhaust the stack. */
const MAX_DEPTH = 256;

class Malformed extends Error {}

const COLON = 0x3a;
const SEMICOLON = 0x3b;
const QUOTE = 0x22;
const OPEN = 0x7b;
const CLOSE = 0x7d;

class Reader {
    public position = 0;

    public constructor(private readonly bytes: Buffer) {}

    public get done(): boolean {
        return this.position >= this.bytes.length;
    }

    public peek(): number {
        if (this.done) throw new Malformed();
        return this.bytes[this.position]!;
    }

    public expect(byte: number): void {
        if (this.peek() !== byte) throw new Malformed();
        this.position += 1;
    }

    /** An unsigned decimal, up to the next `stop` byte, which is consumed. */
    public count(stop: number): number {
        const start = this.position;
        while (!this.done && this.peek() >= 0x30 && this.peek() <= 0x39) this.position += 1;
        if (this.position === start || this.position - start > 10) throw new Malformed();
        const value = Number(this.bytes.subarray(start, this.position).toString("latin1"));
        this.expect(stop);
        return value;
    }

    /** Everything up to the next `;`, which is consumed. */
    public scalar(): Buffer {
        const end = this.bytes.indexOf(SEMICOLON, this.position);
        if (end < 0) throw new Malformed();
        const body = this.bytes.subarray(this.position, end);
        this.position = end + 1;
        return body;
    }

    public take(length: number): Buffer {
        if (this.position + length > this.bytes.length) throw new Malformed();
        const body = this.bytes.subarray(this.position, this.position + length);
        this.position += length;
        return body;
    }

    public from(start: number): Buffer {
        return this.bytes.subarray(start, this.position);
    }
}

const SCALAR_BODY: Record<string, RegExp> = {
    i: /^-?\d+$/,
    d: /^(?:-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|NAN|-?INF)$/,
    b: /^[01]$/,
    r: /^\d+$/,
    R: /^\d+$/
};

function readNode(reader: Reader, depth: number): Node {
    if (depth > MAX_DEPTH) throw new Malformed();
    const start = reader.position;
    const type = String.fromCharCode(reader.peek());
    reader.position += 1;
    switch (type) {
        case "N":
            reader.expect(SEMICOLON);
            return { kind: "raw", bytes: reader.from(start) };
        case "i":
        case "d":
        case "b":
        case "r":
        case "R": {
            reader.expect(COLON);
            if (!SCALAR_BODY[type]!.test(reader.scalar().toString("latin1"))) throw new Malformed();
            return { kind: "raw", bytes: reader.from(start) };
        }
        case "s": {
            reader.expect(COLON);
            const length = reader.count(COLON);
            reader.expect(QUOTE);
            const bytes = reader.take(length);
            reader.expect(QUOTE);
            reader.expect(SEMICOLON);
            return { kind: "string", bytes };
        }
        case "E": {
            // An enum case, `E:11:"Suit:Heart";` - a name, never an address.
            reader.expect(COLON);
            const length = reader.count(COLON);
            reader.expect(QUOTE);
            reader.take(length);
            reader.expect(QUOTE);
            reader.expect(SEMICOLON);
            return { kind: "raw", bytes: reader.from(start) };
        }
        case "a": {
            reader.expect(COLON);
            const entries = readEntries(reader, depth);
            return { kind: "array", entries };
        }
        case "O": {
            reader.expect(COLON);
            const length = reader.count(COLON);
            reader.expect(QUOTE);
            const className = reader.take(length);
            reader.expect(QUOTE);
            reader.expect(COLON);
            return { kind: "object", className, entries: readEntries(reader, depth) };
        }
        default:
            // `C:` carries a class's own format, which only the class can read.
            throw new Malformed();
    }
}

function readEntries(reader: Reader, depth: number): [Node, Node][] {
    const count = reader.count(COLON);
    reader.expect(OPEN);
    const entries: [Node, Node][] = [];
    for (let index = 0; index < count; index += 1) {
        const key = readNode(reader, depth + 1);
        const keyIsName = key.kind === "string" || (key.kind === "raw" && key.bytes[0] === 0x69);
        if (!keyIsName) throw new Malformed();
        entries.push([key, readNode(reader, depth + 1)]);
    }
    reader.expect(CLOSE);
    return entries;
}

/** The value as a tree, or null when it is not a whole serialized value. */
function parse(bytes: Buffer): Node | null {
    try {
        const reader = new Reader(bytes);
        const node = readNode(reader, 0);
        return reader.done ? node : null;
    } catch (error) {
        if (error instanceof Malformed) return null;
        throw error;
    }
}

function write(node: Node, out: Buffer[]): void {
    switch (node.kind) {
        case "raw":
            out.push(node.bytes);
            return;
        case "string":
            out.push(Buffer.from(`s:${node.bytes.length}:"`, "latin1"), node.bytes, Buffer.from('";', "latin1"));
            return;
        case "array":
            out.push(Buffer.from(`a:${node.entries.length}:{`, "latin1"));
            for (const [key, value] of node.entries) {
                write(key, out);
                write(value, out);
            }
            out.push(Buffer.from("}", "latin1"));
            return;
        case "object":
            out.push(
                Buffer.from(`O:${node.className.length}:"`, "latin1"),
                node.className,
                Buffer.from(`":${node.entries.length}:{`, "latin1")
            );
            for (const [key, value] of node.entries) {
                write(key, out);
                write(value, out);
            }
            out.push(Buffer.from("}", "latin1"));
    }
}

function replaceBytes(bytes: Buffer, from: Buffer, to: Buffer): Buffer {
    let at = bytes.indexOf(from);
    if (at < 0) return bytes;
    const parts: Buffer[] = [];
    let start = 0;
    while (at >= 0) {
        parts.push(bytes.subarray(start, at), to);
        start = at + from.length;
        at = bytes.indexOf(from, start);
    }
    parts.push(bytes.subarray(start));
    return Buffer.concat(parts);
}

/** Replace in every string of the tree. Keys and class names are names, not
 *  content, and stay as they are. A string that is itself serialized - as
 *  plugins nest them - is walked in turn. */
function walk(node: Node, from: Buffer, to: Buffer, depth: number): Node {
    switch (node.kind) {
        case "raw":
            return node;
        case "string":
            return { kind: "string", bytes: replaceValue(node.bytes, from, to, depth + 1) };
        case "array":
        case "object":
            return {
                ...node,
                entries: node.entries.map(([key, value]) => [key, walk(value, from, to, depth + 1)] as const)
            };
    }
}

/** Whether a value starts and ends like a serialized one. */
function looksSerialized(bytes: Buffer): boolean {
    const text = bytes.subarray(0, 4).toString("latin1");
    const last = bytes[bytes.length - 1];
    return /^(?:[aOCEs]:\d|[idbrR]:|N;)/.test(text) && (last === SEMICOLON || last === CLOSE);
}

function replaceValue(bytes: Buffer, from: Buffer, to: Buffer, depth: number): Buffer {
    if (bytes.indexOf(from) < 0) return bytes;
    if (depth > MAX_DEPTH) return bytes;
    const tree = looksSerialized(bytes) ? parse(bytes) : null;
    if (tree) {
        const out: Buffer[] = [];
        write(walk(tree, from, to, depth), out);
        return Buffer.concat(out);
    }
    return looksSerialized(bytes) ? bytes : replaceBytes(bytes, from, to);
}

/**
 * Replace `from` with `to` in a stored value, keeping a serialized one
 * readable. Bytes in, bytes out: a column's contents need not be UTF-8.
 */
export function replaceInStoredValue(value: Buffer, from: string, to: string): Buffer {
    if (!from) return value;
    return replaceValue(value, Buffer.from(from, "utf8"), Buffer.from(to, "utf8"), 0);
}

/** `replaceInStoredValue` for a value already held as text. */
export function replaceInStoredText(value: string, from: string, to: string): string {
    return replaceInStoredValue(Buffer.from(value, "utf8"), from, to).toString("utf8");
}
