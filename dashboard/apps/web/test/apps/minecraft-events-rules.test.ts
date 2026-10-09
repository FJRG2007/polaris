/**
 * The rules around a Minecraft event, apart from playing it: what a stored
 * setting reads as, when an automatic one is due, who counts as playing, who
 * stands on the podium and what they are owed.
 */

import { describe, expect, it } from "vitest";
import * as plan from "@polaris-app/game-servers/src/lib/minecraft/events/plan";
import * as catalog from "@polaris-app/game-servers/src/lib/minecraft/events/catalog";
import * as stored from "@polaris-app/game-servers/src/lib/minecraft/events/state";
import { gameMessageIn } from "@polaris-app/game-servers/src/lib/game-message";

/** What a carried sentence says to an English reader. */
const english = (text: string | null | undefined) => gameMessageIn("en-US", text ?? "");

const settings = (patch: Partial<catalog.EventSettings> = {}): catalog.EventSettings => ({
    ...catalog.settingsSchema.parse({}),
    ...patch
});

/** 2026-09-28 was a Monday. */
const at = (time: string, day = "2026-09-28") => Date.parse(`${day}T${time}:00Z`);

/** Always the same number, so a draw is decided by the test. */
const always = (value: number) => () => value;

describe("a kind added in an update", () => {
    const saved = (defaults: number | undefined, pool: { presetId: string; weight: number }[]) => ({
        [catalog.EVENTS_KEY]: {
            presets: [catalog.newPreset("fishing", "fish"), catalog.newPreset("trivia", "quiz")],
            settings: {
                ...(defaults === undefined ? {} : { defaults }),
                language: "es",
                random: { enabled: true, pool }
            }
        }
    });

    it("is given once to a server whose events were saved before it, named in its players' language", () => {
        const read = catalog.readEventsConfig(saved(2, []));
        const added = read.presets.filter((one) => one.id.startsWith("default-"));
        expect(added.map((one) => one.kind)).toEqual([
            "tnt-run",
            "boat-race",
            "dropper",
            "capture-the-flag",
            "hide-and-seek",
            "hot-potato",
            "sky-wars",
            "village-defense",
            "bingo",
            "boss-fishing",
            "nether-maze",
            "acid-rain"
        ]);
        expect(added.find((one) => one.kind === "hot-potato")?.name).toBe("Patata bomba");
        expect(added.find((one) => one.kind === "nether-maze")?.name).toBe("Laberintos mortales");
        expect(added.find((one) => one.kind === "acid-rain")?.name).toBe("Lluvia ácida");
        expect(read.settings.defaults).toBe(catalog.DEFAULTS_VERSION);
        // Saved since: one deleted after that stays deleted.
        expect(
            catalog
                .readEventsConfig(saved(catalog.DEFAULTS_VERSION, []))
                .presets.map((one) => one.id)
        ).toEqual(["fish", "quiz"]);
    });

    it("gives a server saved at an earlier version only the kinds added since", () => {
        const added = (version: number) =>
            catalog
                .readEventsConfig(saved(version, []))
                .presets.filter((one) => one.id.startsWith("default-"))
                .map((one) => one.kind);
        expect(added(3)).toEqual(["nether-maze", "acid-rain"]);
        expect(added(4)).toEqual(["acid-rain"]);
    });

    it("joins the draw only where the draw took every event the server had", () => {
        const all = catalog.readEventsConfig(
            saved(2, [
                { presetId: "fish", weight: 2 },
                { presetId: "quiz", weight: 2 }
            ])
        );
        expect(all.settings.random.pool).toHaveLength(14);
        expect(all.settings.random.pool.every((entry) => entry.weight === 2)).toBe(true);
        const some = catalog.readEventsConfig(saved(2, [{ presetId: "fish", weight: 1 }]));
        expect(some.settings.random.pool).toEqual([{ presetId: "fish", weight: 1 }]);
    });

    it("is given only while there is room, so the events still save", () => {
        const presets = Array.from({ length: 35 }, (_, n) =>
            catalog.newPreset("fishing", `fish-${n}`)
        );
        const read = catalog.readEventsConfig({
            [catalog.EVENTS_KEY]: {
                presets,
                settings: {
                    defaults: 2,
                    random: {
                        enabled: true,
                        pool: presets.map((one) => ({ presetId: one.id, weight: 1 }))
                    }
                }
            }
        });
        expect(read.presets).toHaveLength(40);
        expect(read.presets.slice(35).map((one) => one.kind)).toEqual([
            "tnt-run",
            "boat-race",
            "dropper",
            "capture-the-flag",
            "hide-and-seek"
        ]);
        expect(read.settings.random.pool).toHaveLength(40);
        expect(catalog.eventsConfigSchema.safeParse(read).success).toBe(true);
    });
});

