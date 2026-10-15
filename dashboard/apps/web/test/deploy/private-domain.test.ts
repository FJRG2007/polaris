/**
 * A private address in the routing file, and the decision the sign-in hop makes for
 * it. The file is rendered by a pure function, so what the edge will enforce is
 * asserted here rather than taken on trust: one value that does not parse freezes
 * every route on the instance.
 */

import { describe, expect, it } from "vitest";
import { decodeGuardRule } from "@polaris/core/waf";
import { renderDynamicConfig, type AppRoute } from "@/lib/deploy/router";
import {
    PRIVATE_TOKEN_TTL_SECONDS,
    domainPrivateInputSchema,
    parsePrivateAccess,
    privateVerdict,
    storePrivateAccess,
    withPrivateAccess,
    type PrivateAccess
} from "@/lib/deploy/private-domain";

const NOW = 1_800_000_000;

function route(overrides: Partial<AppRoute> = {}): AppRoute {
    return {
        id: "d1",
        hostname: "shop.example.com",
        certResolver: "le",
        dialHost: "host.docker.internal",
        dialPort: 20001,
        loginUrl: "https://polaris.example.com",
        ...overrides
    };
}

function block(config: string, name: string): string {
    const lines = config.split("\n");
    const start = lines.findIndex((line) => line === `    ${name}:`);
    if (start < 0) return "";
    const end = lines.findIndex((line, index) => index > start && /^ {4}\S/.test(line));
    return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

/** The rule the guard is handed for a route, decoded back from the file. */
function guardRuleOf(config: string, name: string) {
    const ctx = block(config, `${name}-waf-ctx`);
    const encoded = /X-Polaris-Waf: "([^"]+)"/.exec(ctx)?.[1];
    expect(encoded, "the route carries a guard rule").toBeDefined();
    return decodeGuardRule(encoded as string);
}

const members: PrivateAccess = { members: true, allow: [], deny: [] };
const named: PrivateAccess = {
    members: false,
    allow: [{ ref: "group:eng" }, { ref: "user:ana" }],
    deny: [{ ref: "user:mallory" }]
};

describe("a private address in the routing file", () => {
    it("puts the guard in front with login required, and keeps every router ranked", () => {
        const config = renderDynamicConfig([withPrivateAccess(route(), members)]);
        const router = block(config, "polaris-app-d1");
        expect(router).toMatch(/middlewares: \[[^\]]*polaris-app-d1-waf-ctx/);
        expect(router).toMatch(/middlewares: \[[^\]]*polaris-waf-guard/);
        expect(router).toMatch(/priority: \d+/);
        for (const line of config.split("\n").filter((l) => /^ {4}\S.*:$/.test(l))) {
            const name = line.trim().slice(0, -1);
            const body = block(config, name);
            if (/\n {6}rule:/.test(body))
                expect(body, `${name} has a priority`).toMatch(/priority: \d+/);
        }
        const rule = guardRuleOf(config, "polaris-app-d1");
        expect(rule?.requireLogin).toBe(true);
        expect(rule?.loginUrl).toBe("https://polaris.example.com");
        // Members are decided at sign-in, never by a list the guard would enforce.
        expect(rule?.loginAllowLists ?? []).toEqual([]);
        // And the guard refuses a token older than that decision, whatever it says.
        expect(rule?.loginMaxAge).toBe(PRIVATE_TOKEN_TTL_SECONDS);
    });

    it("carries a named list and the refusals to the guard when members are not admitted", () => {
        const config = renderDynamicConfig([withPrivateAccess(route(), named)]);
        const rule = guardRuleOf(config, "polaris-app-d1");
        expect(rule?.loginAllowLists).toEqual([named.allow]);
        expect(rule?.loginDeny).toEqual(named.deny);
    });

    it("adds to the service's own firewall lists rather than replacing them", () => {
        const held = route({
            loginAllowLists: [[{ ref: "role:staff" }]],
            loginDeny: [{ ref: "user:x" }]
        });
        const merged = withPrivateAccess(held, named);
        expect(merged.loginAllowLists).toEqual([[{ ref: "role:staff" }], named.allow]);
        expect(merged.loginDeny).toEqual([{ ref: "user:x" }, ...named.deny]);
    });

    it("leaves a public address exactly as it was", () => {
        const plain = route();
        expect(withPrivateAccess(plain, null)).toBe(plain);
        expect(block(renderDynamicConfig([plain]), "polaris-app-d1")).not.toContain("waf-ctx");
    });
});

describe("who a private address admits", () => {
    it("admits a member when members are allowed", () => {
        expect(privateVerdict(members, new Set(["user:ana"]), true, NOW)).toBe("admitted");
    });

    it("turns away a signed-in account that is neither a member nor named", () => {
        expect(privateVerdict(members, new Set(["user:bob"]), false, NOW)).toBe("not-admitted");
        expect(privateVerdict(named, new Set(["user:bob"]), true, NOW)).toBe("not-admitted");
    });

    it("admits somebody through a group the address names", () => {
        expect(privateVerdict(named, new Set(["user:bob", "group:eng"]), false, NOW)).toBe(
            "admitted"
        );
    });

    it("refuses a named refusal even when the account is a member", () => {
        const both: PrivateAccess = { ...members, deny: [{ ref: "user:mallory" }] };
        expect(privateVerdict(both, new Set(["user:mallory"]), true, NOW)).toBe("refused");
    });

    it("stops admitting a named entry once its window has passed", () => {
        const lapsed: PrivateAccess = {
            members: false,
            allow: [{ ref: "user:ana", until: NOW - 1 }],
            deny: []
        };
        expect(privateVerdict(lapsed, new Set(["user:ana"]), false, NOW)).toBe("not-admitted");
    });
});

describe("the stored setting", () => {
    it("round-trips, and reads anything unreadable as public", () => {
        expect(parsePrivateAccess(storePrivateAccess(named))).toEqual(named);
        expect(parsePrivateAccess(null)).toBeNull();
        expect(parsePrivateAccess("{not json")).toBeNull();
        expect(parsePrivateAccess(JSON.stringify({ members: "yes" }))).toBeNull();
    });

    it("refuses a private address nobody could open, and a malformed principal", () => {
        const id = "0190b6a2-0000-7000-8000-000000000001";
        expect(
            domainPrivateInputSchema.safeParse({
                domainId: id,
                access: { members: false, allow: [], deny: [] }
            }).success
        ).toBe(false);
        expect(
            domainPrivateInputSchema.safeParse({
                domainId: id,
                access: { members: false, allow: [{ ref: "admin:*" }], deny: [] }
            }).success
        ).toBe(false);
        expect(domainPrivateInputSchema.safeParse({ domainId: "x", access: null }).success).toBe(
            false
        );
        expect(domainPrivateInputSchema.safeParse({ domainId: id, access: null }).success).toBe(
            true
        );
    });
});
