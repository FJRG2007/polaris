/**
 * A bag exported to a file and imported back: lossless for enchanted, named and
 * damaged stacks, refused by name where a stack cannot be written, CSV for
 * reading only, a preview that says slot by slot what changes, and a waiting
 * import for a player who is not on.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Stored = { id: string; count: number; data: string | null };

/** Each player's bag, by slot, with the data compound exactly as the server prints it. */
const bags = new Map<string, Map<number, Stored>>();
const said: string[][] = [];
/** The syntax the simulated server takes. */
let era: "components" | "tag" = "components";

function entry(slot: number, stack: Stored): string {
    const data = stack.data ? `, ${era}: ${stack.data}` : "";
    return `{Slot: ${slot}b, id: "${stack.id}", count: ${stack.count}${data}}`;
}

function slotOf(name: string): number {
    if (name === "weapon.offhand") return -106;
    const armour = ["armor.feet", "armor.legs", "armor.chest", "armor.head"].indexOf(name);
    if (armour >= 0) return 100 + armour;
    const [area, index] = name.split(".");
    return area === "hotbar" ? Number(index) : Number(index) + 9;
}

/** `id[k=v,...]` back into the compound the game prints: keys quoted, `: ` and `, `. */
function stored(argument: string): { id: string; data: string | null } {
    if (era === "tag") {
        const brace = argument.indexOf("{");
        return brace === -1
            ? { id: argument, data: null }
            : { id: argument.slice(0, brace), data: argument.slice(brace) };
    }
    const bracket = argument.indexOf("[");
    if (bracket === -1) return { id: argument, data: null };
    const body = argument.slice(bracket + 1, -1);
    const parts: string[] = [];
    let depth = 0;
    let start = 0;
    for (let index = 0; index <= body.length; index += 1) {
        const c = body[index];
        if (c === "{" || c === "[") depth += 1;
        if (c === "}" || c === "]") depth -= 1;
        if ((c === "," && depth === 0) || index === body.length) {
            const part = body.slice(start, index);
            const equals = part.indexOf("=");
            parts.push(`"${part.slice(0, equals)}": ${part.slice(equals + 1)}`);
            start = index + 1;
        }
    }
    return { id: argument.slice(0, bracket), data: `{${parts.join(", ")}}` };
}

async function say(argv: string[]): Promise<string> {
    said.push(argv);
    const [command, ...rest] = argv;
    if (command === "data") {
        const [, , player, path] = rest;
        const bag = bags.get(player ?? "");
        if (!bag) return "No entity was found";
        const one = /^Inventory\[\{Slot:(-?\d+)b\}\]$/.exec(path ?? "");
        if (one) {
            const stack = bag.get(Number(one[1]));
            return stack
                ? `${player} has the following entity data: ${entry(Number(one[1]), stack)}`
                : `Found no elements matching ${path}`;
        }
        if (path !== "Inventory") return `Found no elements matching ${path}`;
        const all = [...bag.entries()]
            .sort(([a], [b]) => a - b)
            .map(([slot, stack]) => entry(slot, stack));
        return `${player} has the following entity data: [${all.join(", ")}]`;
    }
    if (command === "item") {
        const [, , player, slot, , item, count] = rest;
        const bag = bags.get(player ?? "");
        if (!bag) return "No entity was found";
        if (item === "minecraft:air") bag.delete(slotOf(slot ?? ""));
        else bag.set(slotOf(slot ?? ""), { ...stored(item ?? ""), count: Number(count) });
        return "Replaced a slot";
    }
    if (command === "clear") {
        const item = rest[1] ?? "";
        const speaks =
            era === "components" ? item.includes("[") || !item.includes("{") : !item.includes("[");
        if (!speaks)
            return "Expected whitespace to end one argument, but found trailing data...<--[HERE]";
        return bags.has(rest[0] ?? "")
            ? `No items were found on player ${rest[0]}`
            : "No player was found";
    }
    return "";
}

vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: {
            findUnique: async () => ({ config: JSON.stringify({ itemCommand: "item" }) }),
            update: async () => ({})
        },
        playerInventorySnapshot: {
            findFirst: async () => null,
            upsert: async () => ({})
        }
    }
}));

vi.mock("@polaris-app/game-servers/src/lib/minecraft/service", () => ({
    withServerContainer: async (
        _ownerId: string,
        _installedAppId: string,
        run: (server: unknown) => Promise<unknown>
    ) => run(server)
}));

vi.mock("@polaris-app/game-servers/src/lib/recent-items", () => ({
    recentlyGivenItems: async () => []
}));

const server = {
    edition: "java",
    installedAppId: "server",
    say,
    run: async () => ({ code: 0, output: "" })
};

