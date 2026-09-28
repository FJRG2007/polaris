/**
 * Minecraft events played end to end against a server that answers the way the
 * game does: the countdown, the scoreboard, the chest found, the podium, the
 * prizes - handed over or kept for later - the anti-cheat's word, calling one
 * off, and the minute sweep that starts them on their own.
 *
 * The server here records every line it is sent and answers the few questions
 * the engine asks it. Nothing else is faked: the loop, the timers, the stored
 * state and every decision are the real ones.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ------------------------------------------------------------------ the world

interface World {
    online: string[];
    scores: Record<string, number>;
    chestOpenedAfter: number;
    chestChecks: number;
    flagged: string[];
    sent: string[];
    /** The server log, for what players say in the chat. */
    log: string;
    bossAlive: boolean;
    deaths: Record<string, number>;
    arrived: boolean;
    /** Every column tried is water. */
    allWater: boolean;
    /** Where whoever has a kill of the boss's kind is standing. */
    killerAt: [number, number, number];
    /** Item ids the server does not know. */
    unknownItems: string[];
    /** Which world each player is in; the Overworld when not said. */
    dims: Record<string, string>;
    /** The game's running damage counts, per player. */
    hurt: Record<string, number>;
    /** Players standing perfectly still, looking the same way. */
    still: string[];
    /** Players in creative or spectator. */
    creative: string[];
    difficulty: string;
    daylightCycle: "true" | "false";
    /** A version that knows the game rules by their new names only. */
    renamedRules: boolean;
    /** Whether the ground under a place is somebody's build. */
    built: boolean;
    /** Ground names the server does not know. */
    refusedGround: string[];
    /** How many ground checks answer that the column is not loaded before any answers. */
    unsureGround: number;
    /** Where players online sleep: `Name: [x, z]`. */
    homes: Record<string, [number, number]>;
}

const world: World = {
    online: [],
    scores: {},
    chestOpenedAfter: 3,
    chestChecks: 0,
    flagged: [],
    sent: [],
    log: "",
    bossAlive: true,
    deaths: {},
    arrived: false,
    allWater: false,
    killerAt: [305, 70, 2],
    unknownItems: [],
    dims: {},
    hurt: {},
    still: [],
    creative: [],
    difficulty: "Normal",
    daylightCycle: "true",
    renamedRules: false,
    built: false,
    refusedGround: [],
    unsureGround: 0,
    homes: {}
};
let config: Record<string, unknown> = {};
const held: string[] = [];
const released: string[] = [];

/** Bumped on every look, so a player who is not still has always moved - a
 *  block and a turn, well past the threshold for standing still. */
let step = 0;

function answer(line: string): string {
    world.sent.push(line);
    if (line.startsWith("execute in minecraft:overworld unless block")) {
        const refused = world.refusedGround.find((id) => line.includes(`minecraft:${id} `) || line.endsWith(`minecraft:${id}`));
        if (refused) return `Unknown block type 'minecraft:${refused}'`;
        if (world.unsureGround > 0) {
            world.unsureGround -= 1;
            return "That position is not loaded";
        }
        return world.built ? "Test passed" : "Test failed";
    }
    if (line === "execute as @a run data get entity @s SpawnX" || line === "execute as @a run data get entity @s SpawnZ") {
        const axis = line.endsWith("SpawnX") ? 0 : 1;
        return Object.entries(world.homes)
            .map(([name, home]) => `${name} has the following entity data: ${home[axis]}`)
            .join("\n");
    }
    if (line === "difficulty") return `The difficulty is ${world.difficulty}`;
    if (line === "time query daytime") return "The time is 6000";
    if (world.renamedRules && /^gamerule do\w+$/.test(line))
        return "Unknown or incomplete command, see below for error";
    if (line === "gamerule advance_time" || line === "gamerule advance_weather") {
        return world.renamedRules
            ? `Gamerule ${line.slice(9)} is currently set to: ${world.daylightCycle}`
            : "Unknown or incomplete command, see below for error";
    }
    if (line === "gamerule doDaylightCycle")
        return `Gamerule doDaylightCycle is currently set to: ${world.daylightCycle}`;
    if (line.startsWith("execute as @a[gamemode=!survival,gamemode=!adventure]")) {
        return world.creative
            .map((name) => `${name} has the following entity data: [0.0d, 64.0d, 0.0d]`)
            .join("\n");
    }
    if (line === "execute as @a run data get entity @s Dimension") {
        return world.online
            .map(
                (name) =>
                    `${name} has the following entity data: "${world.dims[name] ?? "minecraft:overworld"}"`
            )
            .join("\n");
    }
    const counted = /^execute as @a run scoreboard players get @s (pe_hurt|pe_hit)$/.exec(line);
    if (counted) {
        return world.online
            .map(
                (name) =>
                    `${name} has ${counted[1] === "pe_hurt" ? (world.hurt[name] ?? 0) : 0} [${counted[1]}]`
            )
            .join("\n");
    }
    if (line.includes("as @a[distance=0..] run data get entity @s Pos")) {
        return world.online
            .filter((name) => (world.dims[name] ?? "minecraft:overworld") === "minecraft:overworld")
            .map(
                (name, index) =>
                    `${name} has the following entity data: [${index * 10 + step}d, 64.0d, 0.0d]`
            )
            .join("\n");
    }
    if (line === "execute as @a run data get entity @s Pos") {
        step += 1;
        return world.online
            .map((name, index) =>
                world.still.includes(name)
                    ? `${name} has the following entity data: [100.0d, 64.0d, 100.0d]`
                    : `${name} has the following entity data: [${index * 10 + step}d, 64.0d, 0.0d]`
            )
            .join("\n");
    }
    if (line === "execute as @a run data get entity @s Rotation") {
        return world.online
            .map((name) =>
                world.still.includes(name)
                    ? `${name} has the following entity data: [10.0f, 0.0f]`
                    : `${name} has the following entity data: [${(step * 37) % 360}f, 0.0f]`
            )
            .join("\n");
    }
    if (line === "execute as @a run scoreboard players get @s pe_score") {
        return world.online
            .filter((name) => world.scores[name] !== undefined)
            .map((name) => `${name} has ${world.scores[name]} [pe_score]`)
            .join("\n");
    }
    const one = /^scoreboard players get (\S+) pe_score$/.exec(line);
    if (one) {
        const name = one[1] as string;
        return world.scores[name] !== undefined
            ? `${name} has ${world.scores[name]} [pe_score]`
            : `Can't get value of pe_score for ${name}; none is set`;
    }
    if (line.includes("spreadplayers") && line.includes("pe_mark") && world.allWater) {
        return "Could not spread 1 entity around 300, 0 (too many entities for space - try using spread of at most 0.0)";
    }
    if (line.includes("spreadplayers") && line.includes("pe_mark"))
        return "Spread 1 entity around 300.5, 0.5 with an average distance of 0 blocks apart";
    if (line.startsWith("data get entity @e[tag=pe_mark"))
        return "Armor Stand has the following entity data: [300.5d, 70.0d, 0.5d]";
    if (line.includes("if data block") && line.includes("LootTable")) {
        world.chestChecks += 1;
        return world.chestChecks > world.chestOpenedAfter ? "Test failed" : "Test passed";
    }
    if (line.includes("sort=nearest"))
        return `${world.online[0]} has the following entity data: [301.0d, 70.0d, 1.0d]`;
    if (line.startsWith("give ")) {
        const [, name, item] = line.split(" ") as [string, string, string];
        if (world.unknownItems.includes(item)) return `Unknown item '${item}'`;
        return world.online.includes(name) ? `Gave 1 [Item] to ${name}` : "No player was found";
    }
    if (line.startsWith("xp add ")) return "Gave 10 experience levels to somebody";
    if (line === "execute if entity @e[tag=pe_boss]")
        return world.bossAlive ? "Test passed, count: 1" : "Test failed";
    if (line === "data get entity @e[tag=pe_boss,limit=1] Pos") {
        return world.bossAlive
            ? "Wither Skeleton has the following entity data: [310.5d, 70.0d, 4.5d]"
            : "No entity was found";
    }
    if (line.startsWith("execute as @a[scores={pe_kill=1..}]")) {
        const [x, y, z] = world.killerAt;
        return world.bossAlive
            ? ""
            : `${world.online[0]} has the following entity data: [${x}.0d, ${y}.0d, ${z}.0d]`;
    }
    if (line.includes("dx=12,dy=384,dz=12")) {
        return world.arrived
            ? `${world.online[1]} has the following entity data: [1.0d, 64.0d, 1.0d]`
            : "";
    }
    const rule = /^gamerule (doDaylightCycle|doWeatherCycle)$/.exec(line);
    if (rule) return `Gamerule ${rule[1]} is currently set to: true`;
    if (line.startsWith("attribute "))
        return "Set base value of attribute Max Health for entity Boss to 400.0";
    if (line === "execute as @a run scoreboard players get @s pe_death") {
        return Object.entries(world.deaths)
            .map(([name, count]) => `${name} has ${count} [pe_death]`)
            .join("\n");
    }
    return "";
}

