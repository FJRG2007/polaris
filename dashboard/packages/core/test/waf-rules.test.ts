/**
 * The firewall's custom rules decide, for every request to a protected route,
 * whether it is served at all. Two things are protected here: that the order of the
 * rules is the order they are tried in (so an exception written above a block stays
 * an exception), and that a condition never holds by accident - a missing user agent
 * must not satisfy "the user agent is not curl", which is exactly what a client
 * evading that rule would send.
 */

import { describe, expect, it } from "vitest";
import { evaluateWafRules } from "../src/waf-rules.js";
import { wafConditionTests, wafCustomRuleSchema, type WafCustomRule } from "../src/schemas/deploy.js";

function rule(overrides: Partial<WafCustomRule> & Pick<WafCustomRule, "conditions">): WafCustomRule {
    return { name: "rule", enabled: true, action: "block", ...overrides };
}

describe("matching one condition", () => {
    it("matches a path prefix", () => {
        const rules = [rule({ conditions: [{ field: "path", operator: "starts_with", values: ["/wp-admin"] }] })];

        expect(evaluateWafRules(rules, { path: "/wp-admin/setup.php" }).verdict?.action).toBe("block");
        expect(evaluateWafRules(rules, { path: "/about" }).verdict).toBeNull();
    });

    it("matches any one of a condition's values", () => {
        const rules = [rule({ conditions: [{ field: "method", operator: "equals", values: ["POST", "PUT"] }] })];

        expect(evaluateWafRules(rules, { method: "put" }).verdict?.action).toBe("block");
        expect(evaluateWafRules(rules, { method: "GET" }).verdict).toBeNull();
    });

    it("reads an address as a range, not as a string", () => {
        const rules = [rule({ conditions: [{ field: "ip", operator: "equals", values: ["203.0.113.0/24"] }] })];

        expect(evaluateWafRules(rules, { ip: "203.0.113.9" }).verdict?.action).toBe("block");
        expect(evaluateWafRules(rules, { ip: "203.0.114.9" }).verdict).toBeNull();
    });

    it("ignores case where case carries no meaning", () => {
        const rules = [rule({ conditions: [{ field: "user_agent", operator: "contains", values: ["CURL"] }] })];

        expect(evaluateWafRules(rules, { userAgent: "curl/8.4.0" }).verdict?.action).toBe("block");
    });

    it("keeps case in a path, which is where it means something", () => {
        const rules = [rule({ conditions: [{ field: "path", operator: "equals", values: ["/Admin"] }] })];

        expect(evaluateWafRules(rules, { path: "/admin" }).verdict).toBeNull();
    });

    it("does not satisfy a negative condition with a missing fact", () => {
        const rules = [rule({ conditions: [{ field: "user_agent", operator: "not_equals", values: ["polaris"] }] })];

        expect(evaluateWafRules(rules, { userAgent: null }).verdict).toBeNull();
        expect(evaluateWafRules(rules, { userAgent: "something-else" }).verdict?.action).toBe("block");
    });
});

describe("combining conditions", () => {
    it("needs every condition to hold", () => {
        const rules = [
            rule({
                conditions: [
                    { field: "path", operator: "starts_with", values: ["/api"] },
                    { field: "method", operator: "equals", values: ["DELETE"] }
                ]
            })
        ];

        expect(evaluateWafRules(rules, { path: "/api/things", method: "DELETE" }).verdict?.action).toBe("block");
        expect(evaluateWafRules(rules, { path: "/api/things", method: "GET" }).verdict).toBeNull();
    });

    it("reads a nested group as its own any", () => {
        const rules = [
            rule({
                conditions: [
                    { field: "ip", operator: "equals", values: ["203.0.113.0/24"] },
                    {
                        match: "any",
                        conditions: [
                            { field: "path", operator: "starts_with", values: ["/admin"] },
                            { field: "query", operator: "contains", values: ["debug=1"] }
                        ]
                    }
                ]
            })
        ];

        expect(evaluateWafRules(rules, { ip: "203.0.113.9", path: "/admin/users" }).verdict?.action).toBe("block");
        expect(evaluateWafRules(rules, { ip: "203.0.113.9", path: "/", query: "debug=1" }).verdict?.action).toBe("block");
        // Inside the network but doing neither of the two things the group names.
        expect(evaluateWafRules(rules, { ip: "203.0.113.9", path: "/about" }).verdict).toBeNull();
        // Doing one of them from outside the network.
        expect(evaluateWafRules(rules, { ip: "198.51.100.2", path: "/admin/users" }).verdict).toBeNull();
    });

    it("reads a nested group as its own all", () => {
        const rules = [
            rule({
                conditions: [
                    {
                        match: "all",
                        conditions: [
                            { field: "path", operator: "starts_with", values: ["/api"] },
                            { field: "method", operator: "equals", values: ["POST"] }
                        ]
                    }
                ]
            })
        ];

        expect(evaluateWafRules(rules, { path: "/api/things", method: "POST" }).verdict?.action).toBe("block");
        expect(evaluateWafRules(rules, { path: "/api/things", method: "GET" }).verdict).toBeNull();
    });

    it("carries the match down a second level of nesting", () => {
        const rules = [
            rule({
                conditions: [
                    {
                        match: "any",
                        conditions: [
                            { field: "user_agent", operator: "contains", values: ["curl"] },
                            {
                                match: "all",
                                conditions: [
                                    { field: "method", operator: "equals", values: ["POST"] },
                                    { field: "path", operator: "ends_with", values: [".php"] }
                                ]
                            }
                        ]
                    }
                ]
            })
        ];

        expect(evaluateWafRules(rules, { userAgent: "curl/8.4.0" }).verdict?.action).toBe("block");
        expect(evaluateWafRules(rules, { method: "POST", path: "/x.php" }).verdict?.action).toBe("block");
        // The inner group is an `all`, so half of it is not enough.
        expect(evaluateWafRules(rules, { method: "POST", path: "/x.html" }).verdict).toBeNull();
    });
});

