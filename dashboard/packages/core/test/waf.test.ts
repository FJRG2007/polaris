import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { wafRuleInputSchema, WAF_LIST_MAX } from "../src/schemas/deploy.js";
import {
    decodeGuardRule,
    encodeGuardRule,
    membershipTooOld,
    principalVerdict,
    principalsSuperseded,
    signEdgeToken,
    verifyEdgeToken,
    EDGE_TOKEN_TTL_SECONDS,
    MEMBERSHIP_MAX_AGE_SECONDS
} from "../src/waf.js";

const SECRET = "unit-test-secret-16chars";
const HOST = "app.example.com";
const NOW = 1_800_000_000;

/** A custom rule as the editor produces one. */
const CUSTOM_RULE = {
    name: "Block the admin path",
    enabled: true,
    action: "block" as const,
    conditions: [{ field: "path" as const, operator: "starts_with" as const, values: ["/wp-admin"] }]
};

describe("guard rule codec", () => {
    it("round-trips a rule", () => {
        const rule = {
            deny: ["10.0.0.0/8", "203.0.113.5"],
            requireLogin: true,
            loginUrl: "https://polaris.example.com",
            loginAllowLists: [[{ ref: "group:ops" }], [{ ref: "user:u1", until: NOW + 3600 }]],
            loginDeny: [{ ref: "role:contractor", from: NOW }],
            browserIntegrity: false,
            sqlInjectionProtection: true,
            xssProtection: true,
            emailObfuscation: false,
            presets: [],
            rules: [CUSTOM_RULE],
            managedRules: []
        };
        expect(decodeGuardRule(encodeGuardRule(rule))).toEqual(rule);
    });

    it("round-trips a rule with nested condition groups", () => {
        // The decoder re-validates every rule and drops the ones that fail, so a
        // group the schema does not recognise would not be a visible error - it would
        // be a rule that quietly stops being enforced at the edge.
        const nested = {
            name: "admin from outside",
            enabled: true,
            action: "block" as const,
            conditions: [
                { field: "ip" as const, operator: "not_equals" as const, values: ["203.0.113.0/24"] },
                {
                    match: "any" as const,
                    conditions: [
                        { field: "path" as const, operator: "starts_with" as const, values: ["/admin"] },
                        {
                            match: "all" as const,
                            conditions: [
                                { field: "method" as const, operator: "equals" as const, values: ["POST"] },
                                { field: "query" as const, operator: "contains" as const, values: ["debug=1"] }
                            ]
                        }
                    ]
                }
            ]
        };

        const decoded = decodeGuardRule(
            encodeGuardRule({ deny: [], requireLogin: false, rules: [nested] })
        );

        expect(decoded.rules).toEqual([nested]);
    });

    it("treats an absent header as a no-op", () => {
        expect(decodeGuardRule(undefined)).toEqual({
            deny: [],
            requireLogin: false,
            loginAllowLists: [],
            loginDeny: [],
            browserIntegrity: false,
            sqlInjectionProtection: false,
            xssProtection: false,
            emailObfuscation: false,
            presets: [],
            rules: [],
            managedRules: []
        });
    });

    it("fails closed on a malformed header (requires login and inspects payloads)", () => {
        expect(decodeGuardRule("###not-valid###")).toEqual({
            deny: [],
            requireLogin: true,
            // No principal list, deliberately: an unreadable header must send a visitor
            // to a login, not refuse every account including the operator fixing it.
            loginAllowLists: [],
            loginDeny: [],
            browserIntegrity: false,
            sqlInjectionProtection: true,
            xssProtection: true,
            emailObfuscation: false,
            presets: [],
            rules: [],
            managedRules: []
        });
    });

    it("drops non-string denylist entries", () => {
        const header = Buffer.from(JSON.stringify({ d: ["10.0.0.1", 5, null], l: false })).toString("base64");
        expect(decodeGuardRule(header)).toEqual({
            deny: ["10.0.0.1"],
            requireLogin: false,
            loginAllowLists: [],
            loginDeny: [],
            browserIntegrity: false,
            sqlInjectionProtection: false,
            xssProtection: false,
            emailObfuscation: false,
            presets: [],
            rules: [],
            managedRules: []
        });
    });

    it("reads a header from before principals as admitting any account", () => {
        // An edge materialized before this control existed carries no `n` key at all.
        // That route required a login and let any account through, and it has to keep
        // doing exactly that until it is rewritten.
        const header = Buffer.from(JSON.stringify({ d: [], l: true })).toString("base64");
        expect(decodeGuardRule(header).loginAllowLists).toEqual([]);
        expect(decodeGuardRule(header).loginDeny).toEqual([]);
    });

    it("drops a principal list that decodes to nothing rather than keeping it empty", () => {
        // An empty list is a constraint nobody satisfies, so keeping one would turn a
        // garbled entry into a route nobody can reach.
        const header = Buffer.from(
            JSON.stringify({ d: [], l: true, n: [[{ r: "group:ops" }], [], [3, null], "nope"] })
        ).toString("base64");
        expect(decodeGuardRule(header).loginAllowLists).toEqual([[{ ref: "group:ops" }]]);
    });

    it("drops a grant whose window did not decode, rather than keeping it unbounded", () => {
        // An expiry that silently became "never" is the one way this can fail that
        // nobody would notice, so the entry goes rather than its bound.
        const header = Buffer.from(
            JSON.stringify({
                d: [],
                l: true,
                y: [
                    { r: "user:u1", u: "soon" },
                    { r: "user:u2", u: NOW }
                ]
            })
        ).toString("base64");
        expect(decodeGuardRule(header).loginDeny).toEqual([{ ref: "user:u2", until: NOW }]);
    });

    it("keeps the login address off a rule that does not need one", () => {
        // The header is stamped onto every request to the route, so a key that could
        // only ever go unread is one not worth sending.
        const encoded = encodeGuardRule({
            deny: [],
            requireLogin: false,
            loginUrl: "https://polaris.example.com",
            rules: []
        });
        expect(decodeGuardRule(encoded).loginUrl).toBeUndefined();
    });

    it("refuses a login address that is not an absolute http(s) URL", () => {
        // It ends up in a Location header, so a misconfigured one has to fail to a login
        // that does not happen rather than to a redirect somewhere unintended.
        for (const loginUrl of ["polaris.example.com", "javascript:alert(1)", "/edge"]) {
            const encoded = encodeGuardRule({ deny: [], requireLogin: true, loginUrl, rules: [] });
            expect(decodeGuardRule(encoded).loginUrl).toBeUndefined();
        }
    });

    it("reads a pre-split header as both injection checks", () => {
        // An edge materialized before the split still stamps the single `i` flag, and
        // keeps both protections until its route is rewritten.
        const header = Buffer.from(JSON.stringify({ d: [], l: false, i: true })).toString("base64");
        const rule = decodeGuardRule(header);
        expect(rule.sqlInjectionProtection).toBe(true);
        expect(rule.xssProtection).toBe(true);
    });

    it("drops one unreadable custom rule and keeps the rest", () => {
        // A rule set survives a schema change; the ones that still parse must keep
        // running rather than the whole route losing its rules.
        const header = Buffer.from(
            JSON.stringify({ d: [], l: false, r: [{ name: "broken" }, CUSTOM_RULE] })
        ).toString("base64");
        expect(decodeGuardRule(header).rules).toEqual([CUSTOM_RULE]);
    });
});

