/**
 * Giving back what a player carried into an event: every stack once, never
 * twice - whatever the player, or a mod sorting their bag, does with a stack
 * the moment it lands.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const rows = new Map<string, Record<string, unknown>>();

vi.mock("@polaris/db", () => ({
    prisma: {
        eventInventoryStash: {
            create: async ({ data }: { data: Record<string, unknown> }) => {
                const id = `row${rows.size + 1}`;
                rows.set(id, { ...data, id });
                return { id };
            },
            update: async ({
                where,
                data
            }: {
                where: { id: string };
                data: Record<string, unknown>;
            }) => {
                rows.set(where.id, { ...rows.get(where.id), ...data });
                return rows.get(where.id);
            },
            findUnique: async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null,
            deleteMany: async ({ where }: { where: { id: string } }) => {
                rows.delete(where.id);
                return { count: 1 };
            }
        },
        installedApp: {
            findUnique: async () => ({ config: null })
        }
    }
}));

vi.mock("@polaris/app-host", () => ({
    host: {
        appsInstallConfig: {
            readInstallConfig: () => ({}),
            patchInstallConfig: async () => undefined
        }
    }
}));

vi.mock("@polaris-app/game-servers/src/lib/minecraft/service", () => ({
    withServerContainer: async () => {
        throw new Error("not in this test");
    }
}));

const { giveBack, stashIn } = await import(
    "@polaris-app/game-servers/src/lib/minecraft/events/kinds/stash-service"
);

type Stack = { id: string; count: number; data: string | null };

/** Ana's bag, by the game's slot numbers, with each stack's data as printed. */
let bag = new Map<number, Stack>();
/** Items lying in the world: tagged while a give-back checks them. */
let ground: { tags: string[]; stack: Stack; pickable: boolean }[] = [];
/** What happens to a stack the moment it is written into a slot. */
let landing: ((slot: number) => void) | null = null;
/** What happens as one slot is read on its own, before it is written. */
let reading: ((slot: number) => void) | null = null;
let said: string[] = [];

const SLOT_NAMES: Record<string, number> = {
    "armor.feet": 100,
    "armor.legs": 101,
    "armor.chest": 102,
    "armor.head": 103,
    "weapon.offhand": -106
};

function slotOf(name: string): number {
    if (name in SLOT_NAMES) return SLOT_NAMES[name]!;
    const [area, index] = name.split(".");
    return area === "hotbar" ? Number(index) : Number(index) + 9;
}

const entry = (slot: number | null, stack: Stack) =>
    `{count: ${stack.count}, ${slot === null ? "" : `Slot: ${slot}b, `}${stack.data ? `components: ${stack.data}, ` : ""}id: "${stack.id}"}`;

/** Every stack Ana took in, by id: what a write of that id puts back. */
const known = new Map<string, Stack>();

async function say(argv: readonly string[]): Promise<string> {
    const line = argv.join(" ");
    said.push(line);
    if (line === "data get entity Ana Inventory")
        return `Ana has the following entity data: [${[...bag]
            .sort(([a], [b]) => a - b)
            .map(([slot, stack]) => entry(slot, stack))
            .join(", ")}]`;
    const one = /^data get entity Ana Inventory\[\{Slot:(-?\d+)b\}\]$/.exec(line);
    if (one) {
        reading?.(Number(one[1]));
        const stack = bag.get(Number(one[1]));
        return stack
            ? `Ana has the following entity data: ${entry(Number(one[1]), stack)}`
            : "Found no elements";
    }
    if (/^xp query Ana/.test(line)) return "Ana has 0 experience levels";
    const empty = /^item replace entity Ana (\S+) with minecraft:air(?: 1)?$/.exec(line);
    if (empty) {
        bag.delete(slotOf(empty[1]!));
        return "Replaced a slot";
    }
    const write = /^item replace entity Ana (\S+) with (minecraft:[a-z_]+)(?:\[.*\])? (\d+)$/.exec(
        line
    );
    if (write) {
        const slot = slotOf(write[1]!);
        bag.set(slot, { ...known.get(write[2]!)!, count: Number(write[3]) });
        landing?.(slot);
        return "Replaced a slot";
    }
    const summon = /run summon minecraft:item ~ ~ ~ \{Item:\{id:"([^"]+)".*Tags:\["([^"]+)"\]/.exec(
        line
    );
    if (summon) {
        if (!ground.some((one) => one.tags.includes(summon[2]!)))
            ground.push({ tags: [summon[2]!], stack: known.get(summon[1]!)!, pickable: false });
        return "Summoned new Item";
    }
    const read = /^data get entity @e\[type=minecraft:item,tag=([^,\]]+),limit=1\] Item$/.exec(
        line
    );
    if (read) {
        const lying = ground.find((one) => one.tags.includes(read[1]!));
        return lying
            ? `Item has the following entity data: ${entry(null, lying.stack)}`
            : "No entity was found";
    }
    const pickup =
        /^execute as @e\[type=minecraft:item,tag=([^\]]+)\] run data modify entity @s PickupDelay set value 0s$/.exec(
            line
        );
    if (pickup) {
        for (const one of ground) if (one.tags.includes(pickup[1]!)) one.pickable = true;
        return "";
    }
    const untag = /^tag @e\[type=minecraft:item,tag=([^\]]+)\] remove (\S+)$/.exec(line);
    if (untag) {
        for (const one of ground) one.tags = one.tags.filter((tag) => tag !== untag[2]);
        return "";
    }
    const kill = /^kill @e\[type=minecraft:item,tag=([^\]]+)\]$/.exec(line);
    if (kill) {
        ground = ground.filter((one) => !one.tags.includes(kill[1]!));
        return "";
    }
    return "";
}

