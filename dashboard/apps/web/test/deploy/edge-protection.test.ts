/**
 * What a service's edge settings turn into in the routing file.
 *
 * Rendered by a pure function and asserted here because the file is the whole of how
 * every deployed service is reached: one value that does not parse, and Traefik keeps
 * serving whatever configuration came before it - silently, for every service.
 */

import { describe, expect, it } from "vitest";
import { parseAppEdgeConfig } from "@polaris/core";
import { decodeGuardRule } from "@polaris/core/waf";
import { renderDynamicConfig, type AppRoute } from "@/lib/deploy/router";

function route(overrides: Partial<AppRoute> = {}): AppRoute {
    return {
        id: "d1",
        hostname: "shop.example.com",
        certResolver: "le",
        dialHost: "host.docker.internal",
        dialPort: 20001,
        ...overrides
    };
}

/** The block of text belonging to one router or middleware, by its name. */
function block(config: string, name: string): string {
    const lines = config.split("\n");
    const start = lines.findIndex((line) => line === `    ${name}:`);
    if (start < 0) return "";
    const end = lines.findIndex((line, index) => index > start && /^ {4}\S/.test(line));
    return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

/** Every double-quoted scalar in the file is closed on its own line, with no bare
 *  quote inside it - the shape a stray character in a value would break. */
function quotesBalanced(config: string): boolean {
    return config
        .split("\n")
        .filter((line) => line.includes('"'))
        .every((line) => /^[^"]*(?:"(?:[^"\\]|\\.)*"[^"]*)*$/.test(line));
}

describe("ranks", () => {
    it("states one for every app router, on the local edge too", () => {
        const config = renderDynamicConfig([route()]);
        expect(block(config, "polaris-app-d1")).toContain("priority: 40");
        expect(block(config, "polaris-app-d1-http")).toContain("priority: 40");
    });

    it("puts a path above its hostname and a wildcard below any exact name", () => {
        const config = renderDynamicConfig([
            route({ id: "a" }),
            route({ id: "b", pathPrefix: "/api" }),
            route({ id: "c", hostname: "*.example.com" })
        ]);
        expect(block(config, "polaris-app-a")).toContain("priority: 40");
        expect(block(config, "polaris-app-b")).toContain("priority: 45");
        expect(block(config, "polaris-app-c")).toContain("priority: 20");
    });

    it("keeps the pushed rank on a remote edge", () => {
        expect(block(renderDynamicConfig([route()], { routePriority: 100 }), "polaris-app-d1")).toContain(
            "priority: 100"
        );
    });
});

describe("hostnames and paths", () => {
    it("routes a wildcard with a one-label pattern and the edge's own certificate", () => {
        const router = block(renderDynamicConfig([route({ hostname: "*.example.com" })]), "polaris-app-d1");
        expect(router).toContain("HostRegexp(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?[.]example[.]com$`)");
        expect(router).toContain("tls: {}");
        expect(router).not.toContain("certResolver");
    });

    it("honours a path prefix in the file, as the labels already did", () => {
        const router = block(renderDynamicConfig([route({ pathPrefix: "/api" })]), "polaris-app-d1");
        expect(router).toContain("Host(`shop.example.com`) && PathPrefix(`/api`)");
    });

    it("leaves out a row that could break the file, and keeps the rest", () => {
        const config = renderDynamicConfig([
            route({ id: "bad", hostname: 'x"`.example.com' }),
            route({ id: "badpath", pathPrefix: "/a`b" }),
            route({ id: "good" })
        ]);
        expect(config).not.toContain("polaris-app-bad:");
        expect(config).not.toContain("polaris-app-badpath:");
        expect(config).toContain("polaris-app-good:");
    });
});

describe("rate limits and concurrency", () => {
    const edge = parseAppEdgeConfig(
        JSON.stringify({
            rateLimits: [
                { average: 20, burst: 40 },
                { path: "/login", average: 5, period: "1m", burst: 5 },
                { average: 100, burst: 100, key: "header", header: "X-Api-Key" }
            ],
            concurrency: 50,
            concurrencyScope: "service"
        })
    );
    const config = renderDynamicConfig([route({ edge })]);

    it("counts by connection address on a direct route", () => {
        expect(block(config, "polaris-app-d1-rate-0")).toContain("average: 20");
        expect(block(config, "polaris-app-d1-rate-0")).toContain("burst: 40");
        expect(block(config, "polaris-app-d1-rate-0")).toContain("depth: 0");
    });

    it("counts by a header when the limit is on a token", () => {
        expect(block(config, "polaris-app-d1-rate-2")).toContain('requestHeaderName: "X-Api-Key"');
    });

    it("counts by the forwarded address behind a tunnel, where every request is the tunnel's", () => {
        const behind = renderDynamicConfig([route({ certResolver: "none", edge })]);
        expect(block(behind, "polaris-app-d1-rate-0")).toContain("depth: 1");
    });

    it("gives a path limit its own router over that path, one rank higher", () => {
        const scoped = block(config, "polaris-app-d1-path-0");
        expect(scoped).toContain("PathPrefix(`/login`)");
        expect(scoped).toContain("priority: 41");
        expect(scoped).toContain("polaris-app-d1-rate-1");
        // The service-wide limits apply there too.
        expect(scoped).toContain("polaris-app-d1-rate-0");
    });

    it("caps concurrency for the whole service", () => {
        expect(block(config, "polaris-app-d1-inflight")).toContain("amount: 50");
        expect(block(config, "polaris-app-d1-inflight")).toContain("requestHost: true");
    });

    it("applies the flood limits on plain HTTP too", () => {
        const http = block(config, "polaris-app-d1-http");
        expect(http).toContain("polaris-app-d1-rate-0");
        expect(http).toContain("polaris-app-d1-inflight");
    });
});

describe("security headers", () => {
    it("sends the preset on the https router and not on the redirect", () => {
        const config = renderDynamicConfig([
            route({ edge: parseAppEdgeConfig(JSON.stringify({ headers: { preset: "strict" } })) })
        ]);
        const headers = block(config, "polaris-app-d1-headers");
        expect(headers).toContain('"Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload"');
        expect(headers).toContain('"Cross-Origin-Embedder-Policy": "require-corp"');
        expect(block(config, "polaris-app-d1")).toContain("polaris-app-d1-headers");
        expect(block(config, "polaris-app-d1-http")).not.toContain("polaris-app-d1-headers");
        expect(quotesBalanced(config)).toBe(true);
    });
});

describe("redirects and rewrites", () => {
    const edge = parseAppEdgeConfig(
        JSON.stringify({
            redirects: [{ kind: "www-to-apex" }, { kind: "regex", regex: "^https://shop\\.example\\.com/old/(.*)", replacement: "https://shop.example.com/new/${1}", permanent: false }],
            rewrites: [{ kind: "strip-prefix", prefix: "/api" }]
        })
    );

    it("sends www to the apex only when the apex is routed too", () => {
        const both = renderDynamicConfig([
            route({ id: "www", hostname: "www.example.com", edge, appHostnames: ["www.example.com", "example.com"] })
        ]);
        expect(block(both, "polaris-app-www-redirect-0")).toContain('replacement: "${1}://${2}${3}"');
        const alone = renderDynamicConfig([
            route({ id: "www", hostname: "www.example.com", edge, appHostnames: ["www.example.com"] })
        ]);
        expect(alone).not.toContain("polaris-app-www-redirect-0:");
    });

    it("writes a pattern redirect with its backslashes escaped for the file", () => {
        const config = renderDynamicConfig([route({ edge })]);
        const redirect = block(config, "polaris-app-d1-redirect-1");
        expect(redirect).toContain('regex: "^https://shop\\\\.example\\\\.com/old/(.*)"');
        expect(redirect).toContain("permanent: false");
        expect(block(config, "polaris-app-d1-rewrite-0")).toContain('prefixes: ["/api"]');
        expect(quotesBalanced(config)).toBe(true);
    });
});

describe("the browser challenge", () => {
    it("puts the guard in front and tells it to challenge", () => {
        const config = renderDynamicConfig([route({ challenge: true })]);
        const ctx = block(config, "polaris-app-d1-waf-ctx");
        const header = /X-Polaris-Waf: "([^"]+)"/.exec(ctx)?.[1];
        expect(decodeGuardRule(header).challenge).toBe(true);
        expect(block(config, "polaris-app-d1")).toContain("polaris-waf-guard");
    });
});
