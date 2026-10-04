import { describe, expect, it } from "vitest";
import * as speech from "@polaris-app/game-servers/src/lib/minecraft/speech";
import * as commands from "@polaris-app/game-servers/src/lib/minecraft/events/commands";
import * as waves from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/waves";
import * as village from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/village-defense";
import * as say from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/village-defense-messages";
import { atLeast } from "@polaris-app/game-servers/src/lib/minecraft/events/events-service";
import {
    COMMAND_BYTES_MAX,
    commandBytes
} from "@polaris-app/game-servers/src/lib/minecraft/command-size";

const point = { x: 300, y: 70, z: 0 };
const MIXES = ["classic", "undead", "mixed"] as const;

/** Every monster a line summons, by id. */
function summonedIds(lines: readonly string[]): string[] {
    return lines.flatMap((line) =>
        [...line.matchAll(/(?:summon minecraft:|Passengers:\[\{id:"minecraft:)([a-z_]+)/g)].map(
            (one) => one[1]!
        )
    );
}

describe("a villager defense's monsters", () => {
    it("are only ones that hunt villagers, and none that changes a block", () => {
        // Zombies (husks and zombie villagers are zombies), vindicators and
        // pillagers go for a villager in vanilla; skeletons, strays, spiders
        // and witches never do.
        const hunters = new Set(["zombie", "husk", "zombie_villager", "vindicator", "pillager"]);
        for (const mix of MIXES) {
            expect(village.VILLAGE_MOBS[mix].length).toBeGreaterThan(0);
            for (const id of village.VILLAGE_MOBS[mix]) expect(hunters.has(id)).toBe(true);
        }
    });

    it("come in every wave as the mix says, riders included, with no skeleton, spider or witch", () => {
        for (const mix of MIXES) {
            const kinds = village.VILLAGE_MOBS[mix];
            for (let wave = 0; wave < 10; wave += 1) {
                const lines = waves.summonWave(point, kinds, 24, wave, 600, {
                    waves: 10,
                    defenders: 3
                });
                for (const id of summonedIds(lines)) {
                    // A chicken or a horse is only ever a mount, never one of the wave.
                    if (["chicken", "zombie_horse"].includes(id)) continue;
                    expect(kinds).toContain(id);
                }
                expect(lines.some((line) => /skeleton|spider|witch|stray/.test(line))).toBe(false);
            }
        }
    });

    it("are armed by hand, and the zombie kinds never call for help", () => {
        const lines = waves.summonWave(point, village.VILLAGE_MOBS.mixed, 20, 0, 600);
        expect(lines).toContain(
            "item replace entity @e[tag=pe_wnew,type=minecraft:vindicator] weapon.mainhand with minecraft:iron_axe"
        );
        expect(lines).toContain(
            "item replace entity @e[tag=pe_wnew,type=minecraft:pillager] weapon.mainhand with minecraft:crossbow"
        );
        expect(lines).toContain(
            "execute as @e[tag=pe_wnew,type=minecraft:zombie_villager] run attribute @s minecraft:spawn_reinforcements base set 0"
        );
    });

    it("are counted and cleared up with their own kill counts", () => {
        const kinds = village.VILLAGE_MOBS.mixed;
        expect(waves.wavesSetup(kinds)).toContain(
            "scoreboard objectives add pe_wk3 minecraft.killed:minecraft.vindicator"
        );
        expect(waves.wavesCleanup(kinds)).toContain("scoreboard objectives remove pe_wk4");
        expect(waves.wavesCleanup(kinds)[0]).toBe("kill @e[tag=pe_mob]");
        // A horde defense by name is what it always was.
        expect(waves.wavesSetup("classic")).toEqual(waves.wavesSetup(waves.MIX_MOBS.classic));
    });
});

describe("the villager", () => {
    it("is summoned unable to move, persistent, glowing and tagged as nothing else is", () => {
        const [summon, name] = village.summonVillager(point, "Petra", true);
        expect(summon).toBe(
            'execute in minecraft:overworld run summon minecraft:villager 300.5 70 0.5 {Tags:["pe_villager"],NoAI:1b,PersistenceRequired:1b,Glowing:1b,CustomNameVisible:1b}'
        );
        // Never the wave's tag, which is what counts the monsters left.
        expect(summon).not.toContain(commands.MOB_TAG);
        expect(name).toBe(
            'data merge entity @e[type=minecraft:villager,tag=pe_villager,limit=1] {CustomName:{text:"Petra",color:"gold"}}'
        );
    });

    it("is named the way an older version reads a name", () => {
        const [, name] = village.summonVillager(point, "Petra", false);
        expect(name).toBe(
            'data merge entity @e[type=minecraft:villager,tag=pe_villager,limit=1] {CustomName:\'[{"text":""},{"text":"Petra","color":"gold"}]\'}'
        );
    });

    it("keeps the same name for the same run", () => {
        expect(village.villagerName("run-a")).toBe(village.villagerName("run-a"));
        const names = new Set(
            Array.from({ length: 200 }, (_, index) => village.villagerName(`run-${index}`))
        );
        expect(names.size).toBeGreaterThan(5);
        for (const one of names) expect(village.VILLAGER_NAMES).toContain(one);
    });

    it("has the wave turned on it, never a mount and never what a defender stands next to", () => {
        const line = village.provokeLine();
        expect(line).toContain("as @e[tag=pe_mob,tag=!pe_wmount,distance=..48]");
        expect(line).toContain(
            "unless entity @a[distance=..3,gamemode=!spectator,gamemode=!creative]"
        );
        // A type that pushes nothing back, from the villager itself.
        expect(line).toMatch(
            / run damage @s 0\.01 minecraft:generic by @e\[type=minecraft:villager,tag=pe_villager,limit=1\]$/
        );
    });

    it("is turned on only from 1.21, where its generic touch pushes nothing back", () => {
        // `generic` joined `#minecraft:no_knockback` in 24w18a (1.21); on
        // 1.19.4-1.20.6 every touch would knock the wave away from it.
        expect(village.LURE_SINCE).toEqual([1, 21]);
        expect(atLeast("1.20.6", village.LURE_SINCE)).toBe(false);
        expect(atLeast("1.19.4", village.LURE_SINCE)).toBe(false);
        expect(atLeast("1.21", village.LURE_SINCE)).toBe(true);
        expect(atLeast("1.21.4", village.LURE_SINCE)).toBe(true);
    });

    it("warns once under half its health and once under a quarter", () => {
        expect(village.warningsDue(20)).toBe(0);
        expect(village.warningsDue(10.5)).toBe(0);
        expect(village.warningsDue(10)).toBe(1);
        expect(village.warningsDue(5)).toBe(2);
        expect(village.warningsDue(0)).toBe(2);
        expect(village.hearts(20)).toBe("10");
        expect(village.hearts(13)).toBe("6.5");
        expect(village.hearts(-2)).toBe("0");
    });

    it("is taken away with what a zombie turned it into, and nothing else", () => {
        expect(village.villagerCleanup(point)).toEqual([
            "kill @e[tag=pe_villager]",
            "execute in minecraft:overworld positioned 300.5 70 0.5 run kill @e[type=minecraft:zombie_villager,distance=..1.5]"
        ]);
        expect(village.villagerCleanup(null)).toEqual(["kill @e[tag=pe_villager]"]);
    });
});

describe("what a villager defense says", () => {
    it("fits a command in both languages", () => {
        const every = speech.spoken(say);
        const name = "Remedios";
        const lines = [
            commands.say(every.pointAt(name, -29999999, -63, -29999999, speech.EVERY)),
            commands.say(every.lostLine(name, 10, speech.EVERY)),
            commands.say(every.savedLine(name, speech.EVERY)),
            ...commands.titleCommands(
                every.pointTitle(speech.EVERY),
                every.pointSubtitle(name, speech.EVERY)
            ),
            ...commands.titleCommands(
                every.hurtTitle(speech.EVERY),
                every.hurtSubtitle(name, "2.5", speech.EVERY)
            ),
            ...commands.titleCommands(
                every.lostTitle(name, speech.EVERY),
                every.lostSubtitle(speech.EVERY)
            ),
            commands.actionbarFor("Ana", every.guide(name, 1200, "north-west", speech.EVERY))
        ];
        for (const line of lines) {
            for (const language of speech.LANGUAGES) {
                const one = speech.localize(line, speech.audienceOf(language))[0]!;
                expect(commandBytes(commands.namespaced(one))).toBeLessThanOrEqual(
                    COMMAND_BYTES_MAX
                );
            }
        }
        expect(say.lostLine(name, 3, "en")).toContain("nobody wins");
        expect(say.lostLine(name, 3, "es")).toContain("nadie gana");
        expect(say.guide(name, 40, "south-east", "es")).toContain("sureste");
    });
});