describe("testing a signature check as a condition", () => {
    it("matches a request the SQL check would refuse, narrowed to one hostname", () => {
        const rules = [
            rule({
                conditions: [
                    { signal: "sql_injection", negate: false },
                    { field: "host", operator: "equals", values: ["shop.example.com"] }
                ]
            })
        ];

        expect(
            evaluateWafRules(rules, { host: "shop.example.com", query: "id=1 or 1=1" }).verdict?.action
        ).toBe("block");
        // The same payload somewhere this rule does not cover.
        expect(evaluateWafRules(rules, { host: "www.example.com", query: "id=1 or 1=1" }).verdict).toBeNull();
        // The same hostname, an honest request.
        expect(evaluateWafRules(rules, { host: "shop.example.com", query: "id=1" }).verdict).toBeNull();
    });

    it("keeps the two injection classes apart", () => {
        const sql = [rule({ conditions: [{ signal: "sql_injection", negate: false }] })];
        const xss = [rule({ conditions: [{ signal: "xss", negate: false }] })];

        expect(evaluateWafRules(sql, { query: "id=1 or 1=1" }).verdict?.action).toBe("block");
        expect(evaluateWafRules(xss, { query: "id=1 or 1=1" }).verdict).toBeNull();
        expect(evaluateWafRules(xss, { query: "q=<script>x</script>" }).verdict?.action).toBe("block");
    });

    it("reads a negated check as everything it would not refuse", () => {
        const rules = [rule({ action: "allow", conditions: [{ signal: "sql_injection", negate: true }] })];

        expect(evaluateWafRules(rules, { query: "id=1" }).verdict?.action).toBe("allow");
        expect(evaluateWafRules(rules, { query: "id=1 or 1=1" }).verdict).toBeNull();
    });

    it("reads the browser integrity check from the headers it is given", () => {
        const rules = [rule({ conditions: [{ signal: "browser_integrity", negate: false }] })];

        // A browser claim with none of what a browser sends.
        expect(evaluateWafRules(rules, { userAgent: "Mozilla/5.0 (Windows NT 10.0)" }).verdict?.action).toBe("block");
        expect(
            evaluateWafRules(rules, {
                userAgent: "Mozilla/5.0 (Windows NT 10.0)",
                accept: "text/html",
                acceptLanguage: "en"
            }).verdict
        ).toBeNull();
    });
});