const transfer = await import("@polaris-app/game-servers/src/lib/minecraft/inventory-transfer");
const service = await import(
    "@polaris-app/game-servers/src/lib/minecraft/inventory-transfer-service"
);
const { readLiveInventory } = await import(
    "@polaris-app/game-servers/src/lib/minecraft/inventory-service"
);
const queue = await import("@polaris-app/game-servers/src/lib/minecraft/queue");

const SWORD =
    '{"minecraft:custom_name": {text:"Excalibur",color:"gold"}, "minecraft:damage": 40, "minecraft:enchantments": {levels: {"minecraft:sharpness": 5, "minecraft:unbreaking": 3}}}';
const SHULKER =
    '{"minecraft:container": [{item: {count: 64, id: "minecraft:diamond"}, slot: 0}, {item: {count: 16, id: "minecraft:golden_apple"}, slot: 1}]}';
const LEGACY_SWORD =
    '{Damage: 40, Enchantments: [{id: "minecraft:sharpness", lvl: 5s}], display: {Name: \'"Excalibur"\'}}';

function modernBag(): Map<number, Stored> {
    return new Map<number, Stored>([
        [0, { id: "minecraft:diamond_sword", count: 1, data: SWORD }],
        [1, { id: "minecraft:arrow", count: 64, data: null }],
        [9, { id: "minecraft:shulker_box", count: 1, data: SHULKER }],
        [
            103,
            {
                id: "minecraft:diamond_helmet",
                count: 1,
                data: '{"minecraft:enchantments": {levels: {"minecraft:protection": 4}}}'
            }
        ],
        [-106, { id: "minecraft:shield", count: 1, data: null }]
    ]);
}

beforeEach(() => {
    bags.clear();
    said.length = 0;
    era = "components";
});

async function bagOf(name: string) {
    return (await readLiveInventory(say, name)).items;
}

describe("a bag exported and imported back", () => {
    it("keeps enchanted, named, damaged and filled stacks byte for byte", async () => {
        bags.set("Alice", modernBag());
        bags.set("Bob", new Map());
        const before = await bagOf("Alice");
        const text = transfer.toJson(
            transfer.exportFile(
                [{ name: "Alice", takenAt: "2026-09-30T10:00:00.000Z", live: true, items: before }],
                "1.21.4"
            )
        );
        const read = transfer.parseTransfer(text);
        expect(read.ok).toBe(true);
        if (!read.ok) return;
        expect(read.file.era).toBe("components");
        const plan = transfer.planImport(
            await bagOf("Bob"),
            read.file.players[0]!.items,
            "replace"
        );
        const done = await service.applyPlanNow(server as never, "server", "Bob", plan);
        expect(done).toEqual({ written: 5, skipped: [] });
        expect(await bagOf("Bob")).toEqual(before);
        expect(bags.get("Bob")!.get(0)!.data).toBe(SWORD);
    });

    it("keeps an older server's tag data exactly too", async () => {
        era = "tag";
        bags.set(
            "Alice",
            new Map([[5, { id: "minecraft:diamond_sword", count: 1, data: LEGACY_SWORD }]])
        );
        bags.set("Bob", new Map([[5, { id: "minecraft:dirt", count: 3, data: null }]]));
        const before = await bagOf("Alice");
        const read = transfer.parseTransfer(
            transfer.toJson(
                transfer.exportFile(
                    [{ name: "Alice", takenAt: "x", live: true, items: before }],
                    "1.20.1"
                )
            )
        );
        expect(read.ok && read.file.era).toBe("tag");
        if (!read.ok) return;
        const plan = transfer.planImport(
            await bagOf("Bob"),
            read.file.players[0]!.items,
            "replace"
        );
        await service.applyPlanNow(server as never, "server", "Bob", plan);
        expect(bags.get("Bob")!.get(5)).toEqual({
            id: "minecraft:diamond_sword",
            count: 1,
            data: LEGACY_SWORD
        });
    });

    it("leaves a slot that changed since the preview as it is", async () => {
        bags.set("Bob", new Map([[0, { id: "minecraft:dirt", count: 1, data: null }]]));
        const seen = await bagOf("Bob");
        const plan = transfer.planImport(
            seen,
            [{ slot: 0, id: "minecraft:stone", count: 5, data: null }],
            "replace"
        );
        bags.get("Bob")!.set(0, { id: "minecraft:dirt", count: 2, data: null });
        const done = await service.applyPlanNow(server as never, "server", "Bob", plan);
        expect(done.skipped).toEqual([0]);
        expect(bags.get("Bob")!.get(0)).toEqual({ id: "minecraft:dirt", count: 2, data: null });
    });
});

