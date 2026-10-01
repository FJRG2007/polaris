/**
 * Keeping a player's things through an arena or a stage, and giving them back
 * (`stash` has the why and the lines). Server-only: it talks to the game and
 * keeps each bag in the database - every stack whole, as an inventory export
 * keeps it - and gives it back through the checked slot writes an import uses
 * (`inventory-transfer-service`).
 */

import * as stash from "./stash";
import { prisma } from "@polaris/db";
import { createHash } from "node:crypto";
import { stripFormatting } from "../../parse";
import { itemArgument } from "../../item-argument";
import type { ServerContainer } from "../../service";
import * as transfer from "../../inventory-transfer";
import { applyPlanNow } from "../../inventory-transfer-service";
import { parseStack, type InventoryItem } from "../../inventory";
import { askerOf, readLiveContainer, readLiveInventory } from "../../inventory-service";

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

/** The same stack exactly: id, count and every byte of its data. */
function whole(left: InventoryItem | undefined, right: InventoryItem): boolean {
    return (
        left !== undefined &&
        left.id === right.id &&
        left.count === right.count &&
        (left.data?.snbt ?? null) === (right.data?.snbt ?? null)
    );
}

const passed = (reply: string) => /test passed/i.test(stripFormatting(reply));

/** Their experience now; null when they are not on to ask. */
async function experienceOf(
    server: ServerContainer,
    name: string
): Promise<stash.Experience | null> {
    const levels = stash.readExperienceCount(stripFormatting(await server.say([stash.readLevels(name)])));
    const points = stash.readExperienceCount(stripFormatting(await server.say([stash.readPoints(name)])));
    return levels === null || points === null ? null : { levels, points };
}

/**
 * Take what `name` carries: every stack a command can carry written whole to
 * the database with their experience, the stash saved in the run - and only
 * then are the slots emptied and the experience taken. Answers the stash, or
 * null when nothing was taken: empty-handed with no experience, a bag that could
 * not be read, or a copy that could not be written - in which case the player
 * keeps everything on them.
 */
export async function stashIn(
    server: ServerContainer,
    owner: StashOwner,
    name: string,
    save: (kept: stash.Stash) => Promise<void>
): Promise<stash.Stash | null> {
    const reading = await readLiveInventory(askerOf(server), name);
    if (!reading.answered) return null;
    const items = stash.keepable(reading.items);
    const kept = stash.keepFrom(items, digest);
    const experience = await experienceOf(server, name);
    const hasExperience = experience !== null && (experience.levels > 0 || experience.points > 0);
    if (kept.length === 0 && !hasExperience) return null;

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
                    items: JSON.stringify(items),
                    experience: hasExperience ? JSON.stringify(experience) : null,
                    barrels: "[]",
                    casing: "[]",
                    status: "stashed"
                },
                select: { id: true }
            })
        ).id;
    } catch (error) {
        console.warn("polaris: keeping a copy of a bag failed", owner.installedAppId, String(error));
        return null;
    }
    const taking: stash.Stash = {
        barrels: [],
        casing: [],
        kept,
        experience: hasExperience ? experience : null,
        state: "taking",
        record
    };
    try {
        await save(taking);
    } catch (error) {
        await prisma.eventInventoryStash.delete({ where: { id: record } }).catch(() => undefined);
        throw error;
    }
    // Written down: now, and only now, the slots are emptied - each only while
    // it still holds the stack that was written down.
    const again = await readLiveInventory(askerOf(server), name);
    const still = kept.filter((one) =>
        stash.sameStack(
            one,
            again.items.find((item) => item.slot === one.slot),
            digest
        )
    );
    await server.sayAll([
        ...still.flatMap((one) => stash.emptySlot(name, one.slot) ?? []),
        ...(hasExperience ? stash.setExperience(name, { levels: 0, points: 0 }) : [])
    ]);
    // What is still in its slot was never taken, and stays theirs where it is.
    const after = await readLiveInventory(askerOf(server), name);
    // Unread - they left that moment: everything written down stays owed, and a
    // stack found still in its slot at the give-back is simply left there.
    const taken = after.answered
        ? still.filter((one) => !after.items.some((item) => item.slot === one.slot))
        : still;
    const stashed: stash.Stash = { ...taking, kept: taken, state: "stashed" };
    await save(stashed);
    return stashed;
}

