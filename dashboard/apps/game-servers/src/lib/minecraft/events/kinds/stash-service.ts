/**
 * Keeping a player's things through an arena or a stage, and giving them back
 * (`stash` has the why and the lines). Server-only: it talks to the game and
 * keeps a copy of each bag in the database - the whole inventory as the game
 * wrote it - so a give-back can be checked against it, and a barrel that was
 * lost can still be rebuilt from it as far as a command can carry a stack.
 */

import * as stash from "./stash";
import { prisma } from "@polaris/db";
import { createHash } from "node:crypto";
import { stripFormatting } from "../../parse";
import type { ServerContainer } from "../../service";
import { itemArgument, replaceSlot } from "../../item-argument";
import { parseStack, type InventoryItem } from "../../inventory";
import { readLiveContainer, readLiveInventory } from "../../inventory-service";

export type { Stash } from "./stash";

/** Which run and event a stash belongs to, for its database copy. */
export interface StashOwner {
    readonly installedAppId: string;
    readonly runId: string;
    readonly event: string;
}

/** A stack's own data, short: enough to tell two stacks of one id apart. */
export function digest(item: InventoryItem): string | null {
    if (!item.data) return null;
    return createHash("sha256").update(item.data.snbt).digest("hex").slice(0, 16);
}

const ask = (server: ServerContainer) => (argv: readonly string[]) => server.say(argv);

const passed = (reply: string) => /test passed/i.test(stripFormatting(reply));
const unloaded = (reply: string) => /not loaded/i.test(stripFormatting(reply));

/** What a barrel holds; empty for one that holds nothing. Null when it is not a
 *  barrel there to read. */
async function barrelHolds(
    server: ServerContainer,
    spot: stash.Spot
): Promise<InventoryItem[] | null> {
    const reading = await readLiveContainer(ask(server), spot);
    if (reading.answered) return reading.unreadable > 0 ? null : reading.items;
    // "Found no elements matching Items": a barrel with nothing in it.
    return /found no elements/i.test(reading.said) ? [] : null;
}

/** The first place under the floor, away from every stash already put down,
 *  where all of it can go into air. */
async function freePlace(
    server: ServerContainer,
    candidates: readonly stash.Spot[],
    taken: readonly stash.Spot[]
): Promise<{ barrels: stash.Spot[]; casing: stash.Spot[] } | null> {
    const used = new Set(taken.map((spot) => `${spot.x},${spot.y},${spot.z}`));
    for (const origin of candidates) {
        const blocks = stash.blocksAt(origin);
        const all = [...blocks.barrels, ...blocks.casing];
        if (all.some((spot) => used.has(`${spot.x},${spot.y},${spot.z}`))) continue;
        if (passed(await server.say([stash.allAir(all)]))) return blocks;
    }
    return null;
}

/**
 * Take what `name` carries into two barrels under the floor: the copy is read
 * back and checked, the whole bag written to the database, the stash saved in
 * the run - and only then are the slots emptied. Answers the stash, or null when
 * nothing was taken: empty-handed, a bag that could not be read whole, no room
 * under the floor, or a copy that did not check out - in which case the barrels
 * are emptied and taken away again and the player keeps everything on them.
 */