const server = {
    installedAppId: "app",
    say,
    sayAll: async (lines: readonly string[]) => {
        for (const line of lines) await say([line]);
    }
} as never;

const owner = { installedAppId: "app", runId: "run", event: "SkyWars" };

const BOW: Stack = {
    id: "minecraft:bow",
    count: 1,
    data: '{"minecraft:enchantments": {levels: {"minecraft:flame": 1, "minecraft:infinity": 1, "minecraft:power": 5, "minecraft:punch": 2, "minecraft:unbreaking": 3}}, "minecraft:damage": 61, "minecraft:repair_cost": 1}'
};
const SWORD: Stack = { id: "minecraft:netherite_sword", count: 1, data: null };

/** How many of `id` Ana has: in her bag, and lying for her to pick up. */
function owned(id: string): number {
    return (
        [...bag.values()].filter((one) => one.id === id).length +
        ground.filter((one) => one.pickable && one.stack.id === id).length
    );
}

/** Ana's things taken in, as an arena does; her bag empty after. */
async function stashed() {
    const result = await stashIn(server, owner, "Ana", async () => undefined);
    expect(result.refused).toBeNull();
    expect(bag.size).toBe(0);
    return result.stash!;
}

beforeEach(() => {
    rows.clear();
    known.clear();
    bag = new Map();
    ground = [];
    landing = null;
    reading = null;
    said = [];
    for (const stack of [BOW, SWORD]) known.set(stack.id, stack);
});

describe("giving back what somebody carried", () => {
    it("gives each stack back into its own slot, once", async () => {
        bag.set(0, BOW);
        bag.set(1, SWORD);
        const kept = await stashed();
        let left: unknown = "unsaved";
        expect(await giveBack(server, "Ana", kept, async (rest) => void (left = rest))).toBe(
            "done"
        );
        expect(left).toBeNull();
        expect(bag.get(0)?.id).toBe(BOW.id);
        expect(bag.get(1)?.id).toBe(SWORD.id);
        expect(ground).toEqual([]);
        expect(rows.size).toBe(0);
    });

    // The report: a player came home from SkyWars with two of their own bow,
    // one in the first hotbar slot and one in the bag. The bow was written into
    // its slot, moved off it at once - by the player, or a mod sorting their
    // bag - and the read back of that one slot took it for never given: a
    // second copy was dropped at their feet.
    it("never drops a second copy of a stack moved off its slot the moment it landed", async () => {
        bag.set(0, BOW);
        bag.set(1, SWORD);
        const kept = await stashed();
        landing = (slot) => {
            if (slot !== 0) return;
            landing = null;
            bag.set(28, bag.get(0)!);
            bag.delete(0);
        };
        expect(await giveBack(server, "Ana", kept, async () => undefined)).toBe("done");
        expect(owned(BOW.id)).toBe(1);
        expect(bag.get(28)?.id).toBe(BOW.id);
        expect(owned(SWORD.id)).toBe(1);
    });

    it("never drops a second copy of a stack thrown or put away the moment it landed", async () => {
        bag.set(0, BOW);
        const kept = await stashed();
        // Out of the bag before it can be read back: on the ground, picked up
        // by somebody, in a chest - seen nowhere.
        landing = () => {
            landing = null;
            bag.delete(0);
        };
        const result = await giveBack(server, "Ana", kept, async () => undefined);
        expect(owned(BOW.id)).toBe(0);
        expect(said.some((line) => line.includes("summon minecraft:item"))).toBe(false);
        // Written, and so not owed: nothing left for the panel to give again.
        expect(result).toBe("done");
    });

    it("still drops at their feet a stack whose slot they filled before it could be written", async () => {
        bag.set(0, BOW);
        const kept = await stashed();
        // Something of their own in the bow's slot by the time it comes back.
        known.set("minecraft:stick", { id: "minecraft:stick", count: 3, data: null });
        bag.set(0, known.get("minecraft:stick")!);
        expect(await giveBack(server, "Ana", kept, async () => undefined)).toBe("done");
        expect(bag.get(0)?.id).toBe("minecraft:stick");
        expect(owned(BOW.id)).toBe(1);
        expect(ground.filter((one) => one.stack.id === BOW.id)).toHaveLength(1);
    });

    it("drops a stack whose slot was filled before its write, even with a plain one of its id elsewhere", async () => {
        bag.set(0, BOW);
        const kept = await stashed();
        // Picked up as the give-back runs: something into the bow's slot, and a
        // plain bow of their own into another one.
        known.set("minecraft:stick", { id: "minecraft:stick", count: 3, data: null });
        reading = (slot) => {
            if (slot !== 0) return;
            reading = null;
            bag.set(0, known.get("minecraft:stick")!);
            bag.set(20, { id: BOW.id, count: 1, data: null });
        };
        expect(await giveBack(server, "Ana", kept, async () => undefined)).toBe("done");
        expect(bag.get(20)?.data).toBeNull();
        expect(ground.filter((one) => one.stack.id === BOW.id)).toHaveLength(1);
    });

    it("keeps a write the game confirmed as given when a later slot cannot be read", async () => {
        bag.set(0, BOW);
        bag.set(1, SWORD);
        const kept = await stashed();
        landing = (slot) => {
            if (slot !== 0) return;
            landing = null;
            bag.delete(0);
        };
        reading = (slot) => {
            if (slot !== 1) return;
            reading = null;
            throw new Error("closed");
        };
        await giveBack(server, "Ana", kept, async () => undefined);
        expect(owned(BOW.id)).toBe(0);
        expect(
            said.some((line) => line.includes(`summon minecraft:item ~ ~ ~ {Item:{id:"${BOW.id}"`))
        ).toBe(false);
    });
});
