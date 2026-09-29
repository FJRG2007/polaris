/**
 * What finishing challenges pays, what the in-game menu says, and the commands
 * it is said with - none of which may ever take anything from a player.
 */

import { describe, expect, it } from "vitest";
import * as draw from "@polaris-app/game-servers/src/lib/minecraft/challenges/draw";
import * as play from "@polaris-app/game-servers/src/lib/minecraft/challenges/play";
import * as stored from "@polaris-app/game-servers/src/lib/minecraft/challenges/state";
import * as catalog from "@polaris-app/game-servers/src/lib/minecraft/challenges/catalog";
import * as commands from "@polaris-app/game-servers/src/lib/minecraft/challenges/commands";
import * as messages from "@polaris-app/game-servers/src/lib/minecraft/challenges/messages";
import * as progress from "@polaris-app/game-servers/src/lib/minecraft/challenges/progress";
import * as settingsModule from "@polaris-app/game-servers/src/lib/minecraft/challenges/settings";

const NOW = Date.parse("2026-09-29T12:00:00Z");
const clock = { timezone: "UTC", resetAt: "00:00", weekDay: 1 };
const settings = settingsModule.settingsSchema.parse({ enabled: true });
const context = (patch: Partial<play.Context> = {}): play.Context => ({
    settings,
    language: "en",
    now: NOW,
    clock,
    day: "2026-09-29",
    season: {
        key: "s#1",
        number: 1,
        startDay: "2026-09-01",
        endDay: "2026-10-12",
        endsAt: NOW,
        daysLeft: 14
    },
    medianTier: 0,
    spelling: "both",
    ...patch
});
const keys = { daily: "2026-09-29", weekly: "2026-09-28", card: "2026-09" };

function withDaily(done: readonly boolean[]): stored.PlayerRecord {
    const tiers = ["easy", "medium", "hard"] as const;
    const instances = ["F4", "F1", "C2"].map((template, index) => {
        const one = progress.dealt(
            {
                template,
                variant: template === "C2" ? "zombie" : null,
                tier: tiers[index]!,
                target: 3
            },
            {},
            NOW - 1000
        );
        return done[index] ? { ...one, progress: 3, doneAt: NOW } : one;
    });
    return {
        ...stored.newPlayer("Alba", NOW),
        daily: { key: keys.daily, instances, rerolls: 0, swept: false, lines: [], full: false }
    };
}

