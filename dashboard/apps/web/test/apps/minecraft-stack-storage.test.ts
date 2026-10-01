/**
 * A stack too big for one command, built in command storage a piece at a time,
 * and a value too big for one answer, read back from there in pieces.
 *
 * The storage here is a model of the game's: it holds the values as the server
 * prints them, applies `set`, `merge`, `append` and `remove` the way the game
 * does, and cuts every answer at one RCON packet, as the console tool does.
 */

import { describe, expect, it } from "vitest";
import * as storage from "@polaris-app/game-servers/src/lib/minecraft/stack-storage";
import { readWhole } from "@polaris-app/game-servers/src/lib/minecraft/stack-storage-service";
import {
    COMMAND_BYTES_MAX,
    commandBytes
} from "@polaris-app/game-servers/src/lib/minecraft/command-size";

type Value = { compound: Map<string, Value> } | { list: Value[] } | { atom: string };

function toValue(node: storage.SnbtNode): Value {
    if (node.kind === "atom") return { atom: node.text };
    if (node.kind === "list") return { list: node.items.map(toValue) };
    return {
        compound: new Map(
            node.fields.map((field) => [field.key.replace(/^"|"$/g, ""), toValue(field.value)])
        )
    };
}

const keyText = (key: string) => (/^[A-Za-z0-9_\-.+]+$/.test(key) ? key : JSON.stringify(key));

function print(value: Value): string {
    if ("atom" in value) return value.atom;
    if ("list" in value) return `[${value.list.map(print).join(", ")}]`;
    return `{${[...value.compound].map(([key, inner]) => `${keyText(key)}: ${print(inner)}`).join(", ")}}`;
}

function parse(text: string): Value {
    const node = storage.parseSnbt(text);
    if (!node) throw new Error(`not SNBT: ${text}`);
    return toValue(node);
}

/** `a."b:c"[2].d` as its steps. */
function steps(path: string): (string | number)[] {
    const out: (string | number)[] = [];
    const pattern = /"((?:[^"\\]|\\.)*)"|\[(-?\d+)\]|([A-Za-z0-9_\-+]+)/g;
    for (const match of path.matchAll(pattern)) {
        if (match[1] !== undefined) out.push(match[1]);
        else if (match[2] !== undefined) out.push(Number(match[2]));
        else out.push(match[3]!);
    }
    return out;
}

class Storage {
    root = new Map<string, Value>();
    asked: string[] = [];

    constructor(private readonly cut = 4096) {}

    private parent(
        path: string
    ): { holder: Value | Map<string, Value>; last: string | number } | null {
        const all = steps(path);
        let holder: Value | Map<string, Value> = this.root;
        for (const step of all.slice(0, -1)) {
            const next: Value | undefined =
                holder instanceof Map
                    ? holder.get(String(step))
                    : "compound" in holder
                      ? holder.compound.get(String(step))
                      : "list" in holder
                        ? holder.list.at(Number(step))
                        : undefined;
            if (!next) return null;
            holder = next;
        }
        return { holder, last: all.at(-1)! };
    }

    get(path: string): Value | undefined {
        const at = this.parent(path);
        if (!at) return undefined;
        const { holder, last } = at;
        if (holder instanceof Map) return holder.get(String(last));
        if ("compound" in holder) return holder.compound.get(String(last));
        if ("list" in holder) return holder.list.at(Number(last));
        return undefined;
    }

    put(path: string, value: Value): void {
        const { holder, last } = this.parent(path)!;
        if (holder instanceof Map) holder.set(String(last), value);
        else if ("compound" in holder) holder.compound.set(String(last), value);
        else if ("list" in holder)
            holder.list[Number(last) < 0 ? holder.list.length + Number(last) : Number(last)] =
                value;
    }

    remove(path: string): void {
        const { holder, last } = this.parent(path)!;
        if (holder instanceof Map) holder.delete(String(last));
        else if ("compound" in holder) holder.compound.delete(String(last));
        else if ("list" in holder) holder.list.splice(Number(last), 1);
    }

