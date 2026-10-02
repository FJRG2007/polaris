/**
 * A stack too big for one command, written and read in as many as it takes,
 * through the game's own command storage.
 *
 * Two limits stand between a stack and a command. A command is at most
 * `COMMAND_BYTES_MAX` bytes on its way in, so a shulker box of enchanted gear,
 * a renamed and trimmed piece of armor with a long lore, cannot be written with
 * one `item replace ... with`. And an answer comes back cut at one RCON packet
 * (4096 characters, see `snbt.replyIsWhole`), so the same shulker read with one
 * `data get` arrives as half a compound.
 *
 * Storage takes any NBT and checks none of it, so a stack is built there a piece
 * at a time - a compound set empty and merged into, a list set empty and
 * appended to, anything still too long built the same way one level down - and
 * only the finished stack is handed to the game once, through an entity that
 * holds an item: an item display, from 1.19.4, whose `contents` slot
 * `item replace ... from entity` copies into a player's slot. Read the other
 * way, a stack copied into storage is read whole where it fits, and where it
 * does not, read as the members that arrived whole, which are then taken out of
 * the storage copy so the rest arrives next time, and a member too big on its
 * own is read the same way, one level down.
 *
 * Nothing is reinterpreted on the way: every member is the server's own text,
 * written back as it was read. Pure: the lines and the reading of answers. The
 * asking is `stack-storage-service`.
 */

import { COMMAND_BYTES_MAX, commandBytes } from "./command-size";
import { readBalanced, splitTopLevel, topLevelColon, unquote } from "./snbt";

/** The storage every piece goes through, each read or write under a key of its own. */
export const STORAGE = "polaris:io";

/** A value as the server prints it, taken apart as far as it nests. */
export type SnbtNode =
    | { readonly kind: "compound"; readonly text: string; readonly fields: SnbtField[] }
    | { readonly kind: "list"; readonly text: string; readonly items: SnbtNode[] }
    | { readonly kind: "atom"; readonly text: string };

export interface SnbtField {
    /** The key as printed: bare, or quoted. */
    readonly key: string;
    readonly value: SnbtNode;
}

