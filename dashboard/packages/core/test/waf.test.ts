import { describe, expect, it } from "vitest";
import { decodeGuardRule, encodeGuardRule, signEdgeToken, verifyEdgeToken } from "../src/waf.js";
import { wafRuleInputSchema, WAF_LIST_MAX } from "../src/schemas/deploy.js";

const SECRET = "unit-test-secret-16chars";
const HOST = "app.example.com";
const NOW = 1_800_000_000;

describe("guard rule codec", () => {
    it("round-trips a rule", () => {
        const rule = { deny: ["10.0.0.0/8", "203.0.113.5"], requireLogin: true };
        expect(decodeGuardRule(encodeGuardRule(rule))).toEqual(rule);
    });

    it("treats an absent header as a no-op", () => {
        expect(decodeGuardRule(undefined)).toEqual({ deny: [], requireLogin: false });
    });

    it("fails closed on a malformed header (requires login)", () => {
        expect(decodeGuardRule("###not-valid###")).toEqual({ deny: [], requireLogin: true });
    });

    it("drops non-string denylist entries", () => {
        const header = Buffer.from(JSON.stringify({ d: ["10.0.0.1", 5, null], l: false })).toString("base64");
        expect(decodeGuardRule(header)).toEqual({ deny: ["10.0.0.1"], requireLogin: false });
    });
});

describe("edge token", () => {
    it("verifies a valid, host-bound, unexpired token", () => {
        const token = signEdgeToken({ sub: "u1", aud: HOST, exp: NOW + 60 }, SECRET);
        expect(verifyEdgeToken(token, SECRET, NOW, HOST)).toEqual({ sub: "u1", aud: HOST, exp: NOW + 60 });
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
});

describe("wafRuleInputSchema", () => {
    it("accepts a valid rule and applies defaults", () => {
        const parsed = wafRuleInputSchema.parse({ ipAllowlist: ["10.0.0.0/8"] });
        expect(parsed).toEqual({ ipAllowlist: ["10.0.0.0/8"], ipDenylist: [], requireLogin: false });
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
});