describe("an event a server cannot play", () => {
    const of = (kind: catalog.EventKind) => catalog.newPreset(kind, "k");

    it("is named only when the server's version is known and too old, with why", () => {
        expect(catalog.incompatibility(of("sky-wars"), "1.16.5")).toEqual({
            why: "items",
            needs: "1.17"
        });
        expect(catalog.incompatibility(of("team-duel"), "1.15.2")).toEqual({
            why: "arena",
            needs: "1.16"
        });
        // Compatible, or not known: nothing to say.
        expect(catalog.incompatibility(of("sky-wars"), "1.21.4")).toBeNull();
        expect(catalog.incompatibility(of("sky-wars"), null)).toBeNull();
        expect(catalog.incompatibility(of("parkour"), "1.13.2")).toBeNull();
    });

    it("follows the options that name something only newer worlds have", () => {
        const drop = of("supply-drop") as catalog.EventPreset<"supply-drop">;
        const bastion = { ...drop, options: { ...drop.options, loot: "bastion" as const } };
        expect(catalog.incompatibility(bastion, "1.15.2")).toEqual({ why: "loot", needs: "1.16" });
        expect(catalog.incompatibility(bastion, "1.16")).toBeNull();
        const city = { ...drop, options: { ...drop.options, loot: "ancient-city" as const } };
        expect(catalog.incompatibility(city, "1.18.2")).toEqual({ why: "loot", needs: "1.19" });
        const shower = of("meteor-shower") as catalog.EventPreset<"meteor-shower">;
        expect(
            catalog.incompatibility(
                { ...shower, options: { ...shower.options, ores: "debris" as const } },
                "1.15.2"
            )
        ).toEqual({ why: "ores", needs: "1.16" });
        const gather = of("gathering") as catalog.EventPreset<"gathering">;
        expect(
            catalog.incompatibility(
                { ...gather, options: { ...gather.options, material: "bamboo" as const } },
                "1.13.2"
            )
        ).toEqual({ why: "material", needs: "1.14" });
    });
});

describe("where each event is played", () => {
    const where = (kind: catalog.EventKind) => catalog.heldWhere(catalog.newPreset(kind, "k"));

    it("puts every kind in one group, and the maps built in the sky together", () => {
        for (const kind of catalog.EVENT_KINDS) expect(catalog.HELD_WHERE).toContain(where(kind));
        const sky = catalog.EVENT_KINDS.filter((kind) => where(kind) === "sky");
        expect(sky).toEqual(
            expect.arrayContaining([
                "parkour",
                "spleef",
                "team-duel",
                "build-battle",
                "tnt-run",
                "boat-race",
                "dropper",
                "capture-the-flag",
                "hide-and-seek",
                "hot-potato",
                "sky-wars"
            ])
        );
        for (const kind of ["supply-drop", "treasure-hunt", "waves", "village-defense"] as const)
            expect(where(kind)).toBe("world");
        for (const kind of ["trivia", "fishing", "bingo", "boss-fishing", "mining-rush"] as const)
            expect(where(kind)).toBe("anywhere");
    });

    it("follows the options that move an event into the sky or onto the ground", () => {
        const boss = catalog.newPreset("world-boss", "b") as catalog.EventPreset<"world-boss">;
        expect(catalog.heldWhere(boss)).toBe("sky");
        expect(catalog.heldWhere({ ...boss, options: { ...boss.options, arena: false } })).toBe(
            "world"
        );
        const ring = catalog.newPreset(
            "king-of-the-hill",
            "r"
        ) as catalog.EventPreset<"king-of-the-hill">;
        expect(catalog.heldWhere(ring)).toBe("sky");
        expect(catalog.heldWhere({ ...ring, options: { ...ring.options, fistsOnly: false } })).toBe(
            "world"
        );
        const explorer = catalog.newPreset("explorer", "e") as catalog.EventPreset<"explorer">;
        expect(catalog.heldWhere(explorer)).toBe("anywhere");
        expect(
            catalog.heldWhere({ ...explorer, options: { ...explorer.options, mode: "race" } })
        ).toBe("world");
    });
});

describe("a parkour saved before it had shapes", () => {
    it("is read as the longer course when it was on the old twenty jumps, and keeps any other length", () => {
        const old = (jumps: number) => ({
            place: { mode: "players" },
            jumps,
            difficulty: "medium",
            height: 30
        });
        expect(catalog.optionsSchemas.parkour.parse(old(20))).toMatchObject({
            jumps: 30,
            shapes: ["rows", "tower"]
        });
        expect(catalog.optionsSchemas.parkour.parse(old(25)).jumps).toBe(25);
        // Saved since, with its shapes: twenty is a choice.
        expect(
            catalog.optionsSchemas.parkour.parse({ ...old(20), shapes: ["tower"] })
        ).toMatchObject({
            jumps: 20,
            shapes: ["tower"]
        });
        expect(catalog.optionsSchemas.parkour.safeParse({ ...old(30), shapes: [] }).success).toBe(
            false
        );
        expect(catalog.optionsSchemas.parkour.safeParse(old(61)).success).toBe(false);
    });

    it("keeps a race already running on the twenty jumps its course was built with", () => {
        const preset = catalog.newPreset("parkour", "race");
        const { shapes: _shapes, ...options } = preset.options as Record<string, unknown>;
        const run = stored.runSchema.parse({
            id: "run-1",
            trigger: "manual",
            startedBy: null,
            preset: { ...preset, options: { ...options, jumps: 20 } },
            phase: "running",
            createdAt: 0,
            startsAt: 0,
            endsAt: 1
        });
        expect(run.preset.options).toMatchObject({ jumps: 20, shapes: ["rows", "tower"] });
    });
});

