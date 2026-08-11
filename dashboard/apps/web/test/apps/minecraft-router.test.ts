/**
 * The routing table that puts every Java server on one port.
 *
 * The cases here are the ones that would send a player to the wrong world or to a
 * world that is not theirs to reach: a table with a fallback in it, a game whose
 * protocol carries no hostname, a server nobody switched over, and two servers
 * claiming the same name.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { installs, applications } = vi.hoisted(() => ({
    installs: [] as Array<{ catalogId: string; config: string; applicationId: string | null }>,
    applications: new Map<string, string>()
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: { findMany: async () => installs },
        application: {
            findUnique: async ({ where }: { where: { id: string } }) => {
                const sourceConfig = applications.get(where.id);
                return sourceConfig === undefined ? null : { sourceConfig };
            }
        }
    }
}));

const { minecraftRoutes, routesConfig } = await import("../../src/lib/apps/minecraft/router-service");

/** An install as the table reads it: a game, a name, and a port to send traffic to. */
function server(
    catalogId: string,
    config: Record<string, unknown>,
    { applicationId = "app-1", hostPort = 25570 }: { applicationId?: string | null; hostPort?: number | null } = {}
): void {
    if (applicationId && hostPort !== null) applications.set(applicationId, JSON.stringify({ hostPort }));
    installs.push({ catalogId, config: JSON.stringify(config), applicationId });
}

beforeEach(() => {
    installs.length = 0;
    applications.clear();
    process.env.POLARIS_APP_DIAL_HOST = "host.docker.internal";
});

describe("routesConfig", () => {
    it("names no fallback, so a connection for an unclaimed name is dropped", () => {
        const parsed = JSON.parse(routesConfig([{ hostname: "survival.mc.example.com", backend: "host:25570" }]));
        // A default would send a port scanner - which connects by address and names
        // no hostname - straight onto somebody's world.
        expect(parsed).not.toHaveProperty("default-server");
        expect(parsed.mappings).toEqual({ "survival.mc.example.com": "host:25570" });
    });

    it("writes an empty table rather than nothing when no server is routed", () => {
        expect(JSON.parse(routesConfig([]))).toEqual({ mappings: {} });
    });
});

describe("minecraftRoutes", () => {
    it("routes a Java server that was switched over", async () => {
        server("minecraft", { hostname: "survival.mc.example.com", routed: true }, { hostPort: 25570 });
        expect(await minecraftRoutes()).toEqual([
            { hostname: "survival.mc.example.com", backend: "host.docker.internal:25570" }
        ]);
    });

    it("leaves a server that was never switched over on its own port", async () => {
        server("minecraft", { hostname: "survival.mc.example.com" });
        expect(await minecraftRoutes()).toEqual([]);
    });

    it("routes nothing whose protocol carries no hostname", async () => {
        server("minecraft-bedrock", { hostname: "pocket.mc.example.com", routed: true }, { applicationId: "app-b" });
        server("ark", { hostname: "island.ark.example.com", routed: true }, { applicationId: "app-c" });
        expect(await minecraftRoutes()).toEqual([]);
    });

    it("skips a server with no name and one with no port to dial", async () => {
        server("minecraft", { routed: true }, { applicationId: "app-x" });
        server("minecraft", { hostname: "no-port.mc.example.com", routed: true }, { applicationId: null });
        expect(await minecraftRoutes()).toEqual([]);
    });

    it("gives a contested name to one server rather than to whichever answers first", async () => {
        server("minecraft", { hostname: "survival.mc.example.com", routed: true }, { applicationId: "app-1", hostPort: 25570 });
        server("minecraft", { hostname: "SURVIVAL.mc.example.com", routed: true }, { applicationId: "app-2", hostPort: 25571 });
        expect(await minecraftRoutes()).toEqual([
            { hostname: "survival.mc.example.com", backend: "host.docker.internal:25570" }
        ]);
    });
});
