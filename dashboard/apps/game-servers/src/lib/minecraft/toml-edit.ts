/**
 * One value in a TOML file, read or changed where it stands.
 *
 * A mod's config file is the mod's: its comments explain each setting, and the
 * mod rewrites the file when it finds a key missing or wrong. So a change Polaris
 * makes to it touches the characters of that one value and nothing else - not a
 * parse and a re-serialise, which would drop every comment and reorder the rest.
 *
 * The file is still read as TOML rather than as lines that look like
 * `key = value`: tables, dotted and quoted keys, strings over several lines and
 * arrays over several lines are all followed, so a line inside a multi-line
 * string or array is never mistaken for a setting. A file this cannot follow is
 * refused (`TomlShapeError`) rather than guessed at, and so is a key that is
 * only reachable through an inline table.
 *
 * Pure.
 */

/** The file is not TOML this can follow; nothing is written to it. */
export class TomlShapeError extends Error {
    constructor(at: number, what: string) {
        super(`TOML not understood at offset ${at}: ${what}`);
        this.name = "TomlShapeError";
    }
}

/** One `key = value` statement, with where its value sits in the text. */
interface Entry {
    /** The table it is in, followed by its own (possibly dotted) key. */
    readonly path: readonly string[];
    readonly valueStart: number;
    readonly valueEnd: number;
    /** The end of its line, newline excluded. */
    readonly lineEnd: number;
}

/** A `[table]` header. Arrays of tables are kept too, so nothing is ever
 *  inserted under one by mistake. */
interface Header {
    readonly path: readonly string[];
    readonly array: boolean;
    readonly lineEnd: number;
}

interface Scan {
    readonly entries: readonly Entry[];
    readonly headers: readonly Header[];
}

const BARE_KEY = /[A-Za-z0-9_-]/;

class Scanner {
    at = 0;
    private readonly text: string;

    constructor(text: string) {
        this.text = text;
    }

    private fail(what: string): never {
        throw new TomlShapeError(this.at, what);
    }

    private peek(offset = 0): string {
        return this.text[this.at + offset] ?? "";
    }

    private startsWith(token: string): boolean {
        return this.text.startsWith(token, this.at);
    }

    /** Spaces and tabs on the current line. */
    private skipBlank(): void {
        while (this.peek() === " " || this.peek() === "\t") this.at += 1;
    }

    private skipComment(): void {
        if (this.peek() !== "#") return;
        while (this.at < this.text.length && this.peek() !== "\n" && this.peek() !== "\r") {
            this.at += 1;
        }
    }

    /** Blank space, newlines and comments, as between array items. */
    private skipSpaceAndComments(): void {
        for (;;) {
            const c = this.peek();
            if (c === " " || c === "\t" || c === "\r" || c === "\n") this.at += 1;
            else if (c === "#") this.skipComment();
            else return;
        }
    }

    /** The end of the line after a statement: only a comment may follow it. */
    private endOfStatement(): number {
        this.skipBlank();
        this.skipComment();
        const lineEnd = this.at;
        if (this.peek() === "\r" && this.peek(1) === "\n") this.at += 2;
        else if (this.peek() === "\n") this.at += 1;
        else if (this.at < this.text.length) this.fail("something after a value on the same line");
        return lineEnd;
    }

    private basicString(): string {
        this.at += 1;
        let out = "";
        for (;;) {
            const c = this.peek();
            if (c === "" || c === "\n") this.fail("a string left open");
            this.at += 1;
            if (c === '"') return out;
            if (c === "\\") {
                out += this.peek();
                this.at += 1;
            } else out += c;
        }
    }

    private literalString(): string {
        this.at += 1;
        const close = this.text.indexOf("'", this.at);
        const newline = this.text.indexOf("\n", this.at);
        if (close < 0 || (newline >= 0 && newline < close)) this.fail("a string left open");
        const out = this.text.slice(this.at, close);
        this.at = close + 1;
        return out;
    }

    private multiline(quote: string): void {
        this.at += 3;
        for (;;) {
            if (this.at >= this.text.length) this.fail("a multi-line string left open");
            if (quote === '"""' && this.peek() === "\\") {
                this.at += 2;
                continue;
            }
            if (this.startsWith(quote)) {
                this.at += 3;
                // Up to two more quotes belong to the string itself.
                while (this.peek() === quote[0]) this.at += 1;
                return;
            }
            this.at += 1;
        }
    }

    /** One key segment, unquoted. */
    private keyPart(): string {
        const c = this.peek();
        if (c === '"') return this.basicString();
        if (c === "'") return this.literalString();
        const start = this.at;
        while (BARE_KEY.test(this.peek())) this.at += 1;
        if (this.at === start) this.fail("a key was expected");
        return this.text.slice(start, this.at);
    }

    /** A dotted key: `a`, `a.b`, `"a b".c`. */
    private key(): string[] {
        const parts = [this.keyPart()];
        for (;;) {
            this.skipBlank();
            if (this.peek() !== ".") return parts;
            this.at += 1;
            this.skipBlank();
            parts.push(this.keyPart());
        }
    }