describe("settling what was finished", () => {
    it("pays each finished challenge once: points, levels, a title and a line", () => {
        const first = play.settle(
            withDaily([true, false, false]),
            stored.readLedger(null, "s#1"),
            context(),
            keys
        );
        expect(first.ledger.points).toBe(10);
        expect(first.effects).toContainEqual({
            kind: "pay",
            payout: settings.rewards.daily.easy,
            label: "Harvest 3 pumpkins and melons"
        });
        expect(first.effects.some((one) => one.kind === "title")).toBe(true);
        expect(first.record.daily!.instances[0]!.paid).toBe(true);
        const again = play.settle(first.record, first.ledger, context(), keys);
        expect(again.effects).toEqual([]);
        expect(again.ledger.points).toBe(10);
    });

    it("adds the sweep bonus for all three, and starts the streak", () => {
        const all = play.settle(
            withDaily([true, true, true]),
            stored.readLedger(null, "s#1"),
            context(),
            keys
        );
        expect(all.ledger.points).toBe(10 + 20 + 40 + 15);
        expect(all.record.daily!.swept).toBe(true);
        expect(all.ledger.streak.count).toBe(1);
        expect(
            all.effects.some((one) => one.kind === "tell" && one.line.includes("Clean sweep"))
        ).toBe(true);
    });

    it("stops at the day's cap and says so once", () => {
        const capped = settingsModule.settingsSchema.parse({ season: { dailyCap: 25 } });
        const paid = play.settle(
            withDaily([true, true, true]),
            stored.readLedger(null, "s#1"),
            context({ settings: capped }),
            keys
        );
        expect(paid.ledger.points).toBe(25);
        expect(
            paid.effects.filter(
                (one) => one.kind === "tell" && one.line.includes("most season points")
            )
        ).toHaveLength(1);
    });

    it("pays a challenge done on another server of a shared season only once", () => {
        const ledger = { ...stored.readLedger(null, "s#1"), done: ["daily:2026-09-29:F4"] };
        const settled = play.settle(withDaily([true, false, false]), ledger, context(), keys);
        expect(settled.ledger.points).toBe(0);
        expect(settled.effects.some((one) => one.kind === "pay")).toBe(false);
    });

    it("pays each bingo line once and the full card", () => {
        const instances = Array.from({ length: 9 }, (_, index) => ({
            ...progress.dealt(
                {
                    template: ["F5", "F6", "F7", "M1", "M2", "C1", "E1", "E2", "B1"][index]!,
                    variant: null,
                    tier: "easy",
                    target: 1
                },
                {},
                NOW
            ),
            doneAt: index < 3 ? NOW : null,
            progress: index < 3 ? 1 : 0
        }));
        const record = {
            ...stored.newPlayer("Alba", NOW),
            card: { key: keys.card, instances, rerolls: 0, swept: false, lines: [], full: false }
        };
        const settled = play.settle(record, stored.readLedger(null, "s#1"), context(), keys);
        expect(settled.record.card!.lines).toEqual([0]);
        expect(settled.ledger.points).toBe(3 * 30 + 50);
        const full = {
            ...settled.record,
            card: {
                ...settled.record.card!,
                instances: settled.record.card!.instances.map((one) => ({
                    ...one,
                    doneAt: one.doneAt ?? NOW
                }))
            }
        };
        const all = play.settle(full, settled.ledger, context(), keys);
        expect(all.record.card!.full).toBe(true);
        expect(all.record.card!.lines).toHaveLength(8);
        expect(
            all.effects.some(
                (one) =>
                    one.kind === "pay" &&
                    one.payout.items.some((item) => item.id === "minecraft:diamond")
            )
        ).toBe(true);
    });

    it("keeps unfinished dailies for three days, three at most", () => {
        const day = withDaily([true, false, false]);
        const kept = play.toBacklog(
            day,
            day.daily!,
            "2026-09-29",
            "2026-09-30",
            (key) => Date.parse(key) / 86_400_000
        );
        expect(kept.backlog.map((one) => one.template)).toEqual(["F1", "C2"]);
        const old = play.toBacklog(
            kept,
            day.daily!,
            "2026-09-29",
            "2026-10-03",
            (key) => Date.parse(key) / 86_400_000
        );
        expect(old.backlog).toEqual([]);
    });

    it("moves a day to the backlog once however often it is closed, each ready to be dealt again", () => {
        const day = withDaily([true, false, false]);
        const read = {
            ...day,
            daily: {
                ...day.daily!,
                instances: day.daily!.instances.map((one) => ({ ...one, readAt: NOW, progress: 1 }))
            }
        };
        const once = play.toBacklog(
            read,
            read.daily!,
            "2026-09-29",
            "2026-09-30",
            (key) => Date.parse(key) / 86_400_000
        );
        const twice = play.toBacklog(
            once,
            read.daily!,
            "2026-09-29",
            "2026-09-30",
            (key) => Date.parse(key) / 86_400_000
        );
        expect(twice.backlog.map((one) => one.template)).toEqual(["F1", "C2"]);
        expect(
            twice.backlog.every(
                (one) =>
                    one.readAt === null && one.carry === 1 && Object.keys(one.base).length === 0
            )
        ).toBe(true);
    });
});

