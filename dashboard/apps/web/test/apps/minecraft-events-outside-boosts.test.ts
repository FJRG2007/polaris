/**
 * A beacon's effects taken off whoever is playing an event.
 *
 * Somebody who walked from a base with a beacon into a match played it with
 * speed, jump boost and regeneration nobody else had. Only the beacon's
 * ("ambient") effects are matched, so what the event itself gives - an arena's
 * respawn resistance, a round's regeneration - stays.
 */

import { describe, expect, it } from "vitest";
import * as outsideBoosts from "@polaris-app/game-servers/src/lib/minecraft/events/outside-boosts";

describe("taking a beacon's effects off the players", () => {
    it("tags exactly the players and clears only ambient effects from them", () => {
        const lines = outsideBoosts.stripLines(["Reckmy", "FJRG2007"]);
        expect(lines.slice(0, 3)).toEqual([
            "tag @a remove pe_unboost",
            "tag Reckmy add pe_unboost",
            "tag FJRG2007 add pe_unboost"
        ]);
        const clears = lines.slice(3);
        expect(clears.length).toBeGreaterThan(0);
        for (const line of clears) {
            expect(line.startsWith("effect clear @a[tag=pe_unboost,nbt={")).toBe(true);
            expect(/ambient:1b|Ambient:1b/.test(line)).toBe(true);
        }
        const beacon = ["speed", "haste", "strength", "jump_boost", "regeneration", "resistance"];
        for (const effect of beacon) {
            expect(clears).toContain(
                `effect clear @a[tag=pe_unboost,nbt={active_effects:[{id:"minecraft:${effect}",ambient:1b}]}] minecraft:${effect}`
            );
        }
    });

    it("asks the spelling from before 1.20.2 too", () => {
        expect(outsideBoosts.stripLines(["Reckmy"])).toContain(
            "effect clear @a[tag=pe_unboost,nbt={ActiveEffects:[{Id:8,Ambient:1b}]}] minecraft:jump_boost"
        );
    });

    it("sends nothing with nobody playing, and never a name that is not one", () => {
        expect(outsideBoosts.stripLines([])).toEqual([]);
        expect(outsideBoosts.stripLines(["@a", "x y", "a;b"])).toEqual([]);
        const lines = outsideBoosts.stripLines(["Reckmy", "@e[type=pig]", "Reckmy"]);
        expect(lines.filter((line) => line.startsWith("tag ") && line.includes(" add "))).toEqual([
            "tag Reckmy add pe_unboost"
        ]);
    });

    it("leaves boosts alone in an event that is itself a boost for everybody", () => {
        expect(outsideBoosts.strips("happy-hour")).toBe(false);
        expect(outsideBoosts.strips("xp-boost")).toBe(false);
        expect(outsideBoosts.strips("sky-wars")).toBe(true);
        expect(outsideBoosts.strips("parkour")).toBe(true);
        expect(outsideBoosts.strips("world-boss")).toBe(true);
    });

    it("takes the tag off everybody once the event is over", () => {
        expect(outsideBoosts.RELEASE_LINE).toBe("tag @a remove pe_unboost");
    });
});