const server = {
    installedAppId: "s",
    applicationId: "a",
    edition: "java",
    running: true,
    say: async (argv: readonly string[]) => answer(argv.join(" ")),
    sayAll: async (lines: readonly string[]) => {
        for (const line of lines) answer(line);
    },
    run: async (argv: readonly string[]) =>
        argv[0] === "stat"
            ? { code: 0, output: String(world.log.length) }
            : { code: 0, output: "Starting minecraft server version 1.21.4" },
    runOk: async () => "",
    readFile: async () => new ReadableStream(),
    trimWorld: null
};

vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: {
            findUnique: async () => ({
                ownerId: "owner",
                name: "Offgrid",
                catalogId: "minecraft",
                status: "running",
                config: JSON.stringify(config)
            }),
            findMany: async () => [
                { id: SERVER, ownerId: "owner", config: JSON.stringify(config) }
            ],
            updateMany: async ({
                where,
                data
            }: {
                where: { config: string };
                data: { config: string };
            }) => {
                if (where.config !== JSON.stringify(config)) return { count: 0 };
                config = JSON.parse(data.config) as Record<string, unknown>;
                return { count: 1 };
            }
        },
        minecraftAnticheatFlag: {
            groupBy: async () => world.flagged.map((player) => ({ player }))
        }
    }
}));

vi.mock("@polaris/app-host", () => ({
    host: {
        appsInstallConfig: {
            readInstallConfig: (raw: string | null) =>
                raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
        }
    }
}));

vi.mock("@polaris-app/game-servers/src/lib/minecraft/service", () => ({
    editionOf: (catalogId: string) => (catalogId.includes("bedrock") ? "bedrock" : "java"),
    openServerContainer: async () => ({ server, close: async () => undefined }),
    withServerContainer: async (
        _owner: string,
        _id: string,
        work: (s: typeof server) => Promise<unknown>
    ) => work(server)
}));

vi.mock("@polaris-app/game-servers/src/lib/minecraft/live-display-service", () => ({
    holdSidebar: (id: string) => held.push(id),
    releaseSidebar: (_owner: string, id: string) => released.push(id)
}));

vi.mock("@polaris-app/game-servers/src/lib/container-files", () => ({
    readContainerRange: async (_server: unknown, _file: string, from: number, to: number) =>
        world.log.slice(from, to),
    containerFileSize: async () => world.log.length
}));

const SERVER = "00000000-0000-4000-8000-000000000001";
const catalog = await import("@polaris-app/game-servers/src/lib/minecraft/events/catalog");
const events = await import("@polaris-app/game-servers/src/lib/minecraft/events/events-service");
const { readEventState } = await import("@polaris-app/game-servers/src/lib/minecraft/events/state");

function setUp(
    presets: catalog.EventPreset[],
    settings: Partial<catalog.EventSettings> = {},
    schedules: catalog.EventScheduleEntry[] = []
) {
    config = {
        [catalog.EVENTS_KEY]: {
            settings: { ...catalog.settingsSchema.parse({}), countdownSeconds: 0, ...settings },
            presets,
            schedules
        }
    };
}