    /** Past one value of any kind; where it started and ended. */
    private value(): { start: number; end: number } {
        const start = this.at;
        const c = this.peek();
        if (this.startsWith('"""') || this.startsWith("'''")) {
            this.multiline(this.text.slice(this.at, this.at + 3));
        } else if (c === '"') {
            this.basicString();
        } else if (c === "'") {
            this.literalString();
        } else if (c === "[") {
            this.at += 1;
            for (;;) {
                this.skipSpaceAndComments();
                if (this.peek() === "]") break;
                this.value();
                this.skipSpaceAndComments();
                if (this.peek() === ",") this.at += 1;
                else if (this.peek() !== "]") this.fail("an array item without a comma");
            }
            this.at += 1;
        } else if (c === "{") {
            this.at += 1;
            this.skipBlank();
            if (this.peek() !== "}") {
                for (;;) {
                    this.skipBlank();
                    this.key();
                    this.skipBlank();
                    if (this.peek() !== "=") this.fail("an inline table key without =");
                    this.at += 1;
                    this.skipBlank();
                    this.value();
                    this.skipBlank();
                    if (this.peek() === ",") this.at += 1;
                    else if (this.peek() === "}") break;
                    else this.fail("an inline table item without a comma");
                }
            }
            this.at += 1;
        } else {
            // A bare scalar: a number, a boolean, a date. It ends where the line,
            // a comment or the enclosing array or table does.
            while (this.at < this.text.length && !/[\s#,\]}]/.test(this.peek())) this.at += 1;
            if (this.at === start) this.fail("a value was expected");
        }
        return { start, end: this.at };
    }

    scan(): Scan {
        const entries: Entry[] = [];
        const headers: Header[] = [];
        let table: string[] = [];
        while (this.at < this.text.length) {
            this.skipSpaceAndComments();
            if (this.at >= this.text.length) break;
            if (this.peek() === "[") {
                const array = this.peek(1) === "[";
                this.at += array ? 2 : 1;
                this.skipBlank();
                const path = this.key();
                this.skipBlank();
                if (!this.startsWith(array ? "]]" : "]")) this.fail("a table header left open");
                this.at += array ? 2 : 1;
                const lineEnd = this.endOfStatement();
                headers.push({ path, array, lineEnd });
                table = array ? [...path, "\u0000array"] : path;
                continue;
            }
            const key = this.key();
            this.skipBlank();
            if (this.peek() !== "=") this.fail("a key without =");
            this.at += 1;
            this.skipBlank();
            const { start, end } = this.value();
            const lineEnd = this.endOfStatement();
            entries.push({ path: [...table, ...key], valueStart: start, valueEnd: end, lineEnd });
        }
        return { entries, headers };
    }
}

function scan(text: string): Scan {
    return new Scanner(text).scan();
}

function samePath(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((part, index) => part === right[index]);
}

function startsWithPath(path: readonly string[], prefix: readonly string[]): boolean {
    return prefix.length <= path.length && prefix.every((part, index) => part === path[index]);
}

/** A key's whole path: its table's parts, then the key. Each part is the name
 *  itself, unquoted - `["Gameplay"]`, `"Show Patreon message"` - however the
 *  file happens to write it. */
function pathOf(table: readonly string[], key: string): string[] {
    const parts = [...table, key];
    if (parts.some((part) => part.length === 0 || /[\u0000-\u001f"\\]/.test(part))) {
        throw new TomlShapeError(0, "a key part that cannot be written");
    }
    return parts;
}

/** One key part as TOML writes it: bare when it can be, quoted when not. */
function keyText(part: string): string {
    return /^[A-Za-z0-9_-]+$/.test(part) ? part : `"${part}"`;
}

/** The value written for a key, exactly as it stands in the file (`false`,
 *  `"text"`), or null when the file does not set it. */
export function readTomlValue(
    text: string,
    table: readonly string[],
    key: string
): string | null {
    const path = pathOf(table, key);
    const entry = scan(text).entries.find((one) => samePath(one.path, path));
    return entry ? text.slice(entry.valueStart, entry.valueEnd) : null;
}

/**
 * The file with one key set to `literal` (already TOML: `true`, `"text"`), and
 * everything else - comments, order, spacing, the other values - as it was.
 *
 * A key that is not there is added at the end of its table, and a table that is
 * not there is added at the end of the file. `changed` is false when the key
 * already held that value, so a caller writes nothing at all.
 */
export function setTomlValue(
    text: string,
    table: readonly string[],
    key: string,
    literal: string
): { text: string; changed: boolean } {
    const path = pathOf(table, key);
    const tablePath = path.slice(0, -1);
    const found = scan(text);
    const entry = found.entries.find((one) => samePath(one.path, path));
    if (entry) {
        if (text.slice(entry.valueStart, entry.valueEnd) === literal) return { text, changed: false };
        return {
            text: text.slice(0, entry.valueStart) + literal + text.slice(entry.valueEnd),
            changed: true
        };
    }
    // The key's table set as a value (`[a]` given as `a = { ... }` or a dotted
    // key under it) cannot take another line beside it without breaking the file.
    if (
        found.entries.some(
            (one) => one.path.length <= tablePath.length && startsWithPath(tablePath, one.path)
        )
    ) {
        throw new TomlShapeError(0, "the key's table is written inline");
    }
    const newline = text.includes("\r\n") ? "\r\n" : "\n";
    const line = `${keyText(key)} = ${literal}`;
    const inTable = found.entries.filter(
        (one) => one.path.length === path.length && startsWithPath(one.path, tablePath)
    );
    const header = found.headers.find((one) => !one.array && samePath(one.path, tablePath));
    const last = inTable.at(-1);
    let at: number | null = null;
    if (last) at = last.lineEnd;
    else if (header) at = header.lineEnd;
    else if (tablePath.length === 0) {
        // No top-level key yet: before the first table, which is the only place a
        // top-level key can go.
        const out = `${line}${newline}${text}`;
        return { text: out, changed: true };
    }
    if (at !== null) {
        return { text: `${text.slice(0, at)}${newline}${line}${text.slice(at)}`, changed: true };
    }
    const tail = text.length === 0 || text.endsWith("\n") ? text : `${text}${newline}`;
    const gap = tail.length === 0 ? "" : newline;
    return {
        text: `${tail}${gap}[${tablePath.map(keyText).join(".")}]${newline}${line}${newline}`,
        changed: true
    };
}
