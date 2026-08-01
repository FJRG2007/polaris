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
import type { WafCustomRule } from "../src/schemas/deploy.js";

function rule(overrides: Partial<WafCustomRule> & Pick<WafCustomRule, "conditions">): WafCustomRule {
    return { name: "rule", enabled: true, action: "block", ...overrides };
}

describe("matching one condition", () => {
    it("matches a path prefix", () => {
        const rules = [rule({ conditions: [{ field: "path", operator: "starts_with", values: ["/wp-admin"] }] })];

        expect(evaluateWafRules(rules, { path: "/wp-admin/setup.php" })?.action).toBe("block");
        expect(evaluateWafRules(rules, { path: "/about" })).toBeNull();
    });

    it("matches any one of a condition's values", () => {
        const rules = [rule({ conditions: [{ field: "method", operator: "equals", values: ["POST", "PUT"] }] })];

        expect(evaluateWafRules(rules, { method: "put" })?.action).toBe("block");
        expect(evaluateWafRules(rules, { method: "GET" })).toBeNull();
    });

    it("reads an address as a range, not as a string", () => {
        const rules = [rule({ conditions: [{ field: "ip", operator: "equals", values: ["203.0.113.0/24"] }] })];

        expect(evaluateWafRules(rules, { ip: "203.0.113.9" })?.action).toBe("block");
        expect(evaluateWafRules(rules, { ip: "203.0.114.9" })).toBeNull();
    });

    it("ignores case where case carries no meaning", () => {
        const rules = [rule({ conditions: [{ field: "user_agent", operator: "contains", values: ["CURL"] }] })];

        expect(evaluateWafRules(rules, { userAgent: "curl/8.4.0" })?.action).toBe("block");
    });

    it("keeps case in a path, which is where it means something", () => {
        const rules = [rule({ conditions: [{ field: "path", operator: "equals", values: ["/Admin"] }] })];

        expect(evaluateWafRules(rules, { path: "/admin" })).toBeNull();
    });

    it("does not satisfy a negative condition with a missing fact", () => {
        const rules = [rule({ conditions: [{ field: "user_agent", operator: "not_equals", values: ["polaris"] }] })];

        expect(evaluateWafRules(rules, { userAgent: null })).toBeNull();
        expect(evaluateWafRules(rules, { userAgent: "something-else" })?.action).toBe("block");
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

        expect(evaluateWafRules(rules, { path: "/api/things", method: "DELETE" })?.action).toBe("block");
        expect(evaluateWafRules(rules, { path: "/api/things", method: "GET" })).toBeNull();
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

        expect(evaluateWafRules(rules, { ip: "203.0.113.7", path: "/anything" })?.action).toBe("allow");
        expect(evaluateWafRules(rules, { ip: "198.51.100.2", path: "/anything" })?.action).toBe("block");
    });

    it("reports which rule decided", () => {
        const rules = [rule({ name: "no scanners", conditions: [{ field: "path", operator: "contains", values: [".env"] }] })];

        expect(evaluateWafRules(rules, { path: "/.env" })?.rule.name).toBe("no scanners");
    });

    it("skips a disabled rule without skipping the ones after it", () => {
        const rules = [
            rule({ name: "off", enabled: false, action: "allow", conditions: [{ field: "path", operator: "starts_with", values: ["/"] }] }),
            rule({ name: "on", conditions: [{ field: "path", operator: "starts_with", values: ["/"] }] })
        ];

        expect(evaluateWafRules(rules, { path: "/x" })?.rule.name).toBe("on");
    });

    it("says nothing when no rule matches, leaving the rest of the guard to decide", () => {
        const rules = [rule({ conditions: [{ field: "host", operator: "equals", values: ["admin.example.com"] }] })];

        expect(evaluateWafRules(rules, { host: "www.example.com" })).toBeNull();
        expect(evaluateWafRules([], { host: "admin.example.com" })).toBeNull();
    });
});
