/**
 * A rule's conditions as text, and text back into conditions.
 *
 * The builder is the good way to write a first rule and the wrong way to write the
 * twentieth. An expression can be pasted, diffed, kept in a document, and copied out
 * of a managed rule into one of your own - which is the whole reason this parses as
 * well as renders. A preview that could only be read would be a picture of the rule;
 * this is the rule.
 *
 * It is not a second source of truth. `renderWafExpression` and `parseWafExpression`
 * are inverses over the same `WafCondition` tree the engine evaluates, and the test
 * suite holds them to it: anything the builder can express round-trips, and anything
 * parsed is re-validated by the same schema a saved rule is.
 *
 * The syntax is the wirefilter-shaped one an operator who has used a WAF before
 * already reads - `http.request.uri.path starts_with "/admin"` joined by `and`/`or`
 * with brackets - kept to exactly what the model can hold. There is no arithmetic, no
 * regex operator and no field that would need a lookup, because none of those is
 * something the engine could then enforce.
 */

import * as rules from "./schemas/deploy.js";

type WafCondition = rules.WafCondition;
type WafConditionGroup = rules.WafConditionGroup;
type WafLeafCondition = rules.WafLeafCondition;
type WafRuleField = rules.WafRuleField;
type WafRuleOperator = rules.WafRuleOperator;
type WafRuleSignal = rules.WafRuleSignal;

/** How long an expression may be. Generous enough for a pack of forty user agents
 *  written out, and bounded because it is parsed on the server for every save. */
export const WAF_EXPRESSION_MAX = 4000;

/** The field as an expression names it. Modelled on the names a Cloudflare user
 *  already knows, so an expression reads as a rule rather than as our column names in
 *  a different font. */
export const WAF_FIELD_TOKENS: Readonly<Record<WafRuleField, string>> = {
    ip: "ip.src",
    host: "http.host",
    path: "http.request.uri.path",
    method: "http.request.method",
    user_agent: "http.user_agent",
    query: "http.request.uri.query"
};

/** The signature checks, named the way the managed rule that owns them is. */
export const WAF_SIGNAL_TOKENS: Readonly<Record<WafRuleSignal, string>> = {
    sql_injection: "waf.sql_injection",
    xss: "waf.xss",
    browser_integrity: "waf.browser_integrity"
};

export const WAF_OPERATOR_TOKENS: Readonly<Record<WafRuleOperator, string>> = {
    equals: "eq",
    not_equals: "ne",
    contains: "contains",
    not_contains: "not contains",
    starts_with: "starts_with",
    not_starts_with: "not starts_with",
    ends_with: "ends_with",
    not_ends_with: "not ends_with"
};

const FIELD_BY_TOKEN = new Map(rules.WAF_RULE_FIELDS.map((field) => [WAF_FIELD_TOKENS[field], field]));
const SIGNAL_BY_TOKEN = new Map(rules.WAF_RULE_SIGNALS.map((signal) => [WAF_SIGNAL_TOKENS[signal], signal]));

/** Longest first, so `not contains` is read before `not` is mistaken for a prefix. */
const OPERATOR_BY_TOKEN = (Object.keys(WAF_OPERATOR_TOKENS) as WafRuleOperator[])
    .map((operator) => ({ token: WAF_OPERATOR_TOKENS[operator], operator }))
    .sort((a, b) => b.token.length - a.token.length);

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** A value as the expression quotes it. Backslashes first, or escaping the quote
 *  would then escape its own escape. */
