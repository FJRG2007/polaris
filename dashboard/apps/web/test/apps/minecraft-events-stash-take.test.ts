/**
 * Putting away what a player carries before an arena or a stage: everything of
 * theirs taken, however long, before they are let in - and what turns up on
 * them meanwhile taken too - or they are kept out with all of it.
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
            findUnique: async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null
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

const { stashIn } = await import(
    "@polaris-app/game-servers/src/lib/minecraft/events/kinds/stash-service"
);

type Stack = { id: string; count: number; data: string | null };

/** Ana's bag, by the game's slot numbers, with each stack's data as printed. */
let bag = new Map<number, Stack>();
let levels = 0;
let said: string[] = [];
/** Run after each batch of lines: what the player does meanwhile. */
let meanwhile: (() => void) | null = null;
let online = true;

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

const entry = (slot: number, stack: Stack) =>
    `{count: ${stack.count}, Slot: ${slot}b, ${stack.data ? `components: ${stack.data}, ` : ""}id: "${stack.id}"}`;

async function say(argv: readonly string[]): Promise<string> {
    const line = argv.join(" ");
    said.push(line);
    if (!online) return "No entity was found";
    if (line === "data get entity Ana Inventory")
        return `Ana has the following entity data: [${[...bag]
            .sort(([a], [b]) => a - b)
            .map(([slot, stack]) => entry(slot, stack))
            .join(", ")}]`;
    const one = /^data get entity Ana Inventory\[\{Slot:(-?\d+)b\}\]$/.exec(line);
    if (one) {
        const stack = bag.get(Number(one[1]));
        return stack
            ? `Ana has the following entity data: ${entry(Number(one[1]), stack)}`
            : "Found no elements";
    }
    if (line === "xp query Ana levels") return `Ana has ${levels} experience levels`;
    if (line === "xp query Ana points") return "Ana has 0 experience points";
    const replace = /^item replace entity Ana (\S+) with minecraft:air$/.exec(line);
    if (replace) {
        bag.delete(slotOf(replace[1]!));
        return "Replaced a slot";
    }
    const xp = /^xp set Ana (\d+) levels$/.exec(line);
    if (xp) levels = Number(xp[1]);
    return "";
}

const server = {
    installedAppId: "app",
    say,
    sayAll: async (lines: readonly string[]) => {
        for (const line of lines) await say([line]);
        const run = meanwhile;
        meanwhile = null;
        run?.();
    }
} as never;

const owner = { installedAppId: "app", runId: "run", event: "Duel" };

const chestplate = (name: string): Stack => ({
    id: "minecraft:diamond_chestplate",
    count: 1,
    data: `{"minecraft:enchantments": {levels: {"minecraft:mending": 1, "minecraft:protection": 4, "minecraft:unbreaking": 3}}, "minecraft:damage": 212, "minecraft:custom_name": '"${name}"', "minecraft:trim": {material: "minecraft:gold", pattern: "minecraft:coast"}}`
});

beforeEach(() => {
    rows.clear();
    bag = new Map();
    levels = 0;
    said = [];
    meanwhile = null;
    online = true;
});

describe("putting away what somebody carries", () => {
    it("takes what they put back on while it was being put away, under a slot of its own", async () => {
        bag.set(0, { id: "minecraft:iron_sword", count: 1, data: null });
        bag.set(102, chestplate("Dragonscale"));
        // The moment their chestplate is gone, they put another one on.
        meanwhile = () => bag.set(102, chestplate("Spare"));
        const saves: unknown[] = [];
        const result = await stashIn(server, owner, "Ana", async (kept) => void saves.push(kept));
        expect(result.refused).toBeNull();
        expect(bag.size).toBe(0);
        expect(result.stash!.state).toBe("stashed");
        expect(result.stash!.kept.map((one) => one.slot).sort((a, b) => a - b)).toEqual([
            0, 9, 102
        ]);
        const copy = JSON.parse(rows.get(result.stash!.record!)!.items as string) as {
            slot: number;
            data: { snbt: string };
        }[];
        expect(copy.find((one) => one.slot === 102)!.data.snbt).toContain("Dragonscale");
        expect(copy.find((one) => one.slot === 9)!.data.snbt).toContain("Spare");
    });

    it("takes a piece too long for one command, and leaves the event's kit where it is", async () => {
        const lore = Array.from(
            { length: 20 },
            (_unused, line) => `'"Line ${line} of a long story"'`
        ).join(", ");
        bag.set(102, {
            id: "minecraft:netherite_chestplate",
            count: 1,
            data: `{"minecraft:lore": [${lore}], "minecraft:damage": 3}`
        });
        bag.set(1, {
            id: "minecraft:stone_sword",
            count: 1,
            data: '{"minecraft:custom_data": {polaris_event: 1b}}'
        });
        levels = 12;
        const result = await stashIn(server, owner, "Ana", async () => undefined);
        expect(result.refused).toBeNull();
        expect(result.stash!.kept.map((one) => one.slot)).toEqual([102]);
        expect(result.stash!.experience).toEqual({ levels: 12, points: 0 });
        expect([...bag.keys()]).toEqual([1]);
        expect(levels).toBe(0);
    });

    it("keeps them out, taking nothing, for a stack no command can write back", async () => {
        bag.set(0, { id: "minecraft:iron_sword", count: 1, data: null });
        bag.set(5, {
            id: "minecraft:written_book",
            count: 1,
            data: `{"minecraft:custom_name": '"${"x".repeat(1200)}"'}`
        });
        const result = await stashIn(server, owner, "Ana", async () => undefined);
        expect(result.refused).toEqual({ why: "untakeable", items: ["minecraft:written_book"] });
        expect(result.stash).toBeNull();
        expect(bag.size).toBe(2);
        expect(rows.size).toBe(0);
        expect(said.some((line) => line.startsWith("item replace"))).toBe(false);
    });

    it("keeps them out when what they carry cannot be read", async () => {
        online = false;
        const result = await stashIn(server, owner, "Ana", async () => undefined);
        expect(result.refused?.why).toBe("unread");
        expect(rows.size).toBe(0);
    });

    it("carries on a stash already made, once they are in", async () => {
        bag.set(102, chestplate("Dragonscale"));
        let kept = (await stashIn(server, owner, "Ana", async () => undefined)).stash!;
        // Picked up on the way in, into the slot just emptied.
        bag.set(102, chestplate("Found"));
        const result = await stashIn(server, owner, "Ana", async () => undefined, kept);
        expect(result.refused).toBeNull();
        kept = result.stash!;
        expect(kept.record).toBe("row1");
        expect(rows.size).toBe(1);
        expect(kept.kept.map((one) => one.slot).sort((a, b) => a - b)).toEqual([9, 102]);
        expect(bag.size).toBe(0);
    });
});
