/**
 * A service with more than one copy: the edge is given each copy by name and
 * balances between them, pins a visitor when asked, and leaves out a copy that
 * fails its health path. And the cases that must stay at one copy say why.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/deploy-service", () => ({ restartFromKeptImage: vi.fn(), syncAppRoutes: vi.fn() }));

const { parseAppEdgeConfig } = await import("@polaris/core");
const { balancedOver, copiesOf } = await import("@/lib/deploy/replicas");
const { singleCopyReason } = await import("@/lib/deploy/scaling-service");
const { renderDynamicConfig } = await import("@/lib/deploy/router");

/** The block of text belonging to one router or service, by its name. */
function block(config: string, name: string, from = 0): string {
    const lines = config.split("\n");
    const start = lines.findIndex((line, index) => index >= from && line === `    ${name}:`);
    if (start < 0) return "";
    const end = lines.findIndex((line, index) => index > start && /^ {4}\S/.test(line));
    return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

/** The service block, which follows the routers of the same name. */
function service(config: string, name: string): string {
    return block(config, name, config.split("\n").indexOf("  services:"));
}

describe("routing a service with several copies", () => {
    const secret = process.env.POLARIS_AUTH_SECRET;
    beforeEach(() => {
        process.env.POLARIS_AUTH_SECRET = "a-secret-long-enough-for-the-test";
    });
    afterEach(() => {
        process.env.POLARIS_AUTH_SECRET = secret;
    });

    const route = {
        id: "d1",
        hostname: "shop.example.com",
        certResolver: "le",
        dialHost: "web",
        dialPort: 3000,
        emailObfuscation: true
    };

    it("lists every copy by name, pins visitors and checks health", () => {
        const config = renderDynamicConfig([
            { ...route, dialHosts: ["web", "web-r2", "web-r3"], sticky: true, healthPath: "/healthz" }
        ]);
        const lb = service(config, "polaris-app-d1");
        expect(lb).toContain('- url: "http://web:3000"');
        expect(lb).toContain('- url: "http://web-r2:3000"');
        expect(lb).toContain('- url: "http://web-r3:3000"');
        expect(lb).toContain("name: polaris_lb");
        expect(lb).toContain('path: "/healthz"');
        // Balanced by the edge rather than through the guard's one-origin proxy.
        expect(lb).not.toContain("8081");
    });

    it("keeps a single copy on the one upstream it always had", () => {
        const lb = service(renderDynamicConfig([route]), "polaris-app-d1");
        expect(lb).toContain("8081");
        expect(lb).not.toContain("sticky");
        expect(lb).not.toContain("healthCheck");
    });
});

describe("copiesOf", () => {
    it("names every copy on plain compose", () => {
        expect(copiesOf({ replicas: 3, target: { runtime: "compose" } }, "web")).toEqual(["web", "web-r2", "web-r3"]);
    });

    it("leaves swarm and a single copy to the ordinary route", () => {
        expect(copiesOf({ replicas: 3, target: { runtime: "swarm" } }, "web")).toBeUndefined();
        expect(copiesOf({ replicas: 1, target: { runtime: "compose" } }, "web")).toBeUndefined();
    });
});

describe("balancedOver", () => {
    it("carries the service's balancing only when there is something to balance", () => {
        const edge = parseAppEdgeConfig(JSON.stringify({ balancing: { sticky: true, healthPath: "/up" } }));
        expect(balancedOver(["web", "web-r2"], edge)).toEqual({
            dialHosts: ["web", "web-r2"],
            sticky: true,
            healthPath: "/up"
        });
        expect(balancedOver(undefined, edge)).toEqual({});
        expect(balancedOver(["web"], edge)).toEqual({});
    });
});

describe("singleCopyReason", () => {
    const plain = { keepReleases: false, sourceType: "github", _count: { volumes: 0 } };

    it("lets a plain service run several copies", () => {
        expect(singleCopyReason(plain)).toBeNull();
    });

    it("says why a service with a volume, a compose file or kept releases runs one", () => {
        expect(singleCopyReason({ ...plain, _count: { volumes: 1 } })).toMatch(/volume/);
        expect(singleCopyReason({ ...plain, sourceType: "compose" })).toMatch(/compose file/);
        expect(singleCopyReason({ ...plain, keepReleases: true })).toMatch(/previous deployments/);
    });
});

describe("the balancing setting", () => {
    it("refuses a health path that is not a path", () => {
        const stored = parseAppEdgeConfig(JSON.stringify({ balancing: { sticky: true, healthPath: "healthz" } }));
        expect(stored.balancing).toEqual({ sticky: false, healthPath: null });
    });

    it("reads a config written before balancing existed as none", () => {
        expect(parseAppEdgeConfig("{}").balancing).toEqual({ sticky: false, healthPath: null });
    });
});
