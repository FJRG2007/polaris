/**
 * Keeping a copy of what each player is carrying.
 *
 * `data get entity` only answers for somebody who is standing on the server, and
 * the question is nearly always asked about somebody who is not: a player who
 * logged off, or one who was banned an hour ago and whose bag is the evidence.
 * So the bag is read on a cadence while they are on, and kept.
 *
 * The latest only. A history would answer a different question - what changed and
 * when - and would cost a row per player per cycle to do it, on a table nobody
 * would prune.
 *
 * What this must never do is imply the copy is live. Every screen reading it is
 * handed `takenAt` and says how old it is, because an inventory that is twenty
 * minutes stale looks exactly like one that is current.
 */

import { prisma } from "@polaris/db";
import { stripFormatting } from "./parse";
import { isDataReply, replyIsWhole } from "./snbt";
import { withServerContainer, type ServerContainer } from "./service";
import { parseInventory, parseStack, type InventoryItem } from "./inventory";

/** How often a bag is worth re-reading. Ten minutes is short enough to be useful
 *  after somebody logs off mid-session and long enough that a busy server is not
 *  paying a round trip per player per minute. */
export const SNAPSHOT_EVERY_MS = 10 * 60 * 1000;

export interface InventorySnapshot {
    readonly items: InventoryItem[];
    /** When the server was asked, ISO 8601. */
    readonly takenAt: string;
}

/**
 * How many stacks a player's `Inventory` list can hold: 36 in the bag and on the
 * hotbar, 4 worn, 1 in the offhand. The list is compact - no gaps - so reading it
 * an entry at a time ends at the first index the server has nothing for.
 */
const MOST_ENTRIES = 41;

/** Asking the game something and getting its answer. Injected so this reads the
 *  same whether it is driven by a screen or by the snapshot sweep. */
type Ask = (argv: readonly string[]) => Promise<string>;

/** A live read, and how it went. */
export interface LiveReading {
    readonly items: InventoryItem[];
    /** Whether the server answered the question at all. False for a refusal - the
     *  player is not on, the command does not exist on this version. */
    readonly answered: boolean;
    /** Whether the bag had to be read a stack at a time because the whole-bag
     *  reply came back cut off. Slower, so what polls says so. */
    readonly chunked: boolean;
    /** Stacks the server named and this could not read whole even alone. Reported
     *  rather than dropped: a grid one shulker short looks like a complete one. */
    readonly unreadable: number;
    /** What the server said, for a refusal worth quoting back. */
    readonly said: string;
}

/**
 * What a player is carrying, read so the answer survives a big bag.
 *
 * The obvious way - one `data get entity <player> Inventory` - is right until the
 * bag is worth looking at. RCON answers in packets of at most 4096 bytes and the
 * client in the server's own image does not reassemble the rest (itzg/rcon-cli#42),
 * so a player wearing enchanted armour and carrying a shulker gets an answer that
 * stops mid-compound. That parses to no stacks, which is indistinguishable from an
 * empty bag - the panel drew a full inventory as empty and said "Live" over it.
 *
 * So the whole bag is still asked for first, because for most players it fits and
 * costs one round trip. When what comes back does not close, the same question is
 * asked one entry at a time: each stack is its own reply, and a single stack fits.
 * That costs a round trip per stack and is only paid by the bags that need it.
 */
export async function readLiveInventory(ask: Ask, player: string): Promise<LiveReading> {
    const whole = stripFormatting(await ask(["data", "get", "entity", player, "Inventory"]));
    if (!isDataReply(whole)) return { items: [], answered: false, chunked: false, unreadable: 0, said: whole };

    const items = parseInventory(whole);
    // A reply that closed is the whole answer, empty or not. One that did not is a
    // reply that ran out of room, whatever it managed to parse to.
    if (replyIsWhole(whole, "[")) {
        return { items, answered: true, chunked: false, unreadable: 0, said: whole };
    }

    const found: InventoryItem[] = [];
    let unreadable = 0;
    for (let index = 0; index < MOST_ENTRIES; index += 1) {
        const reply = stripFormatting(await ask(["data", "get", "entity", player, `Inventory[${index}]`]));
        // "Found no elements matching Inventory[7]" - the list ended.
        if (!isDataReply(reply)) break;
        const stack = parseStack(reply);
        if (stack) found.push(stack);
        else unreadable += 1;
    }
    return {
        items: found.sort((left, right) => left.slot - right.slot),
        answered: true,
        chunked: true,
        unreadable,
        said: whole
    };
}

