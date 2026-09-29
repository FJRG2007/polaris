/**
 * The challenge draws, the season's arithmetic and the calendar they run on.
 */

import { describe, expect, it } from "vitest";
import * as draw from "@polaris-app/game-servers/src/lib/minecraft/challenges/draw";
import * as stored from "@polaris-app/game-servers/src/lib/minecraft/challenges/state";
import * as period from "@polaris-app/game-servers/src/lib/minecraft/challenges/period";
import * as season from "@polaris-app/game-servers/src/lib/minecraft/challenges/season";
import * as catalog from "@polaris-app/game-servers/src/lib/minecraft/challenges/catalog";
import * as settingsModule from "@polaris-app/game-servers/src/lib/minecraft/challenges/settings";

const settings = settingsModule.settingsSchema.parse({ enabled: true });
const input = (patch: Partial<draw.DrawInput> = {}): draw.DrawInput => ({
    settings,
    version: "1.21.4",
    recent: [],
    pace: {},
    seed: "server:2026-09-29",
    budget: draw.BUDGET.daily,
    goalRunning: false,
    ...patch
});
const template = (id: string) => catalog.templateOf(id)!;

describe("a day's pool", () => {
    it("is nine, three of each difficulty, over at least five categories, never two of a group or three of a category", () => {
        for (let day = 1; day <= 40; day += 1) {
            const pool = draw.drawPool("daily", input({ seed: `server:day-${day}` }));
            expect(pool).toHaveLength(9);
            for (const tier of catalog.DIFFICULTIES) expect(pool.filter((one) => one.tier === tier)).toHaveLength(3);
            const categories = pool.map((one) => template(one.template).category);
            expect(new Set(categories).size).toBeGreaterThanOrEqual(5);
            for (const category of new Set(categories)) expect(categories.filter((one) => one === category).length).toBeLessThanOrEqual(2);
            const groups = pool.map((one) => template(one.template).group);
            expect(new Set(groups).size).toBe(9);
            expect(draw.poolCriteria(pool).length).toBeLessThanOrEqual(draw.BUDGET.daily);
            for (const entry of pool) expect(template(entry.template).layers).toContain("daily");
        }
    });

    it("is the same for the same server and day, and different on another day", () => {
        expect(draw.drawPool("daily", input())).toEqual(draw.drawPool("daily", input()));
        expect(draw.drawPool("daily", input())).not.toEqual(draw.drawPool("daily", input({ seed: "server:2026-09-30" })));
    });

    it("leaves out what was drawn in the last days while there is anything else", () => {
        const first = draw.drawPool("daily", input());
        const next = draw.drawPool("daily", input({ seed: "server:2026-09-30", recent: first.map((one) => one.template) }));
        expect(next.filter((one) => first.some((before) => before.template === one.template))).toEqual([]);
    });

    it("only draws what the server's version has", () => {
        for (let day = 1; day <= 30; day += 1) {
            const pool = draw.drawPool("daily", input({ version: "1.16.5", seed: `old-${day}` }));
            for (const entry of pool) {
                expect(catalog.atLeast("1.16.5", template(entry.template).minVersion), entry.template).toBe(true);
                const variant = template(entry.template).variants?.find((one) => one.key === entry.variant);
                expect(catalog.atLeast("1.16.5", variant?.minVersion)).toBe(true);
            }
        }
        for (let day = 1; day <= 60; day += 1) {
            for (const entry of draw.drawPool("daily", input({ version: "1.21.4", seed: `ride-${day}` }))) {
                expect(entry.variant).not.toBe("happy_ghast");
            }
        }
    });

    it("keeps to the categories and templates the operator left on", () => {
        const only = settingsModule.settingsSchema.parse({
            categories: Object.fromEntries(catalog.CATEGORIES.map((category) => [category, { enabled: category === "mining" || category === "combat" }])),
            disabled: ["M1", "C1"]
        });
        const pool = draw.drawPool("daily", input({ settings: only }));
        expect(pool.length).toBeGreaterThan(0);
        for (const entry of pool) {
            expect(["mining", "combat"]).toContain(template(entry.template).category);
            expect(["M1", "C1"]).not.toContain(entry.template);
        }
    });

    it("scales targets by pace and the multiplier, rounded to figures people remember", () => {
        expect(draw.roundNice(96)).toBe(95);
        expect(draw.roundNice(256)).toBe(250);
        expect(draw.roundNice(7)).toBe(7);
        expect(draw.roundNice(1234)).toBe(1250);
        const roll = () => 0.5;
        expect(draw.targetFor(template("M1"), 256, 1, roll)).toBe(250);
        expect(draw.targetFor(template("M1"), 256, 2, roll)).toBe(500);
        // Distances are rounded in blocks, not centimetres.
        expect(draw.targetFor(template("E1"), 200_000, 1, roll) % 100).toBe(0);
        // A single raid stays a single raid.
        expect(draw.targetFor(template("C4"), 1, 1, roll)).toBe(1);
    });

    it("moves pace up for what everybody finishes and down for what nobody does", () => {
        expect(draw.nextPace(1, 10, 9)).toBeCloseTo(1.15);
        expect(draw.nextPace(1, 10, 1)).toBeCloseTo(0.85);
        expect(draw.nextPace(1, 10, 5)).toBe(1);
        expect(draw.nextPace(1, 2, 2)).toBe(1);
        expect(draw.nextPace(1.99, 10, 10)).toBe(2);
        expect(draw.nextPace(0.51, 10, 0)).toBe(0.5);
    });

    it("only offers the community-share challenge while a goal runs", () => {
        for (let day = 1; day <= 40; day += 1) {
            expect(draw.drawPool("daily", input({ seed: `c-${day}` })).some((one) => one.template === "S1")).toBe(false);
        }
    });
});