const state = () => readEventState(config);

/** Advance the clock, letting the loop's ticks run in between. */
async function play(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
    vi.useFakeTimers({ now: Date.parse("2026-09-28T20:00:00Z") });
    world.online = ["Ana", "Ben"];
    world.scores = {};
    world.chestOpenedAfter = 3;
    world.chestChecks = 0;
    world.flagged = [];
    world.sent = [];
    world.log = "";
    world.bossAlive = true;
    world.deaths = {};
    world.arrived = false;
    world.allWater = false;
    world.killerAt = [305, 70, 2];
    world.unknownItems = [];
    world.dims = {};
    world.hurt = {};
    world.still = [];
    world.creative = [];
    world.difficulty = "Normal";
    world.daylightCycle = "true";
    world.renamedRules = false;
    world.built = false;
    world.refusedGround = [];
    world.unsureGround = 0;
    world.homes = {};
    events.forgetPlayers();
    held.length = 0;
    released.length = 0;
});

afterEach(async () => {
    for (const id of events.runningEvents()) {
        await events.cancelEvent("owner", id).catch(() => undefined);
    }
    await play(10_000);
    vi.useRealTimers();
});

describe("a mining rush, from start to podium", () => {
    it("counts, ranks, hands prizes to who is on and keeps the rest", async () => {
        const rush = { ...catalog.newPreset("mining-rush", "rush"), minutes: 3 };
        setUp([rush]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "rush",
            trigger: "manual",
            startedBy: "u1"
        });
        expect(state().run?.phase).toBe("countdown");

        await play(2_100);
        expect(state().run?.phase).toBe("running");
        expect(held).toContain(SERVER);
        expect(world.sent).toContain("scoreboard objectives setdisplay sidebar pe_score");
        expect(
            world.sent.some((line) =>
                line.startsWith("scoreboard objectives add pe_c0 minecraft.mined:")
            )
        ).toBe(true);

        world.scores = { Ana: 30, Ben: 12 };
        // Ben leaves before the end; his score is still read, by name.
        await play(60_000);
        world.online = ["Ana"];
        await play(3 * 60_000);

        const after = state();
        expect(after.run).toBeNull();
        expect(after.history[0]).toMatchObject({ outcome: "finished", presetId: "rush" });
        expect(after.history[0]?.podium).toEqual([
            { place: 1, name: "Ana", score: 30 },
            { place: 2, name: "Ben", score: 12 }
        ]);
        expect(world.sent).toContain("give Ana minecraft:diamond 5");
        expect(world.sent).toContain("xp add Ana 15 levels");
        // Ben is owed second place and taking part, kept for when he is back.
        expect(after.pending.map((one) => one.player)).toEqual(["Ben"]);
        expect(after.pending[0]?.reward.items.map((item) => item.id)).toEqual([
            "minecraft:diamond",
            "minecraft:experience_bottle"
        ]);
        // Everything the event made is taken down, and the side panel given back.
        expect(world.sent).toContain("scoreboard objectives remove pe_score");
        expect(world.sent).toContain("bossbar remove polaris:event");
        expect(released).toContain(SERVER);
    });

    it("leaves somebody the anti-cheat caught off the podium and the prizes", async () => {
        const rush = { ...catalog.newPreset("mining-rush", "rush"), minutes: 3 };
        setUp([rush]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "rush",
            trigger: "manual",
            startedBy: null
        });
        await play(2_100);
        world.scores = { Ana: 50, Ben: 14 };
        world.flagged = ["ana"];
        await play(3 * 60_000);
        const entry = state().history[0];
        expect(entry?.podium).toEqual([{ place: 1, name: "Ben", score: 14 }]);
        expect(entry?.disqualified).toEqual(["Ana"]);
        expect(world.sent.some((line) => line.startsWith("give Ana"))).toBe(false);
    });
});

describe("a supply drop", () => {
    it("lands on dry ground, is told in steps, and goes to whoever opens it", async () => {
        const drop = { ...catalog.newPreset("supply-drop", "drop"), minutes: 10 };
        setUp([drop]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "drop",
            trigger: "manual",
            startedBy: null
        });
        await play(30_000);

        expect(
            world.sent.some((line) =>
                line.startsWith("execute in minecraft:overworld run forceload add")
            )
        ).toBe(true);
        expect(
            world.sent.some((line) =>
                line.includes(
                    'setblock 300 70 0 minecraft:chest{LootTable:"minecraft:chests/buried_treasure"}'
                )
            )
        ).toBe(true);
        const after = state();
        expect(after.run).toBeNull();
        expect(after.history[0]?.podium).toEqual([{ place: 1, name: "Ana", score: 1 }]);
        expect(after.history[0]?.note).toBe("Found by Ana");
        expect(world.sent).toContain("give Ana minecraft:diamond 5");
        // Released; the chest stays, since what is inside is the finder's.
        expect(world.sent).toContain("execute in minecraft:overworld run forceload remove 300 0");
        const removals = world.sent.filter((line) =>
            line.includes("setblock 300 70 0 minecraft:air")
        );
        expect(removals.length).toBeGreaterThan(0);
        expect(removals.every((line) => line.includes("if data block 300 70 0 LootTable"))).toBe(
            true
        );
    });

    it("lets go of the chunk it was trying when it is called off before landing", async () => {
        const drop = { ...catalog.newPreset("supply-drop", "drop"), minutes: 10 };
        setUp([drop]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "drop",
            trigger: "manual",
            startedBy: null
        });
        await play(4_100);
        const added = world.sent.filter((line) => line.includes("run forceload add"));
        expect(added.length).toBeGreaterThan(0);
        expect(state().run?.target).not.toBeNull();
        expect(state().run?.place).toBeNull();
        await events.cancelEvent("owner", SERVER);
        await play(2_100);
        expect(state().run).toBeNull();
        for (const line of added)
            expect(world.sent).toContain(line.replace("forceload add", "forceload remove"));
    });
});

