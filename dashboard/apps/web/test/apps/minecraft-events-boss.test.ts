/**
 * A world boss's commands, without a server: which boss is drawn, how its
 * health grows, its phases, when each attack comes and what it sends, the sky
 * arena it stands in, and what is taken out at the end.
 */

import { describe, expect, it } from "vitest";
import * as boss from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/boss";
import * as catalog from "@polaris-app/game-servers/src/lib/minecraft/events/catalog";
import * as stage from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/stage";
import * as written from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/boss-messages";

type Options = catalog.EventOptions<"world-boss">;

function options(patch: Partial<Options> = {}): Options {
    return { ...(catalog.optionsSchemas["world-boss"].parse({}) as Options), ...patch };
}

/** A command that would place or break a block, or summon what would. */
const BLOCK_EDITS =
    /(^| run )(setblock|fill|clone|place) |summon minecraft:(tnt|fireball|small_fireball|wither_skull|creeper|end_crystal|lightning_bolt|wind_charge)/;

describe("the options", () => {
    it("default to a boss drawn from all of them, on Epic, in the sky arena", () => {
        const value = options();
        expect(value.choice).toBe("random");
        expect(value.difficulty).toBe("epic");
        expect(value.arena).toBe(true);
        expect(value.pool).toEqual([...catalog.BOSS_KINDS]);
    });

    it("read an event saved before the choice as it fought: its own boss, on Normal, on the land", () => {
        const schema = catalog.optionsSchemas["world-boss"];
        const old = schema.parse({ boss: "husk", health: 600 }) as Options;
        expect(old.choice).toBe("chosen");
        expect(old.boss).toBe("husk");
        expect(old.difficulty).toBe("normal");
        expect(old.arena).toBe(false);
        expect(old.health).toBe(600);
        const saved = schema.parse({ choice: "random", boss: "husk" }) as Options;
        expect(saved.difficulty).toBe("epic");
        expect(saved.arena).toBe(true);
    });

    it("refuse the Wither chosen for the land, and a pool with nothing that can fight there", () => {
        const schema = catalog.optionsSchemas["world-boss"];
        expect(schema.safeParse({ choice: "chosen", boss: "wither", arena: false }).success).toBe(
            false
        );
        expect(schema.safeParse({ choice: "chosen", boss: "wither", arena: true }).success).toBe(
            true
        );
        expect(schema.safeParse({ pool: ["wither"], arena: false }).success).toBe(false);
        expect(schema.safeParse({ pool: ["wither"], arena: true }).success).toBe(true);
    });
});

describe("the draw", () => {
    it("takes only from the pool, and never the Wither on the land", () => {
        const land = options({ arena: false, pool: ["wither", "husk"] });
        for (const roll of [0, 0.3, 0.6, 0.99]) expect(boss.draw(land, () => roll)).toBe("husk");
        const sky = options({ arena: true, pool: ["wither", "husk"] });
        expect(boss.draw(sky, () => 0)).toBe("wither");
        expect(boss.draw(sky, () => 0.99)).toBe("husk");
    });

    it("reaches every boss in the pool", () => {
        const all = options();
        const seen = new Set(
            Array.from({ length: 70 }, (_, index) => boss.draw(all, () => index / 70))
        );
        expect([...seen].sort()).toEqual([...catalog.BOSS_KINDS].sort());
    });

    it("is always the chosen one when one is chosen", () => {
        expect(boss.draw(options({ choice: "chosen", boss: "evoker" }), () => 0.9)).toBe("evoker");
    });
});

describe("its health", () => {
    it("is the base on Normal for one fighter, more for each harder level and every fighter", () => {
        expect(boss.effectiveHealth(400, "normal", 1)).toBe(500);
        expect(boss.effectiveHealth(400, "normal", 0)).toBe(500);
        expect(boss.effectiveHealth(400, "hard", 1)).toBe(700);
        expect(boss.effectiveHealth(400, "epic", 1)).toBe(1000);
        expect(boss.effectiveHealth(400, "normal", 2)).toBe(750);
        expect(boss.effectiveHealth(400, "epic", 5)).toBe(4200);
    });

    it("is held as Resistance past what a creature may have", () => {
        expect(boss.splitHealth(1000)).toEqual({ health: 1000, resistance: 0 });
        expect(boss.splitHealth(1200)).toEqual({ health: 960, resistance: 1 });
        expect(boss.splitHealth(4200)).toEqual({ health: 840, resistance: 4 });
        expect(boss.splitHealth(99_999)).toEqual({ health: 1024, resistance: 4 });
    });

    it("keeps what was lost when more fighters come, and adds their share", () => {
        // Half gone of 500, then a second fighter adds 250: 500 of 750.
        expect(
            boss.toppedUp(250, { health: 500, resistance: 0 }, { health: 750, resistance: 0 }, 250)
        ).toBe(500);
        // Across a Resistance level: worth is kept in effective health.
        const before = boss.splitHealth(1000);
        const after = boss.splitHealth(1500);
        expect(after.resistance).toBe(2);
        expect(boss.toppedUp(1000, before, after, 500)).toBe(900);
    });
});