/** How long somebody sent home is waited for to be on the ground, a second a look. */
const SETTLE_LOOKS = 15;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait until somebody sent home is down - standing on something, or in water -
 * keeping them unable to be hurt by a fall while they are not: nothing is given
 * back to a player who could still die with it. Answers whether they came down
 * in time; either way they are left unable to fall to their death for a while.
 */
export async function settle(
    server: ServerContainer,
    name: string,
    fallProof: (name: string) => string[],
    wait: (ms: number) => Promise<unknown> = pause
): Promise<boolean> {
    for (let look = 0; look < SETTLE_LOOKS; look += 1) {
        if (!passed(await server.say([stash.airborne(name)]))) return true;
        await server.sayAll(fallProof(name));
        await wait(1000);
    }
    return false;
}

export type GiveBack =
    /** Everything is theirs again. */
    | "done"
    /** Not on the server: kept for when they are. */
    | "offline"
    /** Could not be asked now - the database, a chunk: tried again later. */
    | "later"
    /** Some of it could not be given back or checked: kept, and on the panel. */
    | "failed";

/** Why a give-back stopped, as the panel says it (`events.stashNote.*`). */
export type StashNote = "notGiven" | "experience";

/** The database copy of a stash: each stack whole, the experience, and - once a
 *  give-back has begun - which slots it still owes and which it was writing. */
async function copyOf(record: string | null): Promise<
    | {
          items: InventoryItem[];
          experience: stash.Experience | null;
          owed: ReadonlySet<number> | null;
          writing: ReadonlySet<number>;
      }
    | null
    | "unread"
> {
    if (!record) return null;
    let row: {
        items: string;
        experience: string | null;
        missing: string | null;
        writing: string | null;
    } | null;
    try {
        row = await prisma.eventInventoryStash.findUnique({
            where: { id: record },
            select: { items: true, experience: true, missing: true, writing: true }
        });
    } catch {
        return "unread";
    }
    if (!row) return null;
    return {
        items: parse<InventoryItem[]>(row.items, []),
        experience: parse<stash.Experience | null>(row.experience, null),
        owed: row.missing ? new Set(parse<number[]>(row.missing, [])) : null,
        writing: new Set(parse<number[]>(row.writing, []))
    };
}

/**
 * What is still owed, written into the database copy as each stack is given
 * back: the copy, not the run, is what a give-back that stopped halfway - a
 * restart in the middle of an event's end - reads again, so a stack dropped at
 * somebody's feet and picked up is never dropped a second time.
 */
async function owing(
    record: string | null,
    owed: readonly stash.Kept[],
    experience: stash.Experience | null
): Promise<void> {
    if (!record) return;
    await prisma.eventInventoryStash.update({
        where: { id: record },
        data: {
            missing: JSON.stringify(owed.map((one) => one.slot)),
            experience: experience ? JSON.stringify(experience) : null,
            writing: null
        }
    });
}

/**
 * Give back what `name` had kept, to a player who is home and down: each stack
 * into its own slot when that is empty, through the checked slot write an import
 * uses, and dropped at their feet as theirs when it is not - every one read back
 * and compared before it is let go of. A stack already in its own slot was given
 * back by a give-back that stopped before it wrote so - when that one had written
 * down it was writing there - and is not given again. Then their experience,
 * added to whatever they have earned since. Saves what is still owed after (null
 * for nothing).
 */
