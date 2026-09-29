/**
 * The anti-exploit arithmetic and the readers of the game's answers, fed what
 * real servers print (vanilla glues its lines together; NeoForge ends each with
 * a newline; a failed `execute` chain says nothing at all).
 */

import { describe, expect, it } from "vitest";
import * as catalog from "@polaris-app/game-servers/src/lib/minecraft/challenges/catalog";
import * as progress from "@polaris-app/game-servers/src/lib/minecraft/challenges/progress";
import * as replies from "@polaris-app/game-servers/src/lib/minecraft/events/replies";

const template = (id: string) => catalog.templateOf(id)!;
const NOW = Date.parse("2026-09-29T12:00:00Z");
const look = (patch: Partial<progress.Look> = {}): progress.Look => ({
    now: NOW,
    active: true,
    afk: true,
    caps: true,
    gate: null,
    requirement: true,
    ...patch
});
const deal = (id: string, target: number, variant: string | null = null) =>
    progress.dealt({ template: id, variant, tier: "easy", target }, {}, NOW - 60_000);

const MINED_PUMPKIN = "minecraft.mined:minecraft.pumpkin";
const USED_PUMPKIN = "minecraft.used:minecraft.pumpkin";

describe("counting net of the tricks", () => {
    it("counts a pumpkin placed and broken again as nothing, and one grown as one", () => {
        const check = catalog.checkOf(template("F4"), null);
        expect(progress.measure(check, { [MINED_PUMPKIN]: 3, [USED_PUMPKIN]: 3 }, {})).toBe(0);
        expect(progress.measure(check, { [MINED_PUMPKIN]: 4, [USED_PUMPKIN]: 3 }, {})).toBe(1);
        // Seen in two halves across two reads: placed, then broken.
        let instance = deal("F4", 3);
        instance = progress.credit(
            instance,
            template("F4"),
            progress.measure(check, { [USED_PUMPKIN]: 1 }, {})!,
            look()
        );
        instance = progress.credit(
            instance,
            template("F4"),
            progress.measure(check, { [USED_PUMPKIN]: 1, [MINED_PUMPKIN]: 1 }, {})!,
            look()
        );
        expect(instance.progress).toBe(0);
    });

    it("counts wheat thrown and picked back up as nothing", () => {
        const check = catalog.checkOf(template("F1"), null);
        const values = {
            "minecraft.picked_up:minecraft.wheat": 10,
            "minecraft.dropped:minecraft.wheat": 10
        };
        expect(progress.measure(check, values, {})).toBe(0);
        expect(
            progress.measure(check, { ...values, "minecraft.picked_up:minecraft.wheat": 15 }, {})
        ).toBe(5);
    });

    it("counts from where each statistic stood when the challenge was dealt", () => {
        const check = catalog.checkOf(template("F1"), null);
        expect(
            progress.measure(
                check,
                { "minecraft.picked_up:minecraft.wheat": 30 },
                { "minecraft.picked_up:minecraft.wheat": 25 }
            )
        ).toBe(5);
    });

    it("never counts more ingots than raw iron was gathered", () => {
        const check = catalog.checkOf(template("Cr2"), null);
        const blockOfIron = { "minecraft.crafted:minecraft.iron_ingot": 9 };
        expect(progress.measure(check, blockOfIron, {})).toBe(0);
        expect(
            progress.measure(
                check,
                { ...blockOfIron, "minecraft.picked_up:minecraft.raw_iron": 4 },
                {}
            )
        ).toBe(4);
    });

    it("counts distinct kinds, each once", () => {
        const check = catalog.checkOf(template("C3"), null);
        expect(
            progress.measure(
                check,
                {
                    "minecraft.killed:minecraft.zombie": 40,
                    "minecraft.killed:minecraft.skeleton": 1
                },
                {}
            )
        ).toBe(2);
    });

    it("starts a deathless run over on a death", () => {
        const deathless = template("C9");
        const check = catalog.checkOf(deathless, null);
        const time = "minecraft.custom:minecraft.time_since_death";
        let instance = deal("C9", 72_000);
        instance = progress.credit(
            instance,
            deathless,
            progress.measure(check, { [time]: 40_000 }, {})!,
            look()
        );
        expect(instance.progress).toBe(40_000);
        instance = progress.credit(
            instance,
            deathless,
            progress.measure(check, { [time]: 300 }, {})!,
            look()
        );
        expect(instance.progress).toBe(300);
        // Without the walking, the hour does not complete.
        const walked = { [time]: 72_000, "minecraft.custom:minecraft.walk_one_cm": 10_000 };
        expect(progress.requirementMet(check, walked, {}, 72_000)).toBe(false);
        expect(
            progress.requirementMet(
                check,
                { ...walked, "minecraft.custom:minecraft.walk_one_cm": 60_000 },
                {},
                72_000
            )
        ).toBe(true);
    });

    it("asks half a cod target to be real catches", () => {
        const check = catalog.checkOf(template("Fi4"), null);
        const cod = { "minecraft.picked_up:minecraft.cod": 10 };
        expect(progress.requirementMet(check, cod, {}, 10)).toBe(false);
        expect(
            progress.requirementMet(
                check,
                { ...cod, "minecraft.custom:minecraft.fish_caught": 5 },
                {},
                10
            )
        ).toBe(true);
    });
});