describe("the stored settings", () => {
    it("give a server that never opened the screen one of every event", () => {
        const read = catalog.readEventsConfig({}, "Europe/Madrid");
        expect(read.presets.map((one) => one.kind)).toEqual([...catalog.EVENT_KINDS]);
        expect(read.settings.timezone).toBe("Europe/Madrid");
        expect(read.settings.random.enabled).toBe(false);
        expect(catalog.eventsConfigSchema.safeParse(read).success).toBe(true);
    });

    it("leave out an event that no longer reads, and what pointed at it", () => {
        const good = catalog.newPreset("fishing", "fish");
        const read = catalog.readEventsConfig({
            [catalog.EVENTS_KEY]: {
                presets: [good, { id: "old", kind: "gone-kind", name: "Old" }],
                schedules: [
                    { id: "a", presetId: "fish", at: "20:00" },
                    { id: "b", presetId: "old", at: "21:00" }
                ],
                settings: { random: { enabled: true, pool: [{ presetId: "old", weight: 1 }] } }
            }
        });
        expect(
            read.presets.filter((one) => !one.id.startsWith("default-")).map((one) => one.id)
        ).toEqual(["fish"]);
        expect(read.schedules.map((one) => one.id)).toEqual(["a"]);
        expect(read.settings.random.pool).toEqual([]);
    });

    it("refuse a longest wait shorter than the shortest", () => {
        const config = catalog.defaultEventsConfig();
        const bad = {
            ...config,
            settings: {
                ...config.settings,
                random: { ...config.settings.random, minGap: 90, maxGap: 30 }
            }
        };
        expect(catalog.eventsConfigSchema.safeParse(bad).success).toBe(false);
    });

    it("name a server's first events in the language its players read", () => {
        expect(catalog.readEventsConfig({}).presets[0]?.name).toBe("Mining rush");
        expect(catalog.readEventsConfig({}, "UTC", "es").presets[0]?.name).toBe("Fiebre minera");
    });

    it("refuse a schedule for an event that is not there", () => {
        const config = catalog.defaultEventsConfig();
        const bad = {
            ...config,
            schedules: [{ id: "x", presetId: "nope", enabled: true, days: [], at: "20:00" }]
        };
        const parsed = catalog.eventsConfigSchema.safeParse(bad);
        expect(parsed.success).toBe(false);
        expect(english(parsed.error?.issues[0]?.message)).toBe("That event no longer exists");
        expect(gameMessageIn("es-ES", parsed.error?.issues[0]?.message ?? "")).toBe(
            "Ese evento ya no existe"
        );
    });

    it("refuse a happy hour with no effect in it", () => {
        const preset = {
            ...catalog.newPreset("happy-hour", "h"),
            options: { haste: false, luck: false, speed: false, regeneration: false }
        };
        expect(catalog.presetSchema.safeParse(preset).success).toBe(false);
    });

    it("refuse a prize written as something that is not an item id", () => {
        const preset = catalog.newPreset("fishing", "f");
        const bad = {
            ...preset,
            rewards: {
                ...preset.rewards,
                first: { items: [{ id: "diamond sword", count: 1 }], levels: 0 }
            }
        };
        expect(catalog.presetSchema.safeParse(bad).success).toBe(false);
    });

    it("run trivia for its rounds rather than its minutes", () => {
        const preset = catalog.newPreset("trivia", "t");
        const options = preset.options as catalog.EventOptions<"trivia">;
        expect(catalog.runMinutes(preset)).toBe(
            Math.ceil((options.rounds * (options.seconds + catalog.ROUND_PAUSE_SECONDS)) / 60)
        );
    });
});

describe("who counts as playing", () => {
    const still = [{ name: "Ana", x: 10, y: 64, z: 10 }];
    const facing = new Map([["Ana", { yaw: 90, pitch: 0 }]]);

    it("is nobody the first time they are seen", () => {
        const seen = plan.observe(new Map(), still, facing, 0);
        expect(plan.activePlayers(seen, 5, 0)).toHaveLength(0);
    });

    it("is somebody seen somewhere else, or facing elsewhere", () => {
        const first = plan.observe(new Map(), still, facing, 0);
        const moved = plan.observe(first, [{ name: "Ana", x: 14, y: 64, z: 10 }], facing, 60_000);
        expect(plan.activePlayers(moved, 5, 60_000).map((one) => one.name)).toEqual(["Ana"]);
        const turned = plan.observe(
            first,
            still,
            new Map([["Ana", { yaw: 150, pitch: 0 }]]),
            60_000
        );
        expect(plan.activePlayers(turned, 5, 60_000)).toHaveLength(1);
    });

    it("is not somebody standing still past the idle time", () => {
        const first = plan.observe(new Map(), still, facing, 0);
        const moved = plan.observe(first, [{ name: "Ana", x: 14, y: 64, z: 10 }], facing, 60_000);
        const idle = plan.observe(
            moved,
            [{ name: "Ana", x: 14.1, y: 64, z: 10 }],
            facing,
            7 * 60_000
        );
        expect(plan.activePlayers(idle, 5, 7 * 60_000)).toHaveLength(0);
    });

    it("treats a turn across north as a small one", () => {
        const first = plan.observe(new Map(), still, new Map([["Ana", { yaw: 179, pitch: 0 }]]), 0);
        const next = plan.observe(
            first,
            still,
            new Map([["Ana", { yaw: -179, pitch: 0 }]]),
            60_000
        );
        expect(plan.activePlayers(next, 5, 60_000)).toHaveLength(0);
    });
});

