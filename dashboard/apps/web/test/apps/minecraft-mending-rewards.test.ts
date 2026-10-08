import { describe, expect, it } from "vitest";
import * as mending from "@polaris-app/game-servers/src/lib/minecraft/mending";
import { parseInventory } from "@polaris-app/game-servers/src/lib/minecraft/inventory";
import { deliver, mendedOf } from "@polaris-app/game-servers/src/lib/minecraft/delivery";

/** A stack as a 1.20.5-1.21.4 server writes it, with Mending and some wear. */
function worn(slot: number, id: string, damage: number, mended = true): string {
    const enchants = mended
        ? `"minecraft:enchantments": {levels: {"minecraft:mending": 1, "minecraft:sharpness": 5}}`
        : `"minecraft:enchantments": {levels: {"minecraft:sharpness": 5}}`;
    return `{Slot: ${slot}b, id: "${id}", count: 1, components: {"minecraft:damage": ${damage}, ${enchants}}}`;
}

function bag(...stacks: string[]): string {
    return `Ana has the following entity data: [${stacks.join(", ")}]`;
}

/**
 * A server that keeps one player's level, points and bag, and answers the lines
 * a delivery sends the way the game does: the bag read, a repair only while the
 * slot still holds that item at that damage, and the experience added.
 */
function game(stacks: { slot: number; id: string; damage: number; mended?: boolean }[], level = 0) {
    const sent: string[] = [];
    const state = { level, points: 0, stacks: stacks.map((one) => ({ mended: true, ...one })) };
    const slotOf = (name: string) =>
        name.startsWith("hotbar.")
            ? Number(name.slice(7))
            : name.startsWith("inventory.")
              ? 9 + Number(name.slice(10))
              : ((
                    {
                        "armor.feet": 100,
                        "armor.legs": 101,
                        "armor.chest": 102,
                        "armor.head": 103
                    } as Record<string, number>
                )[name] ?? -106);
    const say = async (line: string): Promise<string> => {
        sent.push(line);
        if (line === "data get entity Ana Inventory")
            return bag(
                ...state.stacks.map((one) => worn(one.slot, one.id, one.damage, one.mended))
            );
        if (line === "data get entity Ana equipment") return "Found no elements matching equipment";
        if (line === "xp query Ana levels") return `Ana has ${state.level} experience levels`;
        const repair =
            /^execute if items entity Ana (\S+) (\S+)\[minecraft:damage=(\d+)\] run item modify entity Ana \S+ .*"minecraft:damage":(\d+)\}\}$/.exec(
                line
            );
        if (repair) {
            const stack = state.stacks.find(
                (one) =>
                    one.slot === slotOf(repair[1]!) &&
                    one.id === repair[2] &&
                    one.damage === Number(repair[3])
            );
            if (!stack) return "";
            stack.damage = Number(repair[4]);
            return "Applied item modifier to 1 item";
        }
        const levels = /^xp add Ana (\d+) levels$/.exec(line);
        if (levels) {
            state.level += Number(levels[1]);
            return `Gave ${levels[1]} experience levels to Ana`;
        }
        const points = /^xp add Ana (\d+) points$/.exec(line);
        if (points) {
            state.points += Number(points[1]);
            while (state.points >= mending.pointsToNext(state.level)) {
                state.points -= mending.pointsToNext(state.level);
                state.level += 1;
            }
            return `Gave ${points[1]} experience points to Ana`;
        }
        return "Unknown command";
    };
    return { say, sent, state };
}

