/**
 * The rules around a Minecraft event, apart from playing it: what a stored
 * setting reads as, when an automatic one is due, who counts as playing, who
 * stands on the podium and what they are owed.
 */

import { describe, expect, it } from "vitest";
import * as plan from "@polaris-app/game-servers/src/lib/minecraft/events/plan";
import * as catalog from "@polaris-app/game-servers/src/lib/minecraft/events/catalog";

const settings = (patch: Partial<catalog.EventSettings> = {}): catalog.EventSettings => ({
    ...catalog.settingsSchema.parse({}),
    ...patch
});

/** 2026-09-28 was a Monday. */
const at = (time: string, day = "2026-09-28") => Date.parse(`${day}T${time}:00Z`);

/** Always the same number, so a draw is decided by the test. */
const always = (value: number) => () => value;

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
        expect(read.presets.map((one) => one.id)).toEqual(["fish"]);
        expect(read.schedules.map((one) => one.id)).toEqual(["a"]);
        expect(read.settings.random.pool).toEqual([]);
    });

    it("refuse a longest wait shorter than the shortest", () => {
        const config = catalog.defaultEventsConfig();
        const bad = { ...config, settings: { ...config.settings, random: { ...config.settings.random, minGap: 90, maxGap: 30 } } };
        expect(catalog.eventsConfigSchema.safeParse(bad).success).toBe(false);
    });

    it("refuse a schedule for an event that is not there", () => {
        const config = catalog.defaultEventsConfig();
        const bad = { ...config, schedules: [{ id: "x", presetId: "nope", enabled: true, days: [], at: "20:00" }] };
        const parsed = catalog.eventsConfigSchema.safeParse(bad);
        expect(parsed.success).toBe(false);
        expect(parsed.error?.issues[0]?.message).toBe("That event no longer exists");
    });

    it("refuse a happy hour with no effect in it", () => {
        const preset = { ...catalog.newPreset("happy-hour", "h"), options: { haste: false, luck: false, speed: false, regeneration: false } };
        expect(catalog.presetSchema.safeParse(preset).success).toBe(false);
    });

    it("refuse a prize written as something that is not an item id", () => {
        const preset = catalog.newPreset("fishing", "f");
        const bad = { ...preset, rewards: { ...preset.rewards, first: { items: [{ id: "diamond sword", count: 1 }], levels: 0 } } };
        expect(catalog.presetSchema.safeParse(bad).success).toBe(false);
    });

    it("run trivia for its rounds rather than its minutes", () => {
        const preset = catalog.newPreset("trivia", "t");
        const options = preset.options as catalog.EventOptions<"trivia">;
        expect(catalog.runMinutes(preset)).toBe(Math.ceil((options.rounds * (options.seconds + catalog.ROUND_PAUSE_SECONDS)) / 60));
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
        const turned = plan.observe(first, still, new Map([["Ana", { yaw: 150, pitch: 0 }]]), 60_000);
        expect(plan.activePlayers(turned, 5, 60_000)).toHaveLength(1);
    });

    it("is not somebody standing still past the idle time", () => {
        const first = plan.observe(new Map(), still, facing, 0);
        const moved = plan.observe(first, [{ name: "Ana", x: 14, y: 64, z: 10 }], facing, 60_000);
        const idle = plan.observe(moved, [{ name: "Ana", x: 14.1, y: 64, z: 10 }], facing, 7 * 60_000);
        expect(plan.activePlayers(idle, 5, 7 * 60_000)).toHaveLength(0);
    });

    it("treats a turn across north as a small one", () => {
        const first = plan.observe(new Map(), still, new Map([["Ana", { yaw: 179, pitch: 0 }]]), 0);
        const next = plan.observe(first, still, new Map([["Ana", { yaw: -179, pitch: 0 }]]), 60_000);
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
        expect(plan.schedulesDue(settings(), [entry], { e: at("20:01") }, at("20:03"))).toHaveLength(0);
        expect(plan.schedulesDue(settings(), [entry], { e: at("20:01", "2026-09-27") }, at("20:01"))).toHaveLength(1);
    });

    it("is read in the server's zone", () => {
        // 20:00 in Madrid is 18:00 UTC at the end of September.
        const madrid = settings({ timezone: "Europe/Madrid" });
        expect(plan.schedulesDue(madrid, [entry], {}, at("18:00"))).toHaveLength(1);
        expect(plan.schedulesDue(madrid, [entry], {}, at("20:00"))).toHaveLength(0);
    });

    it("keeps to its days", () => {
        expect(plan.schedulesDue(settings(), [{ ...entry, days: [2] }], {}, at("20:00"))).toHaveLength(0);
        expect(plan.schedulesDue(settings(), [{ ...entry, days: [1] }], {}, at("20:00"))).toHaveLength(1);
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
    const base = { settings: on, presets: [fishing, mining], lastKind: null, running: false, active: 3, random: always(0) };

    it("arms itself a gap away rather than starting on the spot", () => {
        const decided = plan.decideRandom({ ...base, nextRandomAt: null, now: at("19:00") });
        expect(decided.start).toBeNull();
        expect(decided.nextRandomAt).toBe(at("20:00"));
    });

    it("waits while it is not due", () => {
        expect(plan.decideRandom({ ...base, nextRandomAt: at("20:00"), now: at("19:30") }).start).toBeNull();
    });

    it("waits outside its hours, across midnight too", () => {
        expect(plan.randomWindowOpen(on, at("01:30"))).toBe(true);
        expect(plan.randomWindowOpen(on, at("03:00"))).toBe(false);
        const decided = plan.decideRandom({ ...base, nextRandomAt: at("03:00"), now: at("03:00") });
        expect(decided.start).toBeNull();
        expect(decided.waiting).toMatch(/outside/i);
    });

    it("waits for enough players who are playing, and says how many", () => {
        const decided = plan.decideRandom({ ...base, active: 1, nextRandomAt: at("20:00"), now: at("20:00") });
        expect(decided.start).toBeNull();
        expect(decided.waiting).toBe("Waiting for 2 active players (1 now)");
    });

    it("waits while another event is on", () => {
        expect(plan.decideRandom({ ...base, running: true, nextRandomAt: at("20:00"), now: at("20:00") }).start).toBeNull();
    });

    it("never draws the same kind twice in a row when there is another", () => {
        const decided = plan.decideRandom({ ...base, lastKind: "fishing", nextRandomAt: at("20:00"), now: at("20:00") });
        expect(decided.start?.id).toBe("mine");
        // Next one after this one ends plus the gap.
        expect(decided.nextRandomAt).toBe(at("20:00") + 10 * 60_000 + 60 * 60_000);
    });

    it("draws by weight", () => {
        const weighted = { ...on, random: { ...on.random, pool: [{ presetId: "fish", weight: 1 }, { presetId: "mine", weight: 9 }] } };
        const low = plan.decideRandom({ ...base, settings: weighted, nextRandomAt: at("20:00"), now: at("20:00"), random: always(0.05) });
        const high = plan.decideRandom({ ...base, settings: weighted, nextRandomAt: at("20:00"), now: at("20:00"), random: always(0.5) });
        expect(low.start?.id).toBe("fish");
        expect(high.start?.id).toBe("mine");
    });

    it("leaves out an event that is switched off", () => {
        const off = { ...fishing, enabled: false };
        const decided = plan.decideRandom({ ...base, presets: [off, mining], nextRandomAt: at("20:00"), now: at("20:00") });
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

    it("leaves the disqualified off it", () => {
        const placed = plan.podium(new Map([["Ana", 10], ["Ben", 8]]), new Set(["ana"]));
        expect(placed).toEqual([{ place: 1, name: "Ben", score: 8 }]);
    });

    it("owes a place's prize plus the one for taking part, and nothing empty", () => {
        const rewards: catalog.Rewards = {
            first: { items: [{ id: "minecraft:diamond", count: 5 }], levels: 10 },
            second: catalog.NO_REWARD,
            third: catalog.NO_REWARD,
            everyone: { items: [{ id: "minecraft:bread", count: 3 }], levels: 0 }
        };
        const owed = plan.prizes([{ place: 1, name: "Ana", score: 3 }, { place: 2, name: "Ben", score: 2 }], ["Ana", "Ben", "Cheat"], rewards, new Set(["cheat"]));
        expect(owed).toEqual([
            {
                name: "Ana",
                reward: {
                    items: [
                        { id: "minecraft:diamond", count: 5 },
                        { id: "minecraft:bread", count: 3 }
                    ],
                    levels: 10
                }
            },
            { name: "Ben", reward: { items: [{ id: "minecraft:bread", count: 3 }], levels: 0 } }
        ]);
    });
});