describe("what an import changes, shown before it happens", () => {
    const stone = (slot: number, count = 1) => ({ slot, id: "minecraft:stone", count, data: null });
    const dirt = (slot: number) => ({ slot, id: "minecraft:dirt", count: 1, data: null });

    it("replaces, adds and empties in replace mode, and fills only empty slots in fill mode", () => {
        const current = [dirt(0), dirt(1), stone(2)];
        const incoming = [stone(0), stone(2), stone(3)];
        const replace = transfer.planImport(current, incoming, "replace");
        const change = (plan: typeof replace, slot: number) =>
            plan.find((one) => one.slot === slot)?.change;
        expect(change(replace, 0)).toBe("replace");
        expect(change(replace, 1)).toBe("remove");
        expect(change(replace, 2)).toBe("keep");
        expect(change(replace, 3)).toBe("add");
        expect(transfer.writesOf(replace).map((one) => one.slot)).toEqual([0, 1, 3]);
        const fill = transfer.planImport(current, incoming, "fill");
        expect(fill.map((one) => [one.slot, one.change])).toEqual([
            [0, "keep"],
            [2, "keep"],
            [3, "add"]
        ]);
    });

    it("refuses by name a stack that does not fit a command or sits where only a mod writes", () => {
        const long = {
            slot: 4,
            id: "minecraft:shulker_box",
            count: 1,
            data: {
                era: "components" as const,
                snbt: `{"minecraft:custom_name": "${"x".repeat(600)}"}`
            }
        };
        const modded = { slot: 150, id: "minecraft:stone", count: 1, data: null };
        const plan = transfer.planImport([], [long, modded], "fill");
        expect(plan.find((one) => one.slot === 4)).toMatchObject({
            change: "refused",
            refused: "too-long",
            wanted: long
        });
        expect(plan.find((one) => one.slot === 150)).toMatchObject({
            change: "refused",
            refused: "slot"
        });
        expect(transfer.writesOf(plan)).toEqual([]);
    });
});

describe("a file that cannot be imported", () => {
    const file = () =>
        transfer.exportFile(
            [
                {
                    name: "Alice",
                    takenAt: "x",
                    live: false,
                    items: [{ slot: 0, id: "minecraft:stone", count: 1, data: null }]
                }
            ],
            null
        );

    it("is refused with a reason, never read partly", () => {
        expect(transfer.parseTransfer("not json")).toEqual({ ok: false, problem: "notJson" });
        expect(transfer.parseTransfer(JSON.stringify({ format: "other" }))).toEqual({
            ok: false,
            problem: "notInventory"
        });
        const twice = file();
        twice.players[0]!.items.push({ slot: 0, id: "minecraft:dirt", count: 1, data: null });
        expect(transfer.parseTransfer(JSON.stringify(twice))).toEqual({
            ok: false,
            problem: "duplicateSlot"
        });
        const mixed = { ...file(), era: "tag" as const };
        mixed.players[0]!.items[0] = {
            slot: 0,
            id: "minecraft:stone",
            count: 1,
            data: { era: "components", snbt: "{}" }
        };
        expect(transfer.parseTransfer(JSON.stringify(mixed))).toEqual({
            ok: false,
            problem: "mixedEra"
        });
        const hostile = file();
        (hostile.players[0]!.items[0] as { id: string }).id = "minecraft:stone 64\nop Mallory";
        expect(transfer.parseTransfer(JSON.stringify(hostile))).toEqual({
            ok: false,
            problem: "notInventory"
        });
    });

    it("from another syntax does not fit, and a plain one fits anywhere", () => {
        expect(transfer.eraFits("components", "tag")).toBe(false);
        expect(transfer.eraFits("tag", "components")).toBe(false);
        expect(transfer.eraFits("plain", "tag")).toBe(true);
        expect(transfer.eraFits("components", "components")).toBe(true);
    });
});