describe("the in-game menu", () => {
    const record = withDaily([true, false, false]);
    const ledger = stored.readLedger(null, "s#1");
    const input = {
        dayLeft: 5 * 3_600_000,
        weekLeft: 3 * 86_400_000,
        rerollsLeft: { daily: 1, weekly: 1 },
        goals: []
    };

    it("lists the challenges with a [Track] and [Change] per line, and fits every line in what the console sends", () => {
        for (const language of ["en", "es"] as const) {
            for (const spelling of ["both", "legacy", "modern"] as const) {
                const lines = play.menu(
                    "Alba",
                    record,
                    ledger,
                    context({ language, spelling }),
                    input
                );
                expect(lines.length).toBeGreaterThan(3);
                for (const line of lines) {
                    expect(line.startsWith("tellraw Alba ")).toBe(true);
                    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(1014);
                    expect(line).not.toMatch(/[\u0080-￿]/);
                }
                const joined = lines.join("\n");
                expect(joined).toContain("/trigger pc_menu set 21");
                expect(joined).toContain("/trigger pc_menu set 11");
                expect(joined.includes('"clickEvent"')).toBe(spelling !== "modern");
                expect(joined.includes('"click_event"')).toBe(spelling !== "legacy");
            }
        }
    });

    it("offers no [Change] once the swaps are used, and none on a finished one", () => {
        const lines = play
            .menu("Alba", record, ledger, context(), {
                ...input,
                rerollsLeft: { daily: 0, weekly: 0 }
            })
            .join("\n");
        expect(lines).not.toContain("/trigger pc_menu set 1");
        expect(lines).not.toContain("set 20");
    });

    it("draws the card as three rows of squares, and the season in lines", () => {
        const card = {
            key: keys.card,
            instances: Array.from({ length: 9 }, () =>
                progress.dealt({ template: "K2", variant: null, tier: "easy", target: 12 }, {}, NOW)
            ),
            rerolls: 0,
            swept: false,
            lines: [],
            full: false
        };
        const lines = play.cardMenu(
            "Alba",
            { ...record, card },
            context({ language: "es" }),
            86_400_000
        );
        for (const line of lines) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(1014);
        expect(lines.join("\n")).toContain("set 38");
        const season = play.seasonMenu("Alba", { ...ledger, points: 340 }, context());
        expect(season.join("\n")).toContain("Tier ");
    });
});