describe("its phases", () => {
    it("turn at two thirds and one third of its health", () => {
        expect(boss.phaseFor(1000, 1000)).toBe(1);
        expect(boss.phaseFor(661, 1000)).toBe(1);
        expect(boss.phaseFor(660, 1000)).toBe(2);
        expect(boss.phaseFor(331, 1000)).toBe(2);
        expect(boss.phaseFor(330, 1000)).toBe(3);
    });

    it("color the bar", () => {
        expect(boss.barColorLine(1)).toBe("bossbar set polaris:event color yellow");
        expect(boss.barColorLine(2)).toBe("bossbar set polaris:event color purple");
        expect(boss.barColorLine(3)).toBe("bossbar set polaris:event color red");
    });

    it("bring more minions for harder levels and more fighters, never past ten", () => {
        expect(boss.minionCount("normal", 1)).toBe(3);
        expect(boss.minionCount("epic", 1)).toBe(5);
        expect(boss.minionCount("epic", 5)).toBe(9);
        expect(boss.minionCount("epic", 20)).toBe(10);
    });

    it("summon minions that are tagged for the shield, drop nothing and cannot open a door", () => {
        const lines = boss.minionLines("husk", 3, true);
        const summons = lines.filter((line) => line.includes(" summon "));
        expect(summons.length).toBeGreaterThanOrEqual(3);
        for (const line of summons) {
            expect(line).toContain("minecraft:zombie");
            expect(line).toContain('"pe_bmob","pe_bshield"');
            expect(line).toContain('DeathLootTable:"minecraft:empty"');
            expect(line).toContain("CanBreakDoors:0b");
            expect(line).toContain("drop_chances:{");
        }
        // Only into two blocks of air round the boss, and at its feet as a last resort.
        expect(
            summons
                .slice(0, 3)
                .every((line) =>
                    line.includes("if block ~ ~ ~ minecraft:air if block ~ ~1 ~ minecraft:air")
                )
        ).toBe(true);
        expect(lines.some((line) => line.includes("spawn_reinforcements base set 0"))).toBe(true);
        expect(lines.at(-1)).toBe("tag @e[tag=pe_bnew] remove pe_bnew");
    });

    it("never have minions of the boss's own kind, whose death would read as the boss's", () => {
        for (const kind of catalog.BOSS_KINDS)
            expect(boss.BOSSES[kind].minion).not.toBe(boss.BOSSES[kind].entity);
    });

    it("keep up the shield, the rage and its immunities only for a few seconds at a time", () => {
        const state = { ...boss.freshState("husk", options()), phase: 3, resistance: 2 };
        const shielded = boss.upkeepLines(state, { rides: true, shield: true });
        expect(shielded).toContain(
            "effect give @e[tag=pe_boss,limit=1] minecraft:resistance 6 4 true"
        );
        expect(shielded).toContain(
            "effect give @e[tag=pe_boss,limit=1] minecraft:fire_resistance 6 0 true"
        );
        expect(shielded).toContain(
            "effect give @e[tag=pe_boss,limit=1] minecraft:water_breathing 6 0 true"
        );
        expect(shielded).toContain("ride @e[tag=pe_boss,limit=1] dismount");
        expect(shielded).toContain(
            "effect give @e[tag=pe_boss,limit=1] minecraft:strength 6 1 true"
        );
        expect(shielded).toContain("effect give @e[tag=pe_boss,limit=1] minecraft:speed 6 1 true");
        const open = boss.upkeepLines({ ...state, phase: 1 }, { rides: false, shield: false });
        expect(open).toContain("effect give @e[tag=pe_boss,limit=1] minecraft:resistance 6 1 true");
        expect(open.some((line) => line.includes("strength") || line.startsWith("ride "))).toBe(
            false
        );
    });
});