describe("a scheduled event", () => {
    const entry = { id: "e", presetId: "p", enabled: true, days: [], at: "20:00" };

    it("is due from its minute, for a few minutes", () => {
        expect(plan.schedulesDue(settings(), [entry], {}, at("19:59"))).toHaveLength(0);
        expect(plan.schedulesDue(settings(), [entry], {}, at("20:00"))).toHaveLength(1);
        expect(plan.schedulesDue(settings(), [entry], {}, at("20:04"))).toHaveLength(1);
        expect(plan.schedulesDue(settings(), [entry], {}, at("20:30"))).toHaveLength(0);
    });

    it("fires once for its minute", () => {
        expect(
            plan.schedulesDue(settings(), [entry], { e: at("20:01") }, at("20:03"))
        ).toHaveLength(0);
        expect(
            plan.schedulesDue(settings(), [entry], { e: at("20:01", "2026-09-27") }, at("20:01"))
        ).toHaveLength(1);
    });

    it("is read in the server's zone", () => {
        // 20:00 in Madrid is 18:00 UTC at the end of September.
        const madrid = settings({ timezone: "Europe/Madrid" });
        expect(plan.schedulesDue(madrid, [entry], {}, at("18:00"))).toHaveLength(1);
        expect(plan.schedulesDue(madrid, [entry], {}, at("20:00"))).toHaveLength(0);
    });

    it("keeps to its days", () => {
        expect(
            plan.schedulesDue(settings(), [{ ...entry, days: [2] }], {}, at("20:00"))
        ).toHaveLength(0);
        expect(
            plan.schedulesDue(settings(), [{ ...entry, days: [1] }], {}, at("20:00"))
        ).toHaveLength(1);
    });
});

describe("the random draw", () => {
    const fishing = { ...catalog.newPreset("fishing", "fish"), minutes: 10 };
    const mining = { ...catalog.newPreset("mining-rush", "mine"), minutes: 10 };
    const on = settings({
        minActive: 2,
        random: {
            enabled: true,
            days: [],
            from: "18:00",
            to: "02:00",
            minGap: 60,
            maxGap: 60,
            pool: [
                { presetId: "fish", weight: 1 },
                { presetId: "mine", weight: 1 }
            ]
        }
    });
    const base = {
        settings: on,
        presets: [fishing, mining],
        lastKind: null,
        running: false,
        active: 3,
        random: always(0)
    };

    it("arms itself a gap away rather than starting on the spot", () => {
        const decided = plan.decideRandom({ ...base, nextRandomAt: null, now: at("19:00") });
        expect(decided.start).toBeNull();
        expect(decided.nextRandomAt).toBe(at("20:00"));
    });

    it("waits while it is not due", () => {
        expect(
            plan.decideRandom({ ...base, nextRandomAt: at("20:00"), now: at("19:30") }).start
        ).toBeNull();
    });

    it("waits outside its hours, across midnight too", () => {
        expect(plan.randomWindowOpen(on, at("01:30"))).toBe(true);
        expect(plan.randomWindowOpen(on, at("03:00"))).toBe(false);
        const decided = plan.decideRandom({ ...base, nextRandomAt: at("03:00"), now: at("03:00") });
        expect(decided.start).toBeNull();
        expect(english(decided.waiting)).toMatch(/outside/i);
    });

    it("waits for enough players who are playing, and says how many", () => {
        const decided = plan.decideRandom({
            ...base,
            active: 1,
            nextRandomAt: at("20:00"),
            now: at("20:00")
        });
        expect(decided.start).toBeNull();
        expect(english(decided.waiting)).toBe("Waiting for 2 active players (1 now)");
    });

    it("waits while another event is on", () => {
        expect(
            plan.decideRandom({
                ...base,
                running: true,
                nextRandomAt: at("20:00"),
                now: at("20:00")
            }).start
        ).toBeNull();
    });

    it("never draws the same kind twice in a row when there is another", () => {
        const decided = plan.decideRandom({
            ...base,
            lastKind: "fishing",
            nextRandomAt: at("20:00"),
            now: at("20:00")
        });
        expect(decided.start?.id).toBe("mine");
        // Next one after this one ends plus the gap.
        expect(decided.nextRandomAt).toBe(at("20:00") + 10 * 60_000 + 60 * 60_000);
    });

    it("draws by weight", () => {
        const weighted = {
            ...on,
            random: {
                ...on.random,
                pool: [
                    { presetId: "fish", weight: 1 },
                    { presetId: "mine", weight: 9 }
                ]
            }
        };
        const low = plan.decideRandom({
            ...base,
            settings: weighted,
            nextRandomAt: at("20:00"),
            now: at("20:00"),
            random: always(0.05)
        });
        const high = plan.decideRandom({
            ...base,
            settings: weighted,
            nextRandomAt: at("20:00"),
            now: at("20:00"),
            random: always(0.5)
        });
        expect(low.start?.id).toBe("fish");
        expect(high.start?.id).toBe("mine");
    });

    it("waits one more look once the players it was short of come, so a join is not landed on", () => {
        const due = at("20:00");
        const short = plan.decideRandom({
            ...base,
            active: 1,
            nextRandomAt: due,
            now: at("20:30")
        });
        expect(short.short).toBe(true);
        const first = plan.decideRandom({ ...base, ...short, nextRandomAt: due, now: at("21:00") });
        expect(first.start).toBeNull();
        expect(first.readySince).toBe(at("21:00"));
        expect(english(first.waiting)).toMatch(/one more check/);
        const second = plan.decideRandom({
            ...base,
            nextRandomAt: due,
            short: true,
            readySince: first.readySince,
            now: at("21:00") + plan.SETTLE_MS
        });
        expect(second.start?.id).toBe("fish");
    });

    it("starts at once when it was never short of players", () => {
        expect(
            plan.decideRandom({ ...base, nextRandomAt: at("20:00"), now: at("21:00") }).start?.id
        ).toBe("fish");
    });

    it("starts the settling again when the players it waits for leave", () => {
        const left = plan.decideRandom({
            ...base,
            active: 1,
            nextRandomAt: at("20:00"),
            short: true,
            readySince: at("20:30"),
            now: at("21:00")
        });
        expect(left.start).toBeNull();
        expect(left.readySince).toBeNull();
    });

    it("leaves out an event that is switched off", () => {
        const off = { ...fishing, enabled: false };
        const decided = plan.decideRandom({
            ...base,
            presets: [off, mining],
            nextRandomAt: at("20:00"),
            now: at("20:00")
        });
        expect(decided.start?.id).toBe("mine");
    });
});

