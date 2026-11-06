/**
 * One router per machine, each holding only that machine's routes.
 *
 * A route dials a published port on the router's own machine, so no router can serve
 * another machine's servers, and one table for the whole fleet would be rewritten -
 * and re-read whole by the router - on every change anywhere. The cases here: which
 * machine a server's route belongs to, that a change writes only its own machine's
 * table, that a machine nobody routed anything on is never touched, and that the
 * sweep repairs a machine's router without redeploying a running one.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Install {
    id: string;
    catalogId: string;
    config: string;
    applicationId: string | null;
    targetId: string | null;
    status: string;
}

const { installs, applications, targets, remote } = vi.hoisted(() => ({
    installs: [] as Install[],
    applications: new Map<string, { sourceConfig: string; targetId: string }>(),
    targets: new Map<string, { kind: string; hostId: string | null }>(),
    remote: {
        tables: new Map<string, string>(),
        writes: [] as string[],
        running: new Set<string>(),
        started: [] as string[]
    }
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: {
            findMany: async (args: {
                where: { targetId?: { in?: string[]; not?: null }; status?: unknown };
                take?: number;
                cursor?: { id: string };
                distinct?: string[];
            }) => {
                if (args.distinct) {
                    const ids = [...new Set(installs.map((row) => row.targetId).filter(Boolean))];
                    return ids.map((targetId) => ({ targetId }));
                }
                const within = args.where.targetId?.in;
                const rows = installs.filter(
                    (row) => row.status !== "removed" && (!within || within.includes(row.targetId ?? ""))
                );
                const start = args.cursor ? rows.findIndex((row) => row.id === args.cursor?.id) + 1 : 0;
                return rows.slice(start, start + (args.take ?? rows.length));
            },
            findUnique: async ({ where }: { where: { id: string } }) =>
                installs.find((row) => row.id === where.id) ?? null
        },
        application: {
            findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
                where.id.in.flatMap((id) => {
                    const app = applications.get(id);
                    return app
                        ? [{ id, sourceConfig: app.sourceConfig, target: targets.get(app.targetId) ?? null }]
                        : [];
                })
        },
        deployTarget: {
            findMany: async ({ where }: { where: Record<string, unknown> }) =>
                [...targets.entries()]
                    .filter(([id, target]) => {
                        if ("OR" in where) return target.kind === "local" || target.hostId === null;
                        if ("id" in where) return (where.id as { in: string[] }).in.includes(id) && target.hostId !== null;
                        return target.hostId === where.hostId;
                    })
                    .map(([id, target]) => ({ id, ...target })),
            findUnique: async ({ where }: { where: { id: string } }) => targets.get(where.id) ?? null
        }
    }
}));

vi.mock("@/lib/minecraft-router", () => ({
    readHostTable: async (hostId: string) => remote.tables.get(hostId) ?? null,
    writeHostTable: async (hostId: string, table: string) => {
        remote.tables.set(hostId, table);
        remote.writes.push(hostId);
    },
    routerRunningOn: async (hostId: string) => remote.running.has(hostId),
    startRouterOn: async (hostId: string) => {
        remote.started.push(hostId);
        remote.running.add(hostId);
        return null;
    },
    stopRouterOn: async () => undefined,
    startRouter: async () => null,
    stopRouter: async () => undefined
}));

const { LOCAL_SHARD, installShard, minecraftRoutes, nextTable, routesByShard, shardOf, syncMinecraftRoutes } =
    await import("@polaris-app/game-servers/src/lib/minecraft/router-service");

/** A Java server named `name`, on `targetId`, published on `port`. */
function server(name: string, targetId: string, port: number, config: Record<string, unknown> = { routed: true }): string {
    const id = `install-${String(installs.length).padStart(6, "0")}`;
    applications.set(`app-${id}`, { sourceConfig: JSON.stringify({ hostPort: port }), targetId });
    installs.push({
        id,
        catalogId: "minecraft",
        config: JSON.stringify({ hostname: `${name}.mc.example.com`, ...config }),
        applicationId: `app-${id}`,
        targetId,
        status: "installed"
    });
    return id;
}

let dir = "";