/** Decode a stored snapshot. A row that cannot be read is no snapshot rather than
 *  an empty bag: "they were carrying nothing" is a claim, and this cannot make it. */
function parseStored(raw: string): InventoryItem[] | null {
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as InventoryItem[]) : null;
    } catch {
        return null;
    }
}

/** The last bag Polaris saw this player carrying, or null if it never has. */
export async function readSnapshot(
    installedAppId: string,
    username: string
): Promise<InventorySnapshot | null> {
    const row = await prisma.playerInventorySnapshot.findFirst({
        where: { installedAppId, username: { equals: username, mode: "insensitive" } },
        select: { items: true, takenAt: true }
    });
    if (!row) return null;
    const items = parseStored(row.items);
    return items === null ? null : { items, takenAt: row.takenAt.toISOString() };
}

/** Store what one player is carrying right now. */
export async function writeSnapshot(
    installedAppId: string,
    username: string,
    items: readonly InventoryItem[],
    takenAt: Date
): Promise<void> {
    const data = { items: JSON.stringify(items), takenAt };
    await prisma.playerInventorySnapshot.upsert({
        where: { installedAppId_username: { installedAppId, username } },
        create: { installedAppId, username, ...data },
        update: data
    });
}

/**
 * Read every player who is on and keep what they are carrying.
 *
 * One round trip per player, through a single container handshake. A player whose
 * bag cannot be read is skipped rather than stored empty - the old snapshot, however
 * stale, is a truer answer than a fabricated empty one.
 */
export async function snapshotOnlinePlayers(
    server: ServerContainer,
    players: readonly string[]
): Promise<number> {
    if (server.edition !== "java" || players.length === 0) return 0;
    const takenAt = new Date();
    let kept = 0;
    for (const player of players) {
        try {
            const reading = await readLiveInventory(server.say, player);
            // A refusal is not a bag. Storing what it parsed to would replace a
            // real copy from ten minutes ago with an empty one, which is the copy
            // somebody reads after the player has already logged off.
            if (!reading.answered) continue;
            await writeSnapshot(server.installedAppId, player, reading.items, takenAt);
            kept += 1;
        } catch {
            // One player who was mid-disconnect must not cost the rest their turn.
        }
    }
    return kept;
}

/**
 * Take the snapshots that are due, if any are.
 *
 * Due is measured off each row's own `takenAt` rather than a stored "last run":
 * the row is the only thing that cannot be wrong, and a sweep that crashed after
 * writing three of five must not mark the other two as done.
 *
 * Driven from the cron and, for an instance that has none configured, from the
 * players screen being read - the same pair the timeouts use.
 */
export async function sweepInventorySnapshots(
    ownerId: string,
    installedAppId: string,
    online: readonly string[],
    now: Date = new Date()
): Promise<number> {
    if (online.length === 0) return 0;
    const fresh = await prisma.playerInventorySnapshot.findMany({
        where: {
            installedAppId,
            takenAt: { gt: new Date(now.getTime() - SNAPSHOT_EVERY_MS) }
        },
        select: { username: true }
    });
    const recent = new Set(fresh.map((row) => row.username.toLowerCase()));
    const due = online.filter((player) => !recent.has(player.toLowerCase()));
    if (due.length === 0) return 0;
    return withServerContainer(ownerId, installedAppId, (server) => snapshotOnlinePlayers(server, due));
}

/** Forget every snapshot for a server. Called when the server itself goes. */
export async function clearSnapshots(installedAppId: string): Promise<void> {
    await prisma.playerInventorySnapshot.deleteMany({ where: { installedAppId } });
}
