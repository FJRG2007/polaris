/**
 * Reading and changing the `define("NAME", value)` calls of a PHP file, such as
 * the database settings in a WordPress `wp-config.php`, without touching
 * anything else in it.
 *
 * The file is tokenized the way PHP reads it - text outside `<?php ... ?>`,
 * comments, single- and double-quoted strings, heredocs and nowdocs are each
 * skipped as a whole - so a `define(` inside a comment, a string or a heredoc is
 * never taken for a call, nor is a method or a function declaration by that
 * name. Only the second argument of a matching call is replaced, and with a
 * single-quoted literal, which PHP reads without interpolation; every other
 * byte of the file stays as it was.
 */

interface Token {
    readonly kind: "ident" | "string" | "punct";
    readonly start: number;
    readonly end: number;
    readonly text: string;
    /** A string's value, when it is a plain literal with nothing interpolated. */
    readonly value?: string;
}

const IDENT_START = /[A-Za-z_\u0080-￿]/;
const IDENT_PART = /[A-Za-z0-9_\u0080-￿]/;
const DOUBLE_ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", v: "\v", e: "\x1b", f: "\f", "\\": "\\", $: "$", '"': '"' };

/** Where the PHP after `?>` starts again, or the end of the file. */
function nextOpenTag(source: string, from: number): number {
    const open = source.indexOf("<?", from);
    if (open < 0) return source.length;
    if (source.startsWith("<?php", open)) return open + 5;
    if (source.startsWith("<?=", open)) return open + 3;
    return open + 2;
}

function singleQuoted(source: string, start: number): Token {
    let value = "";
    let at = start + 1;
    while (at < source.length && source[at] !== "'") {
        if (source[at] === "\\" && (source[at + 1] === "'" || source[at + 1] === "\\")) {
            value += source[at + 1];
            at += 2;
        } else {
            value += source[at];
            at += 1;
        }
    }
    const end = Math.min(at + 1, source.length);
    return { kind: "string", start, end, text: source.slice(start, end), value };
}

/** A double-quoted or backtick string. Its value is kept only when nothing in it
 *  is interpolated. */