describe("the podium and the prizes", () => {
    it("ranks by score, ties sharing a place, nobody without a score", () => {
        const placed = plan.podium(
            new Map([
                ["Ana", 10],
                ["Ben", 10],
                ["Cai", 7],
                ["Dan", 5],
                ["Eve", 0]
            ]),
            new Set()
        );
        expect(placed).toEqual([
            { place: 1, name: "Ana", score: 10 },
            { place: 1, name: "Ben", score: 10 },
            { place: 3, name: "Cai", score: 7 }
        ]);
    });

    it("breaks a tie on score by who took less time, when the time is given", () => {
        const scores = new Map([
            ["Ana", 3],
            ["Ben", 3],
            ["Cai", 3],
            ["Dan", 5]
        ]);
        const placed = plan.podium(scores, new Set(), 1, { Ana: 9_000, Ben: 4_000, Cai: 6_000 });
        expect(placed).toEqual([
            { place: 1, name: "Dan", score: 5 },
            { place: 2, name: "Ben", score: 3 },
            { place: 3, name: "Cai", score: 3 }
        ]);
        // The same score in the same time still shares the place, and a name
        // with no time counts as slowest.
        expect(plan.podium(scores, new Set(), 1, { Ana: 4_000, Ben: 4_000, Dan: 1 })).toEqual([
            { place: 1, name: "Dan", score: 5 },
            { place: 2, name: "Ana", score: 3 },
            { place: 2, name: "Ben", score: 3 }
        ]);
        // The same order every time, whatever order the scores came in.
        const reversed = new Map([...scores.entries()].reverse());
        expect(plan.podium(reversed, new Set(), 1, { Ana: 9_000, Ben: 4_000, Cai: 6_000 })).toEqual(
            placed
        );
        expect(
            [...scores.entries()]
                .sort(plan.ranking({ Ana: 9_000, Ben: 4_000, Cai: 6_000 }))
                .map(([name]) => name)
        ).toEqual(["Dan", "Ben", "Cai", "Ana"]);
    });

    it("reads a trivia game saved before answer times were kept, with none yet", () => {
        const saved = stored.runSchema.parse({
            id: "run-1",
            trigger: "manual",
            startedBy: null,
            preset: catalog.newPreset("trivia", "quiz"),
            phase: "running",
            createdAt: 0,
            startsAt: 0,
            endsAt: 1,
            round: 2,
            points: { Ana: 1, Ben: 1 }
        });
        expect(saved.answerMs).toEqual({});
        expect(saved.triviaOut).toEqual([]);
        // With no times at all, a tie on points still shares the place.
        expect(
            plan.podium(new Map(Object.entries(saved.points)), new Set(), 1, saved.answerMs)
        ).toEqual([
            { place: 1, name: "Ana", score: 1 },
            { place: 1, name: "Ben", score: 1 }
        ]);
    });

    it("leaves the disqualified off it", () => {
        const placed = plan.podium(
            new Map([
                ["Ana", 10],
                ["Ben", 8]
            ]),
            new Set(["ana"])
        );
        expect(placed).toEqual([{ place: 1, name: "Ben", score: 8 }]);
    });

    it("owes the podium its place's prize, everybody else who took part theirs, and nothing empty", () => {
        const rewards: catalog.Rewards = {
            first: { items: [{ id: "minecraft:diamond", count: 5 }], levels: 10 },
            second: catalog.NO_REWARD,
            third: catalog.NO_REWARD,
            everyone: { items: [{ id: "minecraft:bread", count: 3 }], levels: 0 }
        };
        const owed = plan.prizes(
            [
                { place: 1, name: "Ana", score: 3 },
                { place: 2, name: "Ben", score: 2 }
            ],
            ["ana", "Ben", "Cai", "Cheat"],
            rewards,
            new Set(["cheat"])
        );
        // Ana: first place only, never the taking-part prize on top (in any
        // casing); Ben's second place is empty, so he is owed what everybody
        // else is rather than less than them; Cai took part off the podium;
        // the cheat gets nothing.
        expect(owed).toEqual([
            { name: "Ana", reward: { items: [{ id: "minecraft:diamond", count: 5 }], levels: 10 } },
            { name: "Ben", reward: { items: [{ id: "minecraft:bread", count: 3 }], levels: 0 } },
            { name: "Cai", reward: { items: [{ id: "minecraft:bread", count: 3 }], levels: 0 } }
        ]);
    });

    it("owes a place with no prize nothing when the event counts nobody as taking part", () => {
        const owed = plan.prizes(
            [
                { place: 1, name: "Ana", score: 3 },
                { place: 2, name: "Ben", score: 2 }
            ],
            [],
            {
                first: { items: [], levels: 10 },
                second: catalog.NO_REWARD,
                third: catalog.NO_REWARD,
                everyone: { items: [{ id: "minecraft:bread", count: 3 }], levels: 0 }
            },
            new Set()
        );
        expect(owed).toEqual([{ name: "Ana", reward: { items: [], levels: 10 } }]);
    });
});

