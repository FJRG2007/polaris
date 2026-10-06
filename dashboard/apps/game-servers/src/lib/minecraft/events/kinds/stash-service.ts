/**
 * Keeping a player's things through an arena or a stage, and giving them back
 * (`stash` has the why and the lines). Server-only: it talks to the game and
 * keeps each bag in the database - every stack whole, as an inventory export
 * keeps it - and gives it back through the checked slot writes an import uses
 * (`inventory-transfer-service`).
 */

import * as stash from "./stash";
import * as speech from "../../speech";
import * as written from "../messages";
import * as commands from "../commands";
import type { KeptOut } from "../state";
import { prisma } from "@polaris/db";
import { createHash } from "node:crypto";
import { stripFormatting } from "../../parse";
import * as storage from "../../stack-storage";
import { replaceSlot } from "../../item-argument";
import type { ServerContainer } from "../../service";
import * as transfer from "../../inventory-transfer";
import { isDataReply, replyIsWhole } from "../../snbt";
import { readWhole } from "../../stack-storage-service";
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

/** A stack's own data, short: enough to tell two stacks of one id apart. Taken
 *  of the data with its keys in one order (`canonicalSnbt`): the server prints
 *  the same stack in another order once it has taken another road. */
export function digest(item: InventoryItem): string | null {
    if (!item.data) return null;
    return createHash("sha256")
        .update(storage.canonicalSnbt(item.data.snbt))
        .digest("hex")
        .slice(0, 16);
}

/** The same, as a stash written before this took it: of the data as printed. */
function printedDigest(item: InventoryItem): string | null {
    if (!item.data) return null;
    return createHash("sha256").update(item.data.snbt).digest("hex").slice(0, 16);
}

/** The same stack exactly: id, count and every member of its data. */
function whole(left: InventoryItem | undefined, right: InventoryItem): boolean {
    if (left === undefined || left.id !== right.id || left.count !== right.count) return false;
    if (left.data === null || right.data === null) return left.data === right.data;
    return storage.canonicalSnbt(left.data.snbt) === storage.canonicalSnbt(right.data.snbt);
}

const passed = (reply: string) => /test passed/i.test(stripFormatting(reply));

/** Their experience now; null when they are not on to ask. */
async function experienceOf(
    server: ServerContainer,
    name: string
): Promise<stash.Experience | null> {
    const levels = stash.readExperienceCount(
        stripFormatting(await server.say([stash.readLevels(name)]))
    );
    const points = stash.readExperienceCount(
        stripFormatting(await server.say([stash.readPoints(name)]))
    );
    return levels === null || points === null ? null : { levels, points };
}

/** Their health and hunger now, and the absorption over the health; null when
 *  they are not on to ask. Asked in one trip where the server can. */
async function vitalsOf(
    server: ServerContainer,
    name: string
): Promise<{ vitals: stash.Vitals; absorption: number } | null> {
    const lines = stash.readVitals(name);
    const replies: (string | null)[] = server.sayEach
        ? await server.sayEach(lines.map((line) => [line])).catch(() => lines.map(() => null))
        : lines.map(() => null);
    const numbers: (number | null)[] = [];
    for (const [index, line] of lines.entries()) {
        const reply = replies[index] ?? (await server.say([line]));
        numbers.push(stash.readEntityNumber(stripFormatting(reply)));
    }
    const [health, food, saturation, exhaustion, absorption] = numbers;
    if (health == null || food == null || saturation == null || exhaustion == null) return null;
    return {
        vitals: { health, food, saturation, exhaustion: Math.min(exhaustion, 4) },
        absorption: absorption ?? 0
    };
}

/** Why somebody was kept out of an event rather than let in carrying their own
 *  things (`events.refusedWhy.*`). */
export type StashRefusal =
    /** What they carry could not be read whole. */
    | "unread"
    /** Something they carry no command can write back: named in `items`. */
    | "untakeable"
    /** The copy could not be written to the database. */
    | "unsaved"
    /** What they carry kept changing while it was being put away. */
    | "unsettled";

export interface StashResult {
    /** What is kept for them now; null for nothing. */
    readonly stash: stash.Stash | null;
    /** Why they must not be let in; null when everything of theirs is put away. */
    readonly refused: { readonly why: StashRefusal; readonly items: string[] } | null;
}