function doubleQuoted(source: string, start: number): Token {
    const quote = source[start];
    let value: string | undefined = "";
    let at = start + 1;
    while (at < source.length && source[at] !== quote) {
        const char = source[at] as string;
        if (char === "\\" && at + 1 < source.length) {
            const next = source[at + 1] as string;
            if (value !== undefined) value += DOUBLE_ESCAPES[next] ?? (next === quote ? next : `\\${next}`);
            at += 2;
            continue;
        }
        if (char === "$" && /[A-Za-z_{]/.test(source[at + 1] ?? "")) value = undefined;
        if (value !== undefined) value += char;
        at += 1;
    }
    const end = Math.min(at + 1, source.length);
    return { kind: "string", start, end, text: source.slice(start, end), ...(quote === '"' && value !== undefined ? { value } : {}) };
}

/** A heredoc or nowdoc from its `<<<`, to the end of its closing label. */
function heredoc(source: string, start: number): Token | null {
    const opening = /^<<<[ \t]*(["']?)([A-Za-z_][A-Za-z0-9_]*)\1\r?\n/.exec(source.slice(start, start + 256));
    if (!opening) return null;
    const label = opening[2] as string;
    const closing = new RegExp(`^[ \\t]*${label}(?![A-Za-z0-9_])`, "m");
    const body = start + opening[0].length;
    const found = closing.exec(source.slice(body));
    const end = found ? body + found.index + found[0].length : source.length;
    return { kind: "string", start, end, text: source.slice(start, end) };
}

/** The tokens of a PHP file that matter for finding calls; whitespace, comments
 *  and inline text are left out. */
export function tokenize(source: string): Token[] {
    const tokens: Token[] = [];
    let at = nextOpenTag(source, 0);
    while (at < source.length) {
        const char = source[at] as string;
        if (/\s/.test(char)) {
            at += 1;
        } else if (source.startsWith("?>", at)) {
            at = nextOpenTag(source, at + 2);
        } else if (char === "#" || source.startsWith("//", at)) {
            // A line comment ends at the line or at `?>`, whichever comes first.
            const line = source.slice(at).search(/\r?\n|\?>/);
            at = line < 0 ? source.length : at + line;
        } else if (source.startsWith("/*", at)) {
            const close = source.indexOf("*/", at + 2);
            at = close < 0 ? source.length : close + 2;
        } else if (char === "'") {
            const token = singleQuoted(source, at);
            tokens.push(token);
            at = token.end;
        } else if (char === '"' || char === "`") {
            const token = doubleQuoted(source, at);
            tokens.push(token);
            at = token.end;
        } else if (source.startsWith("<<<", at) && heredoc(source, at)) {
            const token = heredoc(source, at) as Token;
            tokens.push(token);
            at = token.end;
        } else if (IDENT_START.test(char)) {
            let end = at + 1;
            while (end < source.length && IDENT_PART.test(source[end] as string)) end += 1;
            tokens.push({ kind: "ident", start: at, end, text: source.slice(at, end) });
            at = end;
        } else {
            const pair = ["?->", "->", "::"].find((op) => source.startsWith(op, at)) ?? char;
            tokens.push({ kind: "punct", start: at, end: at + pair.length, text: pair });
            at += pair.length;
        }
    }
    return tokens;
}

/** One `define` call whose name is a plain string. */
export interface DefineCall {
    readonly name: string;
    /** The second argument's span in the source. */
    readonly start: number;
    readonly end: number;
    /** Its value, when it is a plain string literal. */
    readonly value: string | null;
}

const NOT_A_CALL = new Set(["->", "?->", "::", "function", "new", "const"]);

/** Every `define("NAME", value)` call in the file, in order. */
export function findDefines(source: string): DefineCall[] {
    const tokens = tokenize(source);
    const calls: DefineCall[] = [];
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index] as Token;
        if (token.kind !== "ident" || token.text.toLowerCase() !== "define") continue;
        const before = tokens[index - 1];
        if (before && NOT_A_CALL.has(before.kind === "ident" ? before.text.toLowerCase() : before.text)) continue;
        const [open, name, comma] = [tokens[index + 1], tokens[index + 2], tokens[index + 3]];
        if (open?.text !== "(" || name?.kind !== "string" || name.value === undefined || comma?.text !== ",") continue;
        // The second argument runs to the `,` or `)` that closes it at its own depth.
        let depth = 0;
        let last = index + 3;
        for (let scan = index + 4; scan < tokens.length; scan += 1) {
            const text = (tokens[scan] as Token).text;
            if (depth === 0 && (text === "," || text === ")")) break;
            if (text === "(" || text === "[" || text === "{") depth += 1;
            if (text === ")" || text === "]" || text === "}") depth -= 1;
            last = scan;
        }
        if (last === index + 3) continue;
        const first = tokens[index + 4] as Token;
        const end = (tokens[last] as Token).end;
        const only = last === index + 4 && first.kind === "string" && first.value !== undefined;
        calls.push({ name: name.value, start: first.start, end, value: only ? (first.value as string) : null });
        index = last;
    }
    return calls;
}

/** A value as a PHP single-quoted literal, which PHP reads exactly as written. */
export function phpLiteral(value: string): string {
    return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** The file with every `define` of a name in `values` set to that value. Answers
 *  the names it changed; a name the file never defines is left out. */
export function rewriteDefines(source: string, values: Readonly<Record<string, string>>): { text: string; changed: string[] } {
    const calls = findDefines(source).filter((call) => Object.hasOwn(values, call.name));
    let text = source;
    for (const call of [...calls].reverse()) {
        text = text.slice(0, call.start) + phpLiteral(values[call.name] as string) + text.slice(call.end);
    }
    return { text, changed: [...new Set(calls.map((call) => call.name))] };
}
