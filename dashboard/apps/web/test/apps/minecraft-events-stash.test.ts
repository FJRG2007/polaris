import { describe, expect, it } from "vitest";
import * as stash from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/stash";
import type { InventoryItem } from "@polaris-app/game-servers/src/lib/minecraft/inventory";
import { COMMAND_BYTES_MAX } from "@polaris-app/game-servers/src/lib/minecraft/command-size";

const item = (
    slot: number,
    id: string,
    snbt: string | null = null,
    era: "components" | "tag" = "components"
): InventoryItem => ({
    slot,
    id,
    count: 1,
    data: snbt ? { era, snbt } : null
});

describe("keeping a player's things", () => {
    it("keeps the 41 slots every version has, and nothing else", () => {
        expect(stash.SLOTS).toHaveLength(41);
        expect(stash.SLOTS).toContain(103);
        expect(stash.SLOTS).toContain(-106);
    });

    it("never keeps the event's own kit, a slot vanilla does not have, or a stack no number of commands can carry", () => {
        const kept = [
            item(
                0,
                "minecraft:diamond_sword",
                '{"minecraft:enchantments": {levels: {"minecraft:sharpness": 5}}}'
            ),
            item(1, "minecraft:stone_sword", '{"minecraft:custom_data": {polaris_event: 1b}}'),
            item(150, "curios:ring"),
            item(2, "minecraft:written_book", `{"minecraft:custom_name": '"${"x".repeat(600)}"'}`),
            item(3, "minecraft:written_book", `{"minecraft:custom_name": '"${"x".repeat(1200)}"'}`),
            item(100, "minecraft:leather_boots", '{"minecraft:dyed_color": {rgb: 16711680}}')
        ].filter((one) => !stash.isKit(one) && stash.takeable(one));
        // Too long for one command, but not for several: kept too.
        expect(kept.map((one) => one.slot)).toEqual([0, 2, 100]);
        expect(stash.fitsOneLine(kept[1]!)).toBe(false);
        expect(stash.takeable(item(150, "curios:ring"))).toBe(false);
    });

    it("knows the kit by its marker, never by a name that spells it", () => {
        expect(
            stash.isKit(
                item(0, "minecraft:stone_sword", '{"minecraft:custom_data": {polaris_event: 1b}}')
            )
        ).toBe(true);
        expect(
            stash.isKit(
                item(0, "minecraft:iron_shovel", "{polaris_event: 1b, CanDestroy: []}", "tag")
            )
        ).toBe(true);
        expect(
            stash.isKit(
                item(
                    0,
                    "minecraft:diamond_chestplate",
                    `{"minecraft:custom_name": '"polaris_event"'}`
                )
            )
        ).toBe(false);
        expect(
            stash.isKit(
                item(
                    0,
                    "minecraft:diamond_chestplate",
                    '{"minecraft:custom_data": {note: "polaris_event: 1b"}}'
                )
            )
        ).toBe(false);
        expect(
            stash.isKit(item(0, "minecraft:stone", "{display: {Name: '\"polaris_event\"'}}", "tag"))
        ).toBe(false);
    });

    it("writes a stack taken into a slot nobody is owed yet", () => {
        expect(stash.slotFor(102, new Set([0]))).toBe(102);
        expect(stash.slotFor(102, new Set([102, 9]))).toBe(10);
        expect(stash.slotFor(0, new Set(stash.SLOTS))).toBeNull();
    });

    it("drops a stack too long for one command through storage, under its own tag", () => {
        const record = "00000000-0000-7000-8000-000000000123";
        const lore = Array.from(
            { length: 20 },
            (_unused, line) => `'"Line ${line} of a long story"'`
        ).join(", ");
        const long = item(102, "minecraft:diamond_chestplate", `{"minecraft:lore": [${lore}]}`);
        expect(stash.dropLines("Ana", long, record)).not.toBeNull();
        const huge = item(
            102,
            "minecraft:diamond_chestplate",
            `{"minecraft:lore": [${lore}, ${lore}, ${lore}, ${lore}]}`
        );
        expect(stash.dropLines("Ana", huge, record)).toBeNull();
        const lines = stash.longDropLines("Ana", huge, record)!;
        expect(lines.every((line) => line.length <= COMMAND_BYTES_MAX)).toBe(true);
        const tag = stash.dropTag(record, 102);
        expect(lines.at(-3)).toContain(
            `summon minecraft:item ~ ~ ~ {Item:{id:"minecraft:stone",count:1},Tags:["${tag}"]`
        );
        expect(lines.at(-2)).toBe(
            `data modify entity @e[type=minecraft:item,tag=${tag},limit=1] Item set from storage polaris:io ${stash.longKey(record, 102)}`
        );
        expect(lines.at(-1)).toBe(`data remove storage polaris:io ${stash.longKey(record, 102)}`);
    });

    it("tells two stacks of one id apart by their data", () => {
        const digest = (one: InventoryItem) => one.data?.snbt ?? null;
        const bow = item(0, "minecraft:bow", '{"minecraft:damage": 1}');
        const kept = { id: bow.id, count: bow.count, data: digest(bow) };
        expect(
            stash.sameStack(kept, item(0, "minecraft:bow", '{"minecraft:damage": 1}'), digest)
        ).toBe(true);
        expect(
            stash.sameStack(kept, item(0, "minecraft:bow", '{"minecraft:damage": 2}'), digest)
        ).toBe(false);
        expect(stash.sameStack(kept, undefined, digest)).toBe(false);
    });

    it("reads experience the way the game answers it", () => {
        expect(stash.readExperienceCount("Ana has 12 experience levels")).toBe(12);
        expect(stash.readExperienceCount("Ana has 1 experience level")).toBe(1);
        expect(stash.readExperienceCount("Ana has 7 experience points")).toBe(7);
        expect(stash.readExperienceCount("No player was found")).toBeNull();
        expect(stash.setExperience("Ana", { levels: 12, points: 7 })).toEqual([
            "xp set Ana 12 levels",
            "xp set Ana 7 points"
        ]);
    });

    it("reads health and hunger as the game prints them, and puts them back through what it allows", () => {
        expect(stash.readEntityNumber("Ana has the following entity data: 17.5f")).toBe(17.5);
        expect(stash.readEntityNumber("Ana has the following entity data: 14")).toBe(14);
        expect(stash.readEntityNumber("No entity was found")).toBeNull();
        expect(stash.hurtLine("Ana", 6.5)).toBe("damage Ana 6.5 minecraft:generic_kill");
        expect(stash.feedLine("Ana", 3)).toBe("effect give Ana minecraft:saturation 1 2 true");
        // Hunger's top rate is 25.6 exhaustion a second: more takes longer.
        expect(stash.hungerFor(2)).toEqual({ seconds: 1, amplifier: 19 });
        expect(stash.hungerFor(60)).toEqual({ seconds: 3, amplifier: 199 });
        expect(stash.hungerFor(0.01)).toBeNull();
        // Food that must come down is drained to below what Saturation then
        // brings back up to it with saturation enough.
        expect(
            stash.foodStep(
                { food: 20, saturation: 3, exhaustion: 0 },
                { food: 18, saturation: 3, exhaustion: 0 }
            )
        ).toEqual({ kind: "drain", exhaustion: 4 * (3 + 4) - 2 });
        expect(
            stash.foodStep(
                { food: 16, saturation: 0, exhaustion: 0.1 },
                { food: 18, saturation: 3, exhaustion: 0 }
            )
        ).toEqual({ kind: "feed", points: 2 });
    });

    it("drops a stack whole, in the syntax its own data was read in", () => {
        const record = "00000000-0000-7000-8000-000000000123";
        const tag = stash.dropTag(record, 103);
        expect(tag).toBe("pe_gb00000123_39");
        const modern = stash.dropLines(
            "Ana",
            item(103, "minecraft:diamond_helmet", '{"minecraft:damage": 3}'),
            record
        )!;
        expect(modern).toEqual([
            `execute unless entity @e[type=minecraft:item,tag=${tag}] at Ana run summon minecraft:item ~ ~ ~ {Item:{id:"minecraft:diamond_helmet",count:1,components:{"minecraft:damage": 3}},Tags:["${tag}"],PickupDelay:32767,Age:-32768}`
        ]);
        const legacy = stash.dropLines(
            "Ana",
            item(103, "minecraft:diamond_helmet", "{Damage:3}", "tag"),
            record
        )!;
        expect(legacy).toHaveLength(1);
        expect(legacy[0]).toContain(
            '{Item:{id:"minecraft:diamond_helmet",Count:1b,tag:{Damage:3}}'
        );
        // No data: both ways, the second only where the first made nothing.
        const plain = stash.dropLines("Ana", item(4, "minecraft:bread"), record)!;
        expect(plain).toHaveLength(2);
        const own = stash.dropTag(record, 4);
        expect(
            plain.every((line) =>
                line.startsWith(`execute unless entity @e[type=minecraft:item,tag=${own}]`)
            )
        ).toBe(true);
        // Too long for a command: not dropped at all.
        expect(
            stash.dropLines(
                "Ana",
                item(4, "minecraft:book", `{"a": "${"x".repeat(COMMAND_BYTES_MAX)}"}`),
                record
            )
        ).toBeNull();
    });

    it("lets a checked drop go to its owner only", () => {
        expect(stash.releaseDrop("Ana", "pe_gbx_1")).toEqual([
            "execute as @e[type=minecraft:item,tag=pe_gbx_1] run data modify entity @s Owner set from entity Ana UUID",
            "execute as @e[type=minecraft:item,tag=pe_gbx_1] run data modify entity @s PickupDelay set value 0s",
            "tag @e[type=minecraft:item,tag=pe_gbx_1] remove pe_gbx_1"
        ]);
    });

    it("waits for somebody sent home to be standing on something", () => {
        expect(stash.airborne("Ana")).toBe(
            "execute as Ana at @s if block ~ ~-0.2 ~ minecraft:air if block ~ ~-1.2 ~ minecraft:air"
        );
    });

    it("reads a stash written before this, kept in barrels", () => {
        const old = stash.stashSchema.parse({
            barrels: [{ x: 1, y: 2, z: 3 }],
            casing: [{ x: 0, y: 2, z: 3 }],
            kept: [{ slot: 0, barrel: 0, container: 0, id: "minecraft:bow", count: 1, data: null }],
            state: "stashed",
            record: "r"
        });
        expect(old.experience).toBeNull();
        expect(stash.copyFromBarrel("Ana", old.barrels, old.kept[0]!)).toBe(
            "execute in minecraft:overworld run item replace entity Ana hotbar.0 from block 1 2 3 container.0"
        );
        expect(stash.emptyBarrelSlot(old.barrels, old.kept[0]!)).toBe(
            "execute in minecraft:overworld run item replace block 1 2 3 container.0 with minecraft:air"
        );
        // One kept in the database only has no barrel to empty.
        expect(
            stash.emptyBarrelSlot([], { slot: 0, id: "minecraft:bow", count: 1, data: null })
        ).toBeNull();
    });

    it("takes a block away only while it is still the one put there", () => {
        expect(
            stash.removeLines({ barrels: [{ x: 1, y: 2, z: 3 }], casing: [{ x: 0, y: 2, z: 3 }] })
        ).toEqual([
            "execute in minecraft:overworld if block 1 2 3 minecraft:barrel run setblock 1 2 3 minecraft:air",
            "execute in minecraft:overworld if block 0 2 3 minecraft:barrier run setblock 0 2 3 minecraft:air"
        ]);
    });
});