beforeEach(async () => {
    installs.length = 0;
    applications.clear();
    targets.clear();
    remote.tables.clear();
    remote.writes.length = 0;
    remote.running.clear();
    remote.started.length = 0;
    targets.set("t-local", { kind: "local", hostId: null });
    targets.set("t-a", { kind: "host", hostId: "host-a" });
    targets.set("t-b", { kind: "host", hostId: "host-b" });
    dir = await mkdtemp(join(tmpdir(), "mc-routes-"));
    process.env.POLARIS_MC_ROUTES_DIR = dir;
    process.env.POLARIS_APP_DIAL_HOST = "host.docker.internal";
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

const localTable = async (): Promise<Record<string, string>> =>
    JSON.parse(await readFile(join(dir, "mc-routes.json"), "utf8")).mappings;
const remoteTable = (hostId: string): Record<string, string> => JSON.parse(remote.tables.get(hostId) ?? "{}").mappings;

describe("which machine a route belongs to", () => {
    it("is the connected server's own, or this machine's", () => {
        expect(shardOf({ kind: "host", hostId: "host-a" })).toBe("host-a");
        expect(shardOf({ kind: "local", hostId: null })).toBe(LOCAL_SHARD);
        // A target with no machine behind it is this one, never a shard named "null".
        expect(shardOf({ kind: "host", hostId: null })).toBe(LOCAL_SHARD);
        expect(shardOf(null)).toBe(LOCAL_SHARD);
    });

    it("follows the install's target", async () => {
        const here = server("home", "t-local", 25570);
        const there = server("away", "t-a", 25571);
        expect(await installShard(here)).toBe(LOCAL_SHARD);
        expect(await installShard(there)).toBe("host-a");
    });

    it("keeps one name per machine, the first claim winning", () => {
        const shards = routesByShard([
            { hostname: "x", backend: "a:1", shard: "host-a", routed: true },
            { hostname: "x", backend: "a:2", shard: "host-a", routed: true },
            { hostname: "x", backend: "b:1", shard: "host-b", routed: true }
        ]);
        expect(shards.get("host-a")?.map((route) => route.backend)).toEqual(["a:1"]);
        expect(shards.get("host-b")?.map((route) => route.backend)).toEqual(["b:1"]);
    });
});

describe("a table per machine", () => {
    it("holds only that machine's servers, each dialled on its own machine", async () => {
        server("home", "t-local", 25570);
        server("away", "t-a", 25571);
        server("far", "t-b", 25572);
        expect(await minecraftRoutes(LOCAL_SHARD)).toEqual([
            { hostname: "home.mc.example.com", backend: "host.docker.internal:25570" }
        ]);
        expect(await minecraftRoutes("host-a")).toEqual([
            { hostname: "away.mc.example.com", backend: "host.docker.internal:25571" }
        ]);
    });

    it("a single-machine install has exactly one table, written with nothing configured", async () => {
        server("home", "t-local", 25570);
        await syncMinecraftRoutes();
        expect(await localTable()).toEqual({ "home.mc.example.com": "host.docker.internal:25570" });
        expect(remote.writes).toEqual([]);
        expect(remote.started).toEqual([]);
    });

    it("a change writes its own machine's table and no other", async () => {
        server("home", "t-local", 25570);
        const away = server("away", "t-a", 25571);
        server("far", "t-b", 25572);
        await syncMinecraftRoutes(away);
        expect(remote.writes).toEqual(["host-a"]);
        expect(remoteTable("host-a")).toEqual({ "away.mc.example.com": "host.docker.internal:25571" });
        await expect(readFile(join(dir, "mc-routes.json"), "utf8")).rejects.toThrow();
    });

    it("retires a removed server's name on its own machine", async () => {
        const away = server("away", "t-a", 25571);
        await syncMinecraftRoutes(away);
        installs[0]!.status = "removed";
        await syncMinecraftRoutes(away);
        expect(remoteTable("host-a")).toEqual({ "away.mc.example.com": "host.docker.internal:0" });
    });

    it("the sweep retires names on a machine whose last server went away", async () => {
        server("away", "t-a", 25571);
        await syncMinecraftRoutes();
        installs[0]!.status = "removed";
        await syncMinecraftRoutes();
        expect(remoteTable("host-a")).toEqual({ "away.mc.example.com": "host.docker.internal:0" });
    });

    it("never touches a machine nobody routed anything on", async () => {
        server("away", "t-a", 25571, { routed: false });
        await syncMinecraftRoutes();
        expect(remote.writes).toEqual([]);
        expect(remote.started).toEqual([]);
    });
});

describe("writes are bounded", () => {
    it("an unchanged table is not written again", () => {
        const routes = [{ hostname: "x.mc.example.com", backend: "h:1" }];
        const first = nextTable(null, routes, false);
        expect(first).not.toBeNull();
        expect(nextTable(first, routes, false)).toBeNull();
    });

    it("this machine's table is written empty, a connected server's is not", () => {
        // This machine's router exits at startup without a file; a connected server
        // with nothing routed gets no file and no router at all.
        expect(nextTable(null, [], true)).toBe(`${JSON.stringify({ mappings: {} }, null, 2)}\n`);
        expect(nextTable(null, [], false)).toBeNull();
    });
});

describe("repairing a machine's router", () => {
    it("deploys it where it is not running, and leaves a running one alone", async () => {
        server("away", "t-a", 25571);
        server("far", "t-b", 25572);
        remote.running.add("host-b");
        await syncMinecraftRoutes();
        expect(remote.started).toEqual(["host-a"]);
        await syncMinecraftRoutes();
        // Idempotent: both are running now, and neither table changed.
        expect(remote.started).toEqual(["host-a"]);
        expect(remote.writes.sort()).toEqual(["host-a", "host-b"]);
    });

    it("does not claim a port for a candidate whose own address still answers", async () => {
        server("away", "t-a", 25571, { routeCandidate: true });
        await syncMinecraftRoutes();
        expect(remote.writes).toEqual(["host-a"]);
        expect(remote.started).toEqual([]);
    });
});
