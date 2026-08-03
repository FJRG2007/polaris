/**
 * The dashboard's route at the edge. A domain configured in the admin panel is
 * inert until the edge knows the name, and the failure is silent from the inside:
 * DNS points here, the setup reports success, and the site answers with a 404 the
 * operator has no way to attribute.
 *
 * So what is protected is the shape handed to Traefik - the hostnames it is asked
 * to serve, the certificate resolver, the redirect off :80 - and the filtering that
 * keeps a LAN name or an IP from becoming a certificate order that cannot complete.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();

vi.mock("@polaris/db", () => ({ prisma: { setting: { findUnique, upsert: vi.fn(), deleteMany: vi.fn() } } }));

const { dashboardHosts, publicHostname, renderDashboardConfig } = await import("../../src/lib/domain-edge");

/** The Setting rows an install would hold, so the reads follow the real path. */
function stored(values: Record<string, string>): void {
    findUnique.mockImplementation(async ({ where }: { where: { key: string } }) => {
        const value = values[where.key];
        return value === undefined ? null : { value };
    });
}

/** A saved zone layout, as the wizard writes it. */
function zones(baseDomain: string, label: string): string {
    return JSON.stringify({ baseDomain, zones: [{ label, scope: "polaris", primary: true }] });
}

beforeEach(() => {
    findUnique.mockReset();
    findUnique.mockResolvedValue(null);
});

describe("which names count as public", () => {
    it("takes what the operator typed, however they typed it", () => {
        expect(publicHostname("https://Polaris.FJRG2007.com/")).toBe("polaris.fjrg2007.com");
        expect(publicHostname("  polaris.fjrg2007.com.  ")).toBe("polaris.fjrg2007.com");
        expect(publicHostname("polaris.fjrg2007.com:8443")).toBe("polaris.fjrg2007.com");
    });

    it("leaves the names the compose labels already serve", () => {
        // These have their own router and the internal certificate; routing them here
        // would ask Let's Encrypt for a certificate it can never issue.
        for (const name of ["polaris.local", "polaris", "polaris.internal", "box.lan", "192.168.1.138"]) {
            expect(publicHostname(name)).toBeNull();
        }
    });

    it("ignores an unset or malformed value", () => {
        for (const name of [null, undefined, "", "   ", "not a hostname", "-bad.example.com"]) {
            expect(publicHostname(name)).toBeNull();
        }
    });
});

describe("what the edge is told to serve", () => {
    it("routes the hostnames over https, with a certificate", () => {
        const config = renderDashboardConfig(["polaris.fjrg2007.com", "share.polaris.fjrg2007.com"]);

        expect(config).toContain('rule: "Host(`polaris.fjrg2007.com`) || Host(`share.polaris.fjrg2007.com`)"');
        expect(config).toContain("entryPoints: [websecure]");
        expect(config).toContain("certResolver: letsencrypt");
        expect(config).toContain('- url: "http://web:3000"');
    });

    it("sends :80 to https instead of serving it", () => {
        const config = renderDashboardConfig(["polaris.fjrg2007.com"]);

        expect(config).toContain("entryPoints: [web]");
        expect(config).toContain("middlewares: [polaris-dashboard-redirect-https]");
        expect(config).toContain("redirectScheme:\n        scheme: https");
    });

    it("names its redirect middleware apart from the one the app routes define", () => {
        // Every file in the directory merges into one config, so the shared name the
        // deployed-app routes use would be a duplicate definition and get dropped.
        expect(renderDashboardConfig(["a.example.com"])).not.toContain("    polaris-redirect-https:");
    });

    it("stays under the terminal WebSocket router's priority", () => {
        // That router carries no host of its own, so on these hostnames it has to keep
        // winning its path prefix; Traefik otherwise ranks by rule length.
        const config = renderDashboardConfig(["a.example.com", "b.example.com", "c.example.com"]);
        for (const line of config.split("\n").filter((entry) => entry.includes("priority:"))) {
            expect(Number(line.split(":")[1])).toBeLessThan(100);
        }
    });

    it("writes an empty config when no domain is configured", () => {
        expect(renderDashboardConfig([])).toBe("http: {}\n");
    });
});

