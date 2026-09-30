/**
 * How many trips into the container reading bags costs.
 *
 * Every trip is a process started in the container, and on a registered machine an
 * SSH exchange too: a full bag used to be one for the whole-bag question and one per
 * stack after it (the whole answer is cut at one 4 KiB RCON packet), and an export
 * of several players paid that per player. The fake below counts trips and enforces
 * both limits the real transport has - 4 KiB per answer, 16 KiB per trip, each cut
 * silently - so what is measured is what the server would be asked.
 */

import { describe, expect, it } from "vitest";
import { sayEachReplies, sayEachScript } from "@polaris-app/game-servers/src/lib/minecraft/say-each";
import { readLiveInventories, readLiveInventory } from "@polaris-app/game-servers/src/lib/minecraft/inventory-service";

const RCON_PACKET = 4096;
const TRIP_CAP = 16 * 1024;

/** A stack worth reading: enchanted, named, a few hundred bytes of data. */
function stack(slot: number): string {
    return `{Slot: ${slot}b, id: "minecraft:diamond_sword", count: 1, components: {"minecraft:custom_name": '"Blade number ${slot} of the hoard"', "minecraft:enchantments": {levels: {"minecraft:sharpness": 5, "minecraft:unbreaking": 3, "minecraft:looting": 3, "minecraft:mending": 1}}, "minecraft:damage": ${slot}}}`;
}

/** A full bag: 36 in the bag and hotbar, 4 worn, 1 in the offhand. */
function fullBag(): string[] {
    const slots = [...Array.from({ length: 36 }, (_, index) => index), 100, 101, 102, 103, -106];
    return slots.map(stack);
}

/** A server holding these bags, reached the way the container is: one trip per
 *  `say`, one per `sayEach` batch, every answer and every trip cut where the real
 *  ones are. */
function server(bags: Record<string, string[]>) {
    let trips = 0;
    const answer = (argv: readonly string[]): string => {
        const [, , , player, path] = argv;
        const bag = bags[player!];
        if (!bag) return "No entity was found";
        const entry = /^Inventory\[(\d+)\]$/.exec(path!);
        const text = entry
            ? bag[Number(entry[1])]
                ? `${player} has the following entity data: ${bag[Number(entry[1])]}`
                : `Found no elements matching Inventory[${entry[1]}]`
            : `${player} has the following entity data: [${bag.join(", ")}]`;
        return text.slice(0, RCON_PACKET);
    };
    const say = async (argv: readonly string[]): Promise<string> => {
        trips += 1;
        return answer(argv);
    };
    const sayEach = async (commands: readonly (readonly string[])[]): Promise<(string | null)[]> => {
        trips += 1;
        // What the shell script prints, cut at what one trip hands back.
        expect(sayEachScript(commands)).toContain("rcon-cli");
        const printed = commands.map((argv, index) => `${answer(argv)}\n@@polaris-end ${index} 0\n`).join("");
        return sayEachReplies(printed.slice(0, TRIP_CAP), commands.length);
    };
    return { say, sayEach, trips: () => trips };
}

describe("reading bags", () => {
    it("reads one full bag in 6 trips instead of 42, stack for stack the same", async () => {
        const before = server({ Alice: fullBag() });
        const old = await readLiveInventory(before.say, "Alice");
        const after = server({ Alice: fullBag() });
        const now = await readLiveInventory({ ask: after.say, askEach: after.sayEach }, "Alice");

        expect(old.chunked).toBe(true);
        expect(old.items).toHaveLength(41);
        expect(now.items).toEqual(old.items);
        expect(now.unreadable).toBe(0);
        // 1 whole-bag question + 41 stacks, one trip each.
        expect(before.trips()).toBe(42);
        // 1 whole-bag question + 5 trips of up to ten stacks.
        expect(after.trips()).toBe(6);
    });

    it("reads three players - two full bags and a light one - in 11 trips instead of 85", async () => {
        const bags = { Alice: fullBag(), Bob: fullBag(), Cleo: [stack(0), stack(1)] };
        const before = server(bags);
        const old = [];
        for (const name of Object.keys(bags)) old.push(await readLiveInventory(before.say, name));
        const after = server(bags);
        const now = await readLiveInventories({ ask: after.say, askEach: after.sayEach }, Object.keys(bags));

        expect(now.map((reading) => reading.items)).toEqual(old.map((reading) => reading.items));
        expect(before.trips()).toBe(42 + 42 + 1);
        // 1 trip for all three whole bags, then 5 for each of the two full ones.
        expect(after.trips()).toBe(11);
    });

    it("asks again alone whatever a trip cut off, rather than trusting half an answer", async () => {
        // Stacks so big that ten of them overrun one trip.
        const huge = (slot: number) => stack(slot).replace("Blade number", "B".repeat(1500));
        const bag = Array.from({ length: 12 }, (_, index) => huge(index));
        const truth = await readLiveInventory(server({ Alice: bag }).say, "Alice");
        const after = server({ Alice: bag });
        const now = await readLiveInventory({ ask: after.say, askEach: after.sayEach }, "Alice");
        expect(now.items).toEqual(truth.items);
        expect(now.unreadable).toBe(0);
    });

    it("keeps reading one question at a time where the server cannot take several", async () => {
        const plain = server({ Alice: [stack(0)] });
        const reading = await readLiveInventory({ ask: plain.say }, "Alice");
        expect(reading.items).toHaveLength(1);
        expect(plain.trips()).toBe(1);
    });
});

describe("sayEachReplies", () => {
    it("hands back each answer, and nothing for one whose end did not arrive", () => {
        const output = "first answer\n@@polaris-end 0 0\nsecond\r\nspans lines\n@@polaris-end 1 0\nthird, cut off";
        expect(sayEachReplies(output, 3)).toEqual(["first answer", "second\nspans lines", null]);
    });

    it("hands back nothing for a command the console tool failed on, so it is asked alone", () => {
        const output = "Error: connection refused\n@@polaris-end 0 1\nfine\n@@polaris-end 1 0\n";
        expect(sayEachReplies(output, 2)).toEqual([null, "fine"]);
    });

    it("quotes every argument, so a bracket or a quote reaches the game as typed", () => {
        expect(sayEachScript([["data", "get", "entity", "O'Neil", "Inventory[3]"]])).toBe(
            "rcon-cli 'data' 'get' 'entity' 'O'\\''Neil' 'Inventory[3]'; printf '\\n@@polaris-end %d %d\\n' 0 $?"
        );
    });
});