describe("a competition with prizes, on its own", () => {
    const fishing = { ...catalog.newPreset("fishing", "fish"), minutes: 10 };
    const happy = { ...catalog.newPreset("happy-hour", "happy"), minutes: 10 };
    const unrewarded = {
        ...catalog.newPreset("mining-rush", "free"),
        rewards: {
            first: catalog.NO_REWARD,
            second: catalog.NO_REWARD,
            third: catalog.NO_REWARD,
            everyone: catalog.NO_REWARD
        }
    };
    const loose = settings({ minActive: 1 });

    it("needs two players playing, whatever the minimum says", () => {
        expect(catalog.awardsPrizes(fishing)).toBe(true);
        expect(catalog.activeNeeded(fishing, loose)).toBe(2);
        expect(catalog.activeNeeded(fishing, settings({ minActive: 4 }))).toBe(4);
    });

    it("does not hold back what hands nothing out", () => {
        expect(catalog.awardsPrizes(happy)).toBe(false);
        expect(catalog.awardsPrizes(unrewarded)).toBe(false);
        expect(catalog.activeNeeded(happy, loose)).toBe(1);
        expect(catalog.activeNeeded({ ...unrewarded, minPlayers: 1 }, loose)).toBe(1);
    });

    it("waits for the event's own minimum of players, two for a competition by default", () => {
        expect(catalog.minPlayersOf(unrewarded)).toBe(2);
        expect(catalog.activeNeeded(unrewarded, loose)).toBe(2);
        expect(catalog.minPlayersOf(happy)).toBe(1);
        expect(catalog.activeNeeded({ ...happy, minPlayers: 3 }, loose)).toBe(3);
        // Saved before the setting existed: the kind's default.
        expect(catalog.minPlayersOf({ ...fishing, minPlayers: undefined })).toBe(2);
        expect(catalog.minPlayersOf({ ...happy, minPlayers: undefined })).toBe(1);
        // Never fewer than two join a duel, and more when the event asks for more.
        const duel = catalog.newPreset("team-duel", "duel");
        expect(catalog.joinersNeeded({ ...duel, minPlayers: 1 })).toBe(2);
        expect(catalog.joinersNeeded({ ...duel, minPlayers: 4 })).toBe(4);
        const bare = {
            first: catalog.NO_REWARD,
            second: catalog.NO_REWARD,
            third: catalog.NO_REWARD
        };
        const practice = {
            ...catalog.newPreset("parkour", "p"),
            minPlayers: 1,
            rewards: { ...bare, everyone: catalog.NO_REWARD }
        };
        expect(catalog.joinersNeeded(practice)).toBe(1);
    });

    it("never plays a build battle with fewer than three, whatever its own minimum", () => {
        const battle = catalog.newPreset("build-battle", "b");
        expect(catalog.joinersNeeded({ ...battle, minPlayers: 2 })).toBe(3);
        expect(catalog.joinersNeeded({ ...battle, minPlayers: 5 })).toBe(5);
        expect(catalog.minPlayersOf({ ...battle, minPlayers: undefined })).toBe(3);
        expect(catalog.activeNeeded({ ...battle, minPlayers: 2 }, loose)).toBe(3);
    });

    it("is left out of the draw for one player alone, who still gets the rest", () => {
        const draw = {
            ...loose,
            random: {
                ...loose.random,
                enabled: true,
                from: "00:00",
                to: "00:00",
                pool: [
                    { presetId: "fish", weight: 9 },
                    { presetId: "happy", weight: 1 }
                ]
            }
        };
        const decided = plan.decideRandom({
            settings: draw,
            presets: [fishing, happy],
            nextRandomAt: at("20:00"),
            lastKind: null,
            running: false,
            active: 1,
            now: at("20:00"),
            random: always(0)
        });
        expect(decided.start?.id).toBe("happy");
    });

    it("waits, and says for how many, when it is all the draw has", () => {
        const draw = {
            ...loose,
            random: {
                ...loose.random,
                enabled: true,
                from: "00:00",
                to: "00:00",
                pool: [{ presetId: "fish", weight: 1 }]
            }
        };
        const decided = plan.decideRandom({
            settings: draw,
            presets: [fishing],
            nextRandomAt: at("20:00"),
            lastKind: null,
            running: false,
            active: 1,
            now: at("20:00"),
            random: always(0)
        });
        expect(decided.start).toBeNull();
        expect(english(decided.waiting)).toBe("Waiting for 2 active players (1 now)");
    });
});