export async function stashIn(
    server: ServerContainer,
    owner: StashOwner,
    name: string,
    candidates: readonly stash.Spot[],
    taken: readonly stash.Spot[],
    save: (kept: stash.Stash) => Promise<void>
): Promise<stash.Stash | null> {
    const reading = await readLiveInventory(ask(server), name);
    if (!reading.answered || reading.unreadable > 0) return null;
    const kept = stash.keepFrom(reading.items, digest);
    if (kept.length === 0) return null;
    const blocks = await freePlace(server, candidates, taken);
    if (!blocks) return null;
    await server.sayAll(stash.placeLines(blocks));
    const undo = async () => {
        await server
            .sayAll([
                ...kept.flatMap((one) => stash.emptyKept(blocks.barrels, one) ?? []),
                ...stash.removeLines(blocks)
            ])
            .catch(() => undefined);
        return null;
    };
    const stood = [
        ...blocks.barrels.map((spot) => stash.isBlock(spot, "minecraft:barrel")),
        ...blocks.casing.map((spot) => stash.isBlock(spot, "minecraft:barrier"))
    ];
    for (const line of stood) if (!passed(await server.say([line]))) return undo();

    await server.sayAll(kept.flatMap((one) => stash.copyIn(name, blocks.barrels, one.slot) ?? []));
    const held: InventoryItem[][] = [];
    for (const spot of blocks.barrels) {
        const items = await barrelHolds(server, spot);
        if (items === null) return undo();
        held.push(items);
    }
    if (!stash.copiedWhole(kept, held, digest)) return undo();
    // Still carrying exactly that: nothing moved while it was copied.
    const again = await readLiveInventory(ask(server), name);
    const now = stash.keepFrom(again.items, digest);
    if (
        !again.answered ||
        now.length !== kept.length ||
        !kept.every((one) =>
            stash.sameStack(
                one,
                again.items.find((item) => item.slot === one.slot),
                digest
            )
        )
    )
        return undo();

    let record: string;
    try {
        record = (
            await prisma.eventInventoryStash.create({
                data: {
                    installedAppId: owner.installedAppId,
                    runId: owner.runId,
                    player: name,
                    event: owner.event,
                    inventory: reading.said,
                    items: JSON.stringify(stash.keepable(reading.items)),
                    barrels: JSON.stringify(blocks.barrels),
                    casing: JSON.stringify(blocks.casing),
                    status: "stashed"
                },
                select: { id: true }
            })
        ).id;
    } catch (error) {
        console.warn(
            "polaris: keeping a copy of a bag failed",
            owner.installedAppId,
            String(error)
        );
        return undo();
    }
    const taking: stash.Stash = {
        barrels: blocks.barrels,
        casing: blocks.casing,
        kept,
        state: "taking",
        record
    };
    try {
        await save(taking);
    } catch (error) {
        await prisma.eventInventoryStash.delete({ where: { id: record } }).catch(() => undefined);
        await undo();
        throw error;
    }
    // Written down and checked: now, and only now, the slots are emptied.
    await server.sayAll(kept.flatMap((one) => stash.emptySlot(name, one.slot) ?? []));
    const stashed: stash.Stash = { ...taking, state: "stashed" };
    await save(stashed);
    return stashed;
}

export type GiveBack =
    /** Everything is theirs again and the barrels are gone. */
    | "done"
    /** Not on the server: kept for when they are. */
    | "offline"
    /** The barrels' chunks are not loaded: tried again later. */
    | "later"
    /** Some of it could not be given back or checked: kept, and on the panel. */
    | "failed";

/**
 * Give back what `name` had kept: each stack into the slot it came from if that
 * slot is empty, or - once they are home - dropped at their feet as theirs if it
 * is not, then checked -
 * and only a stack seen given back has its barrel slot emptied. A barrel slot
 * that is already empty was given back before, so nothing is ever given twice.
 * Barrels gone altogether are rebuilt from the database copy as far as a command
 * can carry each stack. Saves what is left after (null for nothing).
 */
