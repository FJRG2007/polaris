/**
 * The generated Traefik config is what actually enforces the firewall, and it is
 * written by Polaris and read by nothing Polaris controls - so a mistake here is not a
 * failing request, it is a route that quietly stops being protected, or one that stops
 * resolving at all.
 *
 * The case worth the most attention is email obfuscation, because it is the only
 * control that changes where a route DIALS. Everything else adds a middleware beside
 * the path; this one puts the guard in the middle of it, and the app's real address has
 * to survive that move.
 */

import { describe, expect, it } from "vitest";
import { verifyEdgeOrigin } from "@polaris/core/waf";
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

/** Run with a secret present, which is what lets a route be proxied at all. */
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

/** The signed upstream out of the generated config. */
function signedOrigin(config: string): string | null {
    const match = /X-Polaris-Origin: "([^"]+)"/.exec(config);
    return match ? verifyEdgeOrigin(match[1], SECRET) : null;
}

describe("a route with nothing switched on", () => {
    it("dials the app directly and adds no guard", () => {
        const config = renderDynamicConfig([route()]);

        expect(config).toContain('url: "http://10.0.0.7:8123"');
        expect(config).not.toContain("polaris-waf-guard");
        expect(config).not.toContain("X-Polaris-Origin");
    });
});

describe("a route with email obfuscation", () => {
    it("dials the guard's proxy instead of the app", () => {
        const config = withSecret(() => renderDynamicConfig([route({ emailObfuscation: true })]));

        expect(config).toContain("polaris-edge-guard:8081");
        expect(config).not.toContain('url: "http://10.0.0.7:8123"');
    });

    it("carries the app's real address in a signed header", () => {
        const config = withSecret(() => renderDynamicConfig([route({ emailObfuscation: true })]));

        // Signed, so a client cannot redirect the proxy at something else, and the
        // address itself only ever travels between Traefik and the guard.
        expect(signedOrigin(config)).toBe("http://10.0.0.7:8123");
    });

    it("stamps the rule header, so the proxy knows to rewrite", () => {
        const config = withSecret(() => renderDynamicConfig([route({ emailObfuscation: true })]));

        expect(config).toContain("X-Polaris-Waf");
    });

    it("does not also forwardAuth, since the proxy runs the same decision inline", () => {
        const config = withSecret(() =>
            renderDynamicConfig([route({ emailObfuscation: true, deny: ["203.0.113.0/24"] })])
        );

        expect(config).toContain("X-Polaris-Origin");
        expect(config).not.toContain("forwardAuth");
    });

    it("routes direct when the guard's proxy is not answering", () => {
        // The guard is a separate container on its own release cadence. One older than
        // the control plane has no proxy listener, and pointing a route at it turns a
        // healthy app into a 502 - the outage this branch exists to prevent.
        const config = withSecret(() =>
            renderDynamicConfig([route({ emailObfuscation: true })], { proxyAvailable: false })
        );

        expect(config).toContain('url: "http://10.0.0.7:8123"');
        expect(config).not.toContain("polaris-edge-guard:8081");
        expect(config).not.toContain("X-Polaris-Origin");
    });

    it("still enforces the request rules when the proxy is unavailable", () => {
        // Losing the rewrite must not lose the firewall with it: the route falls back
        // to forwardAuth, which is exactly what it would have had without obfuscation.
        const config = withSecret(() =>
            renderDynamicConfig([route({ emailObfuscation: true, deny: ["203.0.113.0/24"] })], {
                proxyAvailable: false
            })
        );

        expect(config).toContain("forwardAuth");
        expect(config).toContain("X-Polaris-Waf");
    });

    it("routes direct when there is no secret to sign the upstream with", () => {
        const previous = process.env.POLARIS_AUTH_SECRET;
        delete process.env.POLARIS_AUTH_SECRET;
        try {
            const config = renderDynamicConfig([route({ emailObfuscation: true })]);

            // Losing a cosmetic rewrite is the right failure; a route that cannot
            // resolve is not.
            expect(config).toContain('url: "http://10.0.0.7:8123"');
            expect(config).not.toContain("X-Polaris-Origin");
        } finally {
            if (previous !== undefined) process.env.POLARIS_AUTH_SECRET = previous;
        }
    });
});

describe("a route that only needs the guard's verdict", () => {
    it("keeps forwardAuth and still dials the app directly", () => {
        const config = renderDynamicConfig([route({ deny: ["203.0.113.0/24"] })]);

        expect(config).toContain("forwardAuth");
        expect(config).toContain('url: "http://10.0.0.7:8123"');
    });

    it("enforces an allowlist natively, with no guard at all", () => {
        const config = renderDynamicConfig([route({ allowLists: [["10.0.0.0/8"]] })]);

        expect(config).toContain("ipAllowList");
        expect(config).not.toContain("forwardAuth");
    });
});

describe("a route with injection protection", () => {
    it("gets the guard even with nothing else switched on", () => {
        // Both checks are on by default, so this is the state most routes are actually
        // in: no denylist, no packs, no custom rules, and still inspected.
        const config = renderDynamicConfig([route({ sqlInjectionProtection: true, xssProtection: true })]);

        expect(config).toContain("polaris-waf-guard");
        expect(config).toContain("X-Polaris-Waf");
        // Beside the path, not in it: the app is still dialled directly.
        expect(config).toContain('url: "http://10.0.0.7:8123"');
        expect(config).not.toContain("X-Polaris-Origin");
    });

    it("gets the guard for either check on its own", () => {
        expect(renderDynamicConfig([route({ sqlInjectionProtection: true })])).toContain("polaris-waf-guard");
        expect(renderDynamicConfig([route({ xssProtection: true })])).toContain("polaris-waf-guard");
    });
});