describe("experience a prize pays, spent on Mending gear first", () => {
    it("counts levels in points as the game charges them", () => {
        expect(mending.pointsToNext(0)).toBe(7);
        expect(mending.pointsToNext(15)).toBe(37);
        expect(mending.pointsToNext(16)).toBe(42);
        expect(mending.pointsToNext(30)).toBe(112);
        expect(mending.pointsToNext(31)).toBe(121);
        // 0 to 5: 7 + 9 + 11 + 13 + 15.
        expect(mending.pointsFor(0, 5)).toBe(55);
        expect(mending.pointsFor(30, 1)).toBe(112);
        expect(mending.levelsFor(0, 55)).toBe(5);
        expect(mending.levelsFor(0, 54)).toBe(4);
    });

    it("finds only damaged items that carry Mending, in either enchantment layout", () => {
        const items = parseInventory(
            bag(
                worn(0, "minecraft:diamond_sword", 120),
                worn(1, "minecraft:diamond_pickaxe", 0),
                worn(2, "minecraft:bow", 30, false),
                `{Slot: 3b, id: "minecraft:netherite_axe", count: 1, components: {"minecraft:damage": 40, "minecraft:enchantments": {"minecraft:mending": 1}}}`,
                `{Slot: 4b, id: "minecraft:enchanted_book", count: 1, components: {"minecraft:stored_enchantments": {levels: {"minecraft:mending": 1}}}}`
            )
        );
        expect(mending.wornMending(items)).toEqual([
            { slot: 0, id: "minecraft:diamond_sword", damage: 120 },
            { slot: 3, id: "minecraft:netherite_axe", damage: 40 }
        ]);
        // Before components: nothing to read, so nothing is repaired.
        expect(
            mending.wornMending(
                parseInventory(
                    'Ana has the following entity data: [{Slot: 0b, id: "minecraft:diamond_sword", Count: 1b, tag: {Damage: 120, Enchantments: [{id: "minecraft:mending", lvl: 1s}]}}]'
                )
            )
        ).toEqual([]);
    });

    it("plans held and worn gear first, then the most worn, two durability a point", () => {
        const worn = [
            { slot: 20, id: "minecraft:trident", damage: 200 },
            { slot: 102, id: "minecraft:diamond_chestplate", damage: 30 },
            { slot: 0, id: "minecraft:diamond_sword", damage: 11 }
        ];
        const repairs = mending.plan(worn, 30);
        expect(repairs.map((one) => [one.slot, one.to, one.points])).toEqual([
            [102, 0, 15],
            [0, 0, 6],
            [20, 182, 9]
        ]);
        expect(mending.plan(worn, 0)).toEqual([]);
    });

    it("repairs the gear and puts only what is left on the bar", async () => {
        const { say, sent, state } = game([
            { slot: 0, id: "minecraft:diamond_sword", damage: 100 }
        ]);
        const handed = await deliver(say, "Ana", { items: [], levels: 5 });
        // 5 levels from 0 are 55 points: 50 mend the sword, 5 go on the bar.
        expect(state.stacks[0]!.damage).toBe(0);
        expect(sent).toContain("xp add Ana 5 points");
        expect(sent).not.toContain("xp add Ana 5 levels");
        expect(handed.left).toBeNull();
        expect(mendedOf(handed.delivery)).toEqual({ count: 1, points: 50 });
        expect(state.level).toBe(0);
        expect(state.points).toBe(5);
    });

    it("spends it all on gear worn down enough, and adds nothing to the bar", async () => {
        const { say, sent, state } = game(
            [{ slot: 103, id: "minecraft:netherite_helmet", damage: 400 }],
            20
        );
        const handed = await deliver(say, "Ana", { items: [], levels: 2 });
        const points = mending.pointsFor(20, 2);
        expect(state.stacks[0]!.damage).toBe(400 - 2 * points);
        expect(sent.some((line) => line.startsWith("xp add"))).toBe(false);
        expect(handed.left).toBeNull();
        expect(handed.delivery.levels).toBe(0);
        expect(mendedOf(handed.delivery)).toEqual({ count: 1, points });
    });

    it("pays the levels as before when nothing needs repairing", async () => {
        for (const stacks of [
            [{ slot: 0, id: "minecraft:diamond_sword", damage: 0 }],
            [{ slot: 0, id: "minecraft:diamond_sword", damage: 90, mended: false }],
            []
        ]) {
            const { say, sent, state } = game(stacks, 7);
            const handed = await deliver(say, "Ana", { items: [], levels: 3 });
            expect(sent).toContain("xp add Ana 3 levels");
            expect(sent.some((line) => line.startsWith("execute if items"))).toBe(false);
            expect(handed.delivery.levels).toBe(3);
            expect(mendedOf(handed.delivery)).toBeNull();
            expect(state.level).toBe(10);
        }
    });

    it("never repairs an item that was moved in between, and pays the levels instead", async () => {
        const { say, sent, state } = game([
            { slot: 0, id: "minecraft:diamond_sword", damage: 100 }
        ]);
        const moving = async (line: string) => {
            // The sword goes to another slot before the repair lands.
            if (line.startsWith("execute if items")) state.stacks[0]!.slot = 5;
            return say(line);
        };
        const handed = await deliver(moving, "Ana", { items: [], levels: 5 });
        expect(state.stacks[0]!.damage).toBe(100);
        expect(sent).toContain("xp add Ana 5 levels");
        expect(mendedOf(handed.delivery)).toBeNull();
    });

    it("keeps owed only the levels the rest buys when the bar could not take it", async () => {
        const { say, state } = game([{ slot: 0, id: "minecraft:diamond_sword", damage: 20 }]);
        const offline = async (line: string) =>
            line.startsWith("xp add") ? "No player was found" : say(line);
        const handed = await deliver(offline, "Ana", { items: [], levels: 5 });
        // 10 of the 55 points mended the sword; 45 buy 4 whole levels from 0.
        expect(state.stacks[0]!.damage).toBe(0);
        expect(handed.left).toEqual({ items: [], levels: 4 });
    });
});