export async function giveBack(
    server: ServerContainer,
    name: string,
    kept: stash.Stash,
    save: (left: stash.Stash | null) => Promise<void>,
    /** Sends them home, between the slots given back and the stacks dropped:
     *  what is dropped lands at their feet at home, never in the arena. */
    goHome?: () => Promise<boolean>
): Promise<GiveBack> {
    const current = await readLiveInventory(ask(server), name);
    if (!current.answered) return "offline";
    // Each barrel still standing is read; one that is gone - broken, or lost
    // with its chunk - is rebuilt from the database copy once the rest is back.
    const held: (InventoryItem[] | null)[] = [];
    for (const spot of kept.barrels) {
        const there = await server.say([stash.isBlock(spot, "minecraft:barrel")]);
        if (unloaded(there)) return "later";
        if (!passed(there)) {
            held.push(null);
            continue;
        }
        const items = await barrelHolds(server, spot);
        if (items === null) return "later";
        held.push(items);
    }
    const lost = kept.kept.filter((one) => held[one.barrel] === null);
    const inBarrel = (one: stash.Kept) =>
        held[one.barrel]?.find((item) => item.slot === one.container);
    // Given back before, by a give-back that stopped before it was written down.
    const owed = kept.kept.filter(
        (one) => held[one.barrel] !== null && inBarrel(one) !== undefined
    );
    const free = (slot: number) => !current.items.some((item) => item.slot === slot);
    // Stopped between writing the stash down and emptying the slots: a stack
    // still in its own slot was never taken, and is only let go of in its barrel.
    const neverTaken = (one: stash.Kept) =>
        kept.state === "taking" &&
        stash.sameStack(
            one,
            current.items.find((item) => item.slot === one.slot),
            digest
        );
    const stayed = owed.filter(neverTaken);
    const into = owed.filter((one) => !neverTaken(one) && free(one.slot));
    const dropped = owed.filter((one) => !neverTaken(one) && !free(one.slot));
    await server.sayAll(into.flatMap((one) => stash.copyBack(name, kept.barrels, one) ?? []));

    const after = await readLiveInventory(ask(server), name);
    const given: stash.Kept[] = [...stayed];
    for (const one of into) {
        // In its slot - or, moved there and then at once, in a slot that did not
        // hold it before.
        const found = after.items.some(
            (item) =>
                stash.sameStack(one, item, digest) &&
                (item.slot === one.slot ||
                    !current.items.some((before) => before.slot === item.slot))
        );
        if (found) given.push(one);
    }
    await server.sayAll(given.flatMap((one) => stash.emptyKept(kept.barrels, one) ?? []));
    if (goHome && !(await goHome())) {
        // Gone before they could be sent home: the rest waits for them.
        const rest = owed.filter((one) => !given.includes(one));
        await save({ ...kept, kept: [...rest, ...lost] });
        return "offline";
    }
    const droppedGiven: stash.Kept[] = [];
    await server.sayAll(
        dropped.flatMap((one) => [
            ...stash.dropLines(name, kept.barrels, one),
            ...stash.legacyDropLines(name, kept.barrels, one)
        ])
    );
    for (const one of dropped) {
        const lying = parseStack(stripFormatting(await server.say([stash.readDrop(one)])));
        if (lying && stash.sameStack(one, lying, digest)) {
            droppedGiven.push(one);
            await server.sayAll(stash.releaseDrop(one));
        } else await server.say([stash.discardDrop(one)]);
    }
    await server.sayAll(droppedGiven.flatMap((one) => stash.emptyKept(kept.barrels, one) ?? []));
    given.push(...droppedGiven);
    const left = owed.filter((one) => !given.includes(one));
    if (left.length > 0) {
        await fail(
            kept,
            [...left, ...lost],
            `${left.length} stack(s) could not be given back and checked`,
            save
        );
        return "failed";
    }
    if (lost.length > 0) return rebuild(server, name, { ...kept, kept: lost }, after.items, save);
    return finish(server, kept, save);
}

/** Everything given back: the barrels, now empty, taken away with their casing,
 *  and the database copy with them. */
async function finish(
    server: ServerContainer,
    kept: stash.Stash,
    save: (left: stash.Stash | null) => Promise<void>
): Promise<GiveBack> {
    for (const spot of kept.barrels) {
        const items = await barrelHolds(server, spot);
        // Something in a barrel nobody is owed: it stays, and is shown.
        if (items !== null && items.length > 0) {
            await fail(
                kept,
                [],
                "A barrel still held something after everything was given back",
                save
            );
            return "failed";
        }
    }
    // The database copy goes first: with it gone, a give-back that stops here
    // and is tried again knows everything was already given back.
    if (kept.record) await prisma.eventInventoryStash.deleteMany({ where: { id: kept.record } });
    await server.sayAll(stash.removeLines(kept));
    await save(null);
    return "done";
}

/**
 * A give-back that could not finish. What is left stays in its barrel, which
 * stays where it is, and the database copy says which slots are still owed: the
 * panel shows it until the operator gives it back from there or dismisses it.
 * The run lets go of it, so the player is not held back from anything else.
 */
async function fail(
    kept: stash.Stash,
    left: readonly stash.Kept[],
    note: string,
    save: (left: stash.Stash | null) => Promise<void>
): Promise<void> {
    if (kept.record) {
        await prisma.eventInventoryStash
            .update({
                where: { id: kept.record },
                data: {
                    status: "failed",
                    note,
                    missing: JSON.stringify(left.map((one) => one.slot))
                }
            })
            .catch(() => undefined);
    }
    await save(null);
}

/**
 * The barrels are gone - broken, or lost with their chunk. What the database
 * copy says each slot held is written back by command, into the slot when it is
 * empty and given otherwise, for every stack a command can carry; what cannot
 * be is kept on the panel for the operator.
 */