describe("the least to be ranked", () => {
    it("has a sensible default for every kind, and a stored one wins", () => {
        expect(catalog.minScoreOf(catalog.newPreset("mob-hunt", "a"))).toBe(5);
        expect(catalog.minScoreOf(catalog.newPreset("explorer", "b"))).toBe(250);
        expect(catalog.minScoreOf({ ...catalog.newPreset("fishing", "c"), minScore: 10 })).toBe(10);
        // Saved before the setting existed: the kind's default.
        const { minScore: _dropped, ...older } = catalog.newPreset("king-of-the-hill", "d");
        expect(catalog.minScoreOf(older as catalog.EventPreset)).toBe(30);
    });

    it("is not asked of a supply drop or a race, which have one winner", () => {
        expect(catalog.hasMinScore(catalog.newPreset("supply-drop", "e"))).toBe(false);
        const race = {
            ...catalog.newPreset("explorer", "f"),
            options: { mode: "race" as const, distance: 500, place: { mode: "players" as const } }
        };
        expect(catalog.hasMinScore(race)).toBe(false);
        expect(catalog.minScoreOf(race)).toBe(1);
    });

    it("keeps anybody under it off the podium", () => {
        expect(
            plan.podium(
                new Map([
                    ["Ana", 6],
                    ["Ben", 4]
                ]),
                new Set(),
                5
            )
        ).toEqual([{ place: 1, name: "Ana", score: 6 }]);
    });
});

describe("what each event needs of the world", () => {
    it("is declared for every kind", () => {
        for (const kind of catalog.EVENT_KINDS) expect(catalog.WORLD_NEEDS[kind]).toBeDefined();
    });

    it("holds clear weather on a build and night for a horde", () => {
        expect(catalog.worldNeeds({ kind: "build-battle" })).toEqual({
            time: "day",
            weather: "clear"
        });
        expect(catalog.worldNeeds({ kind: "waves" })).toEqual({ time: "night", weather: "clear" });
        expect(catalog.worldNeeds({ kind: "mob-hunt" }).time).toBe("night");
    });

    it("keeps every arena and stage in the day", () => {
        for (const kind of catalog.EVENT_KINDS) {
            const preset = catalog.newPreset(kind, kind);
            if (catalog.playsInArena(preset) || catalog.playsOnStage(preset))
                expect(catalog.keepsDay(preset)).toBe(true);
        }
    });
});

describe("what the draw can pick now", () => {
    const fishing = catalog.newPreset("fishing", "fish");
    const duel = catalog.newPreset("team-duel", "duel");
    const off = { ...catalog.newPreset("trivia", "quiz"), enabled: false };
    const on = settings({
        minActive: 1,
        random: {
            ...catalog.settingsSchema.parse({}).random,
            enabled: true,
            pool: [
                { presetId: "fish", weight: 1 },
                { presetId: "duel", weight: 1 },
                { presetId: "quiz", weight: 1 },
                { presetId: "gone", weight: 1 }
            ]
        }
    });

    it("says why each one it leaves out cannot start", () => {
        const { choices, skipped } = plan.drawable({
            settings: on,
            presets: [fishing, duel, off],
            lastKind: null,
            // Two by the lake, one of them out of the Overworld.
            activeFor: (preset) => (preset.id === "fish" ? 2 : 1)
        });
        expect(choices.map((one) => one.preset.id)).toEqual(["fish"]);
        expect(skipped.map((one) => [one.presetId, english(one.reason)])).toEqual([
            ["duel", "Waiting for 2 active players (1 now)"],
            ["quiz", "Switched off"]
        ]);
    });

    it("leaves out the same kind as last time, and says so, while another can start", () => {
        const { choices, skipped } = plan.drawable({
            settings: on,
            presets: [fishing, duel, off],
            lastKind: "fishing",
            activeFor: () => 4
        });
        expect(choices.map((one) => one.preset.id)).toEqual(["duel"]);
        expect(skipped.find((one) => one.presetId === "fish")?.reason).toBeDefined();
        expect(english(skipped.find((one) => one.presetId === "fish")!.reason)).toBe(
            "Same kind as the last one"
        );
    });

    it("picks by weight, and nothing from nothing", () => {
        const choices = [
            { preset: fishing, weight: 1 },
            { preset: duel, weight: 3 }
        ];
        expect(plan.pickWeighted(choices, always(0.1))?.id).toBe("fish");
        expect(plan.pickWeighted(choices, always(0.9))?.id).toBe("duel");
        expect(plan.pickWeighted([], always(0.5))).toBeNull();
    });

    it("is open any time of day by default", () => {
        const fresh = settings();
        expect(fresh.random.from).toBe(fresh.random.to);
        for (const time of ["00:00", "03:30", "12:00", "23:59"])
            expect(plan.randomWindowOpen(fresh, at(time))).toBe(true);
    });
});