describe("edge token", () => {
    it("verifies a valid, host-bound, unexpired token", () => {
        const token = signEdgeToken({ sub: "u1", aud: HOST, exp: NOW + 60, iat: NOW }, SECRET);
        expect(verifyEdgeToken(token, SECRET, NOW, HOST)).toEqual({
            sub: "u1",
            aud: HOST,
            exp: NOW + 60,
            iat: NOW,
            prn: []
        });
    });

    it("carries the principals it was minted with", () => {
        const prn = ["user:u1", "group:ops"];
        const token = signEdgeToken({ sub: "u1", aud: HOST, exp: NOW + 60, prn }, SECRET);
        expect(verifyEdgeToken(token, SECRET, NOW, HOST)?.prn).toEqual(prn);
    });

    it("leaves prn undefined for a token minted before principals existed", () => {
        // Signed by hand, because signEdgeToken always writes the key now - which is
        // exactly what makes its absence a reliable signal of an old token.
        const payload = Buffer.from(JSON.stringify({ sub: "u1", aud: HOST, exp: NOW + 60 })).toString("base64url");
        const sig = createHmac("sha256", SECRET).update(`edge:${payload}`).digest("base64url");
        expect(verifyEdgeToken(`${payload}.${sig}`, SECRET, NOW, HOST)?.prn).toBeUndefined();
    });

    it("rejects a token bound to another host", () => {
        const token = signEdgeToken({ sub: "u1", aud: "other.example.com", exp: NOW + 60 }, SECRET);
        expect(verifyEdgeToken(token, SECRET, NOW, HOST)).toBeNull();
    });

    it("rejects an expired token", () => {
        const token = signEdgeToken({ sub: "u1", aud: HOST, exp: NOW - 1 }, SECRET);
        expect(verifyEdgeToken(token, SECRET, NOW, HOST)).toBeNull();
    });

    it("rejects a token signed with a different secret", () => {
        const token = signEdgeToken({ sub: "u1", aud: HOST, exp: NOW + 60 }, "another-secret-16char");
        expect(verifyEdgeToken(token, SECRET, NOW, HOST)).toBeNull();
    });

    it("rejects a tampered payload", () => {
        const token = signEdgeToken({ sub: "u1", aud: HOST, exp: NOW + 60 }, SECRET);
        const tampered = `${Buffer.from(JSON.stringify({ sub: "admin", aud: HOST, exp: NOW + 60 })).toString("base64url")}.${token.split(".")[1]}`;
        expect(verifyEdgeToken(tampered, SECRET, NOW, HOST)).toBeNull();
    });

    it("returns null for missing or shapeless input", () => {
        expect(verifyEdgeToken(undefined, SECRET, NOW)).toBeNull();
        expect(verifyEdgeToken("no-dot", SECRET, NOW)).toBeNull();
    });

    it("rejects any token when the secret is empty (an empty HMAC key is forgeable)", () => {
        const token = signEdgeToken({ sub: "u1", aud: HOST, exp: NOW + 60 }, "");
        expect(verifyEdgeToken(token, "", NOW, HOST)).toBeNull();
    });
});

