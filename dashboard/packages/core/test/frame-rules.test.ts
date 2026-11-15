import { describe, expect, it } from "vitest";
import { decodeGuardRule, encodeGuardRule } from "../src/waf.js";
import { decideFraming, frameHeadersFor, FRAME_DECISION_MAX } from "../src/frame-rules.js";
import {
    FRAME_RULES_MAX,
    wafFrameRuleSchema,
    wafRuleInputSchema,
    type WafFrameRule
} from "../src/schemas/deploy.js";

const BASE = ["https://partner.example"];

function rule(overrides: Partial<WafFrameRule>): WafFrameRule {
    return {
        name: "rule",
        enabled: true,
        action: "allow",
        ancestors: ["https://office.example"],
        conditions: [{ field: "ip", operator: "equals", values: ["10.0.0.0/8"] }],
        ...overrides
    };
}

describe("decideFraming", () => {
    it("keeps the base list when no rule matches", () => {
        expect(decideFraming(BASE, [rule({})], { ip: "203.0.113.5" })).toEqual({
            refuse: false,
            allowed: BASE
        });
    });

    it("adds an allow rule's sites when the address is in its range", () => {
        expect(decideFraming(BASE, [rule({})], { ip: "10.1.2.3" })).toEqual({
            refuse: false,
            allowed: ["https://partner.example", "https://office.example"]
        });
    });

    it("matches by user agent", () => {
        const byAgent = rule({
            conditions: [{ field: "user_agent", operator: "contains", values: ["KioskBrowser"] }]
        });
        expect(decideFraming([], [byAgent], { userAgent: "Mozilla/5.0 kioskbrowser/2" })).toEqual({
            refuse: false,
            allowed: ["https://office.example"]
        });
        expect(decideFraming([], [byAgent], { userAgent: "curl/8" })).toEqual({
            refuse: false,
            allowed: []
        });
    });

    it("matches by hostname", () => {
        const byHost = rule({
            conditions: [{ field: "host", operator: "equals", values: ["Embed.Example.com"] }]
        });
        expect(decideFraming([], [byHost], { host: "embed.example.com" })).toMatchObject({
            allowed: ["https://office.example"]
        });
        expect(decideFraming([], [byHost], { host: "app.example.com" })).toMatchObject({
            allowed: []
        });
    });

    it("reads a combined group", () => {
        const grouped = rule({
            conditions: [
                { field: "ip", operator: "equals", values: ["10.0.0.0/8"] },
                {
                    match: "any",
                    conditions: [
                        { field: "path", operator: "starts_with", values: ["/embed"] },
                        { field: "host", operator: "equals", values: ["widgets.example.com"] }
                    ]
                }
            ]
        });
        const facts = { ip: "10.0.0.9", host: "app.example.com" };
        expect(decideFraming([], [grouped], { ...facts, path: "/embed/1" })).toMatchObject({
            allowed: ["https://office.example"]
        });
        expect(decideFraming([], [grouped], { ...facts, path: "/admin" })).toMatchObject({
            allowed: []
        });
        expect(
            decideFraming([], [grouped], { ip: "192.0.2.1", path: "/embed/1" })
        ).toMatchObject({ allowed: [] });
    });

    it("lets a matching refusal win over an allow, wherever it sits", () => {
        const refuse = rule({ action: "refuse", ancestors: [] });
        expect(decideFraming(BASE, [rule({}), refuse], { ip: "10.0.0.1" })).toEqual({
            refuse: true
        });
        expect(decideFraming(BASE, [refuse, rule({})], { ip: "10.0.0.1" })).toEqual({
            refuse: true
        });
    });

    it("ignores a disabled rule", () => {
        const off = rule({ action: "refuse", enabled: false });
        expect(decideFraming(BASE, [off], { ip: "10.0.0.1" })).toEqual({
            refuse: false,
            allowed: BASE
        });
    });

    it("never treats a missing fact as a match", () => {
        expect(decideFraming(BASE, [rule({ action: "refuse" })], {})).toEqual({
            refuse: false,
            allowed: BASE
        });
    });

    it("caps the origins one response names", () => {
        const many = Array.from({ length: FRAME_RULES_MAX }, (_, i) =>
            rule({
                ancestors: Array.from({ length: 20 }, (_, j) => `https://s${i}-${j}.example`)
            })
        );
        const decision = decideFraming(BASE, many, { ip: "10.0.0.1" });
        expect(decision.refuse).toBe(false);
        if (!decision.refuse) {
            expect(decision.allowed).toHaveLength(FRAME_DECISION_MAX);
            expect(decision.allowed[0]).toBe("https://partner.example");
        }
    });
});

