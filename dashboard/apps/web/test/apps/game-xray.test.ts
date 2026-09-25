/**
 * Anti X-Ray: honeypots, and the rules that keep them from ever pointing at the
 * wrong player.
 *
 * The cost of a mistake here is a player accused - or banned - for something
 * they did not do, so every way a honeypot can disappear without X-Ray is named
 * one at a time: an explosion, somebody else's pickaxe, a chunk nobody has
 * loaded, a single lucky find.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The server and the dashboard the loop talks to, shared with the mocks below. */
const fake = vi.hoisted(() => ({
    config: {} as Record<string, unknown>,
    answer: (_command: string): string => "",
    notified: [] as string[],
    banned: [] as string[],
    /** How many times the loop asked who mined: proof that it looked at all. */
    looks: 0
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: {
            findUnique: async () => ({
                config: JSON.stringify(fake.config),
                name: "Offgrid",
                status: "running",
                catalogId: "minecraft"
            }),
            findMany: async () => []
        }
    }
}));
vi.mock("@polaris/app-host", () => ({
    host: {
        appsInstallConfig: {
            readInstallConfig: (raw: string) => JSON.parse(raw ?? "{}"),
            patchInstallConfig: async (_id: string, patch: Record<string, unknown>) => {
                fake.config = { ...fake.config, ...JSON.parse(JSON.stringify(patch)) };
            }
        },
        notificationService: {
            createNotification: async (input: { title: string }) => {
                fake.notified.push(input.title);
            }
        }
    }
}));
vi.mock("@polaris-app/game-servers/src/lib/minecraft/service", () => ({
    withServerContainer: async (_owner: string, _id: string, work: (server: unknown) => unknown) =>
        work({
            running: true,
            edition: "java",
            say: async (argv: string[]) => fake.answer(argv[0] ?? "")
        })
}));
vi.mock("@polaris-app/game-servers/src/lib/minecraft/timeout-service", () => ({
    timeoutPlayer: async (_owner: string, _id: string, player: string) => {
        fake.banned.push(player);
    }
}));
import {
    BAN_HITS_MIN,
    CONFIRM_HITS,
    DEFAULT_XRAY_SETTINGS,
    EVIDENCE_WINDOW_MS,
    HIT_RANGE,
    PLACE_MAX_DISTANCE,
    PLACE_MIN_DISTANCE,
    actionsFor,
    candidatePoints,
    countingHits,
    miningFigures,
    placeCommand,
    readDimensions,
    readPositions,
    readTest,
    trapsNear,
    verdictOf,
    type Honeypot,
    type PlayerEvidence
} from "@polaris-app/game-servers/src/lib/minecraft/xray";

const NOW = Date.parse("2026-09-26T12:00:00Z");
const trap = (x: number, y: number, z: number): Honeypot => ({
    dimension: "minecraft:overworld",
    x,
    y,
    z,
    placedAt: NOW - 60_000
});
const evidence = (hits: number, over: Partial<PlayerEvidence> = {}): PlayerEvidence => ({
    name: "Steve",
    hits: Array.from({ length: hits }, (_, index) => ({
        dimension: "minecraft:overworld" as const,
        x: index * 10,
        y: -50,
        z: 0,
        at: NOW - index * 1000
    })),
    reportedHits: 0,
    warnedAt: null,
    bannedAt: null,
    ...over
});

describe("reading the game's answers", () => {
    it("reads every player's position out of one answer, colour codes and all", () => {
        const answer =
            "Steve has the following entity data: [-5278.04d, -58.0d, -2522.27d]\u001b[0m\nAlex has the following entity data: [1.5d, 64.0d, 2.5d]";
        expect(readPositions(answer)).toEqual([
            { name: "Steve", x: -5278.04, y: -58, z: -2522.27 },
            { name: "Alex", x: 1.5, y: 64, z: 2.5 }
        ]);
    });

    it("reads which dimension each player is in", () => {
        expect(
            readDimensions('Steve has the following entity data: "minecraft:the_nether"')
        ).toEqual(new Map([["Steve", "minecraft:the_nether"]]));
    });

    it("tells a place the game has not loaded from a block that is gone", () => {
        expect(readTest("That position is not loaded")).toBe("unloaded");
        expect(readTest("Test passed")).toBe("passed");
        expect(readTest("Changed the block at 1, -50, 2")).toBe("passed");
        expect(readTest("Test failed")).toBe("failed");
    });
});