/** What players read, in one language or - given `speech.EVERY` - in every one. */
const messages = speech.spoken(written);

/**
 * Somebody kept out for `refused`: told why, and written into the run's list of
 * who was kept out - once, for whatever kept them out last. Answers the list.
 */
export async function keepOut(
    server: ServerContainer,
    keptOut: readonly KeptOut[] | undefined,
    name: string,
    refused: NonNullable<StashResult["refused"]>,
    language: speech.Speech
): Promise<KeptOut[]> {
    await server.say([
        `tellraw ${name} ${commands.text(
            messages.tag(language) + messages.keptOut(refused.why, refused.items, language)
        )}`
    ]);
    return [
        ...(keptOut ?? []).filter((each) => each.name.toLowerCase() !== name.toLowerCase()),
        { name, why: refused.why, items: [...refused.items] }
    ];
}

/** How many times what somebody carries is read and put away before it is
 *  called unsettled: once, and again for whatever turned up meanwhile. */
const ROUNDS = 4;

/**
 * Put away everything `name` carries that is theirs - every stack, however
 * long, written whole to the database with their experience, and only then
 * emptied from its slot - until nothing of theirs is left on them. Answers what
 * is kept, and whether they must be kept out instead: a bag that cannot be read
 * whole, a stack no command can write back, a copy that cannot be written, or
 * a bag that will not stop changing. A refusal for something seen before it is
 * taken takes nothing; one after leaves what was taken in the stash, for the
 * caller to give back.
 *
 * `existing` carries on a stash already made - the look after they are in, for
 * anything picked up on the way - into the same database copy.
 */
