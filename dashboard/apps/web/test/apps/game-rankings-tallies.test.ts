/**
 * The leaderboards read out of the game's counters beyond deaths, kills and
 * time: distance, blocks mined, enchanting, crafting and the rest.
 *
 * What is pinned: each counter is read from the same stats file as the rest,
 * with flying and falling left out of the distance; a player filed under two
 * uuids adds up, except the run since the last death, which is the longest of
 * the two; each ranking reads in its own unit and short enough for a line; and
 * every ranking is offered as a variable, a ready-made block and a preview.
 */

import { describe, expect, it } from "vitest";

const { addTallies, countText, distanceText, readTallies, statsRanking, STATS_RANKINGS } = await import(
    "@polaris-app/game-servers/src/lib/minecraft/rankings"
);
const { VARIABLES, RANK_VARIABLES } = await import("@polaris-app/game-servers/src/lib/minecraft/text-vars");
const { SIDEBAR_BLOCKS } = await import("@polaris-app/game-servers/src/lib/minecraft/sidebar-blocks");

const file = JSON.stringify({
    stats: {
        "minecraft:custom": {
            "minecraft:walk_one_cm": 100_000,
            "minecraft:sprint_one_cm": 50_000,
            "minecraft:boat_one_cm": 25_000,
            "minecraft:aviate_one_cm": 25_000,
            "minecraft:fly_one_cm": 9_000_000,
            "minecraft:fall_one_cm": 9_000_000,
            "minecraft:enchant_item": 7,
            "minecraft:jump": 12_345,
            "minecraft:damage_dealt": 2_000,
            "minecraft:damage_taken": 400,
            "minecraft:fish_caught": 3,
            "minecraft:animals_bred": 4,
            "minecraft:traded_with_villager": 5,
            "minecraft:time_since_death": 72_000,
            "minecraft:sleep_in_bed": 6,
            "minecraft:open_chest": 10,
            "minecraft:open_barrel": 2,
            "minecraft:leave_game": 9
        },
        "minecraft:mined": {
            "minecraft:stone": 900,
            "minecraft:diamond_ore": 2,
            "minecraft:deepslate_diamond_ore": 3
        },
        "minecraft:crafted": { "minecraft:stick": 40, "minecraft:torch": 60 },
        "minecraft:killed": { "minecraft:ender_dragon": 1, "minecraft:wither": 2, "minecraft:zombie": 50 }
    },
    DataVersion: 4189
});

describe("the counters in a stats file", () => {
    it("are read from the file the rest comes from, distance without flying or falling", () => {
        expect(readTallies(file)).toEqual({
            travelledCm: 200_000,
            mined: 905,
            enchanted: 7,
            jumps: 12_345,
            damageDealt: 2_000,
            damageTaken: 400,
            fishCaught: 3,
            animalsBred: 4,
            villagerTrades: 5,
            crafted: 100,
            diamonds: 5,
            aliveTicks: 72_000,
            slept: 6,
            chestsOpened: 12,
            sessions: 9,
            bossesSlain: 3
        });
    });

    it("are nothing for a file that is not one", () => {
        expect(readTallies("not json")).toBeNull();
        expect(readTallies('{"DataVersion":4189}')).toBeNull();
    });

    it("add up over two files of one player, but a life is the longer of the two", () => {
        const one = readTallies(file)!;
        const both = addTallies([one, { ...one, aliveTicks: 10 }])!;
        expect(both.mined).toBe(1_810);
        expect(both.aliveTicks).toBe(72_000);
        expect(addTallies([])).toBeNull();
    });
});

describe("the new leaderboards", () => {
    const players = [
        { name: "Steve", stats: { playedMs: 1, deaths: 0, mobKills: 0, playerKills: 0 }, tallies: readTallies(file)! },
        { name: "Alex", stats: { playedMs: 1, deaths: 0, mobKills: 0, playerKills: 0 } }
    ];

    it("read in their own units, and leave out a player with no counters", () => {
        expect(statsRanking("rank.explorer", players)).toEqual(["1. Steve 2km"]);
        expect(statsRanking("rank.mined", players)).toEqual(["1. Steve 905"]);
        expect(statsRanking("rank.jumps", players)).toEqual(["1. Steve 12.3k"]);
        expect(statsRanking("rank.damage", players)).toEqual(["1. Steve 100"]);
        expect(statsRanking("rank.alive", players)).toEqual(["1. Steve 1h"]);
        expect(statsRanking("rank.bosses", players)).toEqual(["1. Steve 3"]);
        expect(statsRanking("rank.chests", players)).toEqual(["1. Steve 12"]);
    });

    it("stay short on a line", () => {
        expect(countText(9_999)).toBe("9999");
        expect(countText(37_403)).toBe("37.4k");
        expect(countText(17_000)).toBe("17k");
        expect(countText(2_500_000)).toBe("2.5M");
        expect(distanceText(85_000)).toBe("850m");
        expect(distanceText(41_250_000)).toBe("412.5km");
    });

    it("are each offered as a variable, a ready-made block and a preview sample", () => {
        const offered = new Set(VARIABLES.map((spec) => spec.name));
        for (const name of STATS_RANKINGS) {
            expect(offered.has(name)).toBe(true);
            expect(RANK_VARIABLES).toContain(name);
            expect(SIDEBAR_BLOCKS.some((block) => block.id === name)).toBe(true);
        }
        expect(STATS_RANKINGS).toHaveLength(20);
    });
});
