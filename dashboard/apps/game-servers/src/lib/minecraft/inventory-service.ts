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

/** Asking several things in one trip, each answer or null for one that did not
 *  arrive whole (`ServerContainer.sayEach`). */
type AskEach = (commands: readonly (readonly string[])[]) => Promise<(string | null)[]>;

/**
 * How the game is asked: one command at a time, and - where the server has it -
 * several in one trip. A caller without the second reads exactly as before.
 */
export interface Asker {
    readonly ask: Ask;
    readonly askEach?: AskEach | undefined;
}

/** The asker for a server's container: its `say`, and its `sayEach` where it has one. */
export function askerOf(server: ServerContainer): Asker {
    return {
        ask: (argv) => server.say(argv),
        askEach: server.sayEach ? (commands) => server.sayEach!(commands) : undefined
    };
}

/**
 * How many stack-by-stack questions go in one trip. A stack's answer is a few
 * hundred bytes and at most one RCON packet (4 KiB), and one trip hands back 16
 * KiB before it is cut; an answer cut off is asked again on its own, so this only
 * decides how often that happens, never whether the bag is read right.
 */
const ENTRIES_PER_TRIP = 10;

/** And how many whole bags: each answer can be a full 4 KiB packet, and three of
 *  them still come back whole. */
const BAGS_PER_TRIP = 3;

/** One command's answer from a batch, asking it again alone when it did not arrive. */
async function eachAnswered(asker: Asker, commands: readonly (readonly string[])[]): Promise<string[]> {
    const batch = asker.askEach
        ? await asker.askEach(commands).catch(() => commands.map(() => null))
        : commands.map(() => null);
    const answers: string[] = [];
    for (const [index, argv] of commands.entries()) {
        answers.push(batch[index] ?? (await asker.ask(argv)));
    }
    return answers;
}

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
 * Where the server can take several questions in one trip (`Asker.askEach`), the
 * entries go ten to a trip rather than one, so a full bag is five trips, not
 * forty-one; only the bags that need it pay even that.
 */
export async function readLiveInventory(asker: Ask | Asker, player: string): Promise<LiveReading> {
    const [reading] = await readLiveInventories(asker, [player]);
    return reading!;
}

/**
 * Several players' bags, in as few trips as they fit: every whole bag in one, then
 * the ones that came back cut off a batch of stacks at a time. An export of the
 * whole server used to cost a trip per player, and one per stack for every big bag.
 */
export async function readLiveInventories(
    asker: Ask | Asker,
    players: readonly string[]
): Promise<LiveReading[]> {
    const how = typeof asker === "function" ? { ask: asker } : asker;
    const wholes: string[] = [];
    for (let start = 0; start < players.length; start += BAGS_PER_TRIP) {
        const some = players.slice(start, start + BAGS_PER_TRIP);
        wholes.push(...(await eachAnswered(how, some.map((player) => ["data", "get", "entity", player, "Inventory"]))));
    }
    const readings: LiveReading[] = [];
    for (const [index, player] of players.entries()) {
        readings.push(await fromWhole(how, ["entity", player], "Inventory", MOST_ENTRIES, wholes[index]!));
    }
    return readings;
}

/** How many stacks a barrel or a chest holds. */
const CONTAINER_ENTRIES = 27;

/**
 * What a container block holds - a barrel an event keeps somebody's things in -
 * read the same way as a bag, so a big one survives the packet limit too. Always
 * the Overworld, which is where the command source stands.
 */
export async function readLiveContainer(
    asker: Ask | Asker,
    at: { readonly x: number; readonly y: number; readonly z: number }
): Promise<LiveReading> {
    const how = typeof asker === "function" ? { ask: asker } : asker;
    const target = ["block", String(at.x), String(at.y), String(at.z)];
    const whole = await how.ask(["data", "get", ...target, "Items"]);
    return fromWhole(how, target, "Items", CONTAINER_ENTRIES, whole);
}

/** A list read from its whole-list answer, and a stack at a time when that answer was cut off. */
async function fromWhole(
    asker: Asker,
    target: readonly string[],
    path: string,
    most: number,
    answer: string
): Promise<LiveReading> {
    const whole = stripFormatting(answer);
    if (!isDataReply(whole)) return { items: [], answered: false, chunked: false, unreadable: 0, said: whole };

    const items = parseInventory(whole);
    // A reply that closed is the whole answer, empty or not. One that did not is a
    // reply that ran out of room, whatever it managed to parse to.
    if (replyIsWhole(whole, "[")) {
        return { items, answered: true, chunked: false, unreadable: 0, said: whole };
    }

    // A batch of entries per trip, stopping at the batch the list ended in. The
    // list is compact, so past its end every entry is refused; asking a few past
    // it inside a trip already being made costs nothing worth saving.
    const found: InventoryItem[] = [];
    let unreadable = 0;
    let ended = false;
    for (let start = 0; start < most && !ended; start += ENTRIES_PER_TRIP) {
        const indexes = Array.from(
            { length: Math.min(ENTRIES_PER_TRIP, most - start) },
            (_, offset) => start + offset
        );
        const commands = asker.askEach
            ? indexes.map((index) => ["data", "get", ...target, `${path}[${index}]`])
            : [];
        const batch = asker.askEach ? await eachAnswered(asker, commands) : null;
        for (const [position, index] of indexes.entries()) {
            const reply = stripFormatting(
                batch ? batch[position]! : await asker.ask(["data", "get", ...target, `${path}[${index}]`])
            );
            // "Found no elements matching Inventory[7]" - the list ended.
            if (!isDataReply(reply)) {
                ended = true;
                break;
            }
            const stack = parseStack(reply);
            if (stack) found.push(stack);
            else unreadable += 1;
        }
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
 * Every bag in one trip where they fit, through a single container handshake. A player whose
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
    const readings = await readLiveInventories(askerOf(server), players).catch(() => null);
    for (const [index, player] of players.entries()) {
        try {
            const reading = readings?.[index] ?? (await readLiveInventory(askerOf(server), player));
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
