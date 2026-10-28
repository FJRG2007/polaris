/**
 * The custom-domain routes: the exact YAML the edge reads, and that nothing
 * unchecked reaches it.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@polaris/app-host", () => ({ host: {} }));

import { renderStatusEdge } from "@polaris-app/status-pages/src/lib/edge";
import { customDomainInput, isCustomHostname } from "@polaris-app/status-pages/src/model/schemas";

const ORIGIN = "http://web:3000";

describe("renderStatusEdge", () => {
    it("is an empty config with nothing to route", () => {
        expect(renderStatusEdge([], ORIGIN)).toBe("# No routes.\n");
    });

    it("routes each hostname to the dashboard at priority 50 and rewrites its root", () => {
        expect(renderStatusEdge([{ hostname: "status.example.com", slug: "acme" }], ORIGIN)).toBe(
            [
                "http:",
                "  routers:",
                "    polaris-status-pages-acme:",
                '      rule: "Host(`status.example.com`)"',
                "      entryPoints: [websecure]",
                "      priority: 50",
                "      service: polaris-status-pages",
                "      middlewares: [polaris-status-pages-acme-root]",
                "      tls:",
                "        certResolver: letsencrypt",
                "    polaris-status-pages-acme-http:",
                '      rule: "Host(`status.example.com`)"',
                "      entryPoints: [web]",
                "      priority: 50",
                "      service: polaris-status-pages",
                "      middlewares: [polaris-status-pages-redirect-https]",
                "  services:",
                "    polaris-status-pages:",
                "      loadBalancer:",
                "        servers:",
                '          - url: "http://web:3000"',
                "  middlewares:",
                "    polaris-status-pages-redirect-https:",
                "      redirectScheme:",
                "        scheme: https",
                "    polaris-status-pages-acme-root:",
                "      replacePathRegex:",
                '        regex: "^/$"',
                '        replacement: "/status/acme"',
                ""
            ].join("\n")
        );
    });

    it("leaves out anything that is not a valid hostname or slug, and repeats", () => {
        const yaml = renderStatusEdge(
            [
                { hostname: "b.example.com", slug: "two" },
                { hostname: "a.example.com", slug: "one" },
                { hostname: "a.example.com", slug: "dup" },
                { hostname: "evil.com`) || Host(`x", slug: "bad" },
                { hostname: "*.example.com", slug: "wild" },
                { hostname: "ok.example.com", slug: 'a"b' }
            ],
            ORIGIN
        );
        expect(yaml.match(/entryPoints: \[websecure\]/g)).toHaveLength(2);
        expect(yaml.indexOf("a.example.com")).toBeLessThan(yaml.indexOf("b.example.com"));
        expect(yaml).not.toContain("evil");
        expect(yaml).not.toContain("*");
        expect(yaml).not.toContain("dup");
        expect(yaml).not.toContain("ok.example.com");
    });
});

describe("custom hostnames", () => {
    it("normalizes what was typed to a bare lowercase hostname", () => {
        const parsed = customDomainInput.parse({
            id: "0190f1a0-0000-7000-8000-000000000002",
            domain: " https://Status.Example.com:443/path "
        });
        expect(parsed.domain).toBe("status.example.com");
    });

    it("refuses wildcards, IPs, single labels and private names", () => {
        for (const value of [
            "*.example.com",
            "10.0.0.1",
            "localhost",
            "nas.local",
            "box.home.arpa",
            "a..b.com",
            "-a.example.com"
        ]) {
            expect(isCustomHostname(value)).toBe(false);
        }
        expect(isCustomHostname("status.example.co.uk")).toBe(true);
    });

    it("takes null to remove the domain", () => {
        expect(
            customDomainInput.parse({ id: "0190f1a0-0000-7000-8000-000000000002", domain: null })
                .domain
        ).toBeNull();
    });
});
