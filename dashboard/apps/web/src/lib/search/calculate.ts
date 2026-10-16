/**
 * The calculator in the search panel: "2 * (3 + 4)" answers 14 as it is typed.
 *
 * A small recursive-descent parser over a fixed grammar, never `eval` or
 * `new Function`: what is typed into the panel is evaluated as arithmetic and
 * nothing else, so it cannot reach a variable, a property or a call that is not
 * in the table below.
 *
 *     expression := term (("+" | "-") term)*
 *     term       := unary (("*" | "/" | "%") unary | "%" "of" unary | implicit unary)*
 *     unary      := ("-" | "+") unary | power
 *     power      := primary (("^" | "**") unary)?
 *     primary    := number | constant | function "(" expression ")" | "(" expression ")"
 *
 * Power binds tighter than unary minus, so "-2^2" is -4 as on paper, and is
 * right-associative through `unary`, so "2^3^2" is 2^9. A number next to a
 * bracket, a constant or a function multiplies: "2pi", "3(4 + 1)". "15% of 200"
 * is a share, 30, and a comma is a decimal point as well as a dot: "1,5 * 2" is 3.
 */

const FUNCTIONS: ReadonlyMap<string, (value: number) => number> = new Map([
    ["sqrt", Math.sqrt],
    ["sin", Math.sin],
    ["cos", Math.cos],
    ["tan", Math.tan],
    ["log", Math.log10],
    ["ln", Math.log],
    ["abs", Math.abs],
    ["round", Math.round],
    ["floor", Math.floor],
    ["ceil", Math.ceil]
]);

const CONSTANTS: ReadonlyMap<string, number> = new Map([
    ["pi", Math.PI],
    ["e", Math.E]
]);

/** Digits joined by dashes, dots or an "x" with no space or bracket - a date, a
 *  phone or invoice number, a version, a screen size - and a date in slashes:
 *  things somebody is looking up, not sums. "10 - 4" and "3 x 4" still are. */
const LOOKS_LIKE_AN_ID = /^(?:\d[\d.]*(?:[-x][\d.]+)+|\d+(?:\/\d+){2,})$/i;

/** Long enough for any sum somebody types, short enough to bound the work. */
const MAX_LENGTH = 200;
/** As many digits as an answer keeps: enough for any sum, few enough that the
 *  noise of binary fractions never shows. */
const SIGNIFICANT_DIGITS = 10;
/** The most digits a number format will write. */
const MAX_DIGITS = 21;
/** Brackets and signs nested deeper than this are not arithmetic anybody typed. */
const MAX_DEPTH = 64;

type Token =
    | { kind: "number"; value: number }
    | { kind: "name"; value: string }
    | { kind: "op"; value: "+" | "-" | "*" | "/" | "%" | "^" }
    | { kind: "open" }
    | { kind: "close" };

class NotArithmetic extends Error {}

function tokenize(input: string): Token[] {
    const tokens: Token[] = [];
    let index = 0;
    while (index < input.length) {
        const char = input[index]!;
        if (/\s/.test(char)) {
            index += 1;
            continue;
        }
        const number = /^(\d+([.,]\d*)?|[.,]\d+)/.exec(input.slice(index));
        if (number) {
            // "1,000" is a thousand to one reader and one to another: no answer
            // beats a wrong one. "1,5" and "3,1416" are not in doubt.
            if (/^\d+,\d{3}$/.test(number[0])) throw new NotArithmetic();
            tokens.push({ kind: "number", value: Number(number[0].replace(",", ".")) });
            index += number[0].length;
            continue;
        }
        const name = /^[a-z]+/i.exec(input.slice(index));
        if (name) {
            const word = name[0].toLowerCase();
            // "3 x 4" is a product, the way it is written by hand.
            tokens.push(word === "x" ? { kind: "op", value: "*" } : { kind: "name", value: word });
            index += name[0].length;
            continue;
        }
        if (input.startsWith("**", index)) {
            tokens.push({ kind: "op", value: "^" });
            index += 2;
            continue;
        }
        if (char === "(") tokens.push({ kind: "open" });
        else if (char === ")") tokens.push({ kind: "close" });
        else if (char === "+" || char === "-" || char === "/" || char === "%" || char === "^")
            tokens.push({ kind: "op", value: char });
        else if (char === "*" || char === "×") tokens.push({ kind: "op", value: "*" });
        else if (char === "÷") tokens.push({ kind: "op", value: "/" });
        else if (char === "−") tokens.push({ kind: "op", value: "-" });
        else throw new NotArithmetic();
        index += 1;
    }
    return tokens;
}

/** What was worked out, and whether it took any working: a bare "42" or "pi"
 *  is something being searched for, not a sum. */