    /** A command, answered as the game would - cut at one packet. */
    async ask(line: string, sources: Record<string, string> = {}): Promise<string> {
        this.asked.push(line);
        expect(commandBytes(line)).toBeLessThanOrEqual(COMMAND_BYTES_MAX);
        const at = `data modify storage ${storage.STORAGE} `;
        if (line.startsWith(at)) {
            const rest = line.slice(at.length);
            const verb = / (set value|merge value|append value|set from) /.exec(rest)!;
            const path = rest.slice(0, verb.index);
            const value = rest.slice(verb.index + verb[0].length);
            if (verb[1] === "set from") {
                const source = sources[value];
                if (source === undefined) return `Found no elements matching ${value}`;
                this.put(path, parse(source));
            } else if (verb[1] === "set value") this.put(path, parse(value));
            else if (verb[1] === "merge value") {
                const into = this.get(path) as { compound: Map<string, Value> };
                for (const [key, inner] of (parse(value) as { compound: Map<string, Value> })
                    .compound)
                    into.compound.set(key, inner);
            } else (this.get(path) as { list: Value[] }).list.push(parse(value));
            return `Modified storage ${storage.STORAGE}`;
        }
        const get = `data get storage ${storage.STORAGE} `;
        if (line.startsWith(get)) {
            const value = this.get(line.slice(get.length));
            if (!value) return `Found no elements matching ${line.slice(get.length)}`;
            return `Storage ${storage.STORAGE} has the following contents: ${print(value)}`.slice(
                0,
                this.cut
            );
        }
        const remove = `data remove storage ${storage.STORAGE} `;
        if (line.startsWith(remove)) {
            this.remove(line.slice(remove.length));
            return `Modified storage ${storage.STORAGE}`;
        }
        throw new Error(`unexpected: ${line}`);
    }
}

/** A shulker box of 27 renamed, enchanted swords, as 1.21.4 prints it: 11 KB. */
function bigShulker(): string {
    const swords = Array.from(
        { length: 27 },
        (_unused, slot) =>
            `{item: {count: 1, components: {"minecraft:custom_name": '{"color":"aqua","italic":false,"text":"Blade number ${slot} of the old armory"}', "minecraft:repair_cost": 7, "minecraft:enchantments": {levels: {"minecraft:looting": 3, "minecraft:sharpness": 5, "minecraft:mending": 1, "minecraft:fire_aspect": 2, "minecraft:sweeping_edge": 3, "minecraft:unbreaking": 3}}, "minecraft:damage": ${slot * 20}}, id: "minecraft:diamond_sword"}, slot: ${slot}}`
    );
    return `{count: 1, Slot: 13b, components: {"minecraft:container": [${swords.join(", ")}]}, id: "minecraft:shulker_box"}`;
}

describe("the same stack, printed in another order", () => {
    it("is the same once its keys are put in one order", () => {
        const left =
            '{count: 1, components: {"minecraft:damage": 212, "minecraft:custom_name": \'"Plate"\'}, id: "minecraft:diamond_chestplate"}';
        const right =
            '{id: "minecraft:diamond_chestplate", components: {"minecraft:custom_name": \'"Plate"\', "minecraft:damage": 212}, count: 1}';
        expect(storage.canonicalSnbt(left)).toBe(storage.canonicalSnbt(right));
        expect(storage.canonicalSnbt(left)).not.toBe(
            storage.canonicalSnbt(right.replace("212", "213"))
        );
        // Lists keep their order: a lore's lines are not interchangeable.
        expect(storage.canonicalSnbt("['\"a\"', '\"b\"']")).not.toBe(
            storage.canonicalSnbt("['\"b\"', '\"a\"']")
        );
    });
});

