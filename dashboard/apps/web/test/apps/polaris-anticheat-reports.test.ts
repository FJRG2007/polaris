/**
 * What Polaris's anti-cheat plugin reports, from the server to the Anti-cheat tab.
 *
 * What is pinned: a report is taken only from the server it names, with that
 * server's token, and only while its engine is on; every field is checked, so a
 * server cannot file a bad name, an odd check or a huge body; a server's clock is
 * not trusted for when a flag happened beyond a minute; the owner is told once,
 * when a player's alerts first make them look likely to be cheating; and the
 * engine's alerts score the way the tab explains - one could be a glitch, ten is
 * confirmed, and different checks failing weighs more than the same one again.
 */

import { join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SERVER = "01a0a00b-35c5-7932-861e-1b2161a9b298";
const NOW = Date.parse("2026-09-28T12:00:00.000Z");

const fake = vi.hoisted(() => ({
    rows: [] as {
        installedAppId: string;
        player: string;
        playerName: string;
        check: string;
        violations: number;
        verbose: string;
        at: Date;
    }[],
    env: new Map<string, string>(),
    token: "the-token" as string | null,
    notified: [] as { title: string; body: string; userId: string }[],
    config: {} as Record<string, unknown>
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: {
            findFirst: async () => ({ applicationId: "app-1", ownerId: "owner-1" }),
            findUnique: async () => ({ name: "Offgrid", config: fake.config })
        },
        minecraftAnticheatFlag: {
            createMany: async ({ data }: { data: typeof fake.rows }) => {
                fake.rows.push(...data);
                return { count: data.length };
            },
            deleteMany: async () => ({ count: 0 }),
            groupBy: async ({ where }: { where: { player: { in: string[] } } }) => {
                const groups = new Map<
                    string,
                    { player: string; check: string; n: number; name: string }
                >();
                for (const row of fake.rows) {
                    if (!where.player.in.includes(row.player)) continue;
                    const key = `${row.player}|${row.check}`;
                    const held = groups.get(key) ?? {
                        player: row.player,
                        check: row.check,
                        n: 0,
                        name: row.playerName
                    };
                    held.n += 1;
                    groups.set(key, held);
                }
                return [...groups.values()].map((one) => ({
                    player: one.player,
                    check: one.check,
                    _count: { _all: one.n },
                    _max: { playerName: one.name }
                }));
            }
        }
    }
}));

vi.mock("@polaris/app-host", () => ({
    host: {
        domainService: { publicAppUrl: async () => "https://polaris.example" },
        envVarService: {
            listEnvVars: async () => [...fake.env].map(([key, value]) => ({ key, value })),
            setEnvVars: async () => undefined
        },
        appsInstallSecret: { readInstallEnvSecret: async () => fake.token },
        appsInstallConfig: { readInstallConfig: (config: Record<string, unknown>) => config },
        rateLimitService: { rateLimit: async () => ({ ok: true, retryAfterMs: 0 }) },
        notificationService: {
            createNotification: async (input: { title: string; body: string; userId: string }) => {
                fake.notified.push(input);
            }
        }
    }
}));

const { GET, POST } = await import(
    "@polaris-app/game-servers/src/routes/api/minecraft/anticheat/[id]/route"
);
const { engineCheckLabel, engineScore } = await import(
    "@polaris-app/game-servers/src/lib/minecraft/suspicion"
);

function report(body: unknown, token = "the-token", id = SERVER) {
    return POST(
        new Request(`https://polaris.example/api/minecraft/anticheat/${id}`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: typeof body === "string" ? body : JSON.stringify(body)
        }),
        { params: Promise.resolve({ id }) }
    );
}

const flag = (over: Record<string, unknown> = {}) => ({
    player: "CheaterBot",
    uuid: "b6f17181-9a33-35da-ac7a-dc016f891bd9",
    check: "Simulation",
    vl: 25,
    verbose: "1.000000 /gl 25",
    at: NOW,
    ...over
});

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    fake.rows = [];
    fake.notified = [];
    fake.token = "the-token";
    fake.config = {};
    fake.env = new Map([
        ["MODS", "https://polaris.example/api/minecraft/mod/polaris-anticheat-bukkit.jar"],
        ["POLARIS_ANTICHEAT", "on"]
    ]);
});

