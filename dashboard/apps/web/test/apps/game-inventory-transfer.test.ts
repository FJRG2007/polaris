/**
 * Sending what one player carries to another, and emptying a bag.
 *
 * The order is the whole point: a stack is given to the recipient first and only
 * taken from the sender once the server says it arrived, so a recipient who is
 * not there costs nothing, and a failure in between leaves a copy rather than a
 * lost item.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Stack = { id: string; count: number };

/** Each player's bag, by slot. A player missing from this map is offline. */
const bags = new Map<string, Map<number, Stack>>();
/** Every command the server was handed. */
const said: string[][] = [];

function entry(slot: number, stack: Stack): string {
    return `{Slot: ${slot}b, id: "${stack.id}", count: ${stack.count}}`;
}

/** The slot a `hotbar.N` / `inventory.N` name points at. */
function slotOf(name: string): number {
    const [area, index] = name.split(".");
    return area === "hotbar" ? Number(index) : Number(index) + 9;
}

async function say(argv: string[]): Promise<string> {
    said.push(argv);
    const [command, ...rest] = argv;
    if (command === "data") {
        const [, , player, path] = rest;
        const bag = bags.get(player ?? "");
        if (!bag) return "No entity was found";
        const one = /^Inventory\[\{Slot:(\d+)b\}\]$/.exec(path ?? "");
        if (one) {
            const stack = bag.get(Number(one[1]));
            return stack
                ? `${player} has the following entity data: ${entry(Number(one[1]), stack)}`
                : `Found no elements matching ${path}`;
        }
        const all = [...bag.entries()].map(([slot, stack]) => entry(slot, stack));
        return `${player} has the following entity data: [${all.join(", ")}]`;
    }
    if (command === "give") {
        const [player, item, count] = rest;
        const bag = bags.get(player ?? "");
        if (!bag) return "No player was found";
        let free = 0;
        while (bag.has(free)) free += 1;
        bag.set(free, { id: item ?? "", count: Number(count) });
        return `Gave ${count} [${item}] to ${player}`;
    }
    if (command === "item") {
        // item replace entity <player> <slot> with <item> <count>
        const [, , player, slot, , item, count] = rest;
        const bag = bags.get(player ?? "")!;
        if (item === "minecraft:air") bag.delete(slotOf(slot ?? ""));
        else bag.set(slotOf(slot ?? ""), { id: item ?? "", count: Number(count) });
        return "Replaced a slot";
    }
    if (command === "clear") {
        const bag = bags.get(rest[0] ?? "");
        if (!bag) return "No player was found";
        const removed = bag.size;
        bag.clear();
        return `Removed ${removed} item(s) from player ${rest[0]}`;
    }
    return "";
}

vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: {
            findUnique: async () => ({ config: JSON.stringify({ itemCommand: "item" }) }),
            update: async () => ({})
        }
    }
}));

vi.mock("@/lib/apps/minecraft/service", () => ({
    withServerContainer: async (
        _ownerId: string,
        _installedAppId: string,
        run: (server: unknown) => Promise<unknown>
    ) => run({ edition: "java", say, run: async () => ({ code: 0, output: "" }) })
}));

vi.mock("@/lib/apps/recent-items", () => ({ recentlyGivenItems: async () => [] }));

const { clearInventory, transferInventory, transferStack } = await import(
    "@/lib/apps/minecraft/item-service"
);

const OWNER = "owner";
const SERVER = "server";

beforeEach(() => {
    bags.clear();
    said.length = 0;
    bags.set(
        "Alice",
        new Map([
            [0, { id: "minecraft:diamond", count: 10 }],
            [1, { id: "minecraft:stone", count: 64 }]
        ])
    );
    bags.set("Bob", new Map());
});

describe("sending one stack", () => {
    it("gives it to the recipient and then takes it from the sender", async () => {
        await transferStack(OWNER, SERVER, "Alice", "Bob", 0, {
            slot: 0,
            id: "minecraft:diamond",
            count: 10,
            data: null
        });
        expect(bags.get("Bob")?.get(0)).toEqual({ id: "minecraft:diamond", count: 10 });
        expect(bags.get("Alice")?.has(0)).toBe(false);
        const give = said.findIndex((argv) => argv[0] === "give");
        const take = said.findIndex((argv) => argv[0] === "item");
        expect(give).toBeLessThan(take);
    });

    it("sends part of a stack and leaves the rest", async () => {
        await transferStack(
            OWNER,
            SERVER,
            "Alice",
            "Bob",
            1,
            { slot: 1, id: "minecraft:stone", count: 64, data: null },
            20
        );
        expect(bags.get("Bob")?.get(0)).toEqual({ id: "minecraft:stone", count: 20 });
        expect(bags.get("Alice")?.get(1)).toEqual({ id: "minecraft:stone", count: 44 });
    });

    it("takes nothing when the recipient is not on", async () => {
        bags.delete("Bob");
        await expect(
            transferStack(OWNER, SERVER, "Alice", "Bob", 0, {
                slot: 0,
                id: "minecraft:diamond",
                count: 10,
                data: null
            })
        ).rejects.toThrow(/has to be on the server/);
        expect(bags.get("Alice")?.get(0)).toEqual({ id: "minecraft:diamond", count: 10 });
    });

    it("refuses a stack that changed since the screen read it", async () => {
        await expect(
            transferStack(OWNER, SERVER, "Alice", "Bob", 0, {
                slot: 0,
                id: "minecraft:diamond",
                count: 3,
                data: null
            })
        ).rejects.toThrow(/moved that stack/);
        expect(bags.get("Bob")?.size).toBe(0);
    });

    it("refuses sending to the same player", async () => {
        await expect(transferStack(OWNER, SERVER, "Alice", "alice", 0, null)).rejects.toThrow(
            /different player/
        );
    });
});

describe("sending everything", () => {
    it("moves every stack across", async () => {
        const result = await transferInventory(OWNER, SERVER, "Alice", "Bob");
        expect(result).toEqual({ moved: 2, kept: 0 });
        expect(bags.get("Alice")?.size).toBe(0);
        expect([...(bags.get("Bob")?.values() ?? [])]).toEqual([
            { id: "minecraft:diamond", count: 10 },
            { id: "minecraft:stone", count: 64 }
        ]);
    });

    it("moves nothing when the recipient is not on", async () => {
        bags.delete("Bob");
        await expect(transferInventory(OWNER, SERVER, "Alice", "Bob")).rejects.toThrow(
            /has to be on the server/
        );
        expect(bags.get("Alice")?.size).toBe(2);
    });

    it("says so when the sender is not on", async () => {
        bags.delete("Alice");
        await expect(transferInventory(OWNER, SERVER, "Alice", "Bob")).rejects.toThrow(
            /Alice has to be on the server/
        );
    });
});

describe("emptying a bag", () => {
    it("clears everything the player carries", async () => {
        await clearInventory(OWNER, SERVER, "Alice");
        expect(said).toContainEqual(["clear", "Alice"]);
        expect(bags.get("Alice")?.size).toBe(0);
    });
});