export async function giveBack(
    server: ServerContainer,
    name: string,
    kept: stash.Stash,
    save: (left: stash.Stash | null) => Promise<void>
): Promise<GiveBack> {
    const current = await readLiveInventory(askerOf(server), name);
    if (!current.answered) return "offline";
    const copy = await copyOf(kept.record);
    if (copy === "unread") return "later";
    // No copy: it is deleted only once everything was given back, and this is a
    // give-back that stopped just after.
    if (copy === null) {
        if (kept.kept.length > 0 || kept.experience)
            console.warn("polaris: a kept bag had no database copy", server.installedAppId, name);
        await removeBarrels(server, kept);
        await save(null);
        return "done";
    }
    // Given back already by a give-back that stopped halfway: not owed any more -
    // and what it dropped for them and stopped before letting go of, let go of now.
    if (copy.owed) {
        const owed = copy.owed;
        kept = { ...kept, kept: kept.kept.filter((one) => owed.has(one.slot)) };
        await server.sayAll(
            copy.items
                .filter((item) => !owed.has(item.slot))
                .flatMap((item) =>
                    stash.releaseDrop(name, stash.dropTag(kept.record, item.slot))
                )
        );
    }
    const stackOf = (one: stash.Kept) =>
        copy.items.find((item) => item.slot === one.slot && stash.sameStack(one, item, digest));
    const at = (items: readonly InventoryItem[], slot: number) =>
        items.find((item) => item.slot === slot);

    const given: stash.Kept[] = [];
    const toWrite: { one: stash.Kept; item: InventoryItem }[] = [];
    const toDrop: { one: stash.Kept; item: InventoryItem }[] = [];
    for (const one of kept.kept) {
        const item = stackOf(one);
        if (item && !itemArgument(item).ok && at(current.items, one.slot) === undefined) {
            // Too big for a command, from a stash kept in barrels: copied from its
            // barrel into its own empty slot, as it was put in.
            if (await fromBarrel(server, name, kept, one, item)) given.push(one);
            continue;
        }
        // Not in the copy, or no command can carry it: owed, and on the panel.
        if (!item || !itemArgument(item).ok) continue;
        const there = at(current.items, one.slot);
        // Never taken - stopped between writing it down and emptying the slot -
        // or given back already by a give-back that stopped before it said so.
        // Anywhere else, the same stack there is one of their own since.
        if (whole(there, item) && (kept.state === "taking" || copy.writing.has(one.slot)))
            given.push(one);
        else if (there === undefined) toWrite.push({ one, item });
        else toDrop.push({ one, item });
    }

    // Into their own, empty slots: the import's own write, each slot read again
    // first and left alone when it is no longer empty.
    if (toWrite.length > 0) {
        const plan = transfer.planImport(
            current.items,
            toWrite.map((each) => each.item),
            "fill"
        );
        if (kept.record)
            await prisma.eventInventoryStash.update({
                where: { id: kept.record },
                data: { writing: JSON.stringify(toWrite.map((each) => each.one.slot)) }
            });
        await applyPlanNow(server, server.installedAppId, name, plan).catch(() => undefined);
        const after = await readLiveInventory(askerOf(server), name);
        if (!after.answered) {
            await save({ ...kept, kept: kept.kept.filter((one) => !given.includes(one)) });
            return "offline";
        }
        for (const each of toWrite) {
            const there = at(after.items, each.one.slot);
            // Written into a slot that was empty a moment ago: the same item, as
            // many, is the one written - even when the game has already changed
            // its data, as a worn piece of armor loses durability to the first
            // hit it takes. Asking for every byte here would call a piece that
            // is on them not given back - and a second copy could follow it.
            if (there && there.id === each.item.id && there.count === each.item.count) {
                given.push(each.one);
                if (!whole(there, each.item))
                    console.warn(
                        "polaris: a stack given back changed as it arrived",
                        server.installedAppId,
                        name,
                        each.one.slot
                    );
            }
            // Taken meanwhile - picked up into, or moved: at their feet instead.
            else toDrop.push(each);
        }
    }
    const stillOwed = () => kept.kept.filter((one) => !given.includes(one));
    await owing(kept.record, stillOwed(), kept.experience ?? copy.experience);
    await save({ ...kept, kept: stillOwed() });

    // At their feet, as theirs: only they can pick it up once it is checked.
    for (const { one, item } of toDrop) {
        const tag = stash.dropTag(kept.record, one.slot);
        const lines = stash.dropLines(name, item, kept.record);
        if (!lines) continue;
        await server.sayAll(lines);
        const lying = parseStack(stripFormatting(await server.say([stash.readDrop(tag)])));
        if (lying && whole({ ...lying, slot: item.slot }, item)) {
            // Written down as given before it is let go: never dropped twice.
            given.push(one);
            await owing(kept.record, stillOwed(), kept.experience ?? copy.experience);
            await server.sayAll(stash.releaseDrop(name, tag));
        } else await server.say([stash.discardDrop(tag)]);
    }
    const owed = kept.kept.filter((one) => !given.includes(one));

    // Their experience: set where they still have none, so a give-back that runs
    // twice gives it once, and added to what they have earned since otherwise -
    // written down as given the moment it is.
    let experience = kept.experience ?? copy.experience;
    if (experience && (await experienceBack(server, name, experience, kept.state === "taking"))) {
        experience = null;
        await owing(kept.record, owed, null);
        await save({ ...kept, kept: owed, experience: null });
    }

    if (owed.length > 0 || experience) {
        await fail(
            server,
            { ...kept, kept: owed, experience },
            owed.length > 0 ? "notGiven" : "experience",
            save
        );
        return "failed";
    }
    // The database copy goes first: with it gone, a give-back that stops here
    // and is tried again knows everything was already given back.
    if (kept.record) await prisma.eventInventoryStash.deleteMany({ where: { id: kept.record } });
    await removeBarrels(server, kept);
    await save(null);
    return "done";
}