export async function stashIn(
    server: ServerContainer,
    owner: StashOwner,
    name: string,
    save: (kept: stash.Stash) => Promise<void>,
    existing: stash.Stash | null = null
): Promise<StashResult> {
    let current: stash.Stash | null = existing;
    const read = () => readLiveInventory(askerOf(server), name);
    const refuse = (why: StashRefusal, items: readonly InventoryItem[] = []): StashResult => ({
        stash: current,
        refused: { why, items: [...new Set(items.map((item) => item.id))] }
    });
    let reading = await read();
    if (!reading.answered || reading.unreadable > 0) return refuse("unread");
    let theirs = reading.items.filter((item) => !stash.isKit(item));
    const untakeable = theirs.filter((item) => !stash.takeable(item));
    if (untakeable.length > 0) return refuse("untakeable", untakeable);
    const experience = existing ? null : await experienceOf(server, name);
    const hasExperience = experience !== null && (experience.levels > 0 || experience.points > 0);
    // Their health and hunger as they come in: whatever the event does to
    // them, they leave with these.
    const vitals = existing ? null : ((await vitalsOf(server, name))?.vitals ?? null);
    if (theirs.length === 0 && !hasExperience && !vitals) return { stash: existing, refused: null };

    // The database copy: every stack written down whole, under the slot it is
    // to go back to.
    let record = existing?.record ?? null;
    let copies: InventoryItem[] = [];
    if (existing && record) {
        const copy = await copyOf(record);
        if (copy === "unread") return refuse("unsaved");
        const owed = new Set(existing.kept.map((one) => one.slot));
        copies = (copy?.items ?? []).filter((item) => owed.has(item.slot));
    }
    const writeCopy = async (state: stash.Stash["state"]): Promise<void> => {
        if (record) {
            await prisma.eventInventoryStash.update({
                where: { id: record },
                data: { items: JSON.stringify(copies) }
            });
        } else {
            record = (
                await prisma.eventInventoryStash.create({
                    data: {
                        installedAppId: owner.installedAppId,
                        runId: owner.runId,
                        player: name,
                        event: owner.event,
                        inventory: reading.said,
                        items: JSON.stringify(copies),
                        experience: hasExperience ? JSON.stringify(experience) : null,
                        ...(vitals
                            ? {
                                  health: vitals.health,
                                  foodLevel: vitals.food,
                                  foodSaturation: vitals.saturation,
                                  foodExhaustion: vitals.exhaustion
                              }
                            : {}),
                        barrels: "[]",
                        casing: "[]",
                        status: "stashed"
                    },
                    select: { id: true }
                })
            ).id;
        }
        current = {
            barrels: existing?.barrels ?? [],
            casing: existing?.casing ?? [],
            kept: copies.map((item) => ({
                slot: item.slot,
                id: item.id,
                count: item.count,
                data: digest(item)
            })),
            experience: existing ? existing.experience : hasExperience ? experience : null,
            vitals: existing ? existing.vitals : vitals,
            state,
            record
        };
        await save(current);
    };

    for (let round = 0; round < ROUNDS && (theirs.length > 0 || round === 0); round += 1) {
        // Written down first, each under a slot of its own.
        const owed = new Set(copies.map((item) => item.slot));
        const taking: { from: number; copy: InventoryItem }[] = [];
        for (const item of theirs) {
            const slot = stash.slotFor(item.slot, owed);
            if (slot === null) return refuse("unsettled", theirs);
            owed.add(slot);
            taking.push({ from: item.slot, copy: { ...item, slot } });
        }
        const before = copies;
        copies = [...copies, ...taking.map((one) => one.copy)];
        try {
            await writeCopy("taking");
        } catch (error) {
            console.warn(
                "polaris: keeping a copy of a bag failed",
                owner.installedAppId,
                String(error)
            );
            copies = before;
            if (current) await writeCopy("stashed").catch(() => undefined);
            return refuse("unsaved");
        }
        // Then emptied - each slot only while it still holds the stack written
        // down. One that changed meanwhile is not taken: it is read again next
        // round, as it is now.
        const again = await read();
        const emptying = taking.filter((one) =>
            whole(
                again.items.find((item) => item.slot === one.from),
                one.copy
            )
        );
        await server.sayAll([
            ...emptying.flatMap((one) => stash.emptySlot(name, one.from) ?? []),
            ...(round === 0 && hasExperience
                ? stash.setExperience(name, { levels: 0, points: 0 })
                : [])
        ]);
        reading = await read();
        // Unread - they left that moment: everything written down stays owed,
        // and a stack found still in its slot at the give-back is left there.
        if (!reading.answered || reading.unreadable > 0) {
            await writeCopy("stashed").catch(() => undefined);
            return refuse("unread");
        }
        const after = reading.items;
        const stayed = taking.filter(
            (one) =>
                !emptying.includes(one) ||
                whole(
                    after.find((item) => item.slot === one.from),
                    one.copy
                )
        );
        if (stayed.length > 0)
            copies = copies.filter((item) => !stayed.some((one) => one.copy === item));
        try {
            await writeCopy("stashed");
        } catch (error) {
            console.warn(
                "polaris: keeping a copy of a bag failed",
                owner.installedAppId,
                String(error)
            );
        }
        theirs = after.filter((item) => !stash.isKit(item));
        const late = theirs.filter((item) => !stash.takeable(item));
        if (late.length > 0) return refuse("untakeable", late);
    }
    if (theirs.length > 0) return refuse("unsettled", theirs);
    return { stash: current, refused: null };
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
          vitals: stash.Vitals | null;
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
        health: number | null;
        foodLevel: number | null;
        foodSaturation: number | null;
        foodExhaustion: number | null;
        missing: string | null;
        writing: string | null;
    } | null;
    try {
        row = await prisma.eventInventoryStash.findUnique({
            where: { id: record },
            select: {
                items: true,
                experience: true,
                health: true,
                foodLevel: true,
                foodSaturation: true,
                foodExhaustion: true,
                missing: true,
                writing: true
            }
        });
    } catch {
        return "unread";
    }
    if (!row) return null;
    return {
        items: parse<InventoryItem[]>(row.items, []),
        experience: parse<stash.Experience | null>(row.experience, null),
        // A row written before these were kept has none: nothing to put back.
        vitals:
            row.health != null &&
            row.foodLevel != null &&
            row.foodSaturation != null &&
            row.foodExhaustion != null
                ? {
                      health: row.health,
                      food: row.foodLevel,
                      saturation: row.foodSaturation,
                      exhaustion: row.foodExhaustion
                  }
                : null,
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
    save: (left: stash.Stash | null) => Promise<void>,
    wait: (ms: number) => Promise<unknown> = pause
): Promise<GiveBack> {
    const current = await readLiveInventory(askerOf(server), name);
    if (!current.answered) return "offline";
    const copy = await copyOf(kept.record);
    if (copy === "unread") return "later";
    // No copy: it is deleted only once everything was given back, and this is a
    // give-back that stopped just after.
    if (copy === null) {
        if (kept.kept.length > 0 || kept.experience || kept.vitals)
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
                .flatMap((item) => stash.releaseDrop(name, stash.dropTag(kept.record, item.slot)))
        );
    }
    const stackOf = (one: stash.Kept) =>
        copy.items.find(
            (item) =>
                item.slot === one.slot &&
                (stash.sameStack(one, item, digest) || stash.sameStack(one, item, printedDigest))
        );
    const at = (items: readonly InventoryItem[], slot: number) =>
        items.find((item) => item.slot === slot);

    const given: stash.Kept[] = [];
    const toWrite: { one: stash.Kept; item: InventoryItem }[] = [];
    const toDrop: { one: stash.Kept; item: InventoryItem }[] = [];
    for (const one of kept.kept) {
        const item = stackOf(one);
        if (
            item &&
            kept.barrels.length > 0 &&
            !stash.fitsOneLine(item) &&
            at(current.items, one.slot) === undefined
        ) {
            // Too big for a command, from a stash kept in barrels: copied from its
            // barrel into its own empty slot, as it was put in.
            if (await fromBarrel(server, name, kept, one, item)) given.push(one);
            continue;
        }
        // Not in the copy, or no command can carry it: owed, and on the panel.
        if (!item || !stash.takeable(item)) continue;
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
        // Too long for one command: built in storage and handed over, each
        // into its slot only while that is still empty.
        for (const each of toWrite) {
            if (stash.fitsOneLine(each.item)) continue;
            await writeLong(server, name, kept.record, each.item).catch((error: unknown) =>
                console.warn("polaris: giving back a long stack failed", name, String(error))
            );
        }
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
        const lines =
            stash.dropLines(name, item, kept.record) ??
            stash.longDropLines(name, item, kept.record);
        if (!lines) continue;
        await server.sayAll(lines);
        const lying = await readDropped(server, tag);
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
    const back = experience
        ? await experienceBack(server, name, experience, kept.state === "taking")
        : "given";
    if (experience && back === "given") {
        experience = null;
        await owing(kept.record, owed, null);
        await save({ ...kept, kept: owed, experience: null });
    }
    // Gone before their experience could be asked for - and seen gone: an
    // answer that only could not be read is no proof of it - every stack is
    // theirs again, nothing of the experience was given, and it stays owed:
    // given when they are next on, as a whole give-back for somebody not on is.
    if (
        experience &&
        back === "unasked" &&
        owed.length === 0 &&
        !(await readLiveInventory(askerOf(server), name)).answered
    ) {
        await save({ ...kept, kept: owed, experience });
        return "offline";
    }

    // Their health and hunger as they came in - whatever the event did to them,
    // a death in it included. Put back once, as close as the game lets it be,
    // and never again: a give-back tried later from the panel must not undo
    // what they have lived through since. Gone before they could be asked:
    // kept for when they are next on.
    const vitals = kept.vitals ?? copy.vitals;
    if (vitals) {
        const back = await vitalsBack(server, name, vitals, wait);
        if (back === "unasked" && !(await readLiveInventory(askerOf(server), name)).answered) {
            await save({ ...kept, kept: owed, experience, vitals });
            return "offline";
        }
        if (back !== "given")
            console.warn(
                "polaris: health and hunger not put back exactly",
                server.installedAppId,
                name
            );
        if (kept.record)
            await prisma.eventInventoryStash.update({
                where: { id: kept.record },
                data: { health: null, foodLevel: null, foodSaturation: null, foodExhaustion: null }
            });
        kept = { ...kept, vitals: null };
        await save({ ...kept, kept: owed, experience });
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

/** How many times food and health are each stepped towards what is wanted. */
const VITAL_STEPS = 6;

/**
 * Put `name`'s health and hunger back to `wanted` (`stash` has how): the food
 * first, with their health full so the game's own healing takes nothing from
 * it, then the health - healed to full and the exact rest taken off, past
 * whatever armor, enchantment or Resistance they have on. Answers "given",
 * "near" when the game would not come closer (a peaceful world refills food on
 * its own), or "unasked" when they could not be asked.
 */
async function vitalsBack(
    server: ServerContainer,
    name: string,
    wanted: stash.Vitals,
    wait: (ms: number) => Promise<unknown>
): Promise<"given" | "near" | "unasked"> {
    let now = await vitalsOf(server, name);
    if (!now) return "unasked";
    if (stash.sameVitals(now.vitals, wanted) && now.absorption === 0) return "given";
    await server.sayAll([stash.healLine(name)]);
    for (let step = 0; step < VITAL_STEPS; step += 1) {
        const next = stash.foodStep(now.vitals, wanted);
        if (!next) break;
        if (next.kind === "feed") await server.sayAll([stash.feedLine(name, next.points)]);
        else {
            const hunger = stash.hungerFor(next.exhaustion);
            if (!hunger) break;
            await server.sayAll(stash.hungerLines(name, hunger));
            // Past its last tick, then cleared: a server running slow must not
            // go on draining after this has read it.
            await wait(hunger.seconds * 1000 + 500);
            await server.sayAll([stash.endHunger(name)]);
        }
        now = await vitalsOf(server, name);
        if (!now) return "unasked";
    }
    for (let step = 0; step < VITAL_STEPS; step += 1) {
        const { health } = now.vitals;
        if (Math.abs(health - wanted.health) <= 0.01 && now.absorption === 0) break;
        // Below what they came with - starving on the way down, a hit since:
        // full again first, and the rest taken off from there.
        if (health < wanted.health - 0.01) await server.sayAll([stash.healLine(name)]);
        else await server.sayAll([stash.hurtLine(name, health + now.absorption - wanted.health)]);
        now = await vitalsOf(server, name);
        if (!now) return "unasked";
    }
    return stash.sameVitals(now.vitals, wanted) ? "given" : "near";
}

/**
 * A stack too long for one command into `name`'s own slot: built in storage,
 * held by an item display beside them, and copied from it - only while the slot
 * is still empty. The display and the storage copy are taken away after.
 */
async function writeLong(
    server: ServerContainer,
    name: string,
    record: string | null,
    item: InventoryItem
): Promise<void> {
    const slot = replaceSlot(item.slot);
    const key = stash.longKey(record, item.slot);
    const tag = stash.holdTag(record, item.slot);
    const build = stash.longLines(key, item);
    if (!slot || !build) return;
    try {
        await server.sayAll([
            ...build,
            ...storage.holdLines(name, key, tag),
            storage.fromHolderLine(name, slot, tag)
        ]);
    } finally {
        await server.sayAll([storage.releaseLine(tag), storage.forgetLine(key)]);
    }
}

/** The stack lying at somebody's feet under `tag`, read whole however long it is. */
async function readDropped(server: ServerContainer, tag: string): Promise<InventoryItem | null> {
    const reply = stripFormatting(await server.say([stash.readDrop(tag)]));
    if (!isDataReply(reply)) return null;
    if (replyIsWhole(reply, "{")) return parseStack(reply);
    const value = await readWhole(
        (line) => server.say([line]),
        `entity @e[type=minecraft:item,tag=${tag},limit=1] Item`
    );
    return value === null ? null : parseStack(value);
}

/**
 * Give back `experience` to `name`: set when they have none - or the stash may
 * never have taken it - and added to what they have otherwise. Answers whether
 * it is theirs now, or could not be asked for what they have - nothing is
 * given then. A point under is theirs all the same: the game can say back no
 * closer (`stash.sameExperience`).
 */
async function experienceBack(
    server: ServerContainer,
    name: string,
    experience: stash.Experience,
    taking: boolean
): Promise<"given" | "unasked" | "failed"> {
    const now = await experienceOf(server, name);
    if (!now) return "unasked";
    if (stash.sameExperience(now, experience)) return "given";
    if (taking || (now.levels === 0 && now.points === 0)) {
        await server.sayAll(stash.setExperience(name, experience));
        const after = await experienceOf(server, name);
        return after !== null && stash.sameExperience(after, experience) ? "given" : "failed";
    }
    await server.sayAll(stash.addExperience(name, experience));
    const after = await experienceOf(server, name);
    const levels = now.levels + experience.levels;
    // Nothing moved: not given, however little was owed.
    const moved = after !== null && (after.levels !== now.levels || after.points !== now.points);
    return moved &&
        (after.levels > levels ||
            (after.levels === levels && after.points >= now.points + experience.points - 1))
        ? "given"
        : "failed";
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
                console.warn(
                    "polaris: marking a kept bag failed",
                    server.installedAppId,
                    String(error)
                )
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
        // Put back with the give-back that failed, never by a retry later.
        vitals: null,
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
