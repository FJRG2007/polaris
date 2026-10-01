/**
 * Reading a value too big for one answer, and writing a stack too big for one
 * command, through command storage (`stack-storage` has the why and the lines).
 * Talks to the game through whatever asks it, so a screen, a sweep and an event
 * read the same way.
 */

import { randomBytes } from "node:crypto";
import { stripFormatting } from "./parse";
import * as storage from "./stack-storage";
import { dataReplyValue, isDataReply, readBalanced } from "./snbt";

/** One command, and what the game answered. */
export type AskLine = (line: string) => Promise<string>;

/** A storage key nobody else is using: two reads at once never share one. */
export function storageKey(prefix: string): string {
    return `${prefix}${randomBytes(4).toString("hex")}`;
}

/** How many times one value is asked for before it is given up on. */
const MOST_ASKS = 400;

/**
 * The value at `source` - `entity Ana Inventory[3]`, `block 1 2 3 Items[0]` -
 * read whole however long it is: copied into storage under a key of its own and
 * read from there, in pieces where it does not fit one answer. Null when it is
 * not there, or holds a single piece too long for any answer. The storage copy
 * is always taken away again.
 */
export async function readWhole(ask: AskLine, source: string): Promise<string | null> {
    const key = storageKey("r");
    const copied = stripFormatting(
        await ask(`data modify storage ${storage.STORAGE} ${key} set from ${source}`)
    );
    try {
        if (!/modified/i.test(copied)) return null;
        const budget = { asks: MOST_ASKS };
        return await readPath(ask, key, budget, 0);
    } finally {
        await ask(storage.forgetLine(key)).catch(() => undefined);
    }
}

async function readPath(
    ask: AskLine,
    path: string,
    budget: { asks: number },
    depth: number
): Promise<string | null> {
    const get = async () => {
        budget.asks -= 1;
        if (budget.asks < 0) return null;
        const reply = stripFormatting(await ask(`data get storage ${storage.STORAGE} ${path}`));
        return isDataReply(reply) ? dataReplyValue(reply).trim() : null;
    };
    const first = await get();
    if (first === null) return null;
    if (first[0] !== "{" && first[0] !== "[") return atomWhole(first);
    if (readBalanced(first, 0) === first) return first;
    if (depth >= 16) return null;

    const members: string[] = [];
    let value: string | null = first;
    let kind: "compound" | "list" = first[0] === "{" ? "compound" : "list";
    for (;;) {
        if (value === null) return null;
        if (readBalanced(value, 0) === value) {
            const rest = storage.cutValue(value.slice(0, -1));
            if (!rest) return null;
            members.push(...rest.whole, ...(rest.rest ? [rest.rest] : []));
            break;
        }
        const cut = storage.cutValue(value);
        if (!cut) return null;
        kind = cut.kind;
        if (cut.whole.length > 0) {
            members.push(...cut.whole);
            // Out of the copy, so the rest arrives next time.
            for (const member of cut.whole) {
                if (kind === "list") await ask(`${storage.forgetLine(path)}[0]`);
                else {
                    const key = storage.memberKey(member);
                    if (!key) return null;
                    await ask(`${storage.forgetLine(path)}.${storage.pathKey(key)}`);
                }
            }
        } else if (kind === "list") {
            // One element bigger than an answer: read on its own, one level down.
            const inner = await readPath(ask, `${path}[0]`, budget, depth + 1);
            if (inner === null) return null;
            members.push(inner);
            await ask(`${storage.forgetLine(path)}[0]`);
        } else {
            const key = storage.memberKey(cut.rest);
            if (!key) return null;
            const inner = await readPath(ask, `${path}.${storage.pathKey(key)}`, budget, depth + 1);
            if (inner === null) return null;
            members.push(`${key}: ${inner}`);
            await ask(`${storage.forgetLine(path)}.${storage.pathKey(key)}`);
        }
        value = await get();
        // Everything read and taken out: an empty compound or list is left.
        if (value === "{}" || value === "[]") break;
    }
    const body = members.join(", ");
    return kind === "compound" ? `{${body}}` : `[${body}]`;
}

/** A number or a string, whole only when a string closes its own quote. */
function atomWhole(text: string): string | null {
    const quote = text[0];
    if (quote !== '"' && quote !== "'") return text;
    if (text.length < 2 || !text.endsWith(quote)) return null;
    // A closing quote that is itself escaped is not one.
    let slashes = 0;
    for (let index = text.length - 2; index > 0 && text[index] === "\\"; index -= 1) slashes += 1;
    return slashes % 2 === 0 ? text : null;
}