/** Give back `experience` to `name`: set when they have none - or the stash may
 *  never have taken it - and added to what they have otherwise. Answers whether
 *  it is theirs now. */
async function experienceBack(
    server: ServerContainer,
    name: string,
    experience: stash.Experience,
    taking: boolean
): Promise<boolean> {
    const same = (left: stash.Experience) =>
        left.levels === experience.levels && left.points === experience.points;
    const now = await experienceOf(server, name);
    if (!now) return false;
    if (same(now)) return true;
    if (taking || (now.levels === 0 && now.points === 0)) {
        await server.sayAll(stash.setExperience(name, experience));
        const after = await experienceOf(server, name);
        return after !== null && same(after);
    }
    await server.sayAll(stash.addExperience(name, experience));
    const after = await experienceOf(server, name);
    const levels = now.levels + experience.levels;
    return (
        after !== null &&
        (after.levels > levels ||
            (after.levels === levels && after.points >= now.points + experience.points))
    );
}

/** A stack a command cannot carry, from a stash kept in barrels: copied from its
 *  barrel slot into its own empty slot, and read back. */
async function fromBarrel(
    server: ServerContainer,
    name: string,
    kept: stash.Stash,
    one: stash.Kept,
    item: InventoryItem
): Promise<boolean> {
    const line = stash.copyFromBarrel(name, kept.barrels, one);
    if (!line) return false;
    await server.say([line]);
    const after = await readLiveInventory(askerOf(server), name);
    return whole(
        after.items.find((each) => each.slot === one.slot),
        item
    );
}

/**
 * A stash kept in barrels, before this: once everything is given back from its
 * database copy, what the barrels held of it is emptied, and they and their
 * casing are taken away - each block only where it still is the one placed,
 * and a barrel only when it then holds nothing.
 */
async function removeBarrels(server: ServerContainer, kept: stash.Stash): Promise<boolean> {
    if (kept.barrels.length === 0 && kept.casing.length === 0) return true;
    for (const spot of kept.barrels) {
        if (!passed(await server.say([stash.isBlock(spot, "minecraft:barrel")]))) continue;
        const index = kept.barrels.indexOf(spot);
        await server.sayAll(
            kept.kept
                .filter((one) => one.barrel === index)
                .flatMap((one) => stash.emptyBarrelSlot(kept.barrels, one) ?? [])
        );
        const reading = await readLiveContainer(askerOf(server), spot);
        const empty = reading.answered
            ? reading.items.length === 0 && reading.unreadable === 0
            : /found no elements/i.test(reading.said);
        // Something in it nobody is owed: it stays, and so does its casing.
        if (!empty) return false;
    }
    await server.sayAll(stash.removeLines(kept));
    return true;
}