describe("CSV", () => {
    const HEADER = [
        "Player",
        "Slot",
        "Where",
        "Item",
        "Count",
        "Details",
        "Data",
        "Read at",
        "Source"
    ];

    it("escapes commas, quotes and line breaks, and never starts a formula", () => {
        expect(transfer.csvCell('a,"b"')).toBe('"a,""b"""');
        expect(transfer.csvCell("line\nbreak")).toBe('"line\nbreak"');
        expect(transfer.csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
        expect(transfer.csvCell(-106)).toBe("-106");
    });

    it("reads a stack's name, enchantments and damage", async () => {
        bags.set("Alice", modernBag());
        const file = transfer.exportFile(
            [{ name: "Alice", takenAt: "x", live: true, items: await bagOf("Alice") }],
            null
        );
        const lines = transfer.toCsv(file, HEADER, (slot) => `slot ${slot}`).split("\r\n");
        expect(lines[0]!.startsWith(transfer.CSV_MARK)).toBe(true);
        expect(
            lines.some((line) =>
                line.startsWith(
                    'Alice,0,slot 0,minecraft:diamond_sword,1,"""Excalibur""; sharpness 5, unbreaking 3; damage 40"'
                )
            )
        ).toBe(true);
        expect(
            transfer.summarize({
                slot: 0,
                id: "x:y",
                count: 1,
                data: { era: "tag", snbt: LEGACY_SWORD }
            })
        ).toBe('"Excalibur"; sharpness 5; damage 40');
    });

    it("imports back exactly what the JSON would, empty bags included", async () => {
        bags.set("Alice", modernBag());
        const file = transfer.exportFile(
            [
                {
                    name: "Alice",
                    takenAt: "2026-10-01T00:00:00.000Z",
                    live: true,
                    items: await bagOf("Alice")
                },
                { name: "Bob", takenAt: "2026-10-01T00:00:00.000Z", live: false, items: [] }
            ],
            "1.21.4 NeoForge"
        );
        const csv = transfer.toCsv(file, HEADER, (slot) => `slot ${slot}`);
        expect(transfer.parseTransfer(csv)).toEqual({ ok: true, file });
    });

    it("refuses an export from before CSV carried the data, and a row cut short", () => {
        expect(
            transfer.parseTransfer(
                "# Polaris inventory export - for reading only, it cannot be imported back\r\nPlayer,Slot"
            )
        ).toEqual({ ok: false, problem: "csv" });
        expect(
            transfer.parseTransfer(
                `${transfer.CSV_MARK} v1 era=plain server= exported=2026-10-01T00:00:00.000Z\r\nh\r\nAlice,0,x`
            )
        ).toEqual({ ok: false, problem: "notInventory" });
    });

    it("refuses a slot or count that is blank or not a whole number", () => {
        const row = (slot: string, count: string) =>
            `${transfer.CSV_MARK} v1 era=plain server= exported=2026-10-01T00:00:00.000Z\r\nh\r\nAlice,${slot},,minecraft:stone,${count},,,2026-10-01T00:00:00.000Z,live\r\n`;
        expect(transfer.parseTransfer(row("3", "5"))).toMatchObject({ ok: true });
        for (const [slot, count] of [
            ["", "5"],
            ["3", ""],
            [" 5", "5"],
            ["0x10", "5"],
            ["1e1", "5"],
            ["3", "2.0"]
        ])
            expect(transfer.parseTransfer(row(slot!, count!))).toEqual({
                ok: false,
                problem: "notInventory"
            });
    });

    it("reads back a text cell that was kept from starting a formula", () => {
        expect(transfer.csvCell("'=x")).toBe("''=x");
        const file = transfer.exportFile(
            [
                {
                    name: "Alice",
                    takenAt: "2026-10-01T00:00:00.000Z",
                    live: true,
                    items: [{ slot: 1, id: "-ns:item", count: 2, data: null }]
                }
            ],
            null
        );
        const csv = transfer.toCsv(file, HEADER, (slot) => `slot ${slot}`);
        expect(csv).toContain("'-ns:item");
        expect(transfer.parseTransfer(csv)).toEqual({ ok: true, file });
    });
});

describe("an import for somebody who is not on", () => {
    it("waits in the queue with every stack exactly as the file carries it", () => {
        const items = [
            {
                slot: 0,
                id: "minecraft:diamond_sword",
                count: 1,
                data: { era: "components" as const, snbt: SWORD }
            }
        ];
        const payload = { kind: "import-bag" as const, mode: "replace" as const, items };
        const { kind, ...rest } = payload;
        expect(queue.NEEDS_PLAYER["import-bag"]).toBe(true);
        expect(queue.parseQueuedPayload(kind, JSON.stringify(rest))).toEqual(payload);
    });

    it("lands when they join, and is refused on a server that speaks another syntax", async () => {
        const items = [
            {
                slot: 0,
                id: "minecraft:diamond_sword",
                count: 1,
                data: { era: "components" as const, snbt: SWORD }
            }
        ];
        bags.set("Carol", new Map([[0, { id: "minecraft:dirt", count: 1, data: null }]]));
        const done = await service.applyQueuedImport(
            server as never,
            "server",
            "Carol",
            items,
            "replace"
        );
        expect(done.written).toBe(1);
        expect(bags.get("Carol")!.get(0)).toEqual({
            id: "minecraft:diamond_sword",
            count: 1,
            data: SWORD
        });

        era = "tag";
        bags.set("Dave", new Map());
        await expect(
            service.applyQueuedImport(server as never, "server", "Dave", items, "replace")
        ).rejects.toThrow("era");
        expect(bags.get("Dave")!.size).toBe(0);
    });
});