describe("guarding the dashboard itself", () => {
    const RULE = {
        name: "no scanners",
        enabled: true,
        action: "block" as const,
        conditions: [{ field: "path" as const, operator: "contains" as const, values: [".env"] }]
    };

    it("adds no middleware when nothing is configured", () => {
        const config = renderDashboardConfig(["polaris.fjrg2007.com"], { allow: [], deny: [], rules: [] });

        expect(config).not.toContain("ipAllowList");
        expect(config).not.toContain("X-Polaris-Waf");
    });

    it("carries injection protection on its own", () => {
        // On by default, so this is the dashboard's normal state rather than a
        // configured one, and it is the only thing putting the guard in front of it.
        // Either check alone is enough, since either can be the one left on.
        for (const waf of [{ sqlInjectionProtection: true }, { xssProtection: true }]) {
            const config = renderDashboardConfig(["polaris.fjrg2007.com"], waf);

            expect(config).toContain("X-Polaris-Waf");
            expect(config).toContain("polaris-dashboard-waf-guard");
        }
    });

    it("narrows the route to an allowlist natively", () => {
        // Traefik enforces this one itself, so it keeps working with the guard down.
        const config = renderDashboardConfig(["polaris.fjrg2007.com"], { allow: ["192.168.1.0/24"] });

        expect(config).toContain("      ipAllowList:\n        sourceRange: [\"192.168.1.0/24\"]");
        expect(config).toContain("middlewares: [polaris-dashboard-allow]");
    });

    it("keeps the allowlist on the :80 redirect router as well", () => {
        // Otherwise a blocked address still reaches the redirect and learns the name
        // is served here.
        const config = renderDashboardConfig(["polaris.fjrg2007.com"], { allow: ["192.168.1.0/24"] });

        expect(config).toContain("middlewares: [polaris-dashboard-allow, polaris-dashboard-redirect-https]");
    });

    it("carries a denylist and the custom rules to the guard", () => {
        const config = renderDashboardConfig(["polaris.fjrg2007.com"], { deny: ["203.0.113.9"], rules: [RULE] });

        expect(config).toContain("X-Polaris-Waf:");
        expect(config).toContain("polaris-dashboard-waf-guard");
        expect(config).toContain("forwardAuth:");
    });

    it("names its guard middlewares apart from the app routes' shared ones", () => {
        // Every file in the directory merges into one config, so a repeated name is a
        // duplicate definition and one of the two is dropped.
        const config = renderDashboardConfig(["polaris.fjrg2007.com"], { deny: ["203.0.113.9"] });

        expect(config).not.toContain("    polaris-waf-guard:");
        expect(config).not.toContain("    polaris-app-");
    });

    it("never asks the guard to require a login for the dashboard", () => {
        // Polaris has a login of its own; the guard's handoff in front of it is a loop.
        const config = renderDashboardConfig(["polaris.fjrg2007.com"], { deny: ["203.0.113.9"] });
        const header = /X-Polaris-Waf: "([^"]+)"/.exec(config)?.[1] ?? "";

        expect(JSON.parse(Buffer.from(header, "base64").toString("utf8"))).toMatchObject({ l: false });
    });
});

describe("which hostnames are collected", () => {
    it("serves the app domain, the sharing domain and the configured zone", async () => {
        stored({
            "domain.app": "polaris.fjrg2007.com",
            "domain.sharing": "share.polaris.fjrg2007.com",
            "domain.zones": zones("fjrg2007.com", "plr")
        });

        // The sharing domain matters on its own: share links and drop points are served
        // by the dashboard, so a hostname it lacks is a handed-out link that 404s.
        expect(await dashboardHosts()).toEqual([
            "polaris.fjrg2007.com",
            "share.polaris.fjrg2007.com",
            "plr.fjrg2007.com"
        ]);
    });

    it("serves the zone before the setup has moved the dashboard onto it", async () => {
        // The move waits for the zone to be seen answering here, which it cannot do
        // until the edge serves it - so the zone cannot wait for the move.
        stored({ "domain.zones": zones("fjrg2007.com", "polaris") });

        expect(await dashboardHosts()).toEqual(["polaris.fjrg2007.com"]);
    });

    it("names one hostname once, however many settings point at it", async () => {
        stored({
            "domain.app": "https://polaris.fjrg2007.com",
            "domain.sharing": "polaris.fjrg2007.com",
            "domain.zones": zones("fjrg2007.com", "polaris")
        });

        expect(await dashboardHosts()).toEqual(["polaris.fjrg2007.com"]);
    });

    it("serves the extra domains an operator added", async () => {
        stored({
            "domain.app": "polaris.fjrg2007.com",
            "domain.extra": JSON.stringify(["old.example.com", "www.example.com"])
        });

        expect(await dashboardHosts()).toEqual(["polaris.fjrg2007.com", "old.example.com", "www.example.com"]);
    });

    it("keeps serving the app domain when the extra list is unreadable", async () => {
        // One malformed value must not take the dashboard's own route with it.
        stored({ "domain.app": "polaris.fjrg2007.com", "domain.extra": "{not json" });

        expect(await dashboardHosts()).toEqual(["polaris.fjrg2007.com"]);
    });

    it("collects nothing on a LAN-only install", async () => {
        stored({ "domain.app": "polaris.local" });

        expect(await dashboardHosts()).toEqual([]);
    });
});