describe("starting one now", () => {
    it("skips what is left of the countdown and still runs its full time", async () => {
        const hunt = { ...catalog.newPreset("mob-hunt", "hunt"), minutes: 10 };
        setUp([hunt], { countdownSeconds: 60 });
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "hunt",
            trigger: "manual",
            startedBy: null
        });
        await play(4_100);
        expect(state().run?.phase).toBe("countdown");
        const pressed = Date.now();
        await events.startNow("owner", SERVER);
        await play(2_100);
        const run = state().run;
        expect(run?.phase).toBe("running");
        expect(run!.startsAt).toBeLessThanOrEqual(pressed + 2_100);
        expect(run!.endsAt - run!.startsAt).toBeGreaterThanOrEqual(10 * 60_000 - 2_100);
        expect(world.sent).toContain("scoreboard objectives setdisplay sidebar pe_score");
    });

    it("says so once it has already begun", async () => {
        setUp([{ ...catalog.newPreset("mob-hunt", "hunt"), minutes: 10 }]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "hunt",
            trigger: "manual",
            startedBy: null
        });
        await play(4_100);
        await expect(events.startNow("owner", SERVER)).rejects.toThrow("It has already started");
    });
});

describe("calling one off", () => {
    it("ends it with nobody winning and cleans up", async () => {
        const hunt = { ...catalog.newPreset("mob-hunt", "hunt"), minutes: 10 };
        setUp([hunt]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "hunt",
            trigger: "manual",
            startedBy: null
        });
        await play(4_100);
        world.scores = { Ana: 9 };
        await events.cancelEvent("owner", SERVER);
        await play(2_100);
        const after = state();
        expect(after.run).toBeNull();
        expect(after.history[0]).toMatchObject({ outcome: "cancelled", podium: [] });
        expect(world.sent.some((line) => line.startsWith("give "))).toBe(false);
        expect(world.sent).toContain("scoreboard objectives remove pe_score");
    });

    it("refuses a second event while one is on", async () => {
        setUp([{ ...catalog.newPreset("fishing", "fish"), minutes: 10 }]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "fish",
            trigger: "manual",
            startedBy: null
        });
        await expect(
            events.startEvent({
                ownerId: "owner",
                installedAppId: SERVER,
                presetId: "fish",
                trigger: "manual",
                startedBy: null
            })
        ).rejects.toThrow(/another event is on/i);
    });

    it("refuses one with nobody on the server", async () => {
        world.online = [];
        setUp([{ ...catalog.newPreset("fishing", "fish"), minutes: 10 }]);
        await expect(
            events.startEvent({
                ownerId: "owner",
                installedAppId: SERVER,
                presetId: "fish",
                trigger: "manual",
                startedBy: null
            })
        ).rejects.toThrow(/nobody is on/i);
    });
});

describe("the minute sweep", () => {
    it("draws an event once enough people are playing, not before", async () => {
        const fish = { ...catalog.newPreset("fishing", "fish"), minutes: 5 };
        setUp([fish], {
            minActive: 2,
            random: {
                enabled: true,
                days: [],
                from: "00:00",
                to: "23:59",
                minGap: 15,
                maxGap: 15,
                pool: [{ presetId: "fish", weight: 1 }]
            }
        });
        // Armed on the first pass, a gap away.
        await events.sweepEvents();
        expect(state().nextRandomAt).toBe(Date.now() + 15 * 60_000);
        await play(15 * 60_000);
        // Due, and the players have been seen moving since the last look.
        const started = await events.sweepEvents();
        expect(started.started).toBe(1);
        expect(state().run?.trigger).toBe("random");
    });

    it("skips a scheduled event when too few are playing, and says so", async () => {
        const fish = { ...catalog.newPreset("fishing", "fish"), minutes: 5 };
        world.online = ["Ana"];
        setUp([fish], { minActive: 2 }, [
            { id: "at8", presetId: "fish", enabled: true, days: [], at: "20:00" }
        ]);
        await events.sweepEvents();
        const entry = state().history[0];
        expect(entry).toMatchObject({ outcome: "skipped", trigger: "scheduled" });
        // One player on can be at most one playing - the earlier cases may
        // already have seen Ana move, which is remembered per server.
        expect(entry?.note).toMatch(/^Skipped: [01] active of the 2 it waits for$/);
        expect(state().run).toBeNull();
    });

    it("hands a waiting prize to somebody who is back", async () => {
        setUp([catalog.newPreset("fishing", "fish")], {
            random: { ...catalog.settingsSchema.parse({}).random }
        });
        config[catalog.EVENT_STATE_KEY] = {
            pending: [
                {
                    id: "p1",
                    player: "Ana",
                    reward: { items: [{ id: "minecraft:emerald", count: 2 }], levels: 0 },
                    event: "Fishing contest",
                    createdAt: Date.now()
                }
            ]
        };
        await events.sweepEvents();
        expect(world.sent).toContain("give Ana minecraft:emerald 2");
        expect(state().pending).toEqual([]);
    });

    it("keeps only what did not arrive, so nothing is given twice", async () => {
        setUp([catalog.newPreset("fishing", "fish")], {
            random: { ...catalog.settingsSchema.parse({}).random }
        });
        world.unknownItems = ["minecraft:diamnd"];
        const reward = {
            items: [
                { id: "minecraft:emerald", count: 2 },
                { id: "minecraft:diamnd", count: 1 }
            ],
            levels: 5
        };
        config[catalog.EVENT_STATE_KEY] = {
            pending: [
                { id: "p1", player: "Ana", reward, event: "Fishing contest", createdAt: Date.now() }
            ]
        };
        await events.sweepEvents();
        await events.sweepEvents();
        expect(world.sent.filter((line) => line === "give Ana minecraft:emerald 2")).toHaveLength(
            1
        );
        expect(world.sent.filter((line) => line === "xp add Ana 5 levels")).toHaveLength(1);
        expect(state().pending.map((one) => one.reward)).toEqual([
            { items: [{ id: "minecraft:diamnd", count: 1 }], levels: 0 }
        ]);
    });
});