/**
 * A give-back that could not finish. The database copy says which slots are
 * still owed: the panel shows it until the operator gives it back from there or
 * dismisses it. The run lets go of it, so the player is not held back from
 * anything else.
 */
async function fail(
    server: ServerContainer,
    kept: stash.Stash,
    note: StashNote,
    save: (left: stash.Stash | null) => Promise<void>
): Promise<void> {
    if (kept.record) {
        await prisma.eventInventoryStash
            .update({
                where: { id: kept.record },
                data: {
                    status: "failed",
                    note,
                    missing: JSON.stringify(kept.kept.map((one) => one.slot)),
                    experience: kept.experience ? JSON.stringify(kept.experience) : null
                }
            })
            .catch((error: unknown) =>
                console.warn("polaris: marking a kept bag failed", server.installedAppId, String(error))
            );
    }
    await save(null);
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
        levels: number;
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
            experience: true,
            updatedAt: true
        }
    });
    return rows.map((row) => ({
        id: row.id,
        player: row.player,
        event: row.event,
        note: row.note,
        barrels: parse<stash.Spot[]>(row.barrels, []),
        missing: parse<number[]>(row.missing, []).length,
        levels: parse<stash.Experience | null>(row.experience, null)?.levels ?? 0,
        at: row.updatedAt.toISOString()
    }));
}

function parse<T>(raw: string | null, fallback: T): T {
    try {
        return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
        return fallback;
    }
}

/** A failed stash's row, as the run kept it: the slots still owed and, for one
 *  kept in barrels, where each sat. */
async function failedRow(installedAppId: string, id: string) {
    return prisma.eventInventoryStash.findFirst({
        where: { id, installedAppId, status: "failed" },
        select: {
            id: true,
            player: true,
            items: true,
            barrels: true,
            casing: true,
            missing: true,
            experience: true
        }
    });
}

/** The stash a failed row stands for: the slots it still owes, and - kept in
 *  barrels - where each of them sat, laid out as it was put in. */
function stashOfRow(row: NonNullable<Awaited<ReturnType<typeof failedRow>>>): stash.Stash {
    const missing = new Set(parse<number[]>(row.missing, []));
    const barrels = parse<stash.Spot[]>(row.barrels, []);
    const items = parse<InventoryItem[]>(row.items, []).filter((item) => missing.has(item.slot));
    return {
        barrels,
        casing: parse<stash.Spot[]>(row.casing, []),
        kept: items.map((item) => {
            const index = stash.SLOTS.indexOf(item.slot);
            return {
                slot: item.slot,
                ...(barrels.length > 0 && index >= 0
                    ? { barrel: Math.floor(index / 27), container: index % 27 }
                    : {}),
                id: item.id,
                count: item.count,
                data: digest(item)
            };
        }),
        experience: parse<stash.Experience | null>(row.experience, null),
        state: "failed",
        record: row.id
    };
}

/**
 * A failed give-back tried again from its database copy, when the operator asks:
 * the same give-back, for what is still owed. Answers how it went; "offline"
 * when the player is not on.
 */
export async function retryStash(
    server: ServerContainer,
    installedAppId: string,
    id: string
): Promise<GiveBack> {
    const row = await failedRow(installedAppId, id);
    if (!row) return "done";
    if (stripFormatting(await server.say([stash.airborne(row.player)])).match(/test passed/i))
        return "later";
    return giveBack(server, row.player, stashOfRow(row), async () => undefined);
}

/**
 * A failed give-back taken off the panel by the operator. A stash kept in
 * barrels before this has the blocks it placed taken away with it - each only
 * where it still is that barrel or barrier, and a barrel only once it is empty.
 */
export async function dismissStash(
    server: ServerContainer | null,
    installedAppId: string,
    id: string
): Promise<void> {
    const row = await failedRow(installedAppId, id);
    if (!row) return;
    const kept = stashOfRow(row);
    if (server && (kept.barrels.length > 0 || kept.casing.length > 0))
        await removeBarrels(server, { ...kept, kept: [] }).catch(() => false);
    await prisma.eventInventoryStash.updateMany({
        where: { id, installedAppId, status: "failed" },
        data: { dismissedAt: new Date() }
    });
}