describe("a Wither, which no effect can be given to", () => {
    it("keeps its health up to the cap instead of Resistance", () => {
        expect(boss.splitHealth(4200, true)).toEqual({ health: 1024, resistance: 0 });
        expect(boss.splitHealth(700, true)).toEqual({ health: 700, resistance: 0 });
    });

    it("is shielded by being invulnerable, and never sent an effect", () => {
        const state = { ...boss.freshState("wither", options()), phase: 3, resistance: 2 };
        const shielded = boss.upkeepLines(state, { rides: true, shield: true });
        expect(shielded).toContain("data merge entity @e[tag=pe_boss,limit=1] {Invulnerable:1b}");
        expect(shielded.some((line) => line.startsWith("effect "))).toBe(false);
        expect(boss.SHIELD_DOWN).toContain(
            "data merge entity @e[tag=pe_boss,limit=1] {Invulnerable:0b}"
        );
        expect(boss.immuneRageLines()).toContain(
            "attribute @e[tag=pe_boss,limit=1] minecraft:flying_speed base set 0.9"
        );
    });
});

describe("its attacks", () => {
    const at = (seconds: number) => 1_000_000 + seconds * 1000;

    it("wait their turn, and come sooner in harder levels and later phases", () => {
        expect(boss.cooldownMs("shockwave", "normal", 1)).toBe(12_000);
        expect(boss.cooldownMs("shockwave", "epic", 1)).toBeLessThan(12_000);
        expect(boss.cooldownMs("shockwave", "epic", 3)).toBeLessThan(
            boss.cooldownMs("shockwave", "epic", 1)
        );
        const last = { shockwave: at(0), pull: at(0), burst: at(0) };
        // Too soon after the last one of any.
        expect(boss.nextAbility(last, at(0), at(3), "normal", 1, 20)).toBeNull();
        // A leap is the only one ready, and there is somebody far enough off.
        expect(boss.nextAbility(last, at(0), at(6), "normal", 1, 20)).toBe("leap");
        expect(boss.nextAbility(last, at(0), at(6), "normal", 1, 3)).toBeNull();
        expect(boss.nextAbility(last, at(0), at(13), "normal", 1, 3)).toBe("shockwave");
    });

    it("are warned of a second before, and change no block", () => {
        for (const ability of boss.ABILITIES) {
            for (const arena of [true, false]) {
                const lines = boss.abilityLines(ability, {
                    arena,
                    difficulty: "epic",
                    damage: true,
                    target: "Ana",
                    warning: "&cWarned",
                    markers: true
                });
                expect(lines.warn.length).toBeGreaterThan(0);
                expect(lines.warn.some((line) => line.includes(" particle "))).toBe(true);
                expect(lines.warn.some((line) => line.includes(" playsound "))).toBe(true);
                expect(lines.act.length).toBeGreaterThan(0);
                for (const line of [...lines.warn, ...lines.act])
                    expect(line).not.toMatch(BLOCK_EDITS);
            }
        }
    });

    it("hurt with `damage` from 1.19.4, and with instant damage before", () => {
        const context = {
            arena: false,
            difficulty: "hard" as const,
            target: null,
            warning: "!",
            markers: true
        };
        const modern = boss.abilityLines("shockwave", { ...context, damage: true }).act.join("\n");
        expect(modern).toContain(
            "run execute as @a[distance=..6,gamemode=!creative,gamemode=!spectator] run damage @s 8 minecraft:mob_attack by @e[tag=pe_boss,limit=1]"
        );
        const legacy = boss.abilityLines("shockwave", { ...context, damage: false }).act.join("\n");
        expect(legacy).not.toContain(" damage @s ");
        expect(legacy).toContain(
            "effect give @a[distance=..6,gamemode=!creative,gamemode=!spectator] minecraft:instant_damage 1 0 true"
        );
    });

    it("move a player only into two blocks of air", () => {
        const pull = boss.abilityLines("pull", {
            arena: true,
            difficulty: "normal",
            damage: true,
            target: null,
            warning: "!",
            markers: true
        }).act;
        const moves = pull.filter((line) => line.includes(" tp @s "));
        expect(moves.length).toBe(2);
        for (const line of moves) {
            expect(line).toContain(
                "@a[tag=pe_in,distance=4..,gamemode=!creative,gamemode=!spectator]"
            );
            expect(line).toContain(
                "if block ~ ~ ~ minecraft:air if block ~ ~1 ~ minecraft:air run tp @s ~ ~ ~"
            );
        }
    });

    it("move a player through no wall: every block on the way is air", () => {
        const context = {
            arena: true,
            difficulty: "normal" as const,
            damage: true,
            target: null,
            warning: "!",
            markers: true
        };
        const clear = "if block ~ ~ ~ minecraft:air if block ~ ~1 ~ minecraft:air";
        const path = (step: number) => Array(3).fill(`positioned ^ ^ ^${step} ${clear}`).join(" ");
        const moved = (ability: "pull" | "shockwave") =>
            boss.abilityLines(ability, context).act.find((line) => line.includes(" tp @s "));
        expect(moved("pull")).toContain(
            `facing entity @e[tag=pe_boss,limit=1] feet ${path(1)} run tp @s ~ ~ ~`
        );
        expect(moved("shockwave")).toContain(
            `facing entity @e[tag=pe_boss,limit=1] feet ${path(-1)} run tp @s ~ ~ ~`
        );
    });

    it("leap only at a player, and not at all without one", () => {
        const context = {
            arena: false,
            difficulty: "normal" as const,
            damage: true,
            warning: "!",
            markers: true
        };
        expect(boss.abilityLines("leap", { ...context, target: "Ana" }).act[0]).toBe(
            "execute at Ana run tp @e[tag=pe_boss,limit=1] ~ ~ ~"
        );
        expect(boss.abilityLines("leap", { ...context, target: "@a" })).toEqual({
            warn: [],
            act: []
        });
        expect(boss.abilityLines("leap", { ...context, target: null })).toEqual({
            warn: [],
            act: []
        });
    });

    it("raise fangs only in the arena, where they were warned of, and send vexes on the land", () => {
        const context = {
            difficulty: "epic" as const,
            damage: true,
            target: null,
            warning: "!",
            markers: false
        };
        const sky = boss.abilityLines("burst", { ...context, arena: true });
        expect(sky.warn[0]).toContain(
            'summon minecraft:armor_stand ~ ~ ~ {Tags:["pe_bmob","pe_bfang"],Marker:1b'
        );
        expect(
            sky.act.filter((line) => line.includes("summon minecraft:evoker_fangs"))
        ).toHaveLength(5);
        expect(sky.act).toContain("kill @e[tag=pe_bfang]");
        // Fallen during the warning: nothing bites the winners.
        for (const line of sky.act.filter((one) => one.includes("evoker_fangs ~ ~ ~")))
            expect(
                line.startsWith("execute if entity @e[tag=pe_boss,limit=1] at @e[tag=pe_bfang]")
            ).toBe(true);
        const land = boss.abilityLines("burst", { ...context, arena: false });
        expect(land.act.join("\n")).not.toContain("evoker_fangs");
        const vexes = land.act.filter((line) => line.includes("summon minecraft:vex"));
        expect(vexes).toHaveLength(3);
        for (const line of vexes) {
            expect(line).toContain('"pe_bmob"');
            expect(line).toContain("LifeTicks:400");
        }
    });
});

