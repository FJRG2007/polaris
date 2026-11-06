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

const { minecraftRoutes, retiredRoutes, retiredSince, routesConfig } = await import("@polaris-app/game-servers/src/lib/minecraft/router-service");

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

    it("drops a retired name an hour after it was retired, and keeps it until then", () => {
        const previous = routesConfig([
            { hostname: "old.mc.example.com", backend: "host.docker.internal:0" },
            { hostname: "fresh.mc.example.com", backend: "host.docker.internal:0" }
        ]);
        const now = 10 * 60 * 60_000;
        const since = { "old.mc.example.com": now - 60 * 60_000, "fresh.mc.example.com": now - 60_000 };
        expect(retiredRoutes(previous, [], since, now)).toEqual([
            { hostname: "fresh.mc.example.com", backend: "host.docker.internal:0" }
        ]);
    });

    it("dates a name from the write that retired it, and keeps an earlier date", () => {
        const retired = [
            { hostname: "old.mc.example.com", backend: "host.docker.internal:0" },
            { hostname: "new.mc.example.com", backend: "host.docker.internal:0" }
        ];
        expect(retiredSince(retired, { "old.mc.example.com": 5, "gone.mc.example.com": 1 }, 9)).toEqual({
            "old.mc.example.com": 5,
            "new.mc.example.com": 9
        });
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

/** A fake server that answers one status ping with this JSON. */
async function statusServer(status: unknown): Promise<{ port: number; close: () => void }> {
    const { createServer } = await import("node:net");
    const varInt = (value: number): Buffer => {
        const bytes: number[] = [];
        let rest = value >>> 0;
        do {
            const group = rest & 0x7f;
            rest >>>= 7;
            bytes.push(rest === 0 ? group : group | 0x80);
        } while (rest !== 0);
        return Buffer.from(bytes);
    };
    const json = Buffer.from(JSON.stringify(status), "utf8");
    const payload = Buffer.concat([varInt(0), varInt(json.length), json]);
    const reply = Buffer.concat([varInt(payload.length), payload]);
    const listener = createServer((socket) => {
        // Split in two, as a reply crossing a router can arrive.
        socket.once("data", () => {
            socket.write(reply.subarray(0, 8));
            setTimeout(() => socket.end(reply.subarray(8)), 20);
        });
    });
    await new Promise<void>((ready) => listener.listen(0, "127.0.0.1", ready));
    const { port } = listener.address() as { port: number };
    return { port, close: () => listener.close() };
}

describe("readJavaStatus", () => {
    it("reads the whole reply, however it arrives, and the text it puts on the list", async () => {
        const { readJavaStatus, statusDescription } = await import("@polaris-app/game-servers/src/lib/minecraft/slp");
        const fake = await statusServer({
            version: { name: "1.21.4", protocol: 769 },
            description: { text: "§aSurvival", extra: [{ text: " world" }] }
        });
        const status = await readJavaStatus("127.0.0.1", fake.port, 2000, "survival.mc.example.com");
        fake.close();
        expect(statusDescription(status)).toBe("Survival world");
    });

    it("gives null when nothing answers in the game's shape", async () => {
        const { readJavaStatus } = await import("@polaris-app/game-servers/src/lib/minecraft/slp");
        const { createServer } = await import("node:net");
        const listener = createServer((socket) => socket.end("HTTP/1.1 400 Bad Request"));
        await new Promise<void>((ready) => listener.listen(0, "127.0.0.1", ready));
        const { port } = listener.address() as { port: number };
        expect(await readJavaStatus("127.0.0.1", port, 2000)).toBeNull();
        listener.close();
    });

    it("tells the router's own asleep and loading replies apart from the server's", async () => {
        const { MINECRAFT_ROUTER_ASLEEP_MOTD, MINECRAFT_ROUTER_LOADING_MOTD } = await import("@polaris/core");
        const { statusDescription } = await import("@polaris-app/game-servers/src/lib/minecraft/slp");
        expect(statusDescription({ description: { text: MINECRAFT_ROUTER_ASLEEP_MOTD } })).toBe(MINECRAFT_ROUTER_ASLEEP_MOTD);
        expect(statusDescription({ description: MINECRAFT_ROUTER_LOADING_MOTD })).toBe(MINECRAFT_ROUTER_LOADING_MOTD);
        expect(statusDescription({})).toBe("");
    });
});