describe("placing a honeypot", () => {
    it("only where the ore and all six neighbours are natural rock", () => {
        const command = placeCommand("minecraft:overworld", 10, -50, 20);
        expect(command).toBe(
            [
                "execute in minecraft:overworld if block 10 -50 20 minecraft:deepslate",
                "if block 11 -50 20 #minecraft:deepslate_ore_replaceables",
                "if block 9 -50 20 #minecraft:deepslate_ore_replaceables",
                "if block 10 -49 20 #minecraft:deepslate_ore_replaceables",
                "if block 10 -51 20 #minecraft:deepslate_ore_replaceables",
                "if block 10 -50 21 #minecraft:deepslate_ore_replaceables",
                "if block 10 -50 19 #minecraft:deepslate_ore_replaceables",
                "run setblock 10 -50 20 minecraft:deepslate_diamond_ore"
            ].join(" ")
        );
    });

    it("out of the player's sight and at the dimension's ore depth", () => {
        let seed = 0;
        const random = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
        for (const point of candidatePoints("minecraft:overworld", { x: 0, z: 0 }, 200, random)) {
            const away = Math.hypot(point.x, point.z);
            expect(away).toBeGreaterThanOrEqual(PLACE_MIN_DISTANCE - 2);
            expect(away).toBeLessThanOrEqual(PLACE_MAX_DISTANCE + 2);
            expect(point.y).toBeGreaterThanOrEqual(-58);
            expect(point.y).toBeLessThanOrEqual(-20);
        }
    });
});

describe("what counts as evidence", () => {
    it("tests only the honeypots beside the player who mined", () => {
        const near = trap(3, -50, 0);
        const far = trap(HIT_RANGE + 5, -50, 0);
        const other: Honeypot = { ...near, dimension: "minecraft:the_nether" };
        expect(
            trapsNear([near, far, other], "minecraft:overworld", { x: 0.5, y: -50, z: 0.5 })
        ).toEqual([near]);
    });

    it("says nothing about one honeypot: a branch mine can run into one", () => {
        expect(verdictOf(evidence(1), NOW)).toBe("chance");
        expect(
            actionsFor(evidence(1), { ...DEFAULT_XRAY_SETTINGS, action: "warn-and-ban" }, NOW)
        ).toEqual({ report: false, warn: false, ban: false });
    });

    it(`confirms at ${CONFIRM_HITS} different honeypots, not the same one twice`, () => {
        const twice = evidence(1);
        const same = { ...twice, hits: [...twice.hits, { ...twice.hits[0]!, at: NOW }] };
        expect(verdictOf(same, NOW)).toBe("chance");
        expect(verdictOf(evidence(CONFIRM_HITS), NOW)).toBe("confirmed");
    });

    it("forgets finds older than the window", () => {
        const old = evidence(2);
        const aged = {
            ...old,
            hits: old.hits.map((hit) => ({ ...hit, at: NOW - EVIDENCE_WINDOW_MS - 1 }))
        };
        expect(countingHits(aged, NOW)).toHaveLength(0);
        expect(verdictOf(aged, NOW)).toBe("clear");
    });
});

describe("acting on it", () => {
    const ban = { ...DEFAULT_XRAY_SETTINGS, action: "warn-and-ban" as const, banHits: 3 };

    it("only reports, by default", () => {
        expect(actionsFor(evidence(2), DEFAULT_XRAY_SETTINGS, NOW)).toEqual({
            report: true,
            warn: false,
            ban: false
        });
    });

    it("warns before it ever bans, and never bans below the floor", () => {
        expect(actionsFor(evidence(3), ban, NOW)).toEqual({ report: true, warn: true, ban: false });
        expect(actionsFor(evidence(2, { warnedAt: NOW }), ban, NOW).ban).toBe(false);
        expect(actionsFor(evidence(3, { warnedAt: NOW }), ban, NOW).ban).toBe(true);
        expect(
            actionsFor(evidence(2, { warnedAt: NOW }), { ...ban, banHits: 1 }, NOW).ban,
            `a setting below ${BAN_HITS_MIN} is held to ${BAN_HITS_MIN}`
        ).toBe(false);
    });

    it("reports and bans once, not on every look", () => {
        const done = evidence(3, { reportedHits: 3, warnedAt: NOW - 10, bannedAt: NOW });
        expect(actionsFor(done, ban, NOW)).toEqual({ report: false, warn: false, ban: false });
    });
});

describe("the game's own figures", () => {
    it("reads diamonds and the rock they sit in out of a stats file", () => {
        const stats = JSON.stringify({
            stats: {
                "minecraft:mined": {
                    "minecraft:deepslate_diamond_ore": 178,
                    "minecraft:diamond_ore": 2,
                    "minecraft:deepslate": 1338,
                    "minecraft:tuff": 144,
                    "minecraft:netherrack": 758
                }
            }
        });
        expect(miningFigures(stats)).toEqual({
            diamonds: 180,
            deepRock: 1482,
            debris: 0,
            netherRock: 758
        });
    });
});

/**
 * The loop itself, against a server that answers like one: the world is a map
 * of blocks, the players have positions and live counters.
 */
