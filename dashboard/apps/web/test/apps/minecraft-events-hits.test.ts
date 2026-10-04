/**
 * An arena's hits, pure: the advancements the events data pack ships for them,
 * the batch that takes what they tagged, the game's counts read so a first hit
 * is not lost, and who a hit is credited to by the kinds that read them.
 */

import { describe, expect, it } from "vitest";
import * as hits from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/hits";
import * as arena from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/arena";
import * as duel from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/team-duel";
import * as hs from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/hide-and-seek";
import * as potato from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/hot-potato";
import * as ctf from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/capture-the-flag";
import * as snowballPack from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/snowball-pack";

describe("the events data pack's hits", () => {
    const files = snowballPack.packFiles();

    it("ships both advancements in both folder spellings, each rewarded by a function it has", () => {
        for (const folder of ["advancements", "advancement"]) {
            const hurt = JSON.parse(files.get(`data/polaris/${folder}/hit/hurt.json`)!);
            const struck = JSON.parse(files.get(`data/polaris/${folder}/hit/struck.json`)!);
            // Hurt by a player, never by a fall; a blow a shield stopped is no hit.
            expect(hurt.criteria.hit).toEqual({
                trigger: "minecraft:entity_hurt_player",
                conditions: {
                    damage: { source_entity: { type: "minecraft:player" }, blocked: false }
                }
            });
            expect(struck.criteria.hit).toEqual({
                trigger: "minecraft:player_hurt_entity",
                conditions: { entity: { type: "minecraft:player" }, damage: { blocked: false } }
            });
            // Nobody sees them: no display, so no toast and no chat line.
            expect(hurt.display).toBeUndefined();
            expect(struck.display).toBeUndefined();
            for (const [name, advancement] of [
                ["hurt", hurt],
                ["struck", struck]
            ] as const) {
                expect(advancement.rewards).toEqual({ function: `polaris:hit/${name}` });
                for (const functions of ["functions", "function"])
                    expect(files.get(`data/polaris/${functions}/hit/${name}.mcfunction`)).toBe(
                        `${hits.FUNCTIONS[name]!.join("\n")}\n`
                    );
            }
        }
    });

    it("counts a kill only of a monster the event summoned, and takes the advancement back", () => {
        for (const folder of ["advancements", "advancement"]) {
            const kill = JSON.parse(files.get(`data/polaris/${folder}/hit/kill.json`)!);
            expect(kill.criteria.hit).toEqual({
                trigger: "minecraft:player_killed_entity",
                conditions: { entity: { nbt: '{Tags:["pe_mob"]}' } }
            });
            expect(kill.rewards).toEqual({ function: "polaris:hit/kill" });
        }
        expect(hits.FUNCTIONS.kill).toEqual([
            "scoreboard players add @s pe_wkp 1",
            "advancement revoke @s only polaris:hit/kill"
        ]);
    });

    it("tags only a player an arena took in, and takes the advancement back so the next hit fires it", () => {
        expect(hits.FUNCTIONS.hurt).toEqual([
            `tag @s[tag=${arena.IN_ARENA}] add pe_hit_hurt`,
            "advancement revoke @s only polaris:hit/hurt"
        ]);
        expect(hits.FUNCTIONS.struck).toEqual([
            `tag @s[tag=${arena.IN_ARENA}] add pe_hit_struck`,
            "advancement revoke @s only polaris:hit/struck"
        ]);
        // Rewards only: nothing of theirs runs every tick.
        for (const folder of ["functions", "function"])
            expect(
                JSON.parse(files.get(`data/minecraft/tags/${folder}/tick.json`)!).values
            ).not.toContain("polaris:hit/tick");
    });

    it("takes what was tagged in one batch: copied before the live tags are cleared", () => {
        const copy = hits.TAKE.indexOf("tag @a[tag=pe_hit_hurt] add pe_hit_was_hurt");
        const clear = hits.TAKE.indexOf("tag @a remove pe_hit_hurt");
        expect(copy).toBeGreaterThan(hits.TAKE.indexOf("tag @a remove pe_hit_was_hurt"));
        expect(clear).toBeGreaterThan(copy);
        expect(hits.TAGS_OFF).toContain("tag @a remove pe_hit_was_struck");
        expect(hits.attackerLine("Ana")).toBe(
            "execute as Ana on attacker run data get entity @s Pos"
        );
    });
});