describe("what a boss drops whatever its loot table says", () => {
    it("is the Wither's star alone, taken off the arena floor by its age, never a thrown one", () => {
        expect(boss.BOSSES.wither.drops).toBe("minecraft:nether_star");
        expect(boss.BOSSES.husk.drops).toBeUndefined();
        const volume = boss.arenaVolume({ x: 100, y: 120, z: -40 });
        const [score, take] = boss.looseDropLines("minecraft:nether_star", volume);
        expect(score).toBe(
            'execute in minecraft:overworld as @e[type=minecraft:item,x=87,y=120,z=-53,dx=26,dy=10,dz=26,nbt={Item:{id:"minecraft:nether_star"}}] store result score @s pe_sum run data get entity @s Age'
        );
        // A boss's drop is born with a long life, its age below zero; a thrown stack starts at zero.
        expect(take).toBe(
            "execute in minecraft:overworld run kill @e[type=minecraft:item,x=87,y=120,z=-53,dx=26,dy=10,dz=26,scores={pe_sum=..-1}]"
        );
    });

    it("is counted and taken back without a name, so a trophy is never taken", () => {
        expect(boss.plainCountLine("Ana", "minecraft:nether_star")).toBe(
            "clear Ana minecraft:nether_star[!minecraft:custom_name] 0"
        );
        expect(boss.takeBackLine("Ana", "minecraft:nether_star", 1)).toBe(
            "clear Ana minecraft:nether_star[!minecraft:custom_name] 1"
        );
    });
});