describe("wafRuleInputSchema", () => {
    it("accepts a valid rule and applies defaults", () => {
        const parsed = wafRuleInputSchema.parse({ ipAllowlist: ["10.0.0.0/8"] });
        // The two injection checks and email obfuscation default ON, which is what "on
        // everywhere" means at the schema level rather than at the UI's.
        expect(parsed).toEqual({
            ipAllowlist: ["10.0.0.0/8"],
            ipDenylist: [],
            requireLogin: false,
            loginAllowPrincipals: [],
            loginDenyPrincipals: [],
            browserIntegrity: false,
            sqlInjectionProtection: true,
            xssProtection: true,
            emailObfuscation: true,
            presets: [],
            rules: []
        });
    });

    it("rejects a custom rule with no conditions", () => {
        // A rule that tests nothing matches everything, which for a block is the
        // whole site and for an allow is the firewall switched off.
        const result = wafRuleInputSchema.safeParse({
            rules: [{ name: "empty", action: "block", conditions: [] }]
        });
        expect(result.success).toBe(false);
    });

    it("rejects a condition with no values", () => {
        const result = wafRuleInputSchema.safeParse({
            rules: [{ name: "empty", action: "block", conditions: [{ field: "path", operator: "equals", values: [] }] }]
        });
        expect(result.success).toBe(false);
    });

    it("rejects an entry present in both allow and deny", () => {
        const result = wafRuleInputSchema.safeParse({ ipAllowlist: ["10.0.0.1"], ipDenylist: ["10.0.0.1"] });
        expect(result.success).toBe(false);
    });

    it("rejects a malformed CIDR/IP entry", () => {
        expect(wafRuleInputSchema.safeParse({ ipAllowlist: ["not-an-ip"] }).success).toBe(false);
    });

    it("caps a list at WAF_LIST_MAX entries", () => {
        const many = Array.from({ length: WAF_LIST_MAX + 1 }, (_, i) => `10.0.${Math.floor(i / 256)}.${i % 256}`);
        expect(wafRuleInputSchema.safeParse({ ipDenylist: many }).success).toBe(false);
    });

    it("accepts the three principal kinds and rejects anything else", () => {
        const ok = wafRuleInputSchema.safeParse({
            loginAllowPrincipals: [{ ref: "user:abc" }, { ref: "group:ops-1" }, { ref: "role:admin" }]
        });
        expect(ok.success).toBe(true);
        // A bare id names nothing in particular, and an unknown kind would be stored,
        // shipped to the edge and silently matched against nobody.
        expect(wafRuleInputSchema.safeParse({ loginAllowPrincipals: [{ ref: "abc" }] }).success).toBe(false);
        expect(wafRuleInputSchema.safeParse({ loginAllowPrincipals: [{ ref: "host:abc" }] }).success).toBe(false);
        expect(wafRuleInputSchema.safeParse({ loginAllowPrincipals: [{ ref: "user:" }] }).success).toBe(false);
    });

    it("rejects a window that ends before it starts", () => {
        // Not merely useless: it reads as a grant while admitting nobody, ever.
        const result = wafRuleInputSchema.safeParse({
            loginAllowPrincipals: [{ ref: "user:abc", from: NOW + 60, until: NOW }]
        });
        expect(result.success).toBe(false);
    });

    it("rejects a principal named in both lists", () => {
        const result = wafRuleInputSchema.safeParse({
            loginAllowPrincipals: [{ ref: "group:ops" }],
            loginDenyPrincipals: [{ ref: "group:ops" }]
        });
        expect(result.success).toBe(false);
    });
});