/** Typed arrays - `[I; 1, 2]` - are written and read whole. */
const TYPED_ARRAY = /^\[[BIL];/;

/** A value taken apart; null for one that is not whole SNBT. */
export function parseSnbt(raw: string): SnbtNode | null {
    const text = raw.trim();
    if (text.length === 0) return null;
    const first = text[0];
    if (first !== "{" && first !== "[") return { kind: "atom", text };
    if (readBalanced(text, 0) !== text) return null;
    if (TYPED_ARRAY.test(text)) return { kind: "atom", text };
    const members = splitTopLevel(text.slice(1, -1));
    if (first === "[") {
        const items: SnbtNode[] = [];
        for (const member of members) {
            const node = parseSnbt(member);
            if (!node) return null;
            items.push(node);
        }
        return { kind: "list", text, items };
    }
    const fields: SnbtField[] = [];
    for (const member of members) {
        const colon = topLevelColon(member);
        if (colon <= 0) return null;
        const value = parseSnbt(member.slice(colon + 1));
        if (!value) return null;
        fields.push({ key: member.slice(0, colon).trim(), value });
    }
    return { kind: "compound", text, fields };
}

/**
 * The same value with every compound's keys in one order.
 *
 * The server prints a compound in the order of its own hash map, which is not
 * the order the stack was made in and can differ between two copies of the same
 * stack that took different roads - one read off a player, the same one copied
 * into storage. Two stacks are the same stack when this is the same.
 */
export function canonicalSnbt(raw: string): string {
    const node = parseSnbt(raw);
    return node ? canonical(node) : raw.trim();
}

function canonical(node: SnbtNode): string {
    if (node.kind === "atom") return node.text;
    if (node.kind === "list") return `[${node.items.map(canonical).join(", ")}]`;
    return `{${node.fields
        .map((field) => ({ key: unquote(field.key), value: canonical(field.value) }))
        .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
        .map((field) => `${JSON.stringify(field.key)}: ${field.value}`)
        .join(", ")}}`;
}

/** A member of a path as the game reads one: always quoted, so a key with a dot
 *  in it is not read as two. */
export function pathKey(key: string): string {
    const trimmed = key.trim();
    if (trimmed.startsWith('"') || trimmed.startsWith("'")) return trimmed;
    return `"${trimmed}"`;
}

const fits = (line: string) => commandBytes(line) <= COMMAND_BYTES_MAX && !/[\r\n]/.test(line);

/**
 * The lines that build `value` in storage under `path`, each one command; null
 * when a single piece of it - one string, one typed array - is longer than a
 * command can carry, which no number of commands can write.
 */
export function storeLines(path: string, value: string): string[] | null {
    const node = parseSnbt(value);
    return node ? write(path, node, 0) : null;
}

/** How deep a stack is taken apart before it is called unwritable. */
const DEEPEST = 16;

function write(path: string, node: SnbtNode, depth: number): string[] | null {
    const at = `data modify storage ${STORAGE} ${path}`;
    const whole = `${at} set value ${node.text}`;
    if (fits(whole)) return [whole];
    if (node.kind === "atom" || depth >= DEEPEST) return null;
    if (node.kind === "compound") {
        const lines = [`${at} set value {}`];
        let batch: string[] = [];
        const merge = (pieces: readonly string[]) => `${at} merge value {${pieces.join(",")}}`;
        const flush = () => {
            if (batch.length > 0) lines.push(merge(batch));
            batch = [];
        };
        for (const field of node.fields) {
            const piece = `${field.key}:${field.value.text}`;
            if (fits(merge([...batch, piece]))) {
                batch.push(piece);
                continue;
            }
            flush();
            if (fits(merge([piece]))) {
                batch.push(piece);
                continue;
            }
            const inner = write(`${path}.${pathKey(field.key)}`, field.value, depth + 1);
            if (!inner) return null;
            lines.push(...inner);
        }
        flush();
        return lines;
    }
    const lines = [`${at} set value []`];
    for (const [index, item] of node.items.entries()) {
        const append = `${at} append value ${item.text}`;
        if (fits(append)) {
            lines.push(append);
            continue;
        }
        if (item.kind === "atom") return null;
        lines.push(`${at} append value ${item.kind === "compound" ? "{}" : "[]"}`);
        const inner = write(`${path}[${index}]`, item, depth + 1);
        if (!inner) return null;
        lines.push(...inner);
    }
    return lines;
}

/** The storage key taken off again: nothing is left behind in the world's data. */
export function forgetLine(key: string): string {
    return `data remove storage ${STORAGE} ${key}`;
}

// ------------------------------------------------------------------ the holder

/** The item display that hands a finished stack over, as a selector. */
export function holder(tag: string): string {
    return `@e[type=minecraft:item_display,tag=${tag},limit=1]`;
}

/**
 * An item display at `name`, holding the stack built under `key`: summoned
 * fresh - one left by a write that stopped is taken away first - and filled
 * from storage, where the stack is read as the game reads any item.
 */
export function holdLines(name: string, key: string, tag: string): string[] {
    return [
        releaseLine(tag),
        `execute at ${name} run summon minecraft:item_display ~ ~ ~ {Tags:["${tag}"]}`,
        `data modify entity ${holder(tag)} item set from storage ${STORAGE} ${key}`
    ];
}

/** The held stack copied into a player's slot (`replaceSlot`'s name for it) -
 *  only while that slot is empty, whatever the version keeps it in. */
export function fromHolderLine(name: string, slot: string, tag: string): string {
    return `execute unless items entity ${name} ${slot} * run item replace entity ${name} ${slot} from entity ${holder(tag)} contents`;
}

export function releaseLine(tag: string): string {
    return `kill @e[type=minecraft:item_display,tag=${tag}]`;
}

/** An item entity's stack set from storage: one dropped at somebody's feet. */
export function fillItemLine(selector: string, key: string): string {
    return `data modify entity ${selector} Item set from storage ${STORAGE} ${key}`;
}

// ------------------------------------------------------------------ reading in pieces

/** The members of a cut-off compound or list that arrived whole, and what is left. */
export interface CutValue {
    readonly kind: "compound" | "list";
    /** Each member that arrived whole, as printed. */
    readonly whole: string[];
    /** The start of the first member that did not; empty when it did not start. */
    readonly rest: string;
}

/**
 * A value whose answer was cut off, as far as it arrived: the members followed
 * by a comma at its own level are whole, the one after them is not. Null for a
 * value that is not a compound or a list, or a typed array - those are read
 * whole or not at all.
 */
export function cutValue(raw: string): CutValue | null {
    const text = raw.trimStart();
    const first = text[0];
    if ((first !== "{" && first !== "[") || TYPED_ARRAY.test(text)) return null;
    const whole: string[] = [];
    let depth = 0;
    let quote: string | null = null;
    let start = 1;
    for (let index = 1; index < text.length; index += 1) {
        const character = text[index] as string;
        if (quote) {
            if (character === "\\") index += 1;
            else if (character === quote) quote = null;
            continue;
        }
        if (character === '"' || character === "'") quote = character;
        else if (character === "[" || character === "{") depth += 1;
        else if (character === "]" || character === "}") depth -= 1;
        else if (character === "," && depth === 0) {
            const member = text.slice(start, index).trim();
            if (member) whole.push(member);
            start = index + 1;
        }
    }
    return { kind: first === "{" ? "compound" : "list", whole, rest: text.slice(start).trim() };
}

/** The key a compound member was printed under; null when its colon never arrived. */
export function memberKey(member: string): string | null {
    const colon = topLevelColon(member);
    return colon > 0 ? member.slice(0, colon).trim() : null;
}