describe("watching a server", () => {
    const INSTALL = "018f2b7a-0000-7000-8000-0000000000e1";
    let world = new Map<string, string>();
    let players: { name: string; x: number; y: number; z: number; mined: number }[] = [];

    const key = (x: number, y: number, z: number) => `${x},${y},${z}`;

    function answer(command: string): string {
        const counter =
            /^execute as @a\[scores=\{polaris_xray_d=1\.\.\}\] run data get entity @s Pos$/;
        if (counter.test(command)) {
            fake.looks += 1;
            return players
                .filter((one) => one.mined > 0)
                .map(
                    (one) =>
                        `${one.name} has the following entity data: [${one.x}d, ${one.y}d, ${one.z}d]`
                )
                .join("\n");
        }
        const reset = /^scoreboard players reset (\w+) polaris_xray_d$/.exec(command);
        if (reset) {
            const player = players.find((one) => one.name === reset[1]);
            if (player) player.mined = 0;
            return "";
        }
        const test =
            /^execute in minecraft:overworld if block (-?\d+) (-?\d+) (-?\d+) minecraft:deepslate_diamond_ore$/.exec(
                command
            );
        if (test) {
            const block = world.get(key(Number(test[1]), Number(test[2]), Number(test[3])));
            if (block === undefined) return "That position is not loaded";
            return block === "ore" ? "Test passed" : "Test failed";
        }
        return "";
    }

    beforeEach(() => {
        vi.useFakeTimers();
        world = new Map();
        players = [];
        fake.notified.length = 0;
        fake.banned.length = 0;
        fake.looks = 0;
        fake.answer = answer;
        // A fresh loop for every test: one left running from the test before
        // would be on the old clock and never look again.
        vi.resetModules();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    async function withTraps(traps: Honeypot[], settings = DEFAULT_XRAY_SETTINGS) {
        for (const one of traps) world.set(key(one.x, one.y, one.z), "ore");
        fake.config = {
            xrayTraps: {
                settings: { ...settings, enabled: true, nether: false },
                honeypots: traps,
                evidence: {},
                cleanup: []
            }
        };
        const service = await import("@polaris-app/game-servers/src/lib/minecraft/xray-service");
        service.startXrayTraps("owner", INSTALL);
    }

    async function look() {
        const before = fake.looks;
        await vi.advanceTimersByTimeAsync(4_100);
        expect(fake.looks, "the loop looked").toBeGreaterThan(before);
    }

    function hitsOf(name: string): number {
        const stored = fake.config.xrayTraps as { evidence: Record<string, { hits: unknown[] }> };
        return stored.evidence[name.toLowerCase()]?.hits.length ?? 0;
    }

    it("counts a honeypot mined by the player beside it", async () => {
        await withTraps([trap(10, -50, 10)]);
        world.set(key(10, -50, 10), "air");
        players = [{ name: "Steve", x: 10.5, y: -50, z: 12.5, mined: 1 }];
        await look();
        expect(hitsOf("Steve")).toBe(1);
    });

    it("does not count one taken by an explosion: nobody's counter moved", async () => {
        await withTraps([trap(20, -50, 20)]);
        world.set(key(20, -50, 20), "air");
        players = [{ name: "Alex", x: 21, y: -50, z: 20, mined: 0 }];
        await look();
        expect(hitsOf("Alex")).toBe(0);
    });

    it("does not count one gone near somebody who mined a diamond far from it", async () => {
        await withTraps([trap(30, -50, 30)]);
        world.set(key(30, -50, 30), "air");
        players = [{ name: "Alex", x: 30 + HIT_RANGE + 20, y: -50, z: 30, mined: 1 }];
        await look();
        expect(hitsOf("Alex")).toBe(0);
    });

    it("does not count one in a place the game has not loaded", async () => {
        await withTraps([trap(40, -50, 40)]);
        world.delete(key(40, -50, 40));
        players = [{ name: "Steve", x: 40, y: -50, z: 41, mined: 1 }];
        await look();
        expect(hitsOf("Steve")).toBe(0);
    });

    it("tells the owner at the second honeypot, and bans nobody by default", async () => {
        await withTraps([trap(50, -50, 50), trap(70, -50, 70)]);
        world.set(key(50, -50, 50), "air");
        players = [{ name: "Steve", x: 50, y: -50, z: 51, mined: 1 }];
        await look();
        expect(fake.notified).toEqual([]);
        world.set(key(70, -50, 70), "air");
        players = [{ name: "Steve", x: 70, y: -50, z: 71, mined: 1 }];
        await look();
        expect(fake.notified).toEqual(["Steve dug to 2 hidden ores on Offgrid"]);
        expect(fake.banned).toEqual([]);
    });
});
