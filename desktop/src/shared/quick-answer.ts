/**
 * Answers worked out on the computer as they are typed: arithmetic
 * (`2^10 / 4`, `sqrt(2) * pi`) and unit conversions (`5 km to mi`,
 * `100 f in c`, `3 gib to mb`). A small recursive-descent parser, never
 * `eval`: what is typed into the launcher is text, not code.
 */

export interface QuickAnswer {
    /** The answer as it is shown and copied. */
    readonly value: string;
    /** What it was worked out from, e.g. "5 km in mi". */
    readonly label: string;
}

const FUNCTIONS: Readonly<Record<string, (x: number) => number>> = {
    sqrt: Math.sqrt,
    abs: Math.abs,
    round: Math.round,
    floor: Math.floor,
    ceil: Math.ceil,
    sin: Math.sin,
    cos: Math.cos,
    tan: Math.tan,
    ln: Math.log,
    log: Math.log10
};

const CONSTANTS: Readonly<Record<string, number>> = { pi: Math.PI, e: Math.E };

type Token = { kind: "num"; value: number; } | { kind: "op"; value: string; } | { kind: "word"; value: string; };

function tokenize(text: string): Token[] | null {
    const tokens: Token[] = [];
    let at = 0;
    while (at < text.length) {
        const char = text[at]!;
        if (/\s/.test(char)) {
            at += 1;
            continue;
        }
        const number = /^(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?/i.exec(text.slice(at));
        if (number) {
            tokens.push({ kind: "num", value: Number(number[0]) });
            at += number[0].length;
            continue;
        }
        const word = /^[a-z]+/i.exec(text.slice(at));
        if (word) {
            tokens.push({ kind: "word", value: word[0].toLowerCase() });
            at += word[0].length;
            continue;
        }
        if ("+-*/%^()".includes(char)) {
            tokens.push({ kind: "op", value: char });
            at += 1;
            continue;
        }
        return null;
    }
    return tokens;
}

/** The value of an arithmetic expression, or null when it is not one. */
export function evaluate(text: string): number | null {
    const tokens = tokenize(text);
    if (!tokens || tokens.length === 0 || tokens.length > 200) return null;
    let at = 0;
    const peek = () => tokens[at];
    const isOp = (value: string) => {
        const token = peek();
        return token?.kind === "op" && token.value === value;
    };
    // expr := term (("+" | "-") term)*
    const expr = (): number => {
        let value = term();
        while (isOp("+") || isOp("-")) {
            const op = (tokens[at++] as { value: string; }).value;
            const right = term();
            value = op === "+" ? value + right : value - right;
        }
        return value;
    };
    // term := unary (("*" | "/" | "%") unary)*
    const term = (): number => {
        let value = unary();
        while (isOp("*") || isOp("/") || isOp("%")) {
            const op = (tokens[at++] as { value: string; }).value;
            const right = unary();
            value = op === "*" ? value * right : op === "/" ? value / right : value % right;
        }
        return value;
    };
    // unary := ("-" | "+") unary | power
    const unary = (): number => {
        if (isOp("-")) {
            at += 1;
            return -unary();
        }
        if (isOp("+")) {
            at += 1;
            return unary();
        }
        return power();
    };
    // power := atom ("^" unary)?   (right-associative)
    const power = (): number => {
        const base = atom();
        if (isOp("^")) {
            at += 1;
            return base ** unary();
        }
        return base;
    };
    const atom = (): number => {
        const token = tokens[at++];
        if (!token) throw new Error("end");
        if (token.kind === "num") return token.value;
        if (token.kind === "op" && token.value === "(") {
            const value = expr();
            if (!isOp(")")) throw new Error("paren");
            at += 1;
            return value;
        }
        if (token.kind === "word") {
            const fn = FUNCTIONS[token.value];
            if (fn) {
                if (!isOp("(")) throw new Error("call");
                return fn(atom());
            }
            const constant = CONSTANTS[token.value];
            if (constant !== undefined) return constant;
        }
        throw new Error("token");
    };
    try {
        const value = expr();
        if (at !== tokens.length || !Number.isFinite(value)) return null;
        return value;
    } catch {
        return null;
    }
}

/** Each unit as a factor of its family's base, or a pair of functions for temperature. */
interface Unit {
    readonly family: string;
    readonly toBase: (x: number) => number;
    readonly fromBase: (x: number) => number;
}

const linear = (family: string, factor: number): Unit => ({ family, toBase: (x) => x * factor, fromBase: (x) => x / factor });

const UNITS: Readonly<Record<string, Unit>> = {
    mm: linear("length", 0.001),
    cm: linear("length", 0.01),
    m: linear("length", 1),
    km: linear("length", 1000),
    in: linear("length", 0.0254),
    ft: linear("length", 0.3048),
    yd: linear("length", 0.9144),
    mi: linear("length", 1609.344),
    mg: linear("mass", 0.001),
    g: linear("mass", 1),
    kg: linear("mass", 1000),
    oz: linear("mass", 28.349523125),
    lb: linear("mass", 453.59237),
    ml: linear("volume", 0.001),
    l: linear("volume", 1),
    gal: linear("volume", 3.785411784),
    ms: linear("time", 0.001),
    s: linear("time", 1),
    min: linear("time", 60),
    h: linear("time", 3600),
    d: linear("time", 86400),
    b: linear("data", 1),
    kb: linear("data", 1e3),
    mb: linear("data", 1e6),
    gb: linear("data", 1e9),
    tb: linear("data", 1e12),
    kib: linear("data", 1024),
    mib: linear("data", 1024 ** 2),
    gib: linear("data", 1024 ** 3),
    tib: linear("data", 1024 ** 4),
    c: { family: "temperature", toBase: (x) => x, fromBase: (x) => x },
    f: { family: "temperature", toBase: (x) => ((x - 32) * 5) / 9, fromBase: (x) => (x * 9) / 5 + 32 },
    k: { family: "temperature", toBase: (x) => x - 273.15, fromBase: (x) => x + 273.15 }
};

/** A number shown to at most ten significant digits, without trailing zeros. */
export function formatNumber(value: number): string {
    if (Object.is(value, -0)) return "0";
    const abs = Math.abs(value);
    if (abs !== 0 && (abs >= 1e15 || abs < 1e-9)) return value.toExponential(6).replace(/\.?0+e/, "e");
    return String(Number(value.toPrecision(10)));
}

/** `5 km to mi`, `100f in c`: the converted value, or null. */
export function convert(text: string): QuickAnswer | null {
    const match = /^\s*(-?\d+(?:\.\d+)?)\s*([a-z]+)\s+(?:to|in)\s+([a-z]+)\s*$/i.exec(text);
    if (!match) return null;
    const amount = Number(match[1]);
    const fromName = match[2]!.toLowerCase();
    const toName = match[3]!.toLowerCase();
    const from = UNITS[fromName];
    const to = UNITS[toName];
    if (!from || !to || from.family !== to.family) return null;
    const value = to.fromBase(from.toBase(amount));
    return { value: formatNumber(value), label: `${formatNumber(amount)} ${fromName} in ${toName}` };
}

/** The quick answer to what was typed, or null. A bare number or word is not a question. */
export function quickAnswer(text: string): QuickAnswer | null {
    const trimmed = text.trim();
    if (!trimmed || trimmed.length > 300) return null;
    const conversion = convert(trimmed);
    if (conversion) return conversion;
    if (!/[+\-*/%^(]/.test(trimmed.replace(/^-/, ""))) return null;
    const value = evaluate(trimmed);
    return value === null ? null : { value: formatNumber(value), label: trimmed };
}