describe("dealing", () => {
    const pool = draw.drawPool("daily", input());

    it("deals one of each difficulty, the same every time for the same player and day", () => {
        const dealt = draw.deal("daily", pool, "Alba", "2026-09-29");
        expect(dealt.map((one) => one.tier)).toEqual(["easy", "medium", "hard"]);
        expect(draw.deal("daily", pool, "alba", "2026-09-29")).toEqual(dealt);
        const others = new Set(["Bruno", "Carla", "Dario", "Elena", "Fede"].map((name) => JSON.stringify(draw.deal("daily", pool, name, "2026-09-29"))));
        expect(others.size).toBeGreaterThan(1);
    });

    it("rerolls to another of the same difficulty, never the same group or one already held, and nothing when none is left", () => {
        const dealt = draw.deal("daily", pool, "Alba", "2026-09-29");
        const replacing = dealt[1]!;
        const next = draw.reroll(pool, replacing, dealt, "seed")!;
        expect(next.tier).toBe(replacing.tier);
        expect(next.template).not.toBe(replacing.template);
        expect(template(next.template).group).not.toBe(template(replacing.template).group);
        expect(dealt.some((one) => one.template === next.template)).toBe(false);
        const lonely = [replacing];
        expect(draw.reroll(lonely, replacing, lonely, "seed")).toBeNull();
    });

    it("gives the card nine squares, laid out so no line is three hard ones", () => {
        const card = draw.layCard(draw.drawPool("card", input({ budget: draw.BUDGET.card })));
        expect(card).toHaveLength(9);
        for (const line of draw.LINES) {
            expect(line.every((square) => card[square]!.tier === "hard")).toBe(false);
        }
        expect(draw.completeLines([true, true, true, false, false, false, false, false, false])).toEqual([0]);
        expect(draw.completeLines(Array(9).fill(true))).toHaveLength(8);
    });

    it("names objectives under pc_, short enough for any version", () => {
        const names = Object.values(draw.objectivesFor("daily", draw.poolCriteria(draw.drawPool("daily", input()))));
        for (const name of names) {
            expect(name).toMatch(/^pc_d\d+$/);
            expect(name.length).toBeLessThanOrEqual(16);
        }
    });

    it("draws a community goal scaled by how many play", () => {
        const two = draw.autoGoal(settings, "1.21.4", 2, "seed")!;
        const ten = draw.autoGoal(settings, "1.21.4", 10, "seed")!;
        expect(two.template).toBe(ten.template);
        expect(ten.target).toBeGreaterThan(two.target);
        expect(template(two.template).layers).toContain("community");
    });
});

