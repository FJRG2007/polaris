/**
 * Moving things around a player's inventory from the editor: between the bag,
 * the hotbar, the offhand and what they wear, and onto the same item to stack
 * them up - what a drag in the game's own inventory screen does.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/** Slot -> stack, as the fake server holds it. */
const fake = vi.hoisted(() => ({ slots: new Map<number, { id: string; count: number }>(), wrote: [] as string[] }));

/** Which slot number a replace command's slot name is. */
function slotNumber(name: string): number {
    if (name === "weapon.offhand") return -106;
    const hotbar = /^hotbar\.(\d+)$/.exec(name);
    if (hotbar) return Number(hotbar[1]);
    const bag = /^inventory\.(\d+)$/.exec(name);
    if (bag) return Number(bag[1]) + 9;
    return 100 + ["armor.feet", "armor.legs", "armor.chest", "armor.head"].indexOf(name);
}

const server = {
    running: true,
    edition: "java",
    say: async (argv: string[]) => {
        if (argv[0] === "data") {
            const slot = Number(/Slot:(-?\d+)b/.exec(argv[4] ?? "")?.[1]);
            const stack = fake.slots.get(slot);
            if (!stack) return "Found no elements matching Inventory";
            return `Reckmy has the following entity data: {Slot: ${slot}b, id: "${stack.id}", count: ${stack.count}}`;
        }
        // item replace entity <player> <slot> with <item> <count>
        fake.wrote.push(argv.join(" "));
        const slot = slotNumber(argv[4] ?? "");
        const item = argv[6] ?? "";
        const count = Number(argv[7]);
        if (item === "minecraft:air" || item === "air") fake.slots.delete(slot);
        else fake.slots.set(slot, { id: item, count });
        return "Replaced a slot on Reckmy with ...";
    }
};

vi.mock("@polaris/db", () => ({
    prisma: { installedApp: { findUnique: async () => ({ config: JSON.stringify({ itemCommand: "item" }) }) } }
}));
vi.mock("@polaris/app-host", () => ({
    host: {
        appsInstallConfig: {
            readInstallConfig: (raw: string) => JSON.parse(raw ?? "{}"),
            patchInstallConfig: async () => undefined
        }
    }
}));
vi.mock("@polaris-app/game-servers/src/lib/minecraft/service", () => ({
    withServerContainer: async (_owner: string, _id: string, work: (one: unknown) => unknown) => work(server)
}));

const { moveStack } = await import("@polaris-app/game-servers/src/lib/minecraft/item-service");
const { planStackMove } = await import("@polaris-app/game-servers/src/lib/minecraft/stack-move");

const stack = (slot: number, id: string, count: number) => ({ slot, id, count, data: null });
const OFFHAND = -106;
const HEAD = 103;

/** Drag `from` onto `to`, telling the server what the editor was showing. */
async function drag(from: number, to: number, count?: number) {
    const seen = (slot: number) => {
        const held = fake.slots.get(slot);
        return held ? stack(slot, held.id, held.count) : null;
    };
    await moveStack("owner", "install", "Reckmy", from, to, { from: seen(from), to: seen(to) }, count);
}

beforeEach(() => {
    fake.slots = new Map();
    fake.wrote = [];
});

describe("what a drop does", () => {
    it("tops the same item up and leaves the rest behind", () => {
        expect(planStackMove(stack(9, "minecraft:stone", 40), stack(0, "minecraft:stone", 50), undefined, 64)).toEqual({
            kind: "merge",
            target: 64,
            source: 26
        });
    });

    it("does nothing onto the same item already full, and swaps anything else", () => {
        expect(planStackMove(stack(9, "minecraft:stone", 5), stack(0, "minecraft:stone", 64), undefined, 64).kind).toBe(
            "full"
        );
        expect(planStackMove(stack(9, "minecraft:stone", 5), stack(0, "minecraft:dirt", 3), undefined, 64).kind).toBe(
            "swap"
        );
    });

    it("never stacks items whose data differs", () => {
        const sword = { ...stack(9, "minecraft:diamond_sword", 1), data: { era: "components" as const, snbt: "{a:1}" } };
        const other = { ...sword, slot: 0, data: { era: "components" as const, snbt: "{a:2}" } };
        expect(planStackMove(sword, other, undefined, 1).kind).toBe("swap");
    });
});

describe("moving things around a live player's inventory", () => {
    it("moves a stack from the bag to the hotbar", async () => {
        fake.slots.set(9, { id: "minecraft:torch", count: 32 });
        await drag(9, 0);
        expect(fake.slots.get(0)).toEqual({ id: "minecraft:torch", count: 32 });
        expect(fake.slots.has(9)).toBe(false);
    });

    it("stacks two of the same item together instead of swapping them", async () => {
        fake.slots.set(9, { id: "minecraft:cobblestone", count: 40 });
        fake.slots.set(0, { id: "minecraft:cobblestone", count: 50 });
        await drag(9, 0);
        expect(fake.slots.get(0)).toEqual({ id: "minecraft:cobblestone", count: 64 });
        expect(fake.slots.get(9)).toEqual({ id: "minecraft:cobblestone", count: 26 });
    });

    it("empties the slot it came from when all of it fits", async () => {
        fake.slots.set(12, { id: "minecraft:cobblestone", count: 10 });
        fake.slots.set(0, { id: "minecraft:cobblestone", count: 50 });
        await drag(12, 0);
        expect(fake.slots.get(0)).toEqual({ id: "minecraft:cobblestone", count: 60 });
        expect(fake.slots.has(12)).toBe(false);
    });

    it("adds one to the same item with Ctrl", async () => {
        fake.slots.set(9, { id: "minecraft:arrow", count: 10 });
        fake.slots.set(0, { id: "minecraft:arrow", count: 3 });
        await drag(9, 0, 1);
        expect(fake.slots.get(0)).toEqual({ id: "minecraft:arrow", count: 4 });
        expect(fake.slots.get(9)).toEqual({ id: "minecraft:arrow", count: 9 });
    });

    it("puts something in the offhand, and on their head, swapping what was there", async () => {
        fake.slots.set(0, { id: "minecraft:shield", count: 1 });
        await drag(0, OFFHAND);
        expect(fake.slots.get(OFFHAND)).toEqual({ id: "minecraft:shield", count: 1 });

        fake.slots.set(10, { id: "minecraft:iron_helmet", count: 1 });
        fake.slots.set(HEAD, { id: "minecraft:leather_helmet", count: 1 });
        await drag(10, HEAD);
        expect(fake.slots.get(HEAD)).toEqual({ id: "minecraft:iron_helmet", count: 1 });
        expect(fake.slots.get(10)).toEqual({ id: "minecraft:leather_helmet", count: 1 });
    });

    it("leaves a full stack of the same item alone", async () => {
        fake.slots.set(9, { id: "minecraft:stone", count: 5 });
        fake.slots.set(0, { id: "minecraft:stone", count: 64 });
        await drag(9, 0);
        expect(fake.wrote).toEqual([]);
    });
});