describe("the boss itself", () => {
    it("is summoned tagged, persistent, dropping nothing, and never a raid captain", () => {
        const [clear, summon] = boss.summonLines("captain", "epic", 900, {
            x: 10.5,
            y: 64,
            z: -3.5
        });
        expect(clear).toBe("kill @e[tag=pe_boss]");
        expect(summon).toMatch(
            /^execute in minecraft:overworld run summon minecraft:pillager 10\.5 64 -3\.5 \{/
        );
        for (const part of [
            'Tags:["pe_boss"]',
            "PersistenceRequired:1b",
            'DeathLootTable:"minecraft:empty"',
            "PatrolLeader:0b",
            "CanJoinRaid:0b",
            "HandDropChances:[0.0f,0.0f]",
            'Name:"generic.maxHealth",Base:900d',
            "Health:900f"
        ])
            expect(summon).toContain(part);
    });

    it("is given its attributes by both spellings, and no reinforcements for a husk", () => {
        const modern = boss.attributeLines("husk", "normal", 500, true);
        expect(modern[0]).toBe(
            "attribute @e[tag=pe_boss,limit=1] minecraft:max_health base set 500"
        );
        expect(modern).toContain(
            "attribute @e[tag=pe_boss,limit=1] minecraft:spawn_reinforcements base set 0"
        );
        expect(boss.attributeLines("husk", "normal", 500, false)[0]).toBe(
            "attribute @e[tag=pe_boss,limit=1] minecraft:generic.max_health base set 500"
        );
        expect(
            boss
                .attributeLines("evoker", "normal", 500, true)
                .some((line) => line.includes("reinforcements"))
        ).toBe(false);
    });

    it("spares every creature near it that is neither a player, its own nor a monster", () => {
        const line = boss.spareBystanders();
        expect(
            line.startsWith(
                "execute as @e[tag=pe_boss,limit=1] at @s run effect give @e[distance=..48,type=!minecraft:player,tag=!pe_boss,tag=!pe_bmob,type=!minecraft:zombie,"
            )
        ).toBe(true);
        expect(line.endsWith("] minecraft:resistance 6 4 true")).toBe(true);
        expect(line).not.toContain("type=!minecraft:wolf");
        expect(Buffer.byteLength(line)).toBeLessThan(1014);
    });

    it("holds keepInventory always, and mobGriefing off only where a block could change", () => {
        const names = (kind: catalog.BossKind, arena: boolean) =>
            boss.heldRules(kind, arena).map((rule) => `${rule.names[0]}=${rule.value}`);
        expect(names("husk", false)).toEqual(["keepInventory=true"]);
        expect(names("ravager", true)).toEqual(["keepInventory=true"]);
        expect(names("ravager", false)).toEqual(["keepInventory=true", "mobGriefing=false"]);
        expect(names("evoker", false)).toEqual(["keepInventory=true", "mobGriefing=false"]);
        expect(names("wither", true)).toEqual(["keepInventory=true", "mobGriefing=false"]);
        expect(boss.MOB_GRIEFING).toContain("mob_griefing");
        expect(boss.KEEP_INVENTORY).toContain("keep_inventory");
    });
});

describe("the sky arena", () => {
    const origin = { x: 100, y: 94, z: -40 };

    it("is built only inside the volume proved empty, of glass, closed all round", () => {
        const volume = boss.arenaVolume(origin);
        const boxes = boss.arenaBoxes(origin);
        for (const box of boxes) {
            expect(box.x1).toBeGreaterThanOrEqual(volume.x1);
            expect(box.x2).toBeLessThanOrEqual(volume.x2);
            expect(box.y1).toBeGreaterThanOrEqual(volume.y1);
            expect(box.y2).toBeLessThanOrEqual(volume.y2);
            expect(box.z1).toBeGreaterThanOrEqual(volume.z1);
            expect(box.z2).toBeLessThanOrEqual(volume.z2);
            // Glass, and a pillar of light at each corner.
            expect(box.block).toMatch(/_stained_glass$|^minecraft:sea_lantern$/);
            expect(stage.ARENA_BLOCKS).toContain(box.block);
        }
        // Floor, four walls and a roof: every block of the shell, no block twice.
        const cells = new Set<string>();
        let count = 0;
        for (const box of boxes) {
            for (let x = box.x1; x <= box.x2; x += 1)
                for (let y = box.y1; y <= box.y2; y += 1)
                    for (let z = box.z1; z <= box.z2; z += 1) {
                        cells.add(`${x} ${y} ${z}`);
                        count += 1;
                    }
        }
        expect(cells.size).toBe(count);
        const side = volume.x2 - volume.x1 + 1;
        const tall = volume.y2 - volume.y1 + 1;
        expect(count).toBe(side * side * tall - (side - 2) * (side - 2) * (tall - 2));
        expect(stage.probeBoxes(volume).reduce((sum, box) => sum + stage.volumeOf(box), 0)).toBe(
            stage.volumeOf(volume)
        );
    });

    it("puts players and the boss on its floor, inside the walls", () => {
        for (let index = 0; index < 12; index += 1) {
            const spot = boss.arenaSpot(origin, index);
            expect(spot.y).toBe(origin.y + 1);
            expect(Math.abs(spot.x - (origin.x + 0.5))).toBeLessThan(boss.ARENA_HALF);
            expect(Math.abs(spot.z - (origin.z + 0.5))).toBeLessThan(boss.ARENA_HALF);
            expect(boss.insideArena(origin, spot)).toBe(true);
        }
        expect(boss.insideArena(origin, boss.arenaCenter(origin))).toBe(true);
    });

    it("catches a fall under its floor, and lets go of whoever is back on the ground", () => {
        const at = (dy: number) => ({ x: origin.x, y: origin.y + dy, z: origin.z });
        expect(boss.underArena(origin, at(-3))).toBe(true);
        expect(boss.leftArena(origin, at(-3), "minecraft:overworld")).toBe(false);
        expect(boss.leftArena(origin, at(-28), "minecraft:overworld")).toBe(true);
        expect(boss.leftArena(origin, at(1), "minecraft:the_nether")).toBe(true);
        expect(
            boss.leftArena(origin, { x: origin.x + 200, y: origin.y + 1, z: origin.z }, undefined)
        ).toBe(true);
    });

    it("takes players up tagged first, then moves them, then into adventure mode", () => {
        const lines = boss.admitLines("Ana", { x: 1.5, y: 95, z: 2.5, yaw: 90 });
        expect(lines[0]).toBe("tag Ana add pe_in");
        expect(lines.at(-1)).toBe("gamemode adventure Ana");
        expect(boss.inLift({ x: 10, y: 64, z: 20 })).toContain(
            "tag=!pe_in,gamemode=!creative,gamemode=!spectator"
        );
    });

    it("brings players to the boss on the land round its lair, in their own game mode", () => {
        const lair = { x: 100, y: 70, z: -40 };
        for (let index = 0; index < 8; index++) {
            const spot = boss.landSpot(lair, index);
            expect(spot.y).toBe(lair.y);
            const away = Math.hypot(spot.x - (lair.x + 0.5), spot.z - (lair.z + 0.5));
            expect(away).toBeGreaterThan(1);
            expect(away).toBeLessThanOrEqual(3 * Math.SQRT2);
        }
        const lines = boss.landAdmitLines("Ana", boss.landSpot(lair, 0));
        expect(lines.indexOf("tag Ana add pe_in")).toBeLessThan(
            lines.findIndex((line) => line.includes(" tp Ana "))
        );
        expect(lines.some((line) => line.startsWith("gamemode"))).toBe(false);
        expect(lines.some((line) => line.includes("slow_falling"))).toBe(false);
    });

    it("lets somebody who left go in their own game mode, without moving them", () => {
        const saved: stage.Saved = {
            name: "Ana",
            dimension: "minecraft:overworld",
            x: 0,
            y: 64,
            z: 0,
            yaw: 0,
            pitch: 0,
            mode: "survival",
            stash: null
        };
        const lines = boss.letGoLines(saved, "gone");
        expect(lines).toContain("gamemode survival Ana");
        expect(lines).toContain("tag Ana remove pe_in");
        expect(lines.some((line) => line.includes(" tp "))).toBe(false);
    });
});

const bossScaled = (rewards: catalog.Rewards, difficulty: catalog.BossDifficulty) =>
    boss.scaledRewards(rewards, difficulty);

describe("the prizes", () => {
    it("are multiplied for the difficulty", () => {
        const prizes = catalog.DEFAULT_PRIZES["world-boss"];
        const scaled = boss.scaledRewards(prizes, "epic");
        expect(scaled.first).toEqual({
            items: [
                { id: "minecraft:diamond", count: 6 },
                { id: "minecraft:golden_apple", count: 4 }
            ],
            levels: 16
        });
        expect(boss.scaledRewards(prizes, "hard").third).toEqual({
            items: [{ id: "minecraft:diamond", count: 2 }],
            levels: 5
        });
        expect(boss.scaledRewards(prizes, "normal")).toEqual(prizes);
    });

    it("pay a world boss on its default difficulty more than any other kind's first place", () => {
        const worth = (reward: catalog.Reward) =>
            reward.items.reduce(
                (sum, item) =>
                    sum + (item.id === "minecraft:diamond" ? item.count * 10 : item.count),
                0
            ) + reward.levels;
        const boss = catalog.newPreset("world-boss", "b");
        const epic = worth(
            bossScaled(
                boss.rewards,
                (boss.options as catalog.EventOptions<"world-boss">).difficulty
            ).first
        );
        for (const kind of catalog.EVENT_KINDS) {
            if (kind === "world-boss") continue;
            expect(worth(catalog.newPreset(kind, kind).rewards.first)).toBeLessThan(epic);
        }
    });

    it("name the trophy the way each version reads a name, its own spelling first", () => {
        // 1.21.5 on: an SNBT text component; the JSON string only if that is refused.
        const [snbt, fallback] = boss.trophyArguments(
            "Trofeo: El Señor",
            "Golpe final - Épico",
            "text"
        );
        expect(snbt).toContain(
            'minecraft:custom_name={text:"Trofeo: El Se\\u00f1or",color:"gold",italic:0b}'
        );
        expect(fallback).toContain(
            `minecraft:custom_name='{"text":"Trofeo: El Se\\\\u00f1or","color":"gold","italic":false}'`
        );
        // 1.20.5 to 1.21.4 read a name as JSON in a string, and refuse the SNBT one.
        const [json, last] = boss.trophyArguments(
            "Trofeo: El Señor",
            "Golpe final - Épico",
            "json"
        );
        expect(json).toContain(
            `minecraft:custom_name='{"text":"Trofeo: El Se\\\\u00f1or","color":"gold","italic":false}'`
        );
        expect(json).toContain(
            `minecraft:lore=['{"text":"Golpe final - \\\\u00c9pico","color":"gray","italic":false}']`
        );
        expect(last).toContain("minecraft:custom_name={text:");
        const [legacy] = boss.trophyArguments("Trophy: The Warlord", "Final blow - Epic", "tag");
        expect(legacy).toBe(
            `minecraft:nether_star{display:{Name:'{"text":"Trophy: The Warlord","color":"gold","italic":false}',Lore:['{"text":"Final blow - Epic","color":"gray","italic":false}']}}`
        );
    });
});

describe("the end", () => {
    it("sends everything the fight summoned into the void, then kills it", () => {
        expect(boss.bossCleanup()).toEqual([
            "execute as @e[tag=pe_bmob] at @s run tp @s ~ -1000 ~",
            "kill @e[tag=pe_bmob]",
            "execute as @e[tag=pe_boss] at @s run tp @s ~ -1000 ~",
            "kill @e[tag=pe_boss]"
        ]);
    });
});
describe("what the fight's creatures hold", () => {
    it("arms every boss that fights with a weapon, and takes the weapon's damage off its own", () => {
        expect(boss.bossWeapon("wither-skeleton")).toBe("minecraft:stone_sword");
        expect(boss.bossWeapon("vindicator")).toBe("minecraft:iron_axe");
        expect(boss.bossWeapon("captain")).toBe("minecraft:crossbow");
        expect(boss.bossWeapon("ravager")).toBeNull();
        expect(boss.bossEquipLines("wither-skeleton")).toContain(
            "item replace entity @e[tag=pe_boss,limit=1] weapon.mainhand with minecraft:stone_sword"
        );
        // What it deals is still the difficulty's: a stone sword adds 4, taken off.
        expect(boss.bossAttack("wither-skeleton", "epic")).toBe(boss.DIFFICULTY.epic.attack - 4);
        expect(boss.bossAttack("husk", "epic")).toBe(boss.DIFFICULTY.epic.attack);
        expect(boss.attributeLines("wither-skeleton", "normal", 500, true)).toContain(
            `attribute @e[tag=pe_boss,limit=1] minecraft:attack_damage base set ${boss.DIFFICULTY.normal.attack - 4}`
        );
    });

    it("arms the minions of every boss, a wither skeleton's with its stone sword", () => {
        const withered = boss.minionLines("wither", 3, true);
        expect(withered).toContain(
            "item replace entity @e[tag=pe_bnew,type=minecraft:wither_skeleton] weapon.mainhand with minecraft:stone_sword"
        );
        const skeletons = boss.minionLines("wither-skeleton", 3, true);
        expect(skeletons).toContain(
            "item replace entity @e[tag=pe_bnew,type=minecraft:skeleton] weapon.mainhand with minecraft:bow"
        );
        // Armed before the tag that finds them comes off.
        const armed = withered.findIndex((line) => line.includes("weapon.mainhand"));
        expect(armed).toBeLessThan(withered.indexOf("tag @e[tag=pe_bnew] remove pe_bnew"));
    });

    it("hands the vexes of a burst on the land their iron swords", () => {
        const planned = boss.abilityLines("burst", {
            arena: false,
            difficulty: "epic",
            damage: true,
            target: null,
            warning: "Vexes!",
            markers: true
        });
        const summons = planned.act.filter((line) => line.includes("summon minecraft:vex"));
        expect(summons).toHaveLength(3);
        for (const line of summons) expect(line).toContain('"pe_bnew"');
        expect(planned.act).toContain(
            "item replace entity @e[tag=pe_bnew,type=minecraft:vex] weapon.mainhand with minecraft:iron_sword"
        );
        expect(planned.act).toContain("tag @e[tag=pe_bnew] remove pe_bnew");
    });
});

describe("finding the way up", () => {
    it("draws a tall column of light from the ground to the arena, and a glow where to step in", () => {
        const [column, foot] = boss.liftBeam({ x: 10, y: 64, z: -5 });
        const half = (boss.ARENA_HEIGHT + boss.ARENA_ROOM) / 2;
        expect(column).toBe(
            `execute in minecraft:overworld run particle minecraft:end_rod 10.5 ${64 + half} -4.5 0.15 ${half} 0.15 0.005 240 force`
        );
        expect(foot).toContain("particle minecraft:glow 10.5 65 -4.5");
    });

    it("shows each fighter their own damage, read by the game itself, in their language", () => {
        const line = boss.damageBarLine(true, { en: "Your damage: ", es: "Tu daño: " });
        expect(line).toMatch(
            /^execute as @e\[tag=pe_boss,limit=1\] at @s as @a\[tag=pe_in,gamemode=!creative,gamemode=!spectator\] run title @s actionbar /
        );
        expect(line).toContain('{"polaris":"');
    });
});

describe("who wins a boss", () => {
    const fought = (
        options: Partial<catalog.EventOptions<"world-boss">>,
        decidedBy: string | null
    ) =>
        ({
            preset: {
                ...catalog.newPreset("world-boss", "b"),
                options: { ...catalog.newPreset("world-boss", "b").options, ...options }
            },
            decidedBy
        }) as unknown as boss.Decided;
    const scores = new Map([
        ["Ana", 120],
        ["Ben", 300],
        ["Cai", 40],
        ["Dee", 5]
    ]);

    it("goes by the most damage by default, the final blow only taking part", () => {
        const run = fought({}, "Cai");
        const placed = boss.podiumOf(run, scores, new Set(), 20);
        expect(placed.map((one) => one.name)).toEqual(["Ben", "Ana", "Cai"]);
        expect(boss.trophyWinner(run, placed)).toBe("Ben");
    });

    it("puts the final blow first when that decides it, the rest by damage", () => {
        const run = fought({ winner: "final-blow" }, "Cai");
        const placed = boss.podiumOf(run, scores, new Set(), 20);
        expect(placed).toEqual([
            { place: 1, name: "Cai", score: 40 },
            { place: 2, name: "Ben", score: 300 },
            { place: 3, name: "Ana", score: 120 }
        ]);
        expect(boss.trophyWinner(run, placed)).toBe("Cai");
    });

    it("gives no trophy when it is switched off, or when the boss got away", () => {
        const off = fought({ trophy: false }, "Cai");
        expect(boss.trophyWinner(off, boss.podiumOf(off, scores, new Set(), 20))).toBeNull();
        const away = fought({}, null);
        expect(boss.trophyWinner(away, [{ place: 1, name: "Ben", score: 300 }])).toBeNull();
    });

    it("lists everybody's damage at the end, most first, leaving out whoever was disqualified", () => {
        const ranked = boss.ranking(scores, new Set(["ana"]), 10);
        expect(ranked).toEqual([
            { name: "Ben", damage: 300 },
            { name: "Cai", damage: 40 },
            { name: "Dee", damage: 5 }
        ]);
        const bare = written.damageRanking(ranked, "en").replace(/&[0-9a-fk-or]/g, "");
        expect(bare).toBe("Damage dealt: 1. Ben 300, 2. Cai 40, 3. Dee 5");
        expect(boss.ranking(new Map([["Ana", 0]]), new Set(), 10)).toEqual([]);
    });

    it("names the trophy for how it was won", () => {
        expect(written.trophyLore("epic", "damage", "en")).toBe("Most damage - Epic");
        expect(written.trophyLore("epic", "final-blow", "es")).toBe("Golpe final - Épico");
    });
});