describe("a count the game keeps, read between looks", () => {
    it("counts nothing on the first look, when what came before is not known", () => {
        const tally = hits.tally();
        expect(hits.rose(tally, new Map([["Ana", 12]]), new Set(["ana"]))).toEqual(new Map());
        expect(hits.rose(tally, new Map([["Ana", 14]]), new Set(["ana"]))).toEqual(
            new Map([["Ana", 2]])
        );
    });

    it("counts a score's first appearance as a rise from nothing, for somebody who was on", () => {
        const tally = hits.tally();
        // Ana has dealt nothing yet: the game has no score for her at all.
        hits.rose(tally, new Map([["Ben", 0]]), new Set(["ana", "ben"]));
        expect(hits.roseFor(tally, new Map([["Ana", 2]]), new Set(["ana", "ben"]))).toEqual(
            new Set(["ana"])
        );
    });

    it("only notes what somebody who was off comes back with", () => {
        const tally = hits.tally();
        hits.rose(tally, new Map([["Ben", 0]]), new Set(["ben"]));
        expect(hits.rose(tally, new Map([["Cy", 40]]), new Set(["ben", "cy"]))).toEqual(new Map());
        expect(hits.rose(tally, new Map([["Cy", 42]]), new Set(["ben", "cy"]))).toEqual(
            new Map([["Cy", 2]])
        );
    });
});

describe("who a hit is credited to", () => {
    it("hot potato: to the holder only where the game said so", () => {
        expect(potato.hurtByHolder("Ana", "ana")).toBe(true);
        expect(potato.hurtByHolder("Ben", "Ana")).toBe(false);
        // Asked, and nothing hurt them: a fall, not the holder.
        expect(potato.hurtByHolder(null, "Ana")).toBe(false);
        // Not asked (before 1.19.4): anybody hurt was the holder's.
        expect(potato.hurtByHolder(undefined, "Ana")).toBe(true);
    });

    it("hide and seek: to the seeker the game names, nobody for a fall, else the nearest who struck", () => {
        const hider = { x: 0, y: 64, z: 0 };
        const near = { name: "Ana", x: 1, y: 64, z: 0 };
        const far = { name: "Ben", x: 3, y: 64, z: 0 };
        expect(hs.foundBy(hider, [near, far], "Ben", ["Ana", "Ben"])).toBe("Ben");
        expect(hs.foundBy(hider, [near, far], "Zed", ["Ana", "Ben"])).toBeNull();
        expect(hs.foundBy(hider, [near, far], null, ["Ana", "Ben"])).toBeNull();
        expect(hs.foundBy(hider, [near, far])).toBe("Ana");
        expect(hs.foundBy(hider, [{ ...far, x: 9 }])).toBeNull();
    });

    it("a duel or capture the flag: to the rival the game names, over a kill or whoever struck last", () => {
        const now = 100_000;
        const lastHit = new Map([["Cy", now - 500]]);
        expect(duel.creditFor(["Ben", "Cy"], new Map(), lastHit, now, "ben")).toBe("Ben");
        // A teammate or anything else named is nobody's credit; nor is a fall.
        expect(duel.creditFor(["Ben", "Cy"], new Map(), lastHit, now, "Dee")).toBeNull();
        expect(duel.creditFor(["Ben", "Cy"], new Map(), lastHit, now, null)).toBeNull();
        // Somebody else's kill this look is not this player's.
        expect(duel.creditFor(["Ben", "Cy"], new Map([["Cy", 1]]), lastHit, now, "Ben")).toBe(
            "Ben"
        );
        // Not asked (a death, or before 1.19.4): the kill the game counted,
        // else whoever struck last, within a few seconds.
        expect(duel.creditFor(["Ben", "Cy"], new Map([["Ben", 1]]), lastHit, now)).toBe("Ben");
        expect(duel.creditFor(["Ben", "Cy"], new Map(), lastHit, now)).toBe("Cy");
    });
});

describe("capture the flag's marks and health", () => {
    it("takes the quick look's marks in one batch: copied before they are cleared", () => {
        for (const tag of [...ctf.TOUCH_TAGS, ...ctf.HOME_TAGS]) {
            const copy = ctf.TAKE_MARKS.indexOf(`tag @a[tag=${tag}] add ${tag}_r`);
            expect(copy).toBeGreaterThan(ctf.TAKE_MARKS.indexOf(`tag @a remove ${tag}_r`));
            expect(ctf.TAKE_MARKS.indexOf(`tag @a remove ${tag}`)).toBeGreaterThan(copy);
            expect(ctf.unmarkLines("Ana")).toContain(`tag Ana remove ${tag}`);
            expect(ctf.TAGS_OFF).toContain(`tag @a remove ${tag}_r`);
        }
    });

    it("reads a player on with no health score yet as whole, and one not on as not there", () => {
        const health = duel.healthOf(new Map([["Ben", 6]]), ["Ana", "Ben"]);
        expect(Object.fromEntries(health)).toEqual({ Ana: duel.FULL_HEALTH, Ben: 6 });
        expect(duel.healthOf(new Map(), []).has("Ana")).toBe(false);
    });
});