describe("fights and worlds", () => {
    const here = [{ name: "Ana", x: 0, y: 64, z: 0 }];
    const facing = new Map([["Ana", { yaw: 0, pitch: 0 }]]);

    it("sees a fight in the damage dealt going up, and lets it go after a while", () => {
        const first = plan.observe(new Map(), here, facing, 0, { hit: new Map([["Ana", 10]]) });
        const second = plan.observe(first, [{ name: "Ana", x: 5, y: 64, z: 0 }], facing, 60_000, {
            hit: new Map([["Ana", 30]])
        });
        const ana = second.get("ana")!;
        expect(plan.busy(ana, 60_000)).toBe(true);
        expect(plan.busy(ana, 60_000 + plan.FIGHT_COOLDOWN_MS + 1)).toBe(false);
        expect(english(plan.busyReason(second, 5, 60_000))).toBe("Ana is in a fight or in the End");
    });

    it("does not take damage taken alone for a fight: hunger, a fall, a mob nibbling", () => {
        // On a small island this held the draw back all evening.
        const first = plan.observe(new Map(), here, facing, 0, {
            hurt: new Map([["Ana", 10]]),
            hit: new Map([["Ana", 0]])
        });
        const second = plan.observe(first, [{ name: "Ana", x: 5, y: 64, z: 0 }], facing, 60_000, {
            hurt: new Map([["Ana", 40]]),
            hit: new Map([["Ana", 0]])
        });
        expect(plan.busy(second.get("ana")!, 60_000)).toBe(false);
        expect(plan.busyReason(second, 5, 60_000)).toBeNull();
    });

    it("takes the End for a fight with the dragon", () => {
        const seen = plan.observe(new Map(), here, facing, 0, {
            dimensions: new Map([["Ana", "minecraft:the_end"]])
        });
        expect(plan.busy(seen.get("ana")!, 0)).toBe(true);
    });

    it("counts only the Overworld for what happens there", () => {
        const first = plan.observe(new Map(), here, facing, 0, {
            dimensions: new Map([["Ana", "minecraft:the_nether"]])
        });
        const moved = plan.observe(first, [{ name: "Ana", x: 9, y: 64, z: 0 }], facing, 60_000);
        expect(
            plan.playersFor(catalog.newPreset("supply-drop", "d"), moved, 5, 60_000)
        ).toHaveLength(0);
        expect(
            plan.playersFor(catalog.newPreset("mining-rush", "m"), moved, 5, 60_000)
        ).toHaveLength(1);
    });
});

describe("a saved event that no longer reads whole", () => {
    it("keeps every part that reads and sets the rest back, rather than vanishing", () => {
        const fishing = catalog.newPreset("fishing", "fish");
        const saved = { ...fishing, name: "Lake day", minutes: 2 };
        const repaired = catalog.repairPreset(saved);
        expect(repaired?.preset.name).toBe("Lake day");
        expect(repaired?.preset.minutes).toBe(fishing.minutes);
        expect(repaired?.reset).toEqual(["minutes"]);
        const config = {
            [catalog.EVENTS_KEY]: {
                settings: {
                    ...settings(),
                    random: {
                        ...settings().random,
                        enabled: true,
                        pool: [{ presetId: "fish", weight: 1 }]
                    }
                },
                presets: [saved],
                schedules: []
            }
        };
        // Still in the list and the draw, and said.
        const read = catalog.readEventsConfig(config);
        expect(
            read.presets.filter((one) => !one.id.startsWith("default-")).map((one) => one.id)
        ).toEqual(["fish"]);
        expect(read.settings.random.pool.map((one) => one.presetId)).toEqual(["fish"]);
        expect(catalog.repairedPresets(config)).toEqual([
            { id: "fish", name: "Lake day", reset: ["minutes"] }
        ]);
    });

    it("gives each event that was set back an id of its own", () => {
        const fishing = catalog.newPreset("fishing", "fish");
        const { id: _, ...noId } = { ...fishing, minutes: 2 };
        const config = {
            [catalog.EVENTS_KEY]: {
                settings: settings(),
                presets: [noId, noId, { ...fishing, minutes: 2 }, fishing],
                schedules: []
            }
        };
        const ids = catalog.readEventsConfig(config).presets.map((one) => one.id);
        expect(ids).toEqual(["fishing-saved", "fishing-saved-2", "fish-2", "fish"]);
        expect(catalog.repairedPresets(config).map((one) => one.id)).toEqual(ids.slice(0, 3));
    });

    it("leaves out only what is not an event of a kind this version knows", () => {
        expect(catalog.repairPreset({ kind: "no-such-kind", id: "x" })).toBeNull();
        expect(catalog.repairPreset("nonsense")).toBeNull();
        const fine = catalog.newPreset("trivia", "q");
        expect(catalog.repairPreset(fine)?.reset).toEqual([]);
    });
});

describe("who an event still holds", () => {
    const saved = (name: string) => ({
        name,
        dimension: "minecraft:overworld",
        x: 0,
        y: 64,
        z: 0,
        yaw: 0,
        pitch: 0,
        mode: "survival" as const,
        stash: null
    });

    it("counts a player inside the stage of the run on now", () => {
        const run = { entrants: [], sentOut: [], stage: { saved: [saved("Ana")] } };
        const held = stored.heldNames({
            run: run as unknown as stored.EventRun,
            arenaLeftovers: [],
            stageLeftovers: []
        });
        expect([...held]).toEqual(["ana"]);
    });

    it("owes a trip back only for what an earlier event left behind", () => {
        const state = {
            run: { entrants: [], sentOut: [], stage: { saved: [saved("Ana")] } },
            arenaLeftovers: [],
            stageLeftovers: [
                { runId: "old", area: null, boxes: [], saved: [saved("Ben")], keepForced: null }
            ]
        } as unknown as stored.EventState;
        expect([...stored.owedNames(state)]).toEqual(["ben"]);
        expect([...stored.heldNames(state)].sort()).toEqual(["ana", "ben"]);
    });
});