describe("trivia", () => {
    it("reads the chat for the first right answer and scores the rounds", async () => {
        const quiz = {
            ...catalog.newPreset("trivia", "quiz"),
            options: {
                rounds: 3,
                seconds: 15,
                mode: "questions" as const,
                questions: [{ question: "Which green mob explodes?", answers: ["creeper"] }]
            }
        };
        setUp([quiz]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "quiz",
            trigger: "manual",
            startedBy: null
        });
        await play(4_100);
        expect(
            world.sent.some(
                (line) =>
                    line.startsWith("tellraw @a") && line.includes("Which green mob explodes?")
            )
        ).toBe(true);
        // On screen too: the title as it is asked, and above the hotbar with the time left.
        expect(world.sent.some((line) => line.startsWith("title @a title") && line.includes("Question 1/3"))).toBe(true);
        expect(
            world.sent.some((line) => line.startsWith("title @a subtitle") && line.includes("Which green mob explodes?"))
        ).toBe(true);
        expect(
            world.sent.some(
                (line) => line.startsWith("title @a actionbar") && line.includes("Which green mob explodes?") && line.includes(" s)")
            )
        ).toBe(true);
        world.log +=
            "[20:00:05] [Server thread/INFO]: <Ana> zombie\n[20:00:06] [Server thread/INFO]: <Ben> Creeper!\n";
        await play(2_100);
        expect(state().run?.points).toEqual({ Ben: 1 });
        expect(world.sent).toContain("scoreboard players set Ben pe_score 1");
        expect(world.sent.some((line) => line.startsWith("title @a title") && line.includes("Ben got it"))).toBe(true);
        // The other two rounds nobody answers, and the game ends on its own.
        await play(2 * (15_000 + 6_000) + 10_000);
        const after = state();
        expect(after.run).toBeNull();
        expect(after.history[0]?.note).toBe("All rounds played");
        expect(after.history[0]?.podium).toEqual([{ place: 1, name: "Ben", score: 1 }]);
    });
});

describe("a world boss", () => {
    it("appears with its health and name, counts damage near it, and falls", async () => {
        const boss = { ...catalog.newPreset("world-boss", "boss"), minutes: 10 };
        setUp([boss]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "boss",
            trigger: "manual",
            startedBy: null
        });
        await play(8_100);
        expect(
            world.sent.some(
                (line) =>
                    line.includes("summon minecraft:wither_skeleton") && line.includes("pe_boss")
            )
        ).toBe(true);
        expect(world.sent).toContain(
            "attribute @e[tag=pe_boss,limit=1] minecraft:max_health base set 400"
        );
        // 1.21.4: the name is still written as JSON in a string.
        expect(
            world.sent.some((line) =>
                line.startsWith("data merge entity @e[tag=pe_boss,limit=1] {CustomName:'")
            )
        ).toBe(true);
        expect(
            world.sent.some((line) =>
                line.startsWith(
                    "execute store result bossbar polaris:event value run data get entity @e[tag=pe_boss"
                )
            )
        ).toBe(true);

        world.scores = { Ana: 180, Ben: 60 };
        world.bossAlive = false;
        await play(2_100);
        const after = state();
        expect(after.run).toBeNull();
        expect(after.history[0]?.note).toBe("Defeated; the final blow by Ana");
        expect(after.history[0]?.podium.map((one) => one.name)).toEqual(["Ana", "Ben"]);
        expect(world.sent).toContain("execute as @e[tag=pe_boss] at @s run tp @s ~ -1000 ~");
    });

    it("is not taken as felled when it is out of reach and somebody far off kills its kind", async () => {
        const boss = { ...catalog.newPreset("world-boss", "boss"), minutes: 10 };
        setUp([boss]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "boss",
            trigger: "manual",
            startedBy: null
        });
        await play(10_100);
        expect(world.sent).toContain(
            "execute if entity @e[tag=pe_boss] run scoreboard players set @a pe_kill 0"
        );
        world.bossAlive = false;
        world.killerAt = [-2000, 40, 900];
        await play(6_100);
        expect(state().run).not.toBeNull();
        expect(state().run?.decidedBy).toBeNull();
        expect(world.sent.some((line) => line.startsWith("give "))).toBe(false);
    });

    it("gives nobody a prize when it got away", async () => {
        const boss = { ...catalog.newPreset("world-boss", "boss"), minutes: 3 };
        setUp([boss]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "boss",
            trigger: "manual",
            startedBy: null
        });
        world.scores = { Ana: 40 };
        await play(3 * 60_000 + 4_000);
        const after = state();
        expect(after.history[0]?.podium).toEqual([]);
        expect(world.sent.some((line) => line.startsWith("give "))).toBe(false);
    });
});

describe("a blood moon", () => {
    it("brings night and waves, and only the survivors stand on the podium", async () => {
        const moon = { ...catalog.newPreset("blood-moon", "moon"), minutes: 3 };
        setUp([moon]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "moon",
            trigger: "manual",
            startedBy: null
        });
        await play(4_100);
        expect(world.sent).toContain("time set 13000");
        // The night is held still, so it neither runs out nor is slept through.
        expect(world.sent).toContain("gamerule doDaylightCycle false");
        expect(world.sent).toContain("gamerule doWeatherCycle false");
        expect(
            world.sent.filter((line) => line.includes("run summon minecraft:")).length
        ).toBeGreaterThan(0);
        world.scores = { Ana: 7, Ben: 12 };
        world.deaths = { Ben: 1 };
        await play(3 * 60_000);
        const after = state();
        expect(after.history[0]?.podium).toEqual([{ place: 1, name: "Ana", score: 7 }]);
        expect(world.sent).toContain("time set 23500");
        // And the server gets back what it had.
        expect(world.sent).toContain("gamerule doDaylightCycle true");
        expect(world.sent).toContain("gamerule doWeatherCycle true");
        expect(world.sent).toContain("kill @e[tag=pe_mob]");
    });
});

