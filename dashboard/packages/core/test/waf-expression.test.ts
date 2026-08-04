/**
 * The expression is editable, so it is an input as well as a rendering - and an input
 * that produces the rules an edge enforces. Two things are held here.
 *
 * First that render and parse are inverses: anything the builder can express comes
 * back as the same tree, because an operator who opens a rule, edits the text and
 * saves has to get the rule they were looking at plus their edit, not a re-shuffled
 * version of it.
 *
 * Second that a bad expression fails as a message rather than as a rule: everything
 * the parser cannot read has to be refused, since the alternative is a condition
 * quietly dropped from something whose job is to refuse traffic.
 */

import { describe, expect, it } from "vitest";
import { wafCustomRuleSchema, type WafCondition } from "../src/schemas/deploy.js";
import { foldWafValues, parseWafExpression, renderWafExpression, WAF_EXPRESSION_MAX } from "../src/waf-expression.js";

/** Render, parse back, fold the way the editor does, and compare. */
function roundTrip(conditions: WafCondition[]): WafCondition[] {
    const result = parseWafExpression(renderWafExpression(conditions));
    if (!result.ok) throw new Error(`${result.error} at ${result.at}`);
    return foldWafValues(result.conditions);
}

describe("an expression and the conditions it describes", () => {
    it("round-trips one test", () => {
        const conditions: WafCondition[] = [{ field: "path", operator: "starts_with", values: ["/admin"] }];

        expect(renderWafExpression(conditions)).toBe('(http.request.uri.path starts_with "/admin")');
        expect(roundTrip(conditions)).toEqual(conditions);
    });

    it("round-trips several values on one test as the or they are", () => {
        const conditions: WafCondition[] = [{ field: "method", operator: "equals", values: ["POST", "PUT"] }];

        expect(renderWafExpression(conditions)).toBe(
            '(http.request.method eq "POST" or http.request.method eq "PUT")'
        );
        expect(roundTrip(conditions)).toEqual(conditions);
    });

    it("round-trips a nested group", () => {
        const conditions: WafCondition[] = [
            { field: "ip", operator: "not_equals", values: ["203.0.113.0/24"] },
            {
                match: "any",
                conditions: [
                    { field: "path", operator: "starts_with", values: ["/admin"] },
                    { field: "query", operator: "contains", values: ["debug=1"] }
                ]
            }
        ];

        expect(roundTrip(conditions)).toEqual(conditions);
    });

    it("round-trips a signature check, negated or not", () => {
        const conditions: WafCondition[] = [
            { signal: "sql_injection", negate: false },
            { signal: "browser_integrity", negate: true }
        ];

        expect(renderWafExpression(conditions)).toBe("(waf.sql_injection) and (not waf.browser_integrity)");
        expect(roundTrip(conditions)).toEqual(conditions);
    });

    it("round-trips every managed pack, which is what makes one reusable", () => {
        // A pack's expression is the thing an operator copies into a rule of their own,
        // so it has to come back as the same rule rather than as something similar.
        const packs: WafCondition[][] = [
            [{ field: "user_agent", operator: "contains", values: ["sqlmap", "nikto", "nmap"] }],
            [
                { field: "path", operator: "starts_with", values: ["/."] },
                { field: "path", operator: "not_starts_with", values: ["/.well-known/"] }
            ]
        ];

        for (const pack of packs) expect(roundTrip(pack)).toEqual(pack);
    });

    it("reads a top-level and as the rule's own list, not as a group", () => {
        const result = parseWafExpression('http.host eq "a" and http.request.uri.path eq "/b"');

        expect(result.ok && result.conditions.length).toBe(2);
    });

    it("keeps brackets meaning what they say", () => {
        const result = parseWafExpression(
            'ip.src eq "10.0.0.1" and (http.host eq "a" or http.request.uri.path eq "/b")'
        );
        if (!result.ok) throw new Error(result.error);

        expect(result.conditions).toHaveLength(2);
        expect(result.conditions[1]).toMatchObject({ match: "any" });
    });

    it("survives a value with a quote and a backslash in it", () => {
        const conditions: WafCondition[] = [
            { field: "query", operator: "contains", values: ['a"b\\c'] }
        ];

        expect(roundTrip(conditions)).toEqual(conditions);
    });
});

describe("an expression that cannot be read", () => {
    const bad: [string, string][] = [
        ["", "empty"],
        ["http.host", "a field with no operator"],
        ["http.host eq", "an operator with no value"],
        ['http.host eq "a"', ""],
        ['http.nonsense eq "a"', "an unknown field"],
        ['http.host equals "a"', "an operator that is not one"],
        ['http.host eq "a', "an unclosed quote"],
        ['(http.host eq "a"', "an unclosed bracket"],
        ['http.host eq "a" and', "a dangling and"],
        ['http.host eq "a" nonsense', "trailing text"],
        ['http.host eq ""', "an empty value"],
        ['not http.host eq "a"', "not in front of a field"]
    ];

    for (const [text, why] of bad) {
        if (!why) continue;
        it(`refuses ${why}`, () => {
            expect(parseWafExpression(text).ok).toBe(false);
        });
    }

    it("reports where it stopped, so the caret can go there", () => {
        const result = parseWafExpression('http.host eq "a" and http.nonsense eq "b"');

        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.at).toBe(21);
    });

    it("refuses one longer than the cap rather than parsing it", () => {
        const long = `${'http.host eq "a" and '.repeat(400)}http.host eq "b"`;

        expect(long.length).toBeGreaterThan(WAF_EXPRESSION_MAX);
        expect(parseWafExpression(long).ok).toBe(false);
    });

    it("hands a rule the schema still gets to refuse", () => {
        // The parser does not know the nesting limit; the rule it produces is validated
        // like any other, so the message is the one a save would have given.
        const result = parseWafExpression(
            'http.host eq "a" or (http.host eq "b" and (http.host eq "c" or (http.host eq "d" and http.host eq "e")))'
        );
        if (!result.ok) throw new Error(result.error);

        const parsed = wafCustomRuleSchema.safeParse({
            name: "deep",
            action: "block",
            conditions: result.conditions
        });

        expect(parsed.success).toBe(false);
    });
});