describe("crediting", () => {
    const hunt = template("C2");

    it("holds back what rose while the player stood still, and never gives it later", () => {
        let instance = deal("C2", 10, "zombie");
        instance = progress.credit(instance, hunt, 3, look({ active: false }));
        expect(instance.progress).toBe(0);
        expect(instance.offset).toBe(3);
        instance = progress.credit(instance, hunt, 5, look({ now: NOW + 60_000 }));
        expect(instance.progress).toBe(2);
        // With the rule off, standing still counts.
        const off = progress.credit(
            deal("C2", 10, "zombie"),
            hunt,
            3,
            look({ active: false, afk: false })
        );
        expect(off.progress).toBe(3);
    });

    it("credits no more than the per-minute ceiling", () => {
        const walker = template("E1");
        const instance = progress.credit(deal("E1", 10_000_000), walker, 500_000, look());
        // Dealt a minute before: at most one minute of sprinting.
        expect(instance.progress).toBe(36_000);
        expect(instance.offset).toBe(500_000 - 36_000);
        const uncapped = progress.credit(
            deal("E1", 10_000_000),
            walker,
            500_000,
            look({ caps: false })
        );
        expect(uncapped.progress).toBe(500_000);
    });

    it("credits a treasure only in a look where a catch was made", () => {
        const treasure = template("Fi2");
        const check = catalog.checkOf(treasure, null);
        const values = { "minecraft.picked_up:minecraft.name_tag": 1 };
        expect(progress.gateRose(check, values, {})).toBe(false);
        expect(
            progress.gateRose(check, { ...values, "minecraft.custom:minecraft.fish_caught": 1 }, {})
        ).toBe(true);
        const fromChest = progress.credit(deal("Fi2", 1), treasure, 1, look({ gate: false }));
        expect(fromChest.doneAt).toBeNull();
        const fished = progress.credit(deal("Fi2", 1), treasure, 1, look({ gate: true }));
        expect(fished.doneAt).toBe(NOW);
    });

    it("finishes at the target, once, and then never moves", () => {
        const done = progress.credit(deal("C2", 3, "zombie"), hunt, 7, look());
        expect(done.progress).toBe(3);
        expect(done.doneAt).toBe(NOW);
        expect(progress.credit(done, hunt, 0, look())).toBe(done);
    });

    it("holds a finished one back until what it requires on the side is met", () => {
        const wool = progress.credit(
            deal("T6", 16),
            template("T6"),
            20,
            look({ requirement: false })
        );
        expect(wool.doneAt).toBeNull();
        expect(wool.progress).toBe(16);
    });

    it("loses a voided challenge for good, but never one already finished", () => {
        const lost = progress.voided(progress.credit(deal("M1", 30), template("M1"), 10, look()));
        expect(lost).toMatchObject({ voided: true, progress: 0 });
        expect(progress.credit(lost, template("M1"), 40, look()).progress).toBe(0);
        const done = progress.credit(deal("M1", 5), template("M1"), 10, look());
        expect(progress.voided(done)).toBe(done);
    });

    it("adds what a backlog challenge had carried over", () => {
        const carried = { ...deal("F4", 10), carry: 4 };
        expect(progress.credit(carried, template("F4"), 3, look()).progress).toBe(7);
    });
});