describe("the others", () => {
    it("a race is won by whoever reaches the finish first", async () => {
        const race = {
            ...catalog.newPreset("explorer", "race"),
            minutes: 10,
            options: { mode: "race" as const, distance: 500, place: { mode: "players" as const } }
        };
        setUp([race]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "race",
            trigger: "manual",
            startedBy: null
        });
        await play(4_100);
        expect(state().run?.place).not.toBeNull();
        world.arrived = true;
        await play(2_100);
        const after = state();
        expect(after.history[0]?.note).toBe("Ben reached the finish first");
        expect(after.history[0]?.podium).toEqual([{ place: 1, name: "Ben", score: 1 }]);
        // No side panel for a race: there is nothing to rank until somebody arrives.
        expect(held).not.toContain(SERVER);
    });

    it("the hill counts the time spent inside the circle", async () => {
        const hill = { ...catalog.newPreset("king-of-the-hill", "hill"), minutes: 3 };
        setUp([hill]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "hill",
            trigger: "manual",
            startedBy: null
        });
        await play(8_100);
        expect(
            world.sent.some((line) =>
                line.includes(
                    "positioned 300.5 70 0.5 as @a[distance=..6,gamemode=!spectator] run scoreboard players add @s pe_score 2"
                )
            )
        ).toBe(true);
        world.scores = { Ana: 95 };
        await play(3 * 60_000);
        expect(state().history[0]?.podium).toEqual([{ place: 1, name: "Ana", score: 95 }]);
    });

    it("draws the circle's edge and a column of light, and tells each player the way", async () => {
        world.online = ["Ana"];
        const hill = { ...catalog.newPreset("king-of-the-hill", "hill"), minutes: 3 };
        setUp([hill]);
        await events.startEvent({ ownerId: "owner", installedAppId: SERVER, presetId: "hill", trigger: "manual", startedBy: null });
        await play(8_100);
        expect(world.sent.filter((line) => line.includes("particle minecraft:flame")).length).toBeGreaterThanOrEqual(24);
        expect(world.sent.some((line) => line.includes("particle minecraft:end_rod"))).toBe(true);
        // Ana is a little way west of the circle, which is at X 300.
        expect(world.sent.some((line) => line.startsWith("title Ana actionbar") && /"\d+ m "/.test(line) && line.includes('"east"'))).toBe(true);
    });

    it("gives up a place on somebody's build and says it could not find one", async () => {
        world.built = true;
        const hill = { ...catalog.newPreset("king-of-the-hill", "hill"), minutes: 3 };
        setUp([hill]);
        await events.startEvent({ ownerId: "owner", installedAppId: SERVER, presetId: "hill", trigger: "manual", startedBy: null });
        await play(60_000);
        expect(world.sent.some((line) => line.includes("run scoreboard players add @s pe_score"))).toBe(false);
        expect(state().history[0]?.outcome).toBe("failed");
    });

    it("judges the ground by older names on a server that refuses the newest", async () => {
        world.built = true;
        world.refusedGround = ["leaf_litter"];
        const hill = { ...catalog.newPreset("king-of-the-hill", "hill"), minutes: 3 };
        setUp([hill]);
        await events.startEvent({ ownerId: "owner", installedAppId: SERVER, presetId: "hill", trigger: "manual", startedBy: null });
        await play(60_000);
        expect(world.sent.some((line) => line.includes("run scoreboard players add @s pe_score"))).toBe(false);
        expect(state().history[0]?.outcome).toBe("failed");
    });

    it("keeps judging the ground after a column that could not be read", async () => {
        world.built = true;
        world.unsureGround = 2;
        const hill = { ...catalog.newPreset("king-of-the-hill", "hill"), minutes: 3 };
        setUp([hill]);
        await events.startEvent({ ownerId: "owner", installedAppId: SERVER, presetId: "hill", trigger: "manual", startedBy: null });
        await play(60_000);
        expect(world.sent.some((line) => line.includes("run scoreboard players add @s pe_score"))).toBe(false);
        expect(state().history[0]?.outcome).toBe("failed");
    });

    it("takes the fixed point an operator chose as it is", async () => {
        world.built = true;
        const hill = {
            ...catalog.newPreset("king-of-the-hill", "hill"),
            minutes: 3,
            options: { place: { mode: "fixed" as const, x: 300, z: 0 }, radius: 6 }
        };
        setUp([hill]);
        await events.startEvent({ ownerId: "owner", installedAppId: SERVER, presetId: "hill", trigger: "manual", startedBy: null });
        await play(8_100);
        expect(world.sent.some((line) => line.includes("run scoreboard players add @s pe_score 2"))).toBe(true);
    });

    it("looks past a player's bed for somewhere to put it", async () => {
        world.homes = { Ana: [0, 0], Ben: [0, 0] };
        const hill = { ...catalog.newPreset("king-of-the-hill", "hill"), minutes: 3 };
        setUp([hill]);
        await events.startEvent({ ownerId: "owner", installedAppId: SERVER, presetId: "hill", trigger: "manual", startedBy: null });
        await play(8_100);
        const loaded = world.sent
            .filter((line) => /run forceload add -?\d+ -?\d+$/.test(line))
            .map((line) => line.split(" ").slice(-2).map(Number) as [number, number]);
        expect(loaded.length).toBeGreaterThan(0);
        for (const [x, z] of loaded) expect(Math.hypot(x, z)).toBeGreaterThanOrEqual(48);
    });

    it("a happy hour gives its effects for exactly as long as it lasts, and no prizes", async () => {
        const happy = { ...catalog.newPreset("happy-hour", "happy"), minutes: 20 };
        setUp([happy]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "happy",
            trigger: "manual",
            startedBy: null
        });
        await play(2_100);
        expect(
            world.sent.some((line) =>
                /^effect give @a minecraft:haste (119\d|1200) 1 true$/.test(line)
            )
        ).toBe(true);
        expect(world.sent.some((line) => line.startsWith("effect give @a minecraft:luck"))).toBe(
            true
        );
        await play(20 * 60_000);
        const after = state();
        expect(after.history[0]).toMatchObject({ outcome: "finished", podium: [] });
        expect(world.sent.some((line) => line.startsWith("give "))).toBe(false);
        expect(world.sent).toContain("effect clear @a minecraft:haste");
    });

    it("a happy hour called off takes its effects back", async () => {
        const happy = { ...catalog.newPreset("happy-hour", "happy"), minutes: 60 };
        setUp([happy]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "happy",
            trigger: "manual",
            startedBy: null
        });
        await play(2_100);
        await events.cancelEvent("owner", SERVER);
        await play(2_100);
        expect(state().history[0]).toMatchObject({ outcome: "cancelled" });
        expect(world.sent).toContain("effect clear @a minecraft:haste");
        expect(world.sent).toContain("effect clear @a minecraft:luck");
    });
});

