/**
 * A service with more than one copy: the edge is given each copy by name and
 * balances between them, pins a visitor when asked, and leaves out a copy that
 * fails its health path. A deploy that changes over starts a whole new set of
 * copies that answer on those same names, and the edge dials only as many as the
 * serving release runs. And the cases that must stay at one copy say why, and a
 * share of the traffic split off to a kept release by weight.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/deploy-service", () => ({ restartFromKeptImage: vi.fn(), syncAppRoutes: vi.fn() }));

const { prisma } = await import("@polaris/db");
const { parseAppEdgeConfig } = await import("@polaris/core");
const { expandReplicas, replicaNames } = await import("@polaris/deploy");
const { restartFromKeptImage, syncAppRoutes } = await import("@/lib/deploy-service");
const { balancedOver, copiesOf } = await import("@/lib/deploy/replicas");
const { scaleService, setServiceScaling, singleCopyReason } = await import("@/lib/deploy/scaling-service");
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

    it("dials as many copies as the serving release was started with, not the new count", () => {
        const app = { replicas: 5, target: { runtime: "compose" } };
        // Scaled up from three: the fourth and fifth do not exist until the release
        // carrying them is promoted, and a name nothing answers is traffic lost.
        expect(copiesOf(app, "web", { replicas: 3 })).toEqual(["web", "web-r2", "web-r3"]);
        expect(copiesOf(app, "web", { replicas: 1 })).toBeUndefined();
        // A release from before the count was recorded reads as the setting.
        expect(copiesOf(app, "web", { replicas: null })).toHaveLength(5);
        expect(copiesOf({ ...app, replicas: 1 }, "web", { replicas: 3 })).toEqual(["web", "web-r2", "web-r3"]);
    });
});

describe("changing over a service with several copies", () => {
    /** A release started beside the running one, the way the pipeline plans it:
     *  under names of its own, answering to the service's by alias. */
    const release = (service: string, marker: string, replicas: number, dialled?: number) =>
        expandReplicas(
            {
                project: `p-${marker}`,
                services: [
                    {
                        // Cut the way `releaseRef` cuts it: the marker whole.
                        name: `${service.slice(0, 63 - marker.length - 1)}-${marker}`,
                        image: "shop:release",
                        env: {},
                        ports: [],
                        volumes: [],
                        labels: { "traefik.enable": "true" },
                        networks: ["polaris-proxy"],
                        aliases: [service],
                        replicas
                    }
                ],
                volumes: [],
                networks: ["polaris-proxy"]
            },
            dialled
        ).services;

    /** Everything one container answers to on the proxy network. */
    const answersTo = (copy: { name: string; aliases?: string[] }) => [copy.name, ...(copy.aliases ?? [])];

    it("reaches every copy of the new release on the names the edge already dials", () => {
        const route = copiesOf({ replicas: 3, target: { runtime: "compose" } }, "web")!;
        const copies = release("web", "abc1234", 3);
        // One new copy behind each name the route holds, so switching the edge is the
        // old copies going rather than a route being rewritten.
        for (const [index, name] of route.entries()) expect(answersTo(copies[index]!)).toContain(name);
        expect(copies.map((copy) => copy.name)).toEqual(["web-abc1234", "web-abc1234-r2", "web-abc1234-r3"]);
        expect(copies[1]?.aliases).toEqual(["web", "web-abc1234", "web-r2"]);
    });

    it("keeps each numbered name to one copy of a release, so a pinned visitor stays on one", () => {
        const copies = release("web", "abc1234", 4);
        for (const name of replicaNames("web", 4).slice(1)) {
            expect(copies.filter((copy) => answersTo(copy).includes(name))).toHaveLength(1);
        }
    });

    it("fits every numbered name in a DNS label, the same way the edge cuts it", () => {
        const long = "a".repeat(63);
        const copies = release(long, "abc1234", 10);
        const route = copiesOf({ replicas: 10, target: { runtime: "compose" } }, long)!;
        for (const [index, copy] of copies.entries()) {
            expect(answersTo(copy)).toContain(route[index]);
            for (const name of answersTo(copy)) expect(name.length).toBeLessThanOrEqual(63);
        }
    });

    it("answers every name a route still dials when it runs fewer copies than the one it replaces", () => {
        // Three copies to two: until the edge takes the file naming two - and an edge
        // frozen on its last good one never does - the third name is still dialled.
        const route = copiesOf({ replicas: 3, target: { runtime: "compose" } }, "web")!;
        const copies = release("web", "abc1234", 2, 3);
        expect(copies.map((copy) => copy.name)).toEqual(["web-abc1234", "web-abc1234-r2"]);
        for (const name of route.slice(1)) {
            expect(copies.filter((copy) => answersTo(copy).includes(name))).toHaveLength(1);
        }
        expect(copies[0]?.aliases).toEqual(["web", "web-r3"]);
        // Down to one copy, which answers for all three.
        expect(answersTo(release("web", "abc1234", 1, 3)[0]!)).toEqual(expect.arrayContaining(route));
    });

    it("answers only its own names when the release it replaces ran no more copies", () => {
        const copies = release("web", "abc1234", 2, 2);
        expect(copies[0]?.aliases).toEqual(["web"]);
        expect(copies[1]?.aliases).toEqual(["web", "web-abc1234", "web-r2"]);
        expect(release("web", "abc1234", 3, 1)).toEqual(release("web", "abc1234", 3));
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

describe("saving a new count", () => {
    const app = {
        replicas: 2,
        autoscale: null,
        cpuLimit: null,
        memoryLimitMb: null,
        sleepAfterMinutes: null,
        asleepSince: null,
        edgeConfig: null,
        keepReleases: false,
        sourceType: "image",
        currentDeploymentId: "dep-1",
        target: { runtime: "compose", kind: "local" },
        _count: { volumes: 0 }
    };
    const input = {
        replicas: 3,
        autoscale: null,
        balancing: { sticky: false, healthPath: null },
        limits: { cpus: null, memoryMb: null },
        sleepAfterMinutes: null
    };

    beforeEach(() => {
        Object.assign(prisma, { application: { findFirst: async () => app, update: async () => app } });
        vi.mocked(syncAppRoutes).mockResolvedValue(undefined);
        vi.mocked(restartFromKeptImage).mockClear();
    });

    it("scales the release serving it rather than changing it over", async () => {
        await expect(setServiceScaling("app-1", "owner-1", "user-1", input)).resolves.toEqual({ redeployed: true });
        expect(restartFromKeptImage).toHaveBeenCalledWith("app-1", "owner-1", "user-1", "scale");
    });

    it("changes over when new limits come with it, since every copy is recreated", async () => {
        await setServiceScaling("app-1", "owner-1", "user-1", { ...input, limits: { cpus: 1, memoryMb: null } });
        expect(restartFromKeptImage).toHaveBeenCalledWith("app-1", "owner-1", "user-1", "settings");
    });

    it("credits nobody for a step the autoscaler takes", async () => {
        await scaleService("app-1", "owner-1", 3);
        expect(restartFromKeptImage).toHaveBeenCalledWith("app-1", "owner-1", null, "scale");
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

describe("a share of the traffic sent to a kept release", () => {
    const route = { id: "d1", hostname: "shop.example.com", certResolver: "le", dialHost: "10.0.0.2", dialPort: 21000 };

    it("splits the service by weight, pinning each visitor to one version", () => {
        const config = renderDynamicConfig([{ ...route, canary: { upstream: "http://10.0.0.2:23456", percent: 10 } }]);
        const split = service(config, "polaris-app-d1");
        expect(split).toContain("weighted:");
        expect(split).toContain("- name: polaris-app-d1-current\n            weight: 90");
        expect(split).toContain("- name: polaris-app-d1-canary\n            weight: 10");
        expect(split).toContain("name: polaris_release");
        expect(service(config, "polaris-app-d1-canary")).toContain('- url: "http://10.0.0.2:23456"');
        expect(service(config, "polaris-app-d1-current")).toContain('- url: "http://10.0.0.2:21000"');
    });

    it("never sends more than half", () => {
        const config = renderDynamicConfig([{ ...route, canary: { upstream: "http://10.0.0.2:23456", percent: 90 } }]);
        expect(service(config, "polaris-app-d1")).toContain("- name: polaris-app-d1-canary\n            weight: 50");
    });

    it("keeps the canary only while it validates, and reads an old config as none", () => {
        const id = "019f9000-1111-7000-8000-222233334444";
        expect(parseAppEdgeConfig(JSON.stringify({ canary: { deploymentId: id, percent: 10 } })).canary).toEqual({
            deploymentId: id,
            percent: 10
        });
        expect(parseAppEdgeConfig(JSON.stringify({ canary: { deploymentId: id, percent: 80 } })).canary).toBeNull();
        expect(parseAppEdgeConfig("{}").canary).toBeNull();
    });
});
