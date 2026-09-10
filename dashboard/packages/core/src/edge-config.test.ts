/**
 * What a service asks of the edge, read back from its stored column.
 *
 * The stored value is older than the code that reads it by definition, and whatever
 * comes out of it is written into the edge's routing file - where one bad value stops
 * the edge taking any new configuration at all. So the tests here are mostly about
 * what is refused and what survives a partly bad row.
 */

import { describe, expect, it } from "vitest";
import {
    detectFloodedHosts,
    edgeConfigIsEmpty,
    hostnameCovers,
    normalizeDeployHostname,
    parseAppEdgeConfig,
    securityHeaderMap
} from "./edge-config.js";

describe("hostnames a service can be reached on", () => {
    it("normalizes what somebody types", () => {
        expect(normalizeDeployHostname("  App.Example.COM. ")).toBe("app.example.com");
        expect(normalizeDeployHostname("*.Example.com")).toBe("*.example.com");
        expect(normalizeDeployHostname("xn--bcher-kva.example")).toBe("xn--bcher-kva.example");
    });

    it("refuses anything that could break the rule it is written into", () => {
        for (const bad of ["app`.example.com", 'a".example.com', "a b.example.com", "-a.example.com", "*.com", "a.*.example.com", ""]) {
            expect(normalizeDeployHostname(bad), bad).toBeNull();
        }
    });

    it("lets a wildcard answer for exactly one label under it", () => {
        expect(hostnameCovers("*.example.com", "shop.example.com")).toBe(true);
        expect(hostnameCovers("*.example.com", "a.b.example.com")).toBe(false);
        expect(hostnameCovers("*.example.com", "example.com")).toBe(false);
        expect(hostnameCovers("app.example.com", "APP.example.com")).toBe(true);
    });
});

describe("the stored edge config", () => {
    it("reads nothing as nothing asked for", () => {
        for (const raw of [null, "", "{}", "not json", "[]", "42"]) {
            expect(edgeConfigIsEmpty(parseAppEdgeConfig(raw)), String(raw)).toBe(true);
        }
    });

    it("drops the one entry that no longer validates and keeps the rest", () => {
        const config = parseAppEdgeConfig(
            JSON.stringify({
                rateLimits: [
                    { average: 10, burst: 20 },
                    { average: -1, burst: 5 },
                    { path: "no-slash", average: 5, burst: 5 }
                ],
                redirects: [{ kind: "regex", regex: "^http://(.*)$", replacement: "https://${1}" }, { kind: "regex", regex: "(?=x)", replacement: "y" }],
                challenge: "sometimes"
            })
        );
        expect(config.rateLimits).toEqual([{ average: 10, burst: 20, period: "1s", key: "ip" }]);
        expect(config.redirects).toHaveLength(1);
        expect(config.challenge).toBe("off");
    });

    it("refuses a header value that could close the quoted string it is written into", () => {
        const config = parseAppEdgeConfig(
            JSON.stringify({ headers: { preset: "off", custom: [{ name: "X-Test", value: 'a"b' }] } })
        );
        expect(config.headers.custom).toEqual([]);
    });

    it("refuses Go-incompatible patterns, which the edge would fail to load", () => {
        const config = parseAppEdgeConfig(
            JSON.stringify({ rewrites: [{ kind: "replace-path", regex: "^/(a)\\1", replacement: "/b" }] })
        );
        expect(config.rewrites).toEqual([]);
    });

    it("needs a header to count by before a token limit is kept", () => {
        const config = parseAppEdgeConfig(JSON.stringify({ rateLimits: [{ average: 5, burst: 5, key: "header" }] }));
        expect(config.rateLimits).toEqual([]);
    });
});

describe("security headers", () => {
    it("sends nothing when off", () => {
        expect(securityHeaderMap({ preset: "off", custom: [] })).toEqual({});
    });

    it("sends the recommended set without a CSP that would blank an unknown app", () => {
        const headers = securityHeaderMap({ preset: "recommended", custom: [] });
        expect(headers["Strict-Transport-Security"]).toBe("max-age=15552000");
        expect(headers["X-Content-Type-Options"]).toBe("nosniff");
        expect(headers["X-Frame-Options"]).toBe("SAMEORIGIN");
        expect(headers["Cross-Origin-Opener-Policy"]).toBe("same-origin-allow-popups");
        expect(headers["Content-Security-Policy"]).toBeUndefined();
        expect(headers["Cross-Origin-Embedder-Policy"]).toBeUndefined();
    });

    it("sends the isolation set when strict", () => {
        const headers = securityHeaderMap({ preset: "strict", custom: [] });
        expect(headers["Strict-Transport-Security"]).toBe("max-age=63072000; includeSubDomains; preload");
        expect(headers["Cross-Origin-Opener-Policy"]).toBe("same-origin");
        expect(headers["Cross-Origin-Embedder-Policy"]).toBe("require-corp");
        expect(headers["Content-Security-Policy"]).toContain("default-src 'self'");
    });

    it("lets one header be switched off without losing the preset", () => {
        const headers = securityHeaderMap({ preset: "strict", crossOriginEmbedderPolicy: "", custom: [] });
        expect(headers["Cross-Origin-Embedder-Policy"]).toBeUndefined();
        expect(headers["Cross-Origin-Opener-Policy"]).toBe("same-origin");
    });

    it("lets a custom header replace the preset's value", () => {
        const headers = securityHeaderMap({
            preset: "recommended",
            custom: [{ name: "X-Frame-Options", value: "DENY" }]
        });
        expect(headers["X-Frame-Options"]).toBe("DENY");
    });
});

describe("telling a flood from a busy day", () => {
    const now = Date.parse("2026-09-10T12:00:00Z");
    const at = (msAgo: number, host: string) => ({ time: new Date(now - msAgo).toISOString(), host });
    const minute = (count: number, minutesAgo: number, host: string) =>
        Array.from({ length: count }, (_, index) => at(minutesAgo * 60_000 + 1000 + (index % 50) * 100, host));

    it("flags a host whose last minute dwarfs its usual one", () => {
        const entries = [
            ...[2, 3, 4, 5].flatMap((ago) => minute(20, ago, "shop.example.com")),
            ...minute(900, 0, "shop.example.com")
        ];
        expect(detectFloodedHosts(entries, now, 5)).toEqual(["shop.example.com"]);
    });

    it("leaves a host that is always this busy alone", () => {
        const entries = [0, 1, 2, 3, 4].flatMap((ago) => minute(900, ago, "api.example.com"));
        expect(detectFloodedHosts(entries, now, 5)).toEqual([]);
    });

    it("never flags a quiet host, however sudden", () => {
        expect(detectFloodedHosts(minute(50, 0, "blog.example.com"), now, 5)).toEqual([]);
    });
});