describe("writing a stack too long for one command", () => {
    it("is one line when it fits", () => {
        expect(storage.storeLines("k", '{id:"minecraft:stone",count:1}')).toEqual([
            `data modify storage ${storage.STORAGE} k set value {id:"minecraft:stone",count:1}`
        ]);
    });

    it("builds a shulker box of enchanted gear in pieces that each fit, and builds it whole", async () => {
        const value = bigShulker();
        const lines = storage.storeLines("k", value)!;
        expect(lines.length).toBeGreaterThan(10);
        const model = new Storage();
        for (const line of lines) await model.ask(line);
        expect(storage.canonicalSnbt(print(model.get("k")!))).toBe(storage.canonicalSnbt(value));
    });

    it("builds a long lore a line at a time", async () => {
        const lore = Array.from(
            { length: 30 },
            (_unused, line) => `'{"text":"Line ${line} of a long story about this chestplate"}'`
        );
        const value = `{id:"minecraft:diamond_chestplate",count:1,components:{"minecraft:lore":[${lore.join(",")}],"minecraft:damage":212}}`;
        const lines = storage.storeLines("k", value)!;
        const model = new Storage();
        for (const line of lines) await model.ask(line);
        expect(storage.canonicalSnbt(print(model.get("k")!))).toBe(storage.canonicalSnbt(value));
    });

    it("cannot write one string longer than any command", () => {
        const value = `{id:"minecraft:written_book",count:1,components:{"minecraft:custom_name":'"${"x".repeat(1200)}"'}}`;
        expect(storage.storeLines("k", value)).toBeNull();
    });

    it("hands the stack over through an item display and takes it away again", () => {
        expect(storage.holdLines("Ana", "k1", "pe_hd1")).toEqual([
            "kill @e[type=minecraft:item_display,tag=pe_hd1]",
            'execute at Ana run summon minecraft:item_display ~ ~ ~ {Tags:["pe_hd1"]}',
            `data modify entity @e[type=minecraft:item_display,tag=pe_hd1,limit=1] item set from storage ${storage.STORAGE} k1`
        ]);
        expect(storage.fromHolderLine("Ana", "armor.chest", "pe_hd1")).toBe(
            "item replace entity Ana armor.chest from entity @e[type=minecraft:item_display,tag=pe_hd1,limit=1] contents"
        );
    });
});

describe("reading a value too long for one answer", () => {
    it("reads a shulker box of enchanted gear whole, and leaves nothing in storage", async () => {
        const value = bigShulker();
        const model = new Storage();
        const read = await readWhole(
            (line) => model.ask(line, { "entity Ana Inventory[4]": value }),
            "entity Ana Inventory[4]"
        );
        expect(read).not.toBeNull();
        expect(storage.canonicalSnbt(read!)).toBe(storage.canonicalSnbt(value));
        expect(model.root.size).toBe(0);
    });

    it("reads a value that fits in one ask", async () => {
        const model = new Storage();
        const value = '{count: 1, Slot: 0b, id: "minecraft:bread"}';
        const read = await readWhole(
            (line) => model.ask(line, { "entity Ana Inventory[0]": value }),
            "entity Ana Inventory[0]"
        );
        expect(read).toBe(value);
        expect(model.asked.filter((line) => line.startsWith("data get"))).toHaveLength(1);
    });

    it("gives up on one string longer than any answer, and on nothing there", async () => {
        const model = new Storage();
        const long = `{count: 1, components: {"minecraft:custom_name": '"${"x".repeat(5000)}"'}, id: "minecraft:book"}`;
        expect(await readWhole((line) => model.ask(line, { s: long }), "s")).toBeNull();
        expect(await readWhole((line) => model.ask(line), "entity Ana Inventory[9]")).toBeNull();
        expect(model.root.size).toBe(0);
    });

    it("takes a cut answer for what arrived of it, never for a whole value", () => {
        const cut = storage.cutValue(
            '{count: 1, Slot: 13b, components: {"minecraft:container": [{item: {cou'
        );
        expect(cut).toEqual({
            kind: "compound",
            whole: ["count: 1", "Slot: 13b"],
            rest: 'components: {"minecraft:container": [{item: {cou'
        });
        expect(storage.memberKey(cut!.rest)).toBe("components");
        expect(storage.cutValue("[I; 1, 2")).toBeNull();
    });
});