describe("when things go wrong", () => {
    it("gives up on a place after a few tries, and tells the players", async () => {
        world.allWater = true;
        const drop = { ...catalog.newPreset("supply-drop", "drop"), minutes: 10 };
        setUp([drop]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "drop",
            trigger: "manual",
            startedBy: null
        });
        await play(40_000);
        const after = state();
        expect(after.run).toBeNull();
        expect(after.history[0]).toMatchObject({
            outcome: "failed",
            note: "No dry ground was found for it near the players"
        });
        expect(
            world.sent.some((line) => line.startsWith("tellraw @a") && line.includes("called off"))
        ).toBe(true);
        expect(world.sent.some((line) => line.includes("minecraft:chest"))).toBe(false);
    });

    it("picks an event back up after a restart, the side panel still its own", async () => {
        const rush = { ...catalog.newPreset("mining-rush", "rush"), minutes: 10 };
        setUp([rush]);
        const now = Date.now();
        config[catalog.EVENT_STATE_KEY] = {
            run: {
                id: "resumed",
                trigger: "scheduled",
                startedBy: null,
                preset: rush,
                phase: "running",
                createdAt: now - 60_000,
                startsAt: now - 60_000,
                endsAt: now + 60_000,
                participants: ["Ana", "Ben"]
            }
        };
        await events.sweepEvents();
        expect(events.runningEvents()).toContain(SERVER);
        expect(held).toContain(SERVER);
        world.scores = { Ana: 13 };
        await play(62_000);
        expect(state().history[0]).toMatchObject({ id: "resumed", outcome: "finished" });
        expect(state().history[0]?.podium).toEqual([{ place: 1, name: "Ana", score: 13 }]);
    });

    it("never plays a run again whose end had already begun", async () => {
        const rush = { ...catalog.newPreset("mining-rush", "rush"), minutes: 10 };
        setUp([rush]);
        const now = Date.now();
        config[catalog.EVENT_STATE_KEY] = {
            run: {
                id: "half-ended",
                trigger: "manual",
                startedBy: null,
                preset: rush,
                phase: "running",
                createdAt: now - 11 * 60_000,
                startsAt: now - 10 * 60_000,
                endsAt: now - 1_000,
                participants: ["Ana"],
                finishing: true
            }
        };
        world.scores = { Ana: 9 };
        await events.sweepEvents();
        await play(10_000);
        expect(events.runningEvents()).not.toContain(SERVER);
        expect(state().run).toBeNull();
        expect(state().history[0]).toMatchObject({ id: "half-ended", outcome: "failed" });
        expect(world.sent.some((line) => line.startsWith("give "))).toBe(false);
        expect(world.sent).toContain("scoreboard objectives remove pe_score");
    });

    it("is not picked up again by the sweep while its end is being written", async () => {
        const rush = { ...catalog.newPreset("mining-rush", "rush"), minutes: 3 };
        setUp([rush]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "rush",
            trigger: "manual",
            startedBy: null
        });
        await play(2_100);
        world.scores = { Ana: 14 };
        const say = server.say;
        let swept = false;
        server.say = async (argv) => {
            if (argv.join(" ").startsWith("give ") && !swept) {
                swept = true;
                expect(state().run?.finishing).toBe(true);
                await events.sweepEvents();
                await events.cancelEvent("owner", SERVER).catch(() => undefined);
            }
            return say(argv);
        };
        try {
            await play(3 * 60_000);
        } finally {
            server.say = say;
        }
        expect(swept).toBe(true);
        expect(world.sent.filter((line) => line === "give Ana minecraft:diamond 5")).toHaveLength(
            1
        );
        const id = state().history[0]?.id;
        expect(state().history.filter((one) => one.id === id)).toHaveLength(1);
        expect(state().run).toBeNull();
        expect(events.runningEvents()).not.toContain(SERVER);
    });
});

describe("the least to be ranked", () => {
    it("keeps a token score off the podium and out of the prizes", async () => {
        const hunt = { ...catalog.newPreset("mob-hunt", "hunt"), minutes: 3 };
        expect(catalog.minScoreOf(hunt)).toBe(5);
        setUp([hunt]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "hunt",
            trigger: "manual",
            startedBy: null
        });
        await play(2_100);
        world.scores = { Ana: 7, Ben: 1 };
        await play(3 * 60_000);
        expect(state().history[0]?.podium).toEqual([{ place: 1, name: "Ana", score: 7 }]);
        expect(world.sent.some((line) => line.startsWith("give Ben"))).toBe(false);
    });

    it("means nobody wins when nobody reaches it", async () => {
        const hunt = { ...catalog.newPreset("mob-hunt", "hunt"), minutes: 3 };
        setUp([hunt]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "hunt",
            trigger: "manual",
            startedBy: null
        });
        await play(2_100);
        world.scores = { Ana: 2, Ben: 1 };
        await play(3 * 60_000);
        expect(state().history[0]?.podium).toEqual([]);
        expect(world.sent.some((line) => line.startsWith("give "))).toBe(false);
    });
});

