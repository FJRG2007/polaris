/**
 * Clickjacking protection on the routes Polaris writes for deployed services.
 *
 * Two paths, and the test is mostly about which one a route takes. Where the guard's
 * proxy can merge with the app's own headers it does, and the file must not also set a
 * blind header on top. Where it cannot - an older guard, a remote server, a service
 * balanced over several copies - the route gets the one header that is safe to set
 * without seeing the app's response, and an operator's own header settings still win.
 */

import { describe, expect, it } from "vitest";
import { EMPTY_EDGE_CONFIG } from "@polaris/core";
import { decodeGuardRule } from "@polaris/core/waf";
import { renderDynamicConfig, type AppRoute } from "@/lib/deploy/router";

const SECRET = "test-secret-at-least-16-chars";

function route(overrides: Partial<AppRoute> = {}): AppRoute {
    return {
        id: "abc",
        hostname: "app.example.com",
        certResolver: "le",
        dialHost: "10.0.0.7",
        dialPort: 8123,
        ...overrides
    };
}

function withSecret<T>(run: () => T): T {
    const previous = process.env.POLARIS_AUTH_SECRET;
    process.env.POLARIS_AUTH_SECRET = SECRET;
    try {
        return run();
    } finally {
        if (previous === undefined) delete process.env.POLARIS_AUTH_SECRET;
        else process.env.POLARIS_AUTH_SECRET = previous;
    }
}

function ruleIn(config: string) {
    const match = /X-Polaris-Waf: "([^"]+)"/.exec(config);
    return match ? decodeGuardRule(match[1]) : null;
}

describe("with a guard that merges framing", () => {
    it("routes through the proxy and hands it the allowed sites", () => {
        const config = withSecret(() =>
            renderDynamicConfig([route({ frameAncestors: ["https://partner.example"] })], {
                proxyAvailable: true,
                frameAvailable: true
            })
        );

        expect(config).toContain("polaris-edge-guard:8081");
        expect(ruleIn(config)?.frameAncestors).toEqual(["https://partner.example"]);
        // The proxy decides with the app's response in hand; no blind header on top.
        expect(config).not.toContain("X-Frame-Options");
    });
});

describe("without one", () => {
    it("sets X-Frame-Options alone, never a CSP that would replace the app's", () => {
        const config = withSecret(() =>
            renderDynamicConfig([route({ frameAncestors: [] })], { proxyAvailable: true, frameAvailable: false })
        );

        expect(config).toContain('"X-Frame-Options": "SAMEORIGIN"');
        expect(config).not.toContain("Content-Security-Policy");
        expect(config).toContain('url: "http://10.0.0.7:8123"');
    });

    it("sends nothing blind when other sites are allowed, since that header cannot name them", () => {
        const config = renderDynamicConfig([route({ frameAncestors: ["https://partner.example"] })]);

        expect(config).not.toContain("X-Frame-Options");
    });

    it("applies to a service balanced over several copies, which the proxy cannot serve", () => {
        const config = withSecret(() =>
            renderDynamicConfig([route({ frameAncestors: [], dialHosts: ["a", "b"] })], {
                proxyAvailable: true,
                frameAvailable: true
            })
        );

        expect(config).toContain('"X-Frame-Options": "SAMEORIGIN"');
        expect(config).not.toContain("polaris-edge-guard:8081");
    });

    it("leaves the header to the service's own setting when it has one", () => {
        const edge = { ...EMPTY_EDGE_CONFIG, headers: { preset: "off" as const, frameOptions: "DENY" as const, custom: [] } };
        const config = renderDynamicConfig([route({ frameAncestors: [], edge })]);

        expect(config).toContain('"X-Frame-Options": "DENY"');
        expect(config).not.toContain("SAMEORIGIN");
    });
});

describe("switched off", () => {
    it("adds nothing", () => {
        const config = renderDynamicConfig([route()]);

        expect(config).not.toContain("X-Frame-Options");
        expect(config).not.toContain("frame-ancestors");
    });
});