describe("skipping rather than deciding", () => {
    const exempt = rule({
        name: "our own SDK",
        action: "skip",
        skip: ["injection_checks"],
        conditions: [{ field: "user_agent", operator: "equals", values: ["PolarisSDK/1.0"] }]
    });

    it("records what to step over and lets the walk carry on", () => {
        const rules = [exempt, rule({ name: "no admin", conditions: [{ field: "path", operator: "starts_with", values: ["/admin"] }] })];
        const outcome = evaluateWafRules(rules, { userAgent: "PolarisSDK/1.0", path: "/admin" });

        // The skip did not admit the request: the block below it still decided.
        expect(outcome.verdict?.rule.name).toBe("no admin");
        expect([...outcome.skipped]).toEqual(["injection_checks"]);
        expect(outcome.skippedBy).toEqual(["our own SDK"]);
    });

    it("stops the walk only when it skips the remaining rules", () => {
        const stopper = rule({
            name: "trusted",
            action: "skip",
            skip: ["custom_rules", "managed_rules"],
            conditions: [{ field: "ip", operator: "equals", values: ["203.0.113.7"] }]
        });
        const rules = [stopper, rule({ name: "no admin", conditions: [{ field: "path", operator: "starts_with", values: ["/admin"] }] })];
        const outcome = evaluateWafRules(rules, { ip: "203.0.113.7", path: "/admin" });

        expect(outcome.verdict).toBeNull();
        expect([...outcome.skipped].sort()).toEqual(["custom_rules", "managed_rules"]);
    });

    it("skips nothing for a request the rule does not match", () => {
        const outcome = evaluateWafRules([exempt], { userAgent: "curl/8.4.0" });

        expect(outcome.verdict).toBeNull();
        expect(outcome.skipped.size).toBe(0);
    });

    it("refuses to save a skip that skips nothing", () => {
        const parsed = wafCustomRuleSchema.safeParse({
            name: "does nothing",
            action: "skip",
            conditions: [{ field: "path", operator: "starts_with", values: ["/"] }]
        });

        expect(parsed.success).toBe(false);
    });
});

describe("what a rule may hold", () => {
    it("still accepts a rule written before groups existed", () => {
        const parsed = wafCustomRuleSchema.safeParse({
            name: "old",
            enabled: true,
            action: "block",
            conditions: [{ field: "path", operator: "starts_with", values: ["/wp-admin"] }]
        });

        expect(parsed.success).toBe(true);
    });

    it("refuses a rule with more tests than the wire format should carry", () => {
        const test = { field: "path", operator: "contains", values: ["x"] };
        const group = { match: "any", conditions: Array.from({ length: 8 }, () => test) };
        const parsed = wafCustomRuleSchema.safeParse({
            name: "too much",
            action: "block",
            // 8 groups of 8 is 64 tests, twice what one rule may hold.
            conditions: Array.from({ length: 8 }, () => group)
        });

        expect(parsed.success).toBe(false);
    });

    it("counts the tests inside every group", () => {
        expect(
            wafConditionTests({
                match: "any",
                conditions: [
                    { field: "path", operator: "contains", values: ["a"] },
                    {
                        match: "all",
                        conditions: [
                            { field: "path", operator: "contains", values: ["b"] },
                            { field: "path", operator: "contains", values: ["c"] }
                        ]
                    }
                ]
            })
        ).toBe(3);
    });
});

describe("ordering", () => {
    it("lets an allow above a block carve out an exception", () => {
        const rules = [
            rule({
                name: "office",
                action: "allow",
                conditions: [{ field: "ip", operator: "equals", values: ["203.0.113.7"] }]
            }),
            rule({ name: "everyone else", conditions: [{ field: "path", operator: "starts_with", values: ["/"] }] })
        ];

        expect(evaluateWafRules(rules, { ip: "203.0.113.7", path: "/anything" }).verdict?.action).toBe("allow");
        expect(evaluateWafRules(rules, { ip: "198.51.100.2", path: "/anything" }).verdict?.action).toBe("block");
    });

    it("reports which rule decided", () => {
        const rules = [rule({ name: "no scanners", conditions: [{ field: "path", operator: "contains", values: [".env"] }] })];

        expect(evaluateWafRules(rules, { path: "/.env" }).verdict?.rule.name).toBe("no scanners");
    });

    it("skips a disabled rule without skipping the ones after it", () => {
        const rules = [
            rule({ name: "off", enabled: false, action: "allow", conditions: [{ field: "path", operator: "starts_with", values: ["/"] }] }),
            rule({ name: "on", conditions: [{ field: "path", operator: "starts_with", values: ["/"] }] })
        ];

        expect(evaluateWafRules(rules, { path: "/x" }).verdict?.rule.name).toBe("on");
    });

    it("says nothing when no rule matches, leaving the rest of the guard to decide", () => {
        const rules = [rule({ conditions: [{ field: "host", operator: "equals", values: ["admin.example.com"] }] })];

        expect(evaluateWafRules(rules, { host: "www.example.com" }).verdict).toBeNull();
        expect(evaluateWafRules([], { host: "admin.example.com" }).verdict).toBeNull();
    });
});