async function rebuild(
    server: ServerContainer,
    name: string,
    kept: stash.Stash,
    carrying: readonly InventoryItem[],
    save: (left: stash.Stash | null) => Promise<void>
): Promise<GiveBack> {
    let row: { items: string } | null;
    try {
        row = kept.record
            ? await prisma.eventInventoryStash.findUnique({
                  where: { id: kept.record },
                  select: { items: true }
              })
            : null;
    } catch {
        return "later";
    }
    // No copy left: it is deleted only once everything was given back, and the
    // barrels taken away after it - this is a give-back that stopped in between.
    if (!row) {
        await save(null);
        return "done";
    }
    let copy: InventoryItem[] = [];
    try {
        copy = JSON.parse(row.items) as InventoryItem[];
    } catch {
        copy = [];
    }
    const lines: string[] = [];
    const built: stash.Kept[] = [];
    for (const one of kept.kept) {
        const item = copy.find((each) => each.slot === one.slot);
        const argument = item ? itemArgument(item) : null;
        const slot = replaceSlot(one.slot);
        if (!item || !argument?.ok || !slot || !stash.sameStack(one, item, digest)) continue;
        const free = !carrying.some((each) => each.slot === one.slot);
        lines.push(
            free
                ? `item replace entity ${name} ${slot} with ${argument.value} ${item.count}`
                : `give ${name} ${argument.value} ${item.count}`
        );
        built.push(one);
    }
    await server.sayAll(lines);
    const left = kept.kept.filter((one) => !built.includes(one));
    if (left.length === 0) {
        if (kept.record)
            await prisma.eventInventoryStash.deleteMany({ where: { id: kept.record } });
        await server.sayAll(stash.removeLines(kept)).catch(() => undefined);
        await save(null);
        return "done";
    }
    await fail(
        kept,
        left,
        `The barrels were gone; ${left.length} stack(s) were too big or too unusual to rebuild by command`,
        save
    );
    return "failed";
}

/** The kept bags whose give-back failed and nobody has dismissed, newest first. */
export async function failedStashes(installedAppId: string): Promise<
    {
        id: string;
        player: string;
        event: string;
        note: string | null;
        barrels: stash.Spot[];
        missing: number;
        at: string;
    }[]
> {
    const rows = await prisma.eventInventoryStash.findMany({
        where: { installedAppId, status: "failed", dismissedAt: null },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: {
            id: true,
            player: true,
            event: true,
            note: true,
            barrels: true,
            missing: true,
            updatedAt: true
        }
    });
    return rows.map((row) => {
        const parse = <T>(raw: string | null, fallback: T): T => {
            try {
                return raw ? (JSON.parse(raw) as T) : fallback;
            } catch {
                return fallback;
            }
        };
        return {
            id: row.id,
            player: row.player,
            event: row.event,
            note: row.note,
            barrels: parse<stash.Spot[]>(row.barrels, []),
            missing: parse<number[]>(row.missing, []).length,
            at: row.updatedAt.toISOString()
        };
    });
}

/**
 * A failed give-back tried again from its database copy, when the operator asks:
 * the same give-back, for the slots still owed. Answers how it went; "offline"
 * when the player is not on.
 */
export async function retryStash(
    server: ServerContainer,
    installedAppId: string,
    id: string
): Promise<GiveBack> {
    const row = await prisma.eventInventoryStash.findFirst({
        where: { id, installedAppId, status: "failed" },
        select: { id: true, player: true, items: true, barrels: true, casing: true, missing: true }
    });
    if (!row) return "done";
    const parse = <T>(raw: string | null, fallback: T): T => {
        try {
            return raw ? (JSON.parse(raw) as T) : fallback;
        } catch {
            return fallback;
        }
    };
    const missing = new Set(parse<number[]>(row.missing, []));
    const items = parse<InventoryItem[]>(row.items, []).filter((item) => missing.has(item.slot));
    const kept: stash.Stash = {
        barrels: parse<stash.Spot[]>(row.barrels, []),
        casing: parse<stash.Spot[]>(row.casing, []),
        kept: stash.keepFrom(items, digest),
        state: "failed",
        record: row.id
    };
    return giveBack(server, row.player, kept, async () => undefined);
}

/** A failed give-back taken off the panel by the operator. */
export async function dismissStash(installedAppId: string, id: string): Promise<void> {
    await prisma.eventInventoryStash.updateMany({
        where: { id, installedAppId, status: "failed" },
        data: { dismissedAt: new Date() }
    });
}