describe("principalVerdict", () => {
    const held = new Set(["user:u1", "group:ops"]);

    it("admits anybody when no scope named anyone", () => {
        expect(principalVerdict({}, held, NOW)).toBe("admitted");
        expect(principalVerdict({ loginAllowLists: [], loginDeny: [] }, new Set(), NOW)).toBe("admitted");
    });

    it("admits a visitor matching any entry of a list", () => {
        const lists = [[{ ref: "group:sales" }, { ref: "user:u1" }]];
        expect(principalVerdict({ loginAllowLists: lists }, held, NOW)).toBe("admitted");
    });

    it("does not admit a visitor matching no entry", () => {
        expect(principalVerdict({ loginAllowLists: [[{ ref: "group:sales" }]] }, held, NOW)).toBe("not-admitted");
    });

    it("requires every scope's list, so a narrower scope can only restrict", () => {
        // In the broad scope's list and not in the narrow one's: the narrow scope wins.
        const lists = [[{ ref: "group:ops" }], [{ ref: "group:release" }]];
        expect(principalVerdict({ loginAllowLists: lists }, held, NOW)).toBe("not-admitted");
        expect(principalVerdict({ loginAllowLists: [[{ ref: "group:ops" }], [{ ref: "user:u1" }]] }, held, NOW)).toBe(
            "admitted"
        );
    });

    it("refuses a denied principal even when a list admits them", () => {
        const rule = { loginAllowLists: [[{ ref: "group:ops" }]], loginDeny: [{ ref: "user:u1" }] };
        expect(principalVerdict(rule, held, NOW)).toBe("refused");
    });

    it("ignores a grant that has not started and one that has expired", () => {
        const early = [[{ ref: "group:ops", from: NOW + 60 }]];
        expect(principalVerdict({ loginAllowLists: early }, held, NOW)).toBe("not-admitted");
        expect(principalVerdict({ loginAllowLists: early }, held, NOW + 60)).toBe("admitted");

        const lapsing = [[{ ref: "group:ops", until: NOW + 60 }]];
        expect(principalVerdict({ loginAllowLists: lapsing }, held, NOW)).toBe("admitted");
        expect(principalVerdict({ loginAllowLists: lapsing }, held, NOW + 60)).toBe("not-admitted");
    });

    it("applies a refusal only inside its own window", () => {
        // A suspension, rather than a removal somebody has to remember to undo.
        const rule = { loginDeny: [{ ref: "group:ops", from: NOW, until: NOW + 60 }] };
        expect(principalVerdict(rule, held, NOW - 1)).toBe("admitted");
        expect(principalVerdict(rule, held, NOW)).toBe("refused");
        expect(principalVerdict(rule, held, NOW + 60)).toBe("admitted");
    });
});

describe("a membership claim's freshness", () => {
    it("round-trips the moment a token was minted", () => {
        const token = signEdgeToken({ sub: "u1", aud: HOST, exp: NOW + 60, iat: NOW }, SECRET);
        expect(verifyEdgeToken(token, SECRET, NOW, HOST)?.iat).toBe(NOW);
    });

    it("treats a token from before this existed as having no moment at all", () => {
        // Signed by hand: the signer always writes `iat` now, which is what makes its
        // absence a reliable signal rather than a guess.
        const payload = Buffer.from(JSON.stringify({ sub: "u1", aud: HOST, exp: NOW + 60 })).toString("base64url");
        const sig = createHmac("sha256", SECRET).update(`edge:${payload}`).digest("base64url");
        const token = verifyEdgeToken(`${payload}.${sig}`, SECRET, NOW, HOST);
        expect(token?.iat).toBeUndefined();
        // It carries a claim with no moment attached, which is exactly what cannot be
        // checked - so both questions answer against it.
        expect(principalsSuperseded(token!, NOW * 1000)).toBe(true);
        expect(membershipTooOld(token!, NOW)).toBe(true);
    });

    it("is superseded only by a change that came after it", () => {
        expect(principalsSuperseded({ iat: NOW }, (NOW + 1) * 1000)).toBe(true);
        expect(principalsSuperseded({ iat: NOW }, (NOW - 1) * 1000)).toBe(false);
    });

    it("costs nothing for an account nothing is known about", () => {
        // Which is every account, almost always - the snapshot names only who moved.
        expect(principalsSuperseded({ iat: NOW }, null)).toBe(false);
    });

    it("ages out past the backstop", () => {
        expect(membershipTooOld({ iat: NOW }, NOW + MEMBERSHIP_MAX_AGE_SECONDS)).toBe(false);
        expect(membershipTooOld({ iat: NOW }, NOW + MEMBERSHIP_MAX_AGE_SECONDS + 1)).toBe(true);
    });

    it("prunes to the token lifetime, so the published list cannot grow", () => {
        // An entry older than the longest a token can live can only concern tokens that
        // have already expired.
        expect(MEMBERSHIP_MAX_AGE_SECONDS).toBeLessThan(EDGE_TOKEN_TTL_SECONDS);
    });
});