describe("reading what the server answers", () => {
    it("reads a player's scores glued together, as vanilla sends them", () => {
        expect(progress.readList("Alba has 3 score(s):[pc_d0]: 5[pc_d12]: -2[pc_menu]: 0")).toEqual(
            { pc_d0: 5, pc_d12: -2, pc_menu: 0 }
        );
    });

    it("reads them a line each, as NeoForge sends them, and with the console's colour codes", () => {
        expect(
            progress.readList("Alba has 2 score(s):\n[pc_d1]: 7\n[pc_d0]: 5\n\u001b[0m\n")
        ).toEqual({ pc_d1: 7, pc_d0: 5 });
    });

    it("reads 1.16's wording, and nothing from a player with no scores", () => {
        expect(progress.readList("Eva has 1 scores:[pc_d1]: 7")).toEqual({ pc_d1: 7 });
        expect(progress.readList("Nobody has no scores to show")).toEqual({});
        expect(progress.readList("")).toEqual({});
    });

    it("leaves out everything that is not Polaris's own", () => {
        expect(progress.readList("Alba has 2 score(s):[deaths]: 4[pe_hit]: 9[pc_w3]: 1")).toEqual({
            pc_w3: 1
        });
    });

    it("reads the objectives that exist, glued or not", () => {
        const made = progress.readObjectives(
            "There are 3 objective(s): [pc_menu], [pc_d0], [pe_hit]"
        );
        expect([...made]).toEqual(["pc_menu", "pc_d0"]);
        expect(
            progress.readObjectives("There are 2 objectives: [pc_d1], [pc_menu]\n").has("pc_d1")
        ).toBe(true);
    });

    it("reads button presses glued together, whatever the bracket shows", () => {
        const presses = progress.readPresses(
            "Alba has 11 [pc_menu]Bruno has 1 [Retos del servidor]"
        );
        expect([...presses]).toEqual([
            ["Alba", 11],
            ["Bruno", 1]
        ]);
        // Nobody pressed anything: an `execute as` over nobody answers nothing.
        expect(progress.readPresses("").size).toBe(0);
    });

    it("reads presses by each player's own name through the display names 1.20.3 prints", () => {
        // A team's prefix and suffix, a Floodgate player, glued with no line break.
        const said = "[VIP] Alba [AFK] has 11 [pc_menu].Bo has 1 [pc_menu]";
        const read = replies.canonicalReplies(said, null);
        const text = read.needsRoster
            ? replies.canonicalReplies(said, ["Alba", ".Bo"]).text
            : read.text;
        expect([...progress.readPresses(text)]).toEqual([
            ["Alba", 11],
            [".Bo", 1]
        ]);
    });

    it("counts what somebody holds, and nothing from a refusal", () => {
        expect(progress.readHeld("Found 3 matching item(s) on player Alba")).toBe(3);
        expect(progress.readHeld("No items were found on player Alba")).toBe(0);
        expect(progress.readHeld("No player was found")).toBe(0);
    });

    it("takes only Test passed as an advancement held", () => {
        expect(progress.passed("Test passed")).toBe(true);
        expect(progress.passed("Test failed\n")).toBe(false);
        expect(progress.passed("")).toBe(false);
    });

    it("maps a player's scores to statistics through a period's objectives", () => {
        const objectives = { [MINED_PUMPKIN]: "pc_d0", [USED_PUMPKIN]: "pc_d2" };
        expect(progress.valuesOf({ pc_d0: 4, pc_d2: 1, pc_d9: 8 }, objectives)).toEqual({
            [MINED_PUMPKIN]: 4,
            [USED_PUMPKIN]: 1
        });
    });
});

describe("the advancements file", () => {
    const file = JSON.stringify({
        "minecraft:husbandry/balanced_diet": {
            criteria: { apple: "2026-09-01 10:00:00 +0000", bread: "2026-09-29 11:00:00 +0200" },
            done: false
        },
        "minecraft:story/mine_stone": {
            criteria: { get_stone: "2026-09-29 12:30:00 +0000" },
            done: true
        },
        "minecraft:recipes/misc/bread": {
            criteria: { has: "2026-09-29 12:30:00 +0000" },
            done: true
        },
        DataVersion: 4189
    });
    const since = Date.parse("2026-09-29T08:00:00Z");

    it("counts criteria earned after the period began, zones included", () => {
        expect(progress.earnedSince(file, since, ["husbandry/balanced_diet"])).toEqual([
            "husbandry/balanced_diet:bread"
        ]);
    });

    it("counts advancements completed since, leaving recipes out", () => {
        expect(progress.earnedSince(file, since, null)).toEqual(["story/mine_stone"]);
        expect(progress.earnedSince("not json", since, null)).toEqual([]);
    });

    it("reads the game's timestamps", () => {
        expect(progress.stamp("2026-09-29 11:00:00 +0200")).toBe(
            Date.parse("2026-09-29T09:00:00Z")
        );
        expect(progress.stamp("nonsense")).toBe(0);
    });
});

describe("what Polaris measures itself", () => {
    it("counts ground covered in the Nether, not portals or pearls", () => {
        const nether = "minecraft:the_nether";
        expect(
            progress.netherStep(
                { x: 0, z: 0, dimension: nether },
                { x: 30, z: 40, dimension: nether },
                20
            )
        ).toBe(50);
        expect(
            progress.netherStep(
                { x: 0, z: 0, dimension: nether },
                { x: 800, z: 0, dimension: nether },
                20
            )
        ).toBe(0);
        expect(
            progress.netherStep(
                { x: 0, z: 0, dimension: "minecraft:overworld" },
                { x: 30, z: 0, dimension: nether },
                20
            )
        ).toBe(0);
        expect(progress.netherStep(null, { x: 30, z: 0, dimension: nether }, 20)).toBe(0);
    });

    it("counts a village once, however often its bell rings", () => {
        expect(progress.cellOf(10, 10, "o")).toBe(progress.cellOf(150, 190, "o"));
        expect(progress.cellOf(10, 10, "o")).not.toBe(progress.cellOf(250, 10, "o"));
    });
});
