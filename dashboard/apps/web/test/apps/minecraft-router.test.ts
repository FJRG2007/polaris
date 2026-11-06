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
    installs: [] as Array<{ id: string; catalogId: string; config: string; applicationId: string | null }>,
    applications: new Map<string, string>()
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: {
            // Paged by id, as the real query is, so a table larger than one page is read whole.
            findMany: async ({ take, cursor }: { take: number; cursor?: { id: string } }) => {
                const start = cursor ? installs.findIndex((row) => row.id === cursor.id) + 1 : 0;
                return installs.slice(start, start + take);
            }
        },
        application: {
            findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
                where.id.in.flatMap((id) => {
                    const sourceConfig = applications.get(id);
                    return sourceConfig === undefined ? [] : [{ id, sourceConfig }];
                })
        }
    }
}));

const { minecraftRoutes, retiredRoutes, routesConfig } = await import("@polaris-app/game-servers/src/lib/minecraft/router-service");

/** An install as the table reads it: a game, a name, and a port to send traffic to. */
function server(
    catalogId: string,
    config: Record<string, unknown>,
    { applicationId = "app-1", hostPort = 25570 }: { applicationId?: string | null; hostPort?: number | null } = {}
): void {
    if (applicationId && hostPort !== null) applications.set(applicationId, JSON.stringify({ hostPort }));
    installs.push({ id: `install-${String(installs.length).padStart(6, "0")}`, catalogId, config: JSON.stringify(config), applicationId });
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

    it("routes a server waiting to be switched over, while its own port still answers", async () => {
        server("minecraft", { hostname: "survival.mc.example.com", routeCandidate: true }, { hostPort: 25570 });
        expect(await minecraftRoutes()).toEqual([
            { hostname: "survival.mc.example.com", backend: "host.docker.internal:25570" }
        ]);
    });

    it("reads every page of a table larger than one query", async () => {
        for (let index = 0; index < 4500; index += 1) {
            server("minecraft", { hostname: `s${index}.mc.example.com`, routed: true }, { applicationId: `app-${index}`, hostPort: 30000 + (index % 30000) });
        }
        const routes = await minecraftRoutes();
        expect(routes).toHaveLength(4500);
        expect(routes[4499]).toEqual({ hostname: "s4499.mc.example.com", backend: "host.docker.internal:34499" });
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

describe("retiredRoutes", () => {
    it("points a name the table dropped at nothing, since the router never forgets one on its own", () => {
        const previous = routesConfig([
            { hostname: "old.mc.example.com", backend: "host.docker.internal:25570" },
            { hostname: "kept.mc.example.com", backend: "host.docker.internal:25571" }
        ]);
        expect(retiredRoutes(previous, [{ hostname: "kept.mc.example.com", backend: "host.docker.internal:25571" }])).toEqual([
            { hostname: "old.mc.example.com", backend: "host.docker.internal:0" }
        ]);
    });

    it("keeps a retired name retired on every write after", () => {
        const previous = routesConfig([{ hostname: "old.mc.example.com", backend: "host.docker.internal:0" }]);
        expect(retiredRoutes(previous, [])).toEqual([{ hostname: "old.mc.example.com", backend: "host.docker.internal:0" }]);
    });

    it("gives a name back the moment a server claims it again", () => {
        const previous = routesConfig([{ hostname: "old.mc.example.com", backend: "host.docker.internal:0" }]);
        expect(retiredRoutes(previous, [{ hostname: "old.mc.example.com", backend: "host.docker.internal:25572" }])).toEqual([]);
    });

    it("retires nothing when there was no table, or one that cannot be read", () => {
        expect(retiredRoutes(null, [])).toEqual([]);
        expect(retiredRoutes("{not json", [])).toEqual([]);
    });
});

describe("pingJava through the router", () => {
    it("names the server in the handshake, which is all the router routes on", async () => {
        const { createServer } = await import("node:net");
        const { pingJava } = await import("@polaris-app/game-servers/src/lib/minecraft/slp");
        let seen = "";
        const listener = createServer((socket) => {
            socket.on("data", (chunk) => {
                seen += chunk.toString("latin1");
                socket.destroy();
            });
        });
        await new Promise<void>((ready) => listener.listen(0, "127.0.0.1", ready));
        const { port } = listener.address() as { port: number };
        expect(await pingJava("127.0.0.1", port, 2000, "survival.mc.example.com")).toBe(false);
        listener.close();
        expect(seen).toContain("survival.mc.example.com");
        expect(seen).not.toContain("127.0.0.1");
    });
});