describe("the calendar", () => {
    const madrid: period.Clock = { timezone: "Europe/Madrid", resetAt: "06:00", weekDay: 1 };

    it("starts a day at the reset time in the server's zone", () => {
        // 05:30 in Madrid (03:30 UTC in summer) is still the day before.
        expect(period.dayKey(madrid, Date.parse("2026-09-29T03:30:00Z"))).toBe("2026-09-28");
        expect(period.dayKey(madrid, Date.parse("2026-09-29T04:30:00Z"))).toBe("2026-09-29");
        expect(period.msToNextDay(madrid, Date.parse("2026-09-29T03:30:00Z"))).toBe(30 * 60_000);
    });

    it("keeps a day, a week and a goal on the reset across a change of the clocks", () => {
        // Madrid goes from +2 to +1 on 2026-10-25: 06:00 there is 04:00 UTC before, 05:00 after.
        expect(new Date(period.dayStartsAt(madrid, "2026-10-24")).toISOString()).toBe("2026-10-24T04:00:00.000Z");
        expect(new Date(period.dayStartsAt(madrid, "2026-10-26")).toISOString()).toBe("2026-10-26T05:00:00.000Z");
        expect(new Date(period.dayEndsAt(madrid, Date.parse("2026-10-25T12:00:00Z"))).toISOString()).toBe("2026-10-26T05:00:00.000Z");
        expect(new Date(period.weekEndsAt(madrid, Date.parse("2026-10-21T12:00:00Z"))).toISOString()).toBe("2026-10-26T05:00:00.000Z");
    });

    it("starts a week on the chosen day and a month on the first", () => {
        const utc: period.Clock = { timezone: "UTC", resetAt: "00:00", weekDay: 1 };
        expect(period.weekKey(utc, Date.parse("2026-10-01T12:00:00Z"))).toBe("2026-09-28");
        expect(period.weekKey({ ...utc, weekDay: 0 }, Date.parse("2026-10-01T12:00:00Z"))).toBe("2026-09-27");
        expect(period.monthKey(utc, Date.parse("2026-10-01T12:00:00Z"))).toBe("2026-10");
        const ends = period.weekEndsAt(utc, Date.parse("2026-10-01T12:00:00Z"));
        expect(new Date(ends).toISOString()).toBe("2026-10-05T00:00:00.000Z");
        expect(new Date(period.monthEndsAt(utc, Date.parse("2026-12-15T12:00:00Z"))).toISOString()).toBe("2027-01-01T00:00:00.000Z");
    });

    it("counts seasons in runs of whole weeks from the first day", () => {
        const utc: period.Clock = { timezone: "UTC", resetAt: "00:00", weekDay: 1 };
        const first = period.seasonOf(utc, Date.parse("2026-09-29T12:00:00Z"), "2026-09-01", 6);
        expect(first).toMatchObject({ number: 1, startDay: "2026-09-01", endDay: "2026-10-12", daysLeft: 14 });
        expect(period.seasonOf(utc, Date.parse("2026-10-13T12:00:00Z"), "2026-09-01", 6).number).toBe(2);
    });
});