describe("taking a report", () => {
    it("keeps flags from the server with its token", async () => {
        const answer = await report({ flags: [flag()] });
        expect(answer.status).toBe(200);
        expect(fake.rows).toEqual([
            expect.objectContaining({
                installedAppId: SERVER,
                player: "cheaterbot",
                playerName: "CheaterBot",
                check: "Simulation",
                violations: 25
            })
        ]);
    });

    it("refuses a wrong token, a server with the engine off, and an id that is not one", async () => {
        expect((await report({ flags: [flag()] }, "wrong")).status).toBe(401);
        fake.env.set("POLARIS_ANTICHEAT", "off");
        expect((await report({ flags: [flag()] })).status).toBe(401);
        expect((await report({ flags: [flag()] }, "the-token", "nope")).status).toBe(401);
        expect(fake.rows).toEqual([]);
    });

    it("refuses a bad name, an odd check, a long line, an empty or oversized batch", async () => {
        for (const body of [
            { flags: [flag({ player: "not a name!" })] },
            { flags: [flag({ check: "<script>" })] },
            { flags: [flag({ verbose: "x".repeat(301) })] },
            { flags: [] },
            { flags: Array.from({ length: 201 }, () => flag()) },
            "{not json"
        ]) {
            expect((await report(body)).status).toBe(400);
        }
        expect(fake.rows).toEqual([]);
    });

    it("does not trust the server's clock for when a flag happened beyond a minute", async () => {
        await report({
            flags: [flag({ at: NOW - 3 * 24 * 3600_000 }), flag({ at: NOW - 30_000 })]
        });
        expect(fake.rows.map((row) => row.at.getTime())).toEqual([NOW, NOW - 30_000]);
    });

    it("tells the owner once, when a player first looks likely to be cheating", async () => {
        await report({ flags: [flag()] });
        await report({ flags: [flag({ check: "Reach" })] });
        expect(fake.notified).toEqual([]);
        await report({ flags: [flag({ check: "Timer" })] });
        expect(fake.notified).toHaveLength(1);
        expect(fake.notified[0]).toMatchObject({
            userId: "owner-1",
            title: "CheaterBot is likely cheating on Offgrid"
        });
        await report({ flags: [flag()] });
        expect(fake.notified).toHaveLength(1);
    });
});

describe("handing the plugin the honeypots", () => {
    const traps = (token = "the-token", id = SERVER) =>
        GET(
            new Request(`https://polaris.example/api/minecraft/anticheat/${id}`, {
                headers: { authorization: `Bearer ${token}` }
            }),
            { params: Promise.resolve({ id }) }
        );

    it("lists every trap as [dimension, x, y, z], the Nether as 1", async () => {
        fake.config = {
            xrayTraps: {
                honeypots: [
                    { dimension: "minecraft:overworld", x: 120, y: -40, z: -8, placedAt: NOW },
                    { dimension: "minecraft:the_nether", x: -5, y: 15, z: 300, placedAt: NOW }
                ]
            }
        };
        const answer = await traps();
        expect(answer.status).toBe(200);
        expect(await answer.json()).toEqual({
            traps: [
                [0, 120, -40, -8],
                [1, -5, 15, 300]
            ]
        });
    });

    it("tells nobody without the server's token, and nothing to a server with the engine off", async () => {
        expect((await traps("wrong")).status).toBe(401);
        fake.env.set("POLARIS_ANTICHEAT", "off");
        expect((await traps()).status).toBe(401);
    });

    it("is an empty list for a server with no traps", async () => {
        expect(await (await traps()).json()).toEqual({ traps: [] });
    });
});

describe("scoring the engine's alerts", () => {
    it("is nothing for nothing, possible for one, and confirmed at ten", () => {
        expect(engineScore([]).level).toBe("unlikely");
        expect(engineScore([{ check: "Simulation", alerts: 1 }]).level).toBe("possible");
        expect(engineScore([{ check: "Simulation", alerts: 10 }]).level).toBe("confirmed");
    });

    it("weighs different checks failing above the same one failing again", () => {
        const same = engineScore([{ check: "Simulation", alerts: 3 }]).value;
        const spread = engineScore([
            { check: "Simulation", alerts: 1 },
            { check: "Reach", alerts: 1 },
            { check: "Timer", alerts: 1 }
        ]).value;
        expect(spread).toBeGreaterThan(same);
    });

    it("says what each check caught, in words", () => {
        expect(engineScore([{ check: "Reach", alerts: 2 }]).reasons).toEqual([
            "Hit from further away than anybody can - Reach, 2 times"
        ]);
    });

    it("has words for every check the engine has", () => {
        const engine = join(
            __dirname,
            "..",
            "..",
            "..",
            "..",
            "resources",
            "minecraft",
            "polaris-anticheat"
        );
        const names = readdirSync(engine, { recursive: true, encoding: "utf8" })
            .filter((file) => file.endsWith(".java"))
            .flatMap((file) =>
                [
                    ...readFileSync(join(engine, file), "utf8").matchAll(
                        /@CheckData\(name = "([^"]+)"/g
                    )
                ].map((match) => match[1]!)
            );
        expect(names.length).toBeGreaterThan(50);
        expect(names.filter((name) => engineCheckLabel(name) === name)).toEqual([]);
        expect(engineCheckLabel("AntiKB")).toBe("ignored knockback");
        expect(engineCheckLabel("FarPlace")).toBe("placed a block it could not reach");
        expect(engineCheckLabel("NegativeTimer")).toBe("sped up the game clock");
    });
});