function quote(value: string): string {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** One condition as an expression. Several values on one test are an `or` over the
 *  same field, which is what the engine does with them. */
function conditionText(condition: WafCondition): string {
    if (rules.isWafSignalCondition(condition)) {
        const token = WAF_SIGNAL_TOKENS[condition.signal];
        return condition.negate ? `not ${token}` : token;
    }
    if (rules.isWafConditionGroup(condition)) {
        const joiner = condition.match === "any" ? " or " : " and ";
        return `(${condition.conditions.map(conditionText).join(joiner)})`;
    }
    const field = WAF_FIELD_TOKENS[condition.field];
    const operator = WAF_OPERATOR_TOKENS[condition.operator];
    if (condition.values.length === 0) return `${field} ${operator} ...`;
    const parts = condition.values.map((value) => `${field} ${operator} ${quote(value)}`);
    return parts.length === 1 ? parts[0]! : `(${parts.join(" or ")})`;
}

/**
 * A rule's conditions as one expression, in the order the engine reads them.
 *
 * The whole thing is bracketed even when it is a single test, because that is how a
 * saved rule reads everywhere else and an expression that changed shape depending on
 * how many conditions it had would look like two different formats.
 */
export function renderWafExpression(conditions: readonly WafCondition[]): string {
    if (conditions.length === 0) return "";
    const parts = conditions.map(conditionText);
    return parts.length === 1 ? bracket(parts[0]!) : parts.map(bracket).join(" and ");
}

/** A part in brackets, unless it already brought its own. */
function bracket(part: string): string {
    return part.startsWith("(") && part.endsWith(")") ? part : `(${part})`;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export type WafExpressionResult =
    | { readonly ok: true; readonly conditions: WafCondition[] }
    /** Where it stopped making sense, as an index into the text, so the editor can
     *  put the caret there rather than only saying that something is wrong. */
    | { readonly ok: false; readonly error: string; readonly at: number };

/** A parse that failed, thrown internally and turned into a result at the boundary -
 *  a recursive descent parser reads far better with one exit than with a result type
 *  threaded through every production. */
class ParseError extends Error {
    constructor(
        message: string,
        readonly at: number
    ) {
        super(message);
    }
}

/**
 * An expression as the conditions it describes.
 *
 * The result is the rule's own `conditions` array, so the top level is read as an
 * implicit `and` exactly as the model stores it: `a and b` is two conditions, and
 * `a or b` is one group. Anything deeper becomes a group, and the schema decides
 * whether it is too deep - this parser deliberately does not know about the nesting
 * limit, so the error an operator reads is the same one a saved rule would give.
 */
export function parseWafExpression(text: string): WafExpressionResult {
    if (text.length > WAF_EXPRESSION_MAX) {
        return { ok: false, error: `An expression may be at most ${WAF_EXPRESSION_MAX} characters`, at: WAF_EXPRESSION_MAX };
    }
    const parser = new Parser(text);
    try {
        const conditions = parser.parseAll();
        return { ok: true, conditions };
    } catch (caught) {
        if (caught instanceof ParseError) return { ok: false, error: caught.message, at: caught.at };
        throw caught;
    }
}

class Parser {
    private at = 0;

    constructor(private readonly text: string) {}

    /** The whole expression, flattened to the condition list a rule stores. */
    parseAll(): WafCondition[] {
        this.skipSpace();
        if (this.at >= this.text.length) throw new ParseError("Write a condition", 0);
        const node = this.parseOr();
        this.skipSpace();
        if (this.at < this.text.length) throw new ParseError("Unexpected text after the expression", this.at);
        // A top-level `and` is the rule's own list rather than a group, which is what
        // makes a round trip through the builder come back unchanged.
        if (rules.isWafConditionGroup(node) && node.match === "all") return [...node.conditions];
        return [node];
    }

    private parseOr(): WafCondition {
        const parts = [this.parseAnd()];
        while (this.eatWord("or")) parts.push(this.parseAnd());
        return parts.length === 1 ? parts[0]! : this.group("any", parts);
    }

    private parseAnd(): WafCondition {
        const parts = [this.parseTerm()];
        while (this.eatWord("and")) parts.push(this.parseTerm());
        return parts.length === 1 ? parts[0]! : this.group("all", parts);
    }

    /** A group, typed as the schema's shape. The parser does not enforce the nesting
     *  limit; validating the finished rule does, with the message a save would give. */
    private group(match: "all" | "any", conditions: WafCondition[]): WafCondition {
        return { match, conditions } as WafConditionGroup;
    }

    private parseTerm(): WafCondition {
        this.skipSpace();
        if (this.text[this.at] === "(") {
            const open = this.at;
            this.at += 1;
            const inner = this.parseOr();
            this.skipSpace();
            if (this.text[this.at] !== ")") throw new ParseError("Missing a closing bracket", open);
            this.at += 1;
            return inner;
        }
        // `not` in front of a signature check. In front of a field it is part of the
        // operator (`not contains`), which is read below.
        const start = this.at;
        if (this.eatWord("not")) {
            const token = this.readToken();
            const signal = SIGNAL_BY_TOKEN.get(token);
            if (!signal) throw new ParseError("`not` here only applies to a firewall check", start);
            return { signal, negate: true };
        }
        return this.parseComparison();
    }

    private parseComparison(): WafCondition {
        this.skipSpace();
        const start = this.at;
        const token = this.readToken();
        if (!token) throw new ParseError("Expected a field", start);

        const signal = SIGNAL_BY_TOKEN.get(token);
        if (signal) return { signal, negate: false };

        const field = FIELD_BY_TOKEN.get(token);
        if (!field) throw new ParseError(`Unknown field "${token}"`, start);

        this.skipSpace();
        const operatorAt = this.at;
        const operator = this.readOperator();
        if (!operator) throw new ParseError("Expected an operator", operatorAt);

        this.skipSpace();
        const valueAt = this.at;
        const value = this.readString();
        if (value === null) throw new ParseError("Expected a quoted value", valueAt);
        if (value.trim() === "") throw new ParseError("A value cannot be empty", valueAt);

        return { field, operator, values: [value] };
    }

    private skipSpace(): void {
        while (this.at < this.text.length && /\s/.test(this.text[this.at]!)) this.at += 1;
    }

    /** A bare word: a field token, a signal token, or a keyword. */
    private readToken(): string {
        this.skipSpace();
        const start = this.at;
        while (this.at < this.text.length && /[A-Za-z0-9_.]/.test(this.text[this.at]!)) this.at += 1;
        return this.text.slice(start, this.at);
    }

    /** Consume `word` if it is the next token, leaving the position alone if not. */
    private eatWord(word: string): boolean {
        const before = this.at;
        this.skipSpace();
        const token = this.readToken();
        if (token.toLowerCase() === word) return true;
        this.at = before;
        return false;
    }

    private readOperator(): WafRuleOperator | null {
        for (const { token, operator } of OPERATOR_BY_TOKEN) {
            if (!this.text.startsWith(token, this.at)) continue;
            const after = this.text[this.at + token.length];
            // `eq` must not swallow the front of a longer word, and the operator has to
            // be followed by whitespace or the opening quote of its value.
            if (after !== undefined && !/[\s"]/.test(after)) continue;
            this.at += token.length;
            return operator;
        }
        return null;
    }

    /** A double-quoted value with backslash escapes, or null when the next thing is
     *  not one. */
    private readString(): string | null {
        if (this.text[this.at] !== '"') return null;
        this.at += 1;
        let out = "";
        while (this.at < this.text.length) {
            const char = this.text[this.at]!;
            if (char === "\\") {
                const next = this.text[this.at + 1];
                if (next === undefined) break;
                out += next;
                this.at += 2;
                continue;
            }
            if (char === '"') {
                this.at += 1;
                return out;
            }
            out += char;
            this.at += 1;
        }
        throw new ParseError("Missing a closing quote", this.at);
    }
}

// ---------------------------------------------------------------------------
// Tidying
// ---------------------------------------------------------------------------

/**
 * Fold the `or`s a parser produces back into the multi-value tests the builder shows.
 *
 * `http.host eq "a" or http.host eq "b"` is one test with two values in the model, and
 * that is what the builder draws. Without this, pasting an expression the UI itself
 * rendered would come back as a group of single-value tests - the same rule, drawn as
 * something the operator did not write.
 */
export function foldWafValues(conditions: readonly WafCondition[]): WafCondition[] {
    return conditions.map(foldOne);
}

function foldOne(condition: WafCondition): WafCondition {
    if (!rules.isWafConditionGroup(condition)) return condition;
    const folded = condition.conditions.map(foldOne);
    if (condition.match !== "any") return { ...condition, conditions: folded } as WafConditionGroup;

    const first = folded[0];
    if (!first || rules.isWafConditionGroup(first) || rules.isWafSignalCondition(first)) {
        return { ...condition, conditions: folded } as WafConditionGroup;
    }
    const sameTest = folded.every(
        (entry): entry is WafLeafCondition =>
            !rules.isWafConditionGroup(entry) &&
            !rules.isWafSignalCondition(entry) &&
            entry.field === first.field &&
            entry.operator === first.operator
    );
    if (!sameTest) return { ...condition, conditions: folded } as WafConditionGroup;
    return { field: first.field, operator: first.operator, values: folded.flatMap((entry) => entry.values) };
}