describe("frameHeadersFor", () => {
    it("appends a refusing policy beside the app's own and denies the old header", () => {
        const out = frameHeadersFor(
            {
                "content-security-policy": "default-src 'self'; frame-ancestors https://a.example",
                "x-frame-options": "SAMEORIGIN"
            },
            { refuse: true }
        );
        expect(out["content-security-policy"]).toEqual([
            "default-src 'self'; frame-ancestors https://a.example",
            "frame-ancestors 'none'"
        ]);
        expect(out["x-frame-options"]).toBe("DENY");
    });

    it("merges an allowed list the ordinary way", () => {
        const out = frameHeadersFor({}, { refuse: false, allowed: ["https://office.example"] });
        expect(out["content-security-policy"]).toEqual([
            "frame-ancestors 'self' https://office.example"
        ]);
        expect(out["x-frame-options"]).toBeUndefined();
    });
});

describe("wafFrameRuleSchema", () => {
    it("normalizes sites and refuses an allow with none", () => {
        const parsed = wafFrameRuleSchema.safeParse(rule({ ancestors: ["Office.Example"] }));
        expect(parsed.success && parsed.data.ancestors).toEqual(["https://office.example"]);
        expect(wafFrameRuleSchema.safeParse(rule({ ancestors: [] })).success).toBe(false);
        expect(
            wafFrameRuleSchema.safeParse(rule({ action: "refuse", ancestors: [] })).success
        ).toBe(true);
    });

    it("refuses a rule without conditions or with a site that could break the header", () => {
        expect(wafFrameRuleSchema.safeParse(rule({ conditions: [] })).success).toBe(false);
        expect(
            wafFrameRuleSchema.safeParse(rule({ ancestors: ["https://a.example; script-src *"] }))
                .success
        ).toBe(false);
    });

    it("defaults to no rules on a scope that never had any, and caps the list", () => {
        expect(wafRuleInputSchema.parse({}).frameRules).toEqual([]);
        const tooMany = Array.from({ length: FRAME_RULES_MAX + 1 }, () => rule({}));
        expect(wafRuleInputSchema.safeParse({ frameRules: tooMany }).success).toBe(false);
    });
});

describe("guard rule framing rules", () => {
    const base = { deny: [], requireLogin: false, rules: [] };

    it("round-trips beside the allowed sites", () => {
        const header = encodeGuardRule({
            ...base,
            frameAncestors: BASE,
            frameRules: [rule({}), rule({ action: "refuse", name: "no" })]
        });
        const decoded = decodeGuardRule(header);
        expect(decoded.frameAncestors).toEqual(BASE);
        expect(decoded.frameRules).toHaveLength(2);
        expect(decoded.frameRules?.[1]?.action).toBe("refuse");
    });

    it("is left out when framing protection is off or there are none", () => {
        const off = JSON.parse(
            Buffer.from(encodeGuardRule({ ...base, frameRules: [rule({})] }), "base64").toString()
        );
        expect(off.fr).toBeUndefined();
        const none = JSON.parse(
            Buffer.from(
                encodeGuardRule({ ...base, frameAncestors: [], frameRules: [] }),
                "base64"
            ).toString()
        );
        expect(none.fr).toBeUndefined();
        expect(decodeGuardRule(encodeGuardRule({ ...base, frameAncestors: [] })).frameRules).toBe(
            undefined
        );
    });

    it("drops an entry that does not validate and keeps the rest", () => {
        const header = Buffer.from(
            JSON.stringify({
                d: [],
                l: false,
                f: [],
                fr: [
                    rule({}),
                    { ...rule({}), ancestors: ["javascript:alert(1)"] },
                    { name: "x", action: "refuse" },
                    "nonsense"
                ],
                r: []
            })
        ).toString("base64");
        const decoded = decodeGuardRule(header);
        expect(decoded.frameRules).toHaveLength(1);
        expect(decoded.frameRules?.[0]?.ancestors).toEqual(["https://office.example"]);
    });

    it("ignores rules sent without the allowed list", () => {
        const header = Buffer.from(
            JSON.stringify({ d: [], l: false, fr: [rule({})], r: [] })
        ).toString("base64");
        const decoded = decodeGuardRule(header);
        expect(decoded.frameAncestors).toBeUndefined();
        expect(decoded.frameRules).toBeUndefined();
    });
});