describe("where the players are, and what they are doing", () => {
    const draw = (presetId: string) => ({
        minActive: 1,
        random: {
            enabled: true,
            days: [],
            from: "00:00",
            to: "23:59",
            minGap: 15,
            maxGap: 15,
            pool: [{ presetId, weight: 1 }]
        }
    });

    it("waits to draw an event while somebody is in a fight", async () => {
        setUp([{ ...catalog.newPreset("fishing", "fish"), minutes: 5 }], draw("fish"));
        await events.sweepEvents();
        await play(15 * 60_000);
        world.hurt = { Ana: 40 };
        await events.sweepEvents();
        world.hurt = { Ana: 55 };
        const held = await events.sweepEvents();
        expect(held.started).toBe(0);
        expect(state().waiting).toBe("Waiting: Ana is in a fight or in the End");
        // A minute and a half after the last blow, it goes ahead.
        await play(100_000);
        const started = await events.sweepEvents();
        expect(started.started).toBe(1);
    });

    it("counts only the Overworld for an event that happens there", async () => {
        world.dims = { Ana: "minecraft:the_nether", Ben: "minecraft:the_nether" };
        setUp([{ ...catalog.newPreset("supply-drop", "drop"), minutes: 5 }], draw("drop"));
        await events.sweepEvents();
        await play(15 * 60_000);
        await events.sweepEvents();
        expect(state().run).toBeNull();
        expect(state().waiting).toBe("Waiting for 2 active players in the Overworld (0 now)");
    });

    it("does not hold a mining rush back for players in the Nether", async () => {
        world.dims = { Ana: "minecraft:the_nether", Ben: "minecraft:the_nether" };
        setUp([{ ...catalog.newPreset("mining-rush", "rush"), minutes: 5 }], draw("rush"));
        await events.sweepEvents();
        await play(15 * 60_000);
        const started = await events.sweepEvents();
        expect(started.started).toBe(1);
    });

    it("does not count a night sat out in the Nether as surviving it", async () => {
        const moon = { ...catalog.newPreset("blood-moon", "moon"), minutes: 3, minScore: 1 };
        setUp([moon]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "moon",
            trigger: "manual",
            startedBy: null
        });
        await play(4_100);
        world.scores = { Ana: 4, Ben: 9 };
        world.dims = { Ben: "minecraft:the_nether" };
        await play(3 * 60_000);
        expect(state().history[0]?.podium).toEqual([{ place: 1, name: "Ana", score: 4 }]);
    });
});

describe("what the audit found", () => {
    it("refuses an event of hostile mobs on Peaceful, and says how to fix it", async () => {
        world.difficulty = "Peaceful";
        setUp([{ ...catalog.newPreset("blood-moon", "moon"), minutes: 5 }]);
        await expect(
            events.startEvent({
                ownerId: "owner",
                installedAppId: SERVER,
                presetId: "moon",
                trigger: "manual",
                startedBy: null
            })
        ).rejects.toThrow(/Peaceful.*Easy or harder under Rules/);
    });

    it("runs one that needs no hostile mobs on Peaceful", async () => {
        world.difficulty = "Peaceful";
        setUp([{ ...catalog.newPreset("fishing", "fish"), minutes: 5 }]);
        await expect(
            events.startEvent({
                ownerId: "owner",
                installedAppId: SERVER,
                presetId: "fish",
                trigger: "manual",
                startedBy: null
            })
        ).resolves.toBeDefined();
    });

    it("leaves somebody who played it in creative off the podium", async () => {
        const rush = { ...catalog.newPreset("mining-rush", "rush"), minutes: 3 };
        setUp([rush]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "rush",
            trigger: "manual",
            startedBy: null
        });
        await play(2_100);
        world.creative = ["Ana"];
        await play(20_000);
        world.creative = [];
        world.scores = { Ana: 900, Ben: 15 };
        await play(3 * 60_000);
        const entry = state().history[0];
        expect(entry?.podium).toEqual([{ place: 1, name: "Ben", score: 15 }]);
        expect(entry?.disqualified).toEqual(["Ana"]);
    });

    it("leaves somebody AFK the whole time off a fishing podium", async () => {
        world.still = ["Ana"];
        const fish = { ...catalog.newPreset("fishing", "fish"), minutes: 3 };
        setUp([fish]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "fish",
            trigger: "manual",
            startedBy: null
        });
        await play(2_100);
        world.scores = { Ana: 40, Ben: 6 };
        await play(3 * 60_000);
        const entry = state().history[0];
        expect(entry?.podium).toEqual([{ place: 1, name: "Ben", score: 6 }]);
        expect(entry?.disqualified).toEqual(["Ana"]);
    });

    it("leaves somebody AFK at a mob farm off a blood moon podium, however much they are hit", async () => {
        world.still = ["Ana"];
        const moon = { ...catalog.newPreset("blood-moon", "moon"), minutes: 3 };
        setUp([moon]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "moon",
            trigger: "manual",
            startedBy: null
        });
        await play(2_100);
        for (let tick = 1; tick <= 8; tick += 1) {
            world.hurt = { Ana: tick * 4 };
            await play(15_000);
        }
        world.scores = { Ana: 30, Ben: 3 };
        await play(3 * 60_000);
        const entry = state().history[0];
        expect(entry?.podium).toEqual([{ place: 1, name: "Ben", score: 3 }]);
        expect(entry?.disqualified).toEqual(["Ana"]);
    });

    it("holds the night on a version that renamed the game rules", async () => {
        world.renamedRules = true;
        world.daylightCycle = "false";
        const moon = { ...catalog.newPreset("blood-moon", "moon"), minutes: 3 };
        setUp([moon]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "moon",
            trigger: "manual",
            startedBy: null
        });
        await play(4_100);
        expect(world.sent).toContain("gamerule advance_time false");
        expect(world.sent).toContain("gamerule advance_weather false");
        expect(world.sent).not.toContain("gamerule doDaylightCycle false");
        await play(3 * 60_000);
        expect(world.sent).toContain("time set 6000");
        expect(world.sent.filter((line) => line.startsWith("gamerule advance_time")).at(-1)).toBe(
            "gamerule advance_time false"
        );
    });

    it("gives a server whose clock stands still its own time back after a blood moon", async () => {
        world.daylightCycle = "false";
        const moon = { ...catalog.newPreset("blood-moon", "moon"), minutes: 3 };
        setUp([moon]);
        await events.startEvent({
            ownerId: "owner",
            installedAppId: SERVER,
            presetId: "moon",
            trigger: "manual",
            startedBy: null
        });
        await play(3 * 60_000 + 4_000);
        expect(world.sent).toContain("time set 6000");
        expect(world.sent).not.toContain("time set 23500");
        expect(world.sent).toContain("gamerule doDaylightCycle false");
    });
});