describe("the season", () => {
    const ledger = stored.readLedger(null, "s#1");

    it("adds points up to the day's cap, and crosses tiers", () => {
        const first = season.addPoints(ledger, 150, "2026-09-29", settings, false);
        expect(first.granted).toBe(150);
        expect(first.tiers).toEqual([1]);
        const second = season.addPoints(first.ledger, 100, "2026-09-29", settings, false);
        expect(second.granted).toBe(50);
        expect(second.ledger.points).toBe(200);
        expect(second.tiers).toEqual([2]);
        const tomorrow = season.addPoints(second.ledger, 100, "2026-09-30", settings, false);
        expect(tomorrow.granted).toBe(100);
    });

    it("pays half as much again in the last two weeks to players below the middle", () => {
        const late: period.Season = { key: "s", number: 1, startDay: "a", endDay: "b", endsAt: 0, daysLeft: 10 };
        const early = { ...late, daysLeft: 30 };
        expect(season.catchUpApplies(settings, late, 2, 5)).toBe(true);
        expect(season.catchUpApplies(settings, early, 2, 5)).toBe(false);
        expect(season.catchUpApplies(settings, late, 6, 5)).toBe(false);
        expect(season.addPoints(ledger, 20, "d", settings, true).granted).toBe(30);
        expect(season.medianTier([0, 1, 3, 5])).toBe(3);
        expect(season.medianTier([2, 4])).toBe(3);
    });

    it("gives items only at the milestone tiers", () => {
        expect(season.tierReward(9, settings).items).toEqual([]);
        expect(season.tierReward(10, settings).items).toEqual([{ id: "minecraft:diamond", count: 3 }]);
        expect(season.tierReward(9, settings).levels).toBe(2);
    });

    it("counts a streak day by day, forgives one missed day a week, and falls back to the last milestone", () => {
        const clock: period.Clock = { timezone: "UTC", resetAt: "00:00", weekDay: 1 };
        let streak = ledger.streak;
        const days = ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"];
        const milestones: number[] = [];
        for (const day of days) {
            const next = season.streakAfter(streak, day, clock);
            streak = next.streak;
            if (next.milestone) milestones.push(next.milestone);
        }
        expect(streak.count).toBe(7);
        expect(milestones).toEqual([3, 7]);
        expect(season.streakAfter(streak, "2026-10-04", clock).streak).toEqual(streak);
        // One missed day (the 5th): the week's freeze covers it.
        const frozen = season.streakAfter(streak, "2026-10-06", clock).streak;
        expect(frozen.count).toBe(8);
        expect(frozen.freezeWeek).toBe("2026-10-05");
        // Another missed day the same week: back to the last milestone, 7, and today makes 8.
        const broken = season.streakAfter(frozen, "2026-10-08", clock).streak;
        expect(broken.count).toBe(8);
        expect(season.milestoneFloor(13)).toBe(7);
        expect(season.milestoneFloor(2)).toBe(0);
        expect(season.streakNow(frozen, "2026-10-06", clock)).toBe(8);
        expect(season.streakNow(frozen, "2026-10-07", clock)).toBe(8);
    });

    it("welcomes back somebody gone a week", () => {
        const now = Date.parse("2026-09-29T12:00:00Z");
        expect(season.isComeback({ ...ledger, lastDoneAt: now - 8 * 86_400_000 }, now)).toBe(true);
        expect(season.isComeback({ ...ledger, lastDoneAt: now - 86_400_000 }, now)).toBe(false);
        expect(season.isComeback(ledger, now)).toBe(false);
    });

    it("starts a new season from nothing but keeps the streak and titles", () => {
        const old = JSON.stringify({ ...ledger, season: "s#1", points: 900, titles: ["Champion"], streak: { count: 5, best: 5, lastDay: "x", freezeWeek: null } });
        const next = stored.readLedger(old, "s#2");
        expect(next.points).toBe(0);
        expect(next.titles).toEqual(["Champion"]);
        expect(next.streak.count).toBe(5);
    });
});
