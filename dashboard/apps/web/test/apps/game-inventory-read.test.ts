import { describe, expect, it } from "vitest";
import { replyIsWhole } from "@/lib/apps/minecraft/snbt";
import { readLiveInventory } from "@/lib/apps/minecraft/inventory-service";

/** A reply the way the server writes one. */
function said(player: string, value: string): string {
    return `${player} has the following entity data: ${value}`;
}

/** An answering server, scripted per command. Anything it was not given an answer
 *  for is the refusal the game gives for a path that matches nothing. */
function server(answers: Record<string, string>) {
    const asked: string[] = [];
    const ask = async (argv: readonly string[]): Promise<string> => {
        const key = argv.join(" ");
        asked.push(key);
        return answers[key] ?? "Found no elements matching that path";
    };
    return { ask, asked };
}

const WHOLE_BAG = "data get entity Alice Inventory";

describe("readLiveInventory", () => {
    it("takes the whole bag in one question when the reply arrives whole", async () => {
        const { ask, asked } = server({
            [WHOLE_BAG]: said(
                "Alice",
                '[{Slot: 0b, id: "minecraft:stone", Count: 64b}, {Slot: 1b, id: "minecraft:torch", Count: 3b}]'
            )
        });
        const reading = await readLiveInventory(ask, "Alice");
        expect(reading.answered).toBe(true);
        expect(reading.chunked).toBe(false);
        expect(reading.items.map((item) => item.id)).toEqual(["minecraft:stone", "minecraft:torch"]);
        expect(asked).toEqual([WHOLE_BAG]);
    });

    it("reports an empty bag as empty, without asking forty more questions", async () => {
        // `[]` closes, so it is the whole answer. Reading it a stack at a time
        // would cost 41 round trips to learn what the first reply already said.
        const { ask, asked } = server({ [WHOLE_BAG]: said("Alice", "[]") });
        const reading = await readLiveInventory(ask, "Alice");
        expect(reading).toMatchObject({ answered: true, chunked: false, unreadable: 0, items: [] });
        expect(asked).toEqual([WHOLE_BAG]);
    });

    it("reads the bag a stack at a time when the whole-bag reply was cut off", async () => {
        // RCON hands back one packet and the client in the server's image does not
        // reassemble the rest, so a big bag ends mid-compound. Parsed as it stands
        // that is no stacks at all - a full inventory drawn as an empty one.
        const { ask, asked } = server({
            [WHOLE_BAG]: said("Alice", '[{Slot: 0b, id: "minecraft:netherite_helmet", Count: 1b, components: {"min'),
            "data get entity Alice Inventory[0]": said("Alice", '{Slot: 103b, id: "minecraft:netherite_helmet", Count: 1b}'),
            "data get entity Alice Inventory[1]": said("Alice", '{Slot: 0b, id: "minecraft:diamond", Count: 12b}')
        });
        const reading = await readLiveInventory(ask, "Alice");
        expect(reading.answered).toBe(true);
        expect(reading.chunked).toBe(true);
        expect(reading.unreadable).toBe(0);
        // In slot order, whichever order the entries came back in.
        expect(reading.items.map((item) => item.slot)).toEqual([0, 103]);
        expect(asked).toEqual([
            WHOLE_BAG,
            "data get entity Alice Inventory[0]",
            "data get entity Alice Inventory[1]",
            "data get entity Alice Inventory[2]"
        ]);
    });

    it("counts a stack it could not read even alone rather than dropping it", async () => {
        const { ask } = server({
            [WHOLE_BAG]: said("Alice", '[{Slot: 0b, id: "minecraft:shulker_box", Count: 1b, components: {"min'),
            "data get entity Alice Inventory[0]": said("Alice", '{Slot: 0b, id: "minecraft:shulker_box", components: {"min'),
            "data get entity Alice Inventory[1]": said("Alice", '{Slot: 1b, id: "minecraft:bread", Count: 5b}')
        });
        const reading = await readLiveInventory(ask, "Alice");
        expect(reading.unreadable).toBe(1);
        expect(reading.items.map((item) => item.id)).toEqual(["minecraft:bread"]);
    });

    it("does not claim an answer when the server refused", async () => {
        const { ask, asked } = server({ [WHOLE_BAG]: "No entity was found" });
        const reading = await readLiveInventory(ask, "Alice");
        expect(reading.answered).toBe(false);
        expect(reading.items).toEqual([]);
        expect(reading.said).toBe("No entity was found");
        expect(asked).toEqual([WHOLE_BAG]);
    });

    it("stops at the 41 entries a player's inventory can hold", async () => {
        // A server that answered every index forever must not become an endless
        // loop of round trips.
        const answers: Record<string, string> = {
            [WHOLE_BAG]: said("Alice", '[{Slot: 0b, id: "minecraft:stone", Count: 1b, components: {"min')
        };
        for (let index = 0; index < 200; index += 1) {
            answers[`data get entity Alice Inventory[${index}]`] = said(
                "Alice",
                `{Slot: ${index}b, id: "minecraft:stone", Count: 1b}`
            );
        }
        const { ask, asked } = server(answers);
        const reading = await readLiveInventory(ask, "Alice");
        expect(reading.items).toHaveLength(41);
        expect(asked).toHaveLength(42);
    });
});

describe("replyIsWhole", () => {
    it("tells a bag that is empty apart from a reply that ran out of room", () => {
        expect(replyIsWhole(said("Alice", "[]"), "[")).toBe(true);
        expect(replyIsWhole(said("Alice", '[{Slot: 0b, id: "minecraft:stone"'), "[")).toBe(false);
    });

    it("is false when there is no value at all", () => {
        expect(replyIsWhole("No entity was found", "[")).toBe(false);
    });
});