interface Evaluation {
    readonly value: number;
    readonly worked: boolean;
}

function evaluate(tokens: readonly Token[]): Evaluation {
    let position = 0;
    let depth = 0;
    let worked = false;

    const peek = (): Token | undefined => tokens[position];
    const isOp = (value: string): boolean => {
        const token = peek();
        return token?.kind === "op" && token.value === value;
    };
    const descend = (): void => {
        depth += 1;
        if (depth > MAX_DEPTH) throw new NotArithmetic();
    };

    function expression(): number {
        descend();
        let value = term();
        while (isOp("+") || isOp("-")) {
            const op = (tokens[position++] as { value: string }).value;
            const right = term();
            value = op === "+" ? value + right : value - right;
            worked = true;
        }
        depth -= 1;
        return value;
    }

    function term(): number {
        let value = unary();
        for (;;) {
            // "15% of 200": the share, not the remainder.
            const after = tokens[position + 1];
            if (isOp("%") && after?.kind === "name" && after.value === "of") {
                position += 2;
                value = (value * unary()) / 100;
                worked = true;
                continue;
            }
            if (isOp("*") || isOp("/") || isOp("%")) {
                const op = (tokens[position++] as { value: string }).value;
                const right = unary();
                value = op === "*" ? value * right : op === "/" ? value / right : value % right;
                worked = true;
                continue;
            }
            // "2pi", "3(4 + 1)", "2 sqrt(9)": side by side is a product.
            const next = peek();
            if (next && (next.kind === "open" || next.kind === "name")) {
                value *= unary();
                worked = true;
                continue;
            }
            return value;
        }
    }

    function unary(): number {
        if (isOp("-") || isOp("+")) {
            const negative = isOp("-");
            position += 1;
            descend();
            const value = unary();
            depth -= 1;
            return negative ? -value : value;
        }
        return power();
    }

    function power(): number {
        const base = primary();
        if (!isOp("^")) return base;
        position += 1;
        descend();
        const exponent = unary();
        depth -= 1;
        worked = true;
        return base ** exponent;
    }

    function bracketed(): number {
        if (peek()?.kind !== "open") throw new NotArithmetic();
        position += 1;
        const value = expression();
        if (peek()?.kind !== "close") throw new NotArithmetic();
        position += 1;
        return value;
    }

    function primary(): number {
        const token = peek();
        if (!token) throw new NotArithmetic();
        if (token.kind === "number") {
            position += 1;
            return token.value;
        }
        if (token.kind === "open") return bracketed();
        if (token.kind === "name") {
            position += 1;
            const fn = FUNCTIONS.get(token.value);
            if (fn) {
                const value = fn(bracketed());
                worked = true;
                return value;
            }
            const constant = CONSTANTS.get(token.value);
            if (constant !== undefined) return constant;
        }
        throw new NotArithmetic();
    }

    const value = expression();
    if (position !== tokens.length) throw new NotArithmetic();
    return { value, worked };
}

/**
 * The answer to what is typed, when it is a sum - or null when it is not one, so
 * the panel goes on searching for it. A bare number or constant is not a sum,
 * and neither is anything that does not come out as a finite number.
 */
export function calculate(input: string): number | null {
    const text = input.trim();
    if (!text || text.length > MAX_LENGTH) return null;
    // Something to work with, so a word that happens to spell "e" stays a search.
    if (!/\d|\bpi\b|\be\b/i.test(text)) return null;
    if (LOOKS_LIKE_AN_ID.test(text)) return null;
    try {
        const { value, worked } = evaluate(tokenize(text));
        if (!worked || !Number.isFinite(value)) return null;
        // Floating point noise off the end: 0.1 + 0.2 is 0.3.
        const tidy = Number(value.toPrecision(calculationDigits(value)));
        return Object.is(tidy, -0) ? 0 : tidy;
    } catch (error) {
        if (error instanceof NotArithmetic) return null;
        throw error;
    }
}

/** The digits an answer is shown and kept with: the fraction is cut to fit,
 *  never a digit of the whole part, so "12345678901 + 1" is 12345678902. */
export function calculationDigits(value: number): number {
    const whole = Math.abs(value) < 1 ? 0 : Math.floor(Math.log10(Math.abs(value))) + 1;
    return Math.min(MAX_DIGITS, Math.max(SIGNIFICANT_DIGITS, whole));
}

/** The answer as it is copied: plain digits a calculator or a sheet reads back,
 *  never "1e+21", so it reads back as the same number here and in a sheet. */
export function calculationText(value: number): string {
    return new Intl.NumberFormat("en-US", {
        useGrouping: false,
        maximumSignificantDigits: calculationDigits(value)
    }).format(value);
}