describe("the commands", () => {
    it("never places, breaks, kills, summons or takes anything", () => {
        const lines = [
            ...commands.addObjectives(
                draw.objectivesFor("daily", ["minecraft.mined:minecraft.stone"])
            ),
            ...commands.MENU_SETUP,
            commands.READ_PRESSES,
            ...commands.pressHandled("Alba"),
            commands.heldCount("Alba", "red_dye"),
            commands.hasAdvancement("Alba", "story/mine_stone"),
            commands.actionBar("Alba", "&ehi"),
            ...commands.completion("Alba", "&6Done", "&fthing"),
            ...commands.barShow(commands.trackedBar("Alba"), "&ehi", 3, 10, "Alba", "yellow"),
            ...commands.teardown(["pc_d0"], [commands.trackedBar("Alba")]),
            ...commands.giveLines("Alba", {
                levels: 3,
                items: [{ id: "minecraft:diamond", count: 2 }]
            }).items,
            commands.giveLines("Alba", { levels: 3, items: [] }).levels!
        ];
        for (const line of lines) {
            expect(line).not.toMatch(
                /^(setblock|fill |kill |summon |item replace|data (merge|modify|remove)|xp set|tp |teleport )/
            );
            expect(line).not.toMatch(/^clear \S+( \S+( [1-9]\d*)?)?$/);
            expect(line).not.toMatch(/^xp (add|remove) \S+ -/);
            expect(line).not.toMatch(/objectives remove (?!pc_)/);
        }
        expect(commands.heldCount("Alba", "red_dye")).toBe("clear Alba minecraft:red_dye 0");
        expect(commands.giveLines("Alba", { levels: 0, items: [] }).levels).toBeNull();
    });

    it("writes the button click both ways unless the version is known", () => {
        const both = JSON.stringify(commands.button("[Go]", "&7hover", 1, "aqua", "both"));
        expect(both).toContain(
            '"clickEvent":{"action":"run_command","value":"/trigger pc_menu set 1"}'
        );
        expect(both).toContain(
            '"click_event":{"action":"run_command","command":"/trigger pc_menu set 1"}'
        );
        expect(both).toContain('"hoverEvent"');
        expect(both).toContain('"hover_event"');
        expect(commands.spellingFor("1.21.5", (wanted) => catalog.atLeast("1.21.5", wanted))).toBe(
            "modern"
        );
        expect(commands.spellingFor("1.16.5", (wanted) => catalog.atLeast("1.16.5", wanted))).toBe(
            "legacy"
        );
        expect(commands.spellingFor(null, () => true)).toBe("both");
    });

    it("splits a line too long for the console tool at its pieces", () => {
        const pieces = Array.from({ length: 12 }, (_, index) =>
            commands.button(`[${index}]`, "&7a long hover text for the test", index, "aqua", "both")
        );
        const lines = commands.fitted("Alba", pieces);
        expect(lines.length).toBeGreaterThan(1);
        for (const line of lines) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(1014);
    });

    it("says rewards in both languages", () => {
        expect(
            messages.rewardText(
                { points: 20, levels: 2, items: [{ id: "minecraft:diamond_block", count: 1 }] },
                "en"
            )
        ).toBe("+20 pts, 2 levels, 1 diamond block");
        expect(messages.rewardText({ points: 0, levels: 1, items: [] }, "es")).toBe("1 nivel");
        expect(messages.joinLine(2, "es")).toContain("quedan");
        expect(messages.duration(3 * 3_600_000 + 12 * 60_000, "en")).toBe("3 h 12 min");
    });
});

describe("community goals", () => {
    it("reaches a tier every fifth of the target, and rewards who gave at least the least share", () => {
        expect(play.goalTier(0, 1000)).toBe(0);
        expect(play.goalTier(199, 1000)).toBe(0);
        expect(play.goalTier(200, 1000)).toBe(1);
        expect(play.goalTier(5000, 1000)).toBe(5);
        const goal = stored.goalStateSchema.parse({
            id: "g",
            template: "M1",
            target: 1000,
            startedAt: 0,
            endsAt: 1,
            minShare: 2,
            rewards: [],
            shares: {
                alba: { name: "Alba", value: 190 },
                bruno: { name: "Bruno", value: 10 },
                carla: { name: "Carla", value: 3 }
            }
        });
        // Tier I needed 200; 2% of it is 4.
        expect(play.goalEarners(goal, 1)).toEqual(["Alba", "Bruno"]);
    });
});

describe("the settings", () => {
    it("reads an empty server as switched off, in its events' zone and language", () => {
        const read = settingsModule.readSettings({}, { timezone: "Europe/Madrid", language: "es" });
        expect(read.enabled).toBe(false);
        expect(read.timezone).toBe("Europe/Madrid");
        expect(read.language).toBe("es");
        expect(read.rewards.daily.hard.points).toBe(40);
        expect(read.season.tiers).toBe(40);
    });

    it("refuses a shared season with no group, and a goal that cannot be one", () => {
        expect(settingsModule.settingsSchema.safeParse({ shared: { enabled: true } }).success).toBe(
            false
        );
        const goal = {
            id: "g",
            template: "C10",
            target: 10,
            start: "2026-09-29",
            rewards: Array(5).fill({})
        };
        expect(
            settingsModule.settingsSchema.safeParse({ community: { goals: [goal] } }).success
        ).toBe(false);
        expect(
            settingsModule.settingsSchema.safeParse({
                community: { goals: [{ ...goal, template: "M1" }] }
            }).success
        ).toBe(true);
    });
});
